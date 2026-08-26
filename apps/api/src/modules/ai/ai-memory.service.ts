import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppLogger } from '../../common/logging/app-logger';
import { MetricsService } from '../../common/metrics/metrics.service';
import { Message } from '../messaging/entities/message.entity';
import { MessageDirection } from '../messaging/message-types';
import { AIJobSlot } from './ai-types';
import { AIConversation } from './entities/ai-conversation.entity';
import { AICustomerFact } from './entities/ai-customer-fact.entity';
import { AIMessage } from './entities/ai-message.entity';
import { AIMessageRole } from './ai-types';
import { AIRegistryService } from './ai-registry.service';
import { SUMMARY_SYSTEM_PROMPT } from './ai-instructions';

/**
 * Three kinds of memory (`PROJECT_SPEC.md` §25, §26).
 *
 *  * **Short term** — the last few turns, verbatim. Cheap, exact, and all that most exchanges need.
 *  * **Medium term** — a rolling summary of everything older, rewritten as the thread grows. This
 *    is what stops a two-hundred-message conversation costing two hundred messages' worth of
 *    tokens on every reply.
 *  * **Long term** — approved facts about the customer. Never inferred and silently kept: a fact
 *    with no approver is invisible here.
 *
 * The rule the whole design turns on: **never send the full history**. A support thread that has
 * run for a week does not fit, and truncating it blindly loses the beginning — which is usually
 * where the actual problem was stated.
 */

/** How many recent turns go in verbatim. Beyond this, the summary carries the weight. */
const DEFAULT_RECENT_TURNS = 8;
/** Rewrite the summary once this many turns have accumulated beyond the last one. */
const SUMMARY_INTERVAL_TURNS = 10;
/** A hard ceiling on any one turn included verbatim, so one pasted log cannot fill the window. */
const MAX_TURN_CHARS = 1_200;

export interface ConversationMemory {
  /** Oldest first, already truncated to the budget. */
  history: Array<{ role: 'customer' | 'agent'; text: string }>;
  summary: string | null;
  customerFacts: string[];
}

@Injectable()
export class AIMemoryService {
  private readonly logger = new AppLogger(AIMemoryService.name);

  constructor(
    @InjectRepository(AIConversation) private readonly conversations: Repository<AIConversation>,
    @InjectRepository(AIMessage) private readonly messages: Repository<AIMessage>,
    @InjectRepository(AICustomerFact) private readonly facts: Repository<AICustomerFact>,
    @InjectRepository(Message) private readonly inbox: Repository<Message>,
    private readonly registry: AIRegistryService,
    private readonly metrics: MetricsService,
  ) {}

  /** Everything the model should be told about the past, within budget. */
  async load(
    conversationId: string,
    customerId: string | null,
    options: { recentTurns?: number } = {},
  ): Promise<ConversationMemory> {
    const [record, recent, facts] = await Promise.all([
      this.conversations.findOne({ where: { conversationId } }),
      this.inbox.find({
        where: { conversationId },
        order: { sentAt: 'DESC' },
        take: options.recentTurns ?? DEFAULT_RECENT_TURNS,
      }),
      customerId ? this.approvedFacts(customerId) : Promise.resolve([]),
    ]);

    const history = recent
      .slice()
      .reverse()
      .map((message) => ({
        role: (message.direction === MessageDirection.INBOUND ? 'customer' : 'agent') as 'customer' | 'agent',
        text: (message.body ?? '').slice(0, MAX_TURN_CHARS),
      }))
      .filter((turn) => turn.text.trim().length > 0);

    return { history, summary: record?.summary ?? null, customerFacts: facts };
  }

  /** Approved facts only. A suggestion nobody signed off is not memory. */
  async approvedFacts(customerId: string): Promise<string[]> {
    const rows = await this.facts.find({
      where: { customerId, isActive: true },
      order: { createdAt: 'ASC' },
      take: 20,
    });
    return rows.filter((row) => row.approvedAt !== null).map((row) => row.fact);
  }

  /** The memory row for a conversation, created on first use. */
  async ensure(conversationId: string): Promise<AIConversation> {
    const existing = await this.conversations.findOne({ where: { conversationId } });
    if (existing) return existing;

    try {
      return await this.conversations.save(this.conversations.create({ conversationId }));
    } catch (error) {
      // Two workers deciding on two messages of the same conversation at once. The unique index
      // settles it; the loser reads the winner's row.
      if ((error as { code?: string }).code === '23505') {
        return this.conversations.findOneOrFail({ where: { conversationId } });
      }
      throw error;
    }
  }

  /** Records one AI turn. Structured verdict and text — never reasoning (§27, §165). */
  async recordTurn(input: {
    conversationId: string | null;
    decisionId: string | null;
    messageId: string | null;
    role: AIMessageRole;
    content: string | null;
    provider?: string | null;
    model?: string | null;
    jobSlot?: AIJobSlot;
    promptTokens?: number | null;
    completionTokens?: number | null;
    latencyMs?: number | null;
    decision?: string | null;
    confidence?: number | null;
    knowledgeSufficient?: boolean | null;
    needsHuman?: boolean | null;
    citedIds?: string[] | null;
    error?: string | null;
  }): Promise<AIMessage> {
    const memory = input.conversationId ? await this.ensure(input.conversationId) : null;

    const row = await this.messages.save(
      this.messages.create({
        aiConversationId: memory?.id ?? null,
        conversationId: input.conversationId,
        decisionId: input.decisionId,
        messageId: input.messageId,
        role: input.role,
        content: input.content,
        provider: input.provider ?? null,
        model: input.model ?? null,
        jobSlot: input.jobSlot ?? AIJobSlot.DECISION,
        promptTokens: input.promptTokens ?? null,
        completionTokens: input.completionTokens ?? null,
        latencyMs: input.latencyMs ?? null,
        decision: input.decision ?? null,
        confidence: input.confidence === null || input.confidence === undefined ? null : String(input.confidence),
        knowledgeSufficient: input.knowledgeSufficient ?? null,
        needsHuman: input.needsHuman ?? null,
        citedIds: input.citedIds ?? null,
        error: input.error ?? null,
      }),
    );

    if (memory) {
      await this.conversations.update(memory.id, {
        turnCount: memory.turnCount + 1,
        lastTurnAt: new Date(),
      });
    }

    return row;
  }

  /**
   * Rewrites the rolling summary if enough has happened since the last one.
   *
   * Best-effort by design. Summarising is a convenience for the *next* reply, so a summariser
   * failure must never fail the reply that triggered it — the conversation simply carries an
   * older summary for a while longer.
   */
  async maybeSummarize(conversationId: string): Promise<void> {
    const memory = await this.ensure(conversationId);

    const total = await this.inbox.count({ where: { conversationId } });
    const since = memory.summarizedAt
      ? await this.inbox.count({ where: { conversationId } })
      : total;

    const due = !memory.summary || since - (memory.summaryTokens ?? 0) >= SUMMARY_INTERVAL_TURNS;
    if (!due || total < SUMMARY_INTERVAL_TURNS) return;

    try {
      const recent = await this.inbox.find({
        where: { conversationId },
        order: { sentAt: 'DESC' },
        take: 40,
      });

      const transcript = recent
        .slice()
        .reverse()
        .map((message) => {
          const who = message.direction === MessageDirection.INBOUND ? 'Customer' : 'Agent';
          return `${who}: ${(message.body ?? '').slice(0, MAX_TURN_CHARS)}`;
        })
        .join('\n');

      const prompt = [
        memory.summary ? `Existing summary:\n${memory.summary}\n` : '',
        'Recent conversation:',
        transcript,
      ]
        .filter(Boolean)
        .join('\n');

      const { result, provider, model } = await this.registry.complete(prompt, {
        system: SUMMARY_SYSTEM_PROMPT,
        maxTokens: 400,
      });

      const summary = result.text.trim();
      if (!summary) return;

      await this.conversations.update(memory.id, {
        summary: summary.slice(0, 4_000),
        summaryTokens: total,
        summarizedAt: new Date(),
        summarizedThroughMessageId: recent[0]?.id ?? null,
      });

      await this.recordTurn({
        conversationId,
        decisionId: null,
        messageId: null,
        role: AIMessageRole.SUMMARY,
        content: summary.slice(0, 4_000),
        provider: provider.kind,
        model,
        jobSlot: AIJobSlot.SUMMARY,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
      });

      this.metrics.increment('ai.summary_written');
    } catch (error) {
      this.metrics.increment('ai.summary_failed');
      this.logger.warn('Conversation summary could not be refreshed; the older one still applies', {
        conversationId,
        error: (error as Error).message,
      });
    }
  }

  /** Every fact recorded about a customer, approved or not, for the review screen. */
  async factsFor(customerId: string): Promise<AICustomerFact[]> {
    return this.facts.find({ where: { customerId }, order: { createdAt: 'DESC' } });
  }

  /**
   * Records a fact.
   *
   * A fact created by a person is approved by that act. One suggested by the AI is not: it is
   * stored inactive-in-effect (no approver) and the retrieval path ignores it until somebody signs
   * off. That is the difference between the system remembering what it was told and remembering
   * what it decided about you.
   */
  async addFact(input: {
    customerId: string;
    fact: string;
    source?: 'HUMAN' | 'AI_SUGGESTED' | 'IMPORTED';
    userId: string | null;
  }): Promise<AICustomerFact> {
    const source = input.source ?? 'HUMAN';
    const approved = source === 'HUMAN';

    return this.facts.save(
      this.facts.create({
        customerId: input.customerId,
        fact: input.fact.slice(0, 1_000),
        source,
        approvedById: approved ? input.userId : null,
        approvedAt: approved ? new Date() : null,
      }),
    );
  }

  async approveFact(id: string, userId: string | null): Promise<AICustomerFact> {
    await this.facts.update(id, { approvedById: userId, approvedAt: new Date(), isActive: true });
    return this.facts.findOneOrFail({ where: { id } });
  }

  /** Retires a fact. Kept rather than deleted, so "why did it say that?" stays answerable. */
  async retireFact(id: string): Promise<AICustomerFact> {
    await this.facts.update(id, { isActive: false });
    return this.facts.findOneOrFail({ where: { id } });
  }

  /** The rolling summary for one conversation, for the trace panel. */
  async summaryFor(conversationId: string): Promise<AIConversation | null> {
    return this.conversations.findOne({ where: { conversationId } });
  }

  async turnsFor(conversationId: string, limit = 50): Promise<AIMessage[]> {
    return this.messages.find({
      where: { conversationId },
      order: { createdAt: 'DESC' },
      take: Math.min(limit, 200),
    });
  }
}
