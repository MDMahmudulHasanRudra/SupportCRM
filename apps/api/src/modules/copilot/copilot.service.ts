import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppLogger } from '../../common/logging/app-logger';
import { MetricsService } from '../../common/metrics/metrics.service';
import type { AuthenticatedUser } from '../auth/auth.service';
import { ActionType, ConditionType } from '../automation/automation-types';
import { AutomationCandidate, CandidateStatus } from '../automation/entities/automation-candidate.entity';
import { Group } from '../groups/entities/group.entity';
import { Escalation, EscalationStatus } from '../escalation/entities/escalation.entity';
import { AIGatewayService } from '../ai/ai-gateway.service';
import { AIRegistryService } from '../ai/ai-registry.service';
import { ActivityAnalyticsService } from '../reports/activity-analytics.service';
import { KnowledgeCandidateService } from '../knowledge/knowledge-candidate.service';
import { TeamIdentityService } from '../team/team-identity.service';
import { ChannelKey } from '../channel/entities/channel.entity';
import { ReportsService, defaultWindow } from '../reports/reports.service';
import { CopilotAction, CopilotActionStatus } from './entities/copilot-action.entity';
import { COPILOT_TOOLS, findTool, validateArguments, type CopilotTool } from './copilot-tools';

/**
 * The admin assistant (`PROJECT_SPEC.md` §89–§91, §137–§138).
 *
 * The shape of this service is one decision repeated: **the Copilot borrows its caller's authority
 * and never exceeds it.**
 *
 *  * Every tool names a permission, and the calling user must hold it. An RBAC denial holds even
 *    when the Copilot is the one asking (§90) — it is not a service account with its own rights.
 *  * A read executes immediately. A write is *proposed*, with its blast radius stated in words, and
 *    does nothing until a person confirms it. "Disable AI for 500 groups" must say five hundred out
 *    loud and wait.
 *  * Every proposal and every execution is recorded in `copilot_actions`, so "the assistant changed
 *    something" is never a thing anyone has to reconstruct from side effects.
 *
 * There is deliberately no tool that deletes anything, and no tool that sends a message.
 */
/** What `ask` gives back: either a real action, or an honest "I could not tell". */
export interface CopilotAnswer {
  answered: boolean;
  message: string;
  action?: CopilotAction;
  suggestions: Array<{ name: string; description: string }>;
}

@Injectable()
export class CopilotService {
  private readonly logger = new AppLogger(CopilotService.name);

  constructor(
    @InjectRepository(CopilotAction) private readonly actions: Repository<CopilotAction>,
    @InjectRepository(AutomationCandidate) private readonly candidates: Repository<AutomationCandidate>,
    @InjectRepository(Group) private readonly groups: Repository<Group>,
    @InjectRepository(Escalation) private readonly escalations: Repository<Escalation>,
    private readonly reports: ReportsService,
    private readonly activity: ActivityAnalyticsService,
    private readonly knowledgeCandidates: KnowledgeCandidateService,
    private readonly identities: TeamIdentityService,
    private readonly ai: AIGatewayService,
    private readonly registry: AIRegistryService,
    private readonly metrics: MetricsService,
  ) {}

  /** What this user may ask for. The list is filtered by their permissions, not just labelled. */
  tools(user: AuthenticatedUser): CopilotTool[] {
    return COPILOT_TOOLS.filter((tool) => user.permissions.has(tool.permission));
  }

  /**
   * Runs a read, or records a write as a proposal.
   *
   * The permission check happens here rather than in a guard because the tool decides which
   * permission applies — and doing it in one place means a new tool cannot accidentally arrive
   * ungated.
   */
  async invoke(
    user: AuthenticatedUser,
    input: { prompt: string; tool: string; arguments?: Record<string, unknown> },
  ): Promise<CopilotAction> {
    const tool = findTool(input.tool);
    if (!tool) throw new BadRequestException(`There is no "${input.tool}" tool.`);

    if (!user.permissions.has(tool.permission)) {
      // The same refusal the REST API would give. The Copilot is not a way around RBAC.
      throw new ForbiddenException(
        `${tool.name} needs the "${tool.permission}" permission, which you do not have.`,
      );
    }

    const args = input.arguments ?? {};
    const problems = validateArguments(tool, args);
    if (problems.length > 0) throw new BadRequestException(problems.join(' '));

    const action = await this.actions.save(
      this.actions.create({
        userId: user.id,
        prompt: input.prompt.slice(0, 4_000),
        tool: tool.name,
        arguments: args,
        kind: tool.kind,
        status: CopilotActionStatus.PROPOSED,
      }),
    );

    if (tool.kind === 'WRITE') {
      // Stated, then stopped. The operator sees the number before anything happens.
      const blastRadius = await this.describeBlastRadius(tool, args);
      await this.actions.update(action.id, { blastRadius });
      this.metrics.increment('copilot.write_proposed', { tool: tool.name });
      return this.actions.findOneOrFail({ where: { id: action.id } });
    }

    try {
      const result = await this.executeRead(tool, args);
      await this.actions.update(action.id, {
        status: CopilotActionStatus.EXECUTED,
        result: JSON.stringify(result).slice(0, 2_000),
      });
      this.metrics.increment('copilot.read_executed', { tool: tool.name });
    } catch (error) {
      await this.actions.update(action.id, {
        status: CopilotActionStatus.FAILED,
        error: (error as Error).message.slice(0, 1_000),
      });
    }

    return this.actions.findOneOrFail({ where: { id: action.id } });
  }

  /**
   * Carries out a proposed write, after a person said yes.
   *
   * The permission is checked *again*, against the confirming user. The proposal may have been
   * made by someone else, or the confirmer's role may have changed since — and a confirmation
   * screen is not a place to discover that the check happened five minutes ago.
   */
  async confirm(user: AuthenticatedUser, actionId: string): Promise<CopilotAction> {
    const action = await this.actions.findOne({ where: { id: actionId } });
    if (!action) throw new NotFoundException('That action does not exist.');
    if (action.status !== CopilotActionStatus.PROPOSED) {
      throw new BadRequestException('That action is no longer awaiting confirmation.');
    }

    const tool = action.tool ? findTool(action.tool) : null;
    if (!tool) throw new BadRequestException('That action refers to a tool that no longer exists.');

    if (!user.permissions.has(tool.permission)) {
      throw new ForbiddenException(`Confirming this needs the "${tool.permission}" permission.`);
    }

    try {
      const result = await this.executeWrite(tool, (action.arguments ?? {}) as Record<string, unknown>, user);
      const saved = await this.actions.save({
        ...action,
        status: CopilotActionStatus.CONFIRMED,
        confirmedById: user.id,
        confirmedAt: new Date(),
        result: JSON.stringify(result).slice(0, 2_000),
      });

      this.metrics.increment('copilot.write_confirmed', { tool: tool.name });
      this.logger.log('Copilot write executed after confirmation', {
        actionId: action.id,
        tool: tool.name,
        userId: user.id,
      });
      return saved;
    } catch (error) {
      return this.actions.save({
        ...action,
        status: CopilotActionStatus.FAILED,
        error: (error as Error).message.slice(0, 1_000),
      });
    }
  }

  /**
   * Answers a question asked in plain language (§89).
   *
   * The model's only job is to pick one of the declared tools and its arguments — it never gets to
   * invent an action, because `invoke` will refuse anything not in the registry, and the permission
   * check happens there regardless of what the model chose. That ordering is the whole safety
   * argument: the assistant proposes, the registry and RBAC dispose.
   *
   * With no AI provider configured this returns the tools the user could run instead of guessing.
   * An assistant that cannot understand the question and says so is more useful than one that picks
   * a plausible-looking tool.
   */
  async ask(user: AuthenticatedUser, question: string): Promise<CopilotAnswer> {
    const available = this.tools(user);
    if (available.length === 0) {
      return {
        answered: false,
        message: 'You do not have permission to use any Copilot tool.',
        suggestions: [],
      };
    }

    if (!(await this.ai.isAvailable())) {
      return {
        answered: false,
        message:
          'No AI provider is configured, so I cannot interpret the question. Pick a tool directly — ' +
          'these are the ones you can run.',
        suggestions: available.map((tool) => ({ name: tool.name, description: tool.description })),
      };
    }

    const catalogue = available
      .map((tool) => {
        const params = tool.parameters
          .map((parameter) => `${parameter.name}${parameter.required ? '' : '?'}: ${parameter.type}`)
          .join(', ');
        return `- ${tool.name}(${params}) [${tool.kind}] — ${tool.description}`;
      })
      .join('\n');

    let chosen: { tool?: unknown; arguments?: unknown } | null = null;
    /** Kept so a failure to map can be logged with what the model actually said. */
    let raw: string | null = null;
    /**
     * Set when the provider itself failed rather than the model declining.
     *
     * The two look identical from here — no tool either way — but they are completely different
     * problems: one is "rephrase your question", the other is "the provider is rate-limited and
     * nothing you type will work". Reporting the second as the first sends an operator off
     * rewording a perfectly good question.
     */
    let providerFailure: string | null = null;
    try {
      /*
       * The registry directly, with a system prompt written for this job.
       *
       * `AIGatewayService.decide` builds the customer-support persona: "You are a customer support
       * assistant for an internet service provider. You answer ONLY from the approved knowledge...
       * escalate rather than guess." Handed an admin question and a tool catalogue as "knowledge",
       * a model following that prompt correctly concludes it cannot answer, and escalates. Two
       * different models did exactly that, returning ESCALATE with no answer and no reason — they
       * were obeying the instructions, which were the wrong instructions.
       *
       * Routing an operator's request to a tool is not customer support, so it does not borrow the
       * customer-support prompt. The safety argument is unchanged and lives where it always did:
       * `invoke` accepts nothing outside the registry and re-checks the caller's permission.
       */
      const { result } = await this.registry.decide(
        {
          question,
          history: [],
          knowledge: [{ id: 'tools', title: 'Available tools', content: catalogue }],
        },
        { system: TOOL_ROUTER_SYSTEM, temperature: 0 },
      );

      /*
       * Both fields, because `decide` is answering a different question than we asked it.
       *
       * It is built for customer support: ANSWER when the supplied knowledge covers the question,
       * ESCALATE when it does not. Given a tool catalogue as "knowledge" it often escalates on
       * perfectly answerable questions — while naming the right tool in its reason. Reading both
       * recovers those. The registry and the permission check still gate what actually runs, so a
       * tool name recovered from prose is no less safe than one parsed from JSON.
       */
      raw = [result.answer, result.reason].filter(Boolean).join('\n') || null;
      if (result.answer) chosen = parseToolChoice(result.answer);
    } catch (error) {
      providerFailure = (error as Error).message;
      this.logger.warn('The Copilot could not interpret a question', { error: providerFailure });
    }

    let toolName = typeof chosen?.tool === 'string' ? chosen.tool : null;

    /*
     * Last resort: find a tool the model *named* without wrapping it correctly.
     *
     * Smaller and free-tier models frequently answer the question in prose while mentioning the
     * right tool, or return the JSON fenced, or ignore the envelope entirely. Refusing those is
     * pedantry — the safety of this path does not come from the model's formatting. It comes from
     * `invoke`, which accepts nothing outside the registry and re-checks the caller's permission
     * whatever the model said. So it is safe to read a tool name out of the text, and unhelpful
     * not to.
     */
    if ((!toolName || !findTool(toolName)) && raw) {
      toolName = available.find((tool) => raw!.includes(tool.name))?.name ?? null;
    }

    if (!toolName || !findTool(toolName)) {
      // Logged with what the model actually said. Without this the operator sees "I could not match
      // that" and has no way to tell a bad question from a model that cannot follow the format.
      this.logger.warn('The Copilot could not map an answer onto a tool', {
        question: question.slice(0, 200),
        modelAnswer: raw ? raw.slice(0, 400) : null,
      });

      return {
        answered: false,
        message: providerFailure
          ? `The AI provider did not answer, so I could not interpret that: ${providerFailure} ` +
            'Your question was fine — you can run a tool directly in the meantime.'
          : 'I could not match that to a tool I have. These are the ones available to you.',
        suggestions: available.map((tool) => ({ name: tool.name, description: tool.description })),
      };
    }

    const action = await this.invoke(user, {
      prompt: question,
      tool: toolName,
      arguments: (chosen?.arguments as Record<string, unknown>) ?? {},
    });

    return {
      answered: true,
      message:
        action.kind === 'WRITE'
          ? `That would change something, so nothing has happened yet. ${action.blastRadius ?? ''}`.trim()
          : 'Here is what I found.',
      action,
      suggestions: [],
    };
  }

  async reject(actionId: string): Promise<CopilotAction> {
    const action = await this.actions.findOne({ where: { id: actionId } });
    if (!action) throw new NotFoundException('That action does not exist.');
    return this.actions.save({ ...action, status: CopilotActionStatus.REJECTED });
  }

  async history(limit = 50) {
    const [items, total] = await this.actions.findAndCount({
      order: { createdAt: 'DESC' },
      take: Math.min(limit, 200),
    });
    return { items, total };
  }

  // === execution ================================================================================

  private async executeRead(tool: CopilotTool, args: Record<string, unknown>): Promise<unknown> {
    switch (tool.name) {
      case 'count_groups': {
        const where: Record<string, unknown> = { isActive: true };
        if (args.monitoringState) where.monitoringState = args.monitoringState;
        if (args.automationEnabled !== undefined) where.automationEnabled = args.automationEnabled;
        return { count: await this.groups.count({ where: where as never }) };
      }
      case 'dashboard_summary':
        return this.reports.dashboard(this.window(args));
      case 'top_issues':
        return this.reports.topIssues(this.window(args));
      case 'knowledge_gaps':
        return this.reports.knowledgeGaps(this.window(args));
      case 'open_escalations': {
        const [items, total] = await this.escalations.findAndCount({
          where: { status: EscalationStatus.OPEN },
          order: { createdAt: 'ASC' },
          take: 20,
        });
        return { total, items: items.map((row) => ({ id: row.id, reason: row.reason, since: row.createdAt })) };
      }
      case 'ai_activity':
        return {
          items: await this.activity.aiActivity({
            bucket: args.bucket === 'month' ? 'month' : 'day',
            periods: Number(args.periods ?? 14),
            channelAccountId: args.channelAccountId ? String(args.channelAccountId) : undefined,
          }),
          note: 'messages counts replies; uniqueGroups counts distinct groups. They are not the same figure.',
        };
      case 'support_activity':
        return {
          items: await this.activity.supportActivity({
            bucket: args.bucket === 'month' ? 'month' : 'day',
            periods: Number(args.periods ?? 14),
            channelAccountId: args.channelAccountId ? String(args.channelAccountId) : undefined,
          }),
          note: 'Only messages from registered support members are counted.',
        };
      case 'why_ai_blocked': {
        const days = Number(args.periods ?? 30);
        const now = new Date();
        const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        return {
          items: await this.activity.aiBlocks({ from: new Date(to.getTime() - days * 86_400_000), to }),
          note: 'Recorded decisions from the engine, not estimates.',
        };
      }
      case 'pattern_summary':
        return this.activity.patternSummary();
      default:
        throw new BadRequestException(`${tool.name} is not a read tool.`);
    }
  }

  private async executeWrite(
    tool: CopilotTool,
    args: Record<string, unknown>,
    user: AuthenticatedUser,
  ): Promise<unknown> {
    switch (tool.name) {
      case 'propose_automation_candidate': {
        // Even the "write" is a proposal: this creates a candidate for review, and a candidate has
        // no way to answer a customer. Publishing it is a separate, human act (§86).
        const candidate = await this.candidates.save(
          this.candidates.create({
            title: String(args.title).slice(0, 200),
            rationale: String(args.rationale),
            source: 'AI_SUGGESTED',
            // Cast because TypeORM reads a jsonb column holding an array as the array overload of
            // `create()`; the shapes are validated by the rule evaluator when the rule is published.
            proposedConditions: {
              match: 'ALL',
              conditions: [{ type: ConditionType.CONTAINS, value: String(args.trigger) }],
            } as never,
            proposedActions: [{ type: ActionType.SEND_MESSAGE, value: String(args.reply) }] as never,
            status: CandidateStatus.PENDING,
          }),
        );
        return { candidateId: candidate.id, status: candidate.status };
      }
      case 'set_group_automation': {
        const where: Record<string, unknown> = { isActive: true };
        if (args.monitoringState) where.monitoringState = args.monitoringState;

        const result = await this.groups.update(where as never, {
          automationEnabled: Boolean(args.enabled),
        });
        this.logger.warn('Copilot changed group automation', {
          userId: user.id,
          affected: result.affected ?? 0,
          enabled: Boolean(args.enabled),
        });
        return { affected: result.affected ?? 0 };
      }
      case 'add_knowledge': {
        // A candidate, not an article. It cannot answer anybody until a person converts it, which
        // is the same gate every other route into the knowledge base goes through.
        const candidate = await this.knowledgeCandidates.create(
          { question: String(args.question), context: args.context ? String(args.context) : null },
          user.id,
        );
        return {
          candidateId: candidate.id,
          status: candidate.status,
          note: 'Queued for review. It is not knowledge the AI can use until somebody converts it.',
        };
      }
      case 'add_support_member': {
        const identity = await this.identities.create(
          {
            channelKey: ChannelKey.WHATSAPP,
            phone: String(args.phone),
            displayName: String(args.displayName),
            ...(args.jobRole ? { jobRole: String(args.jobRole) } : {}),
          },
        );
        return {
          identityId: identity.id,
          displayName: identity.displayName,
          note: 'Not retroactive — messages already stored keep the classification they arrived with.',
        };
      }
      case 'set_group_ai': {
        const where: Record<string, unknown> = { isActive: true };
        if (args.monitoringState) where.monitoringState = args.monitoringState;

        const result = await this.groups.update(where as never, { aiEnabled: Boolean(args.enabled) });
        // Logged at warn: this is the switch that decides whether machines talk to customers.
        this.logger.warn('Copilot changed group AI permission', {
          userId: user.id,
          affected: result.affected ?? 0,
          enabled: Boolean(args.enabled),
        });
        return { affected: result.affected ?? 0 };
      }
      default:
        throw new BadRequestException(`${tool.name} is not a write tool.`);
    }
  }

  /**
   * How much a proposed write would touch, in a sentence.
   *
   * Computed before confirmation, from the same filter the write will use — so the number an
   * operator agrees to is the number that happens, not an estimate.
   */
  private async describeBlastRadius(tool: CopilotTool, args: Record<string, unknown>): Promise<string> {
    if (tool.name === 'set_group_automation') {
      const where: Record<string, unknown> = { isActive: true };
      if (args.monitoringState) where.monitoringState = args.monitoringState;

      const count = await this.groups.count({ where: where as never });
      return `This turns automation ${args.enabled ? 'ON' : 'OFF'} for ${count} group${count === 1 ? '' : 's'}.`;
    }

    if (tool.name === 'set_group_ai') {
      const where: Record<string, unknown> = { isActive: true };
      if (args.monitoringState) where.monitoringState = args.monitoringState;

      const count = await this.groups.count({ where: where as never });
      return args.enabled
        ? `This allows AI to reply in ${count} group${count === 1 ? '' : 's'}. Each still has to pass ` +
            'every other check — the profile, monitoring, the emergency control and a connected session.'
        : `This stops AI replying in ${count} group${count === 1 ? '' : 's'}. Disabling is absolute: no ` +
            'AI reply can reach them afterwards, whatever else is enabled. Messages are still collected.';
    }

    if (tool.name === 'add_knowledge') {
      return 'This queues a question for review. It cannot answer anybody until somebody converts it.';
    }

    if (tool.name === 'add_support_member') {
      return (
        'This registers a colleague so their future replies count as human support. It does not ' +
        'reclassify messages already stored.'
      );
    }

    if (tool.name === 'propose_automation_candidate') {
      return 'This creates a proposal for review. It cannot answer a customer until somebody publishes it.';
    }

    return 'This makes a change.';
  }

  private window(args: Record<string, unknown>) {
    const from = typeof args.fromIso === 'string' ? new Date(args.fromIso) : null;
    const to = typeof args.toIso === 'string' ? new Date(args.toIso) : null;

    if (from && !Number.isNaN(from.getTime())) {
      return { from, to: to && !Number.isNaN(to.getTime()) ? to : new Date() };
    }
    return defaultWindow();
  }
}


/**
 * Reads a tool choice out of whatever the model returned.
 *
 * The contract asks for `{"tool":..,"arguments":{..}}` in the answer field. Models comply loosely:
 * some fence it in ```json, some return the object already parsed, some wrap it in prose. Each of
 * those is the right choice expressed badly, and rejecting them wastes a correct answer.
 *
 * Returns null when nothing usable is found — the caller then falls back to naming the tools, which
 * is more honest than guessing at one.
 */
function parseToolChoice(answer: string): { tool?: unknown; arguments?: unknown } | null {
  const attempt = (text: string) => {
    try {
      const parsed = JSON.parse(text) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as { tool?: unknown }) : null;
    } catch {
      return null;
    }
  };

  const direct = attempt(answer.trim());
  if (direct?.tool) return direct;

  // A fenced block, with or without a language tag.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(answer);
  if (fenced) {
    const inner = attempt(fenced[1].trim());
    if (inner?.tool) return inner;
  }

  // The first balanced-looking object in a prose reply.
  const braced = /\{[\s\S]*\}/.exec(answer);
  if (braced) {
    const inner = attempt(braced[0]);
    if (inner?.tool) return inner;
  }

  return null;
}


/**
 * The system prompt for routing an operator's request to a tool.
 *
 * Deliberately not the customer-support prompt. This model is not talking to a customer, is not
 * quoting policy, and has no reason to be told about prices or escalation — it is choosing one
 * name from a list. Telling it otherwise is what made it refuse.
 *
 * It is still told to decline rather than guess, because a wrong tool wastes the operator's time
 * and, for a WRITE tool, puts a change in front of them they did not ask for. Declining is cheap;
 * the caller falls back to showing the catalogue.
 */
const TOOL_ROUTER_SYSTEM = [
  'You route an administrator request to exactly one tool from a supplied catalogue.',
  'You are not answering a customer. You are not writing prose.',
  '',
  'Set decision to ANSWER. Set answer to a JSON object, encoded as a string, with two keys:',
  'a tool key holding the tool name, and an arguments key holding an object of its arguments.',
  '',
  'Rules:',
  '- Use a tool name exactly as it appears in the catalogue.',
  '- Include only arguments the catalogue declares for that tool.',
  '- Omit any argument the administrator did not supply. Never invent values.',
  '- If no tool in the catalogue fits, set decision to ESCALATE and give a short reason.',
  '- Choosing a tool does not run it. A change is shown to the administrator first.',
].join('\n');
