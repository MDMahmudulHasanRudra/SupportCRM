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
    private readonly ai: AIGatewayService,
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
    try {
      const { result } = await this.ai.decide({
        question,
        history: [],
        // The tool catalogue is passed as knowledge, which means the same no-invention rules apply
        // to it: answer only from what is supplied, escalate rather than guess.
        knowledge: [{ id: 'tools', title: 'Available tools', content: catalogue }],
        guidance:
          'You are choosing ONE tool from the list to answer the administrator. Reply with JSON ' +
          'whose "answer" field is itself JSON of the form {"tool":"<name>","arguments":{...}}. ' +
          'Use only a tool from the list and only its declared arguments. If none fits, set ' +
          'decision to ESCALATE.',
      });

      if (result.decision === 'ANSWER' && result.answer) {
        chosen = JSON.parse(result.answer) as { tool?: unknown; arguments?: unknown };
      }
    } catch (error) {
      this.logger.warn('The Copilot could not interpret a question', {
        error: (error as Error).message,
      });
    }

    const toolName = typeof chosen?.tool === 'string' ? chosen.tool : null;
    if (!toolName || !findTool(toolName)) {
      return {
        answered: false,
        message: 'I could not match that to a tool I have. These are the ones available to you.',
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
