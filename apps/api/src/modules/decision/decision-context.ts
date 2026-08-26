import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { SettingsService } from '../settings/settings.service';
import { AutomationProfile } from '../automation/entities/automation-profile.entity';
import { AutomationRule } from '../automation/entities/automation-rule.entity';
import {
  AutomationStatus,
  RuleScopeType,
  type EvaluableRule,
} from '../automation/automation-types';
import { Conversation } from '../crm/entities/conversation.entity';
import { Group } from '../groups/entities/group.entity';
import { Message } from '../messaging/entities/message.entity';
import { MidConfidencePolicy, type ConfidenceThresholds } from './decision-policy';
import { composePermission, type PermissionChain } from './permission-chain';

/**
 * Everything the engine is allowed to know about one message.
 *
 * Assembled once, up front, so the pipeline reads as a sequence of decisions rather than a sequence
 * of database calls — and so the dry-run endpoint can build the same shape from hypothetical input.
 *
 * What is deliberately absent: any credential, any provider configuration, any channel or gateway
 * detail. The engine works in conversations, messages and identities.
 */

export interface DecisionContext {
  message: Message;
  conversation: Conversation;
  group: Group | null;
  profile: AutomationProfile | null;
  /** Rules in scope, unsorted — the evaluator applies the ordering. */
  rules: EvaluableRule[];
  thresholds: ConfidenceThresholds;
  /** Effective switches after profile and per-entity overrides. */
  automationEnabled: boolean;
  aiEnabled: boolean;
  /**
   * The same two switches, with the layers that produced them.
   *
   * `aiChain.effective === aiEnabled` by construction — the boolean is read off the chain rather
   * than computed beside it, so the console's explanation can never contradict the engine's gate.
   */
  automationChain: PermissionChain;
  aiChain: PermissionChain;
  customerTags: string[];
  now: Date;
}

/** Defaults when nothing overrides them. Settings can change these without a deployment. */
const DEFAULT_AUTO_REPLY_MIN = 0.9;
const DEFAULT_ESCALATE_BELOW = 0.8;

export const DECISION_SETTINGS = {
  AUTO_REPLY_MIN_CONFIDENCE: 'ai.auto_reply_min_confidence',
  ESCALATE_BELOW_CONFIDENCE: 'ai.escalate_below_confidence',
  MID_CONFIDENCE_POLICY: 'ai.mid_confidence_policy',
  MAX_HISTORY_MESSAGES: 'ai.max_history_messages',
  MAX_KNOWLEDGE_CHUNKS: 'ai.max_knowledge_chunks',
  MAX_CONTEXT_CHARS: 'ai.max_context_chars',
  AUTO_REPLIES_PER_CONVERSATION: 'automation.auto_replies_per_conversation',
  AUTO_REPLY_WINDOW_SECONDS: 'automation.auto_reply_window_seconds',
  REPEAT_SUPPRESSION_SECONDS: 'automation.repeat_suppression_seconds',
} as const;

@Injectable()
export class DecisionContextBuilder {
  constructor(
    @InjectRepository(AutomationRule) private readonly rules: Repository<AutomationRule>,
    @InjectRepository(AutomationProfile) private readonly profiles: Repository<AutomationProfile>,
    @InjectRepository(Group) private readonly groups: Repository<Group>,
    private readonly settings: SettingsService,
  ) {}

  async build(message: Message, conversation: Conversation): Promise<DecisionContext> {
    const group = message.groupId
      ? await this.groups.findOne({ where: { id: message.groupId } })
      : null;

    const profile = await this.resolveProfile(conversation, group);
    const rules = await this.loadRules(conversation, group);
    const thresholds = await this.resolveThresholds(profile);

    /*
     * Effective switches.
     *
     * Most specific wins, and a `false` anywhere in the chain is decisive: a group with automation
     * switched off must not have it switched back on by a profile. The switches are permissions to
     * act, and every level can withhold one.
     */
    const automationChain = composePermission({
      conversation: conversation.automationEnabled,
      // `null`, not `true`: a direct chat has no group, and absence is not consent-by-default —
      // it is simply a layer that does not apply here.
      group: group ? group.automationEnabled : null,
      profile: profile ? profile.automationEnabled : null,
    });

    const aiChain = composePermission({
      conversation: conversation.aiEnabled,
      group: group ? group.aiEnabled : null,
      profile: profile ? profile.aiEnabled : null,
    });

    const automationEnabled = automationChain.effective;
    const aiEnabled = aiChain.effective;

    return {
      message,
      conversation,
      group,
      profile,
      rules,
      thresholds,
      automationEnabled,
      aiEnabled,
      automationChain,
      aiChain,
      customerTags: [],
      now: new Date(),
    };
  }

  /** Conversation → customer → group → none. The most specific binding wins. */
  private async resolveProfile(
    conversation: Conversation,
    group: Group | null,
  ): Promise<AutomationProfile | null> {
    const candidates = [conversation.automationProfileId, group?.automationProfileId].filter(
      (id): id is string => Boolean(id),
    );

    for (const id of candidates) {
      const profile = await this.profiles.findOne({ where: { id, status: AutomationStatus.ACTIVE } });
      if (profile) return profile;
    }
    return null;
  }

  /**
   * Rules that could apply to this message.
   *
   * Loaded by scope rather than "all active rules": at the specified scale a global fetch would
   * pull thousands of rows into memory for every inbound message. The evaluator then orders what
   * comes back.
   */
  private async loadRules(conversation: Conversation, group: Group | null): Promise<EvaluableRule[]> {
    const scoped: Array<{ scopeType: RuleScopeType; scopeId: string }> = [
      { scopeType: RuleScopeType.CONVERSATION, scopeId: conversation.id },
    ];
    if (conversation.customerId) {
      scoped.push({ scopeType: RuleScopeType.CUSTOMER, scopeId: conversation.customerId });
    }
    if (group) scoped.push({ scopeType: RuleScopeType.GROUP, scopeId: group.id });

    const rows = await this.rules.find({
      where: [
        { status: AutomationStatus.ACTIVE, scopeType: RuleScopeType.GLOBAL, scopeId: IsNull() },
        ...scoped.map((scope) => ({
          status: AutomationStatus.ACTIVE,
          scopeType: scope.scopeType,
          scopeId: scope.scopeId,
        })),
      ],
      take: 500,
    });

    return rows.map(toEvaluable);
  }

  /**
   * Thresholds, most specific first: profile override → global setting → code default.
   *
   * Never hardcoded at the point of use (brief §15). A profile states only what it changes.
   */
  async resolveThresholds(profile: AutomationProfile | null): Promise<ConfidenceThresholds> {
    const autoReplyMin =
      numeric(profile?.autoReplyMinConfidence) ??
      (await this.settings.get<number>(DECISION_SETTINGS.AUTO_REPLY_MIN_CONFIDENCE, DEFAULT_AUTO_REPLY_MIN));

    const escalateBelow =
      numeric(profile?.escalateBelowConfidence) ??
      (await this.settings.get<number>(DECISION_SETTINGS.ESCALATE_BELOW_CONFIDENCE, DEFAULT_ESCALATE_BELOW));

    const configured =
      profile?.midConfidencePolicy ??
      (await this.settings.get<string>(DECISION_SETTINGS.MID_CONFIDENCE_POLICY, MidConfidencePolicy.ESCALATE));

    const midPolicy = Object.values(MidConfidencePolicy).includes(configured as MidConfidencePolicy)
      ? (configured as MidConfidencePolicy)
      : MidConfidencePolicy.ESCALATE;

    return {
      autoReplyMin: clamp(Number(autoReplyMin), DEFAULT_AUTO_REPLY_MIN),
      escalateBelow: clamp(Number(escalateBelow), DEFAULT_ESCALATE_BELOW),
      midPolicy,
    };
  }

  /** Rules for a dry run, by scope, without needing a real message. */
  async loadRulesForScope(scope: { conversationId?: string; customerId?: string; groupId?: string }) {
    const where: Array<Record<string, unknown>> = [
      { status: AutomationStatus.ACTIVE, scopeType: RuleScopeType.GLOBAL, scopeId: IsNull() },
    ];
    if (scope.conversationId) {
      where.push({ status: AutomationStatus.ACTIVE, scopeType: RuleScopeType.CONVERSATION, scopeId: scope.conversationId });
    }
    if (scope.customerId) {
      where.push({ status: AutomationStatus.ACTIVE, scopeType: RuleScopeType.CUSTOMER, scopeId: scope.customerId });
    }
    if (scope.groupId) {
      where.push({ status: AutomationStatus.ACTIVE, scopeType: RuleScopeType.GROUP, scopeId: scope.groupId });
    }

    const rows = await this.rules.find({ where: where as never, take: 500 });
    return rows.map(toEvaluable);
  }

  /** Rules by explicit id, for testing one rule in isolation. */
  async loadRulesByIds(ids: string[]): Promise<EvaluableRule[]> {
    if (ids.length === 0) return [];
    const rows = await this.rules.find({ where: { id: In(ids) } });
    return rows.map(toEvaluable);
  }
}

export function toEvaluable(rule: AutomationRule): EvaluableRule {
  return {
    id: rule.id,
    name: rule.name,
    status: rule.status,
    priority: rule.priority,
    scopeType: rule.scopeType,
    scopeId: rule.scopeId,
    version: rule.currentVersion,
    conditions: rule.conditions,
    actions: rule.actions,
    cooldownSeconds: rule.cooldownSeconds,
    maxExecutions: rule.maxExecutions,
    executionCount: rule.executionCount,
    lastMatchedAt: rule.lastMatchedAt,
    effectiveFrom: rule.effectiveFrom,
    effectiveUntil: rule.effectiveUntil,
    createdAt: rule.createdAt,
  };
}

/** pg returns `numeric` as a string; null and unparseable both mean "not set". */
function numeric(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) return fallback;
  return value;
}
