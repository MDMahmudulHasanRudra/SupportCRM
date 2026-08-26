import { Injectable } from '@nestjs/common';
import { AppLogger } from '../../../common/logging/app-logger';
import { OpenWaClient, OpenWaError } from './openwa.client';

export interface AutomationGuardResult {
  /** False when the gateway holds active autoreply rules for this session. */
  safe: boolean;
  /** Null when the check could not run — an unreachable gateway is unknown, not safe. */
  activeRuleCount: number | null;
  ruleNames: string[];
  detail: string;
}

/**
 * Refuses to operate a gateway session that is also autoreplying on its own (Phase 2 brief §13).
 *
 * The vendored gateway ships `src/modules/automation/` — a per-session autoreply engine that
 * evaluates every inbound message and **sends a reply directly through its own send path**. If a
 * rule were ever configured on a session Support CRM owns, a customer would receive two answers to
 * one question: the gateway's canned reply, and later whatever the Message Decision Engine decided.
 * Both would be sent, neither would know about the other, and no amount of care on our side of the
 * boundary would prevent it (`docs/adr/0001` §6).
 *
 * The protection is threefold:
 *  1. **`OpenWaClient` has no method to create, update or enable a rule.** Only `listAutomationRules`
 *     exists. The capability is absent from the codebase, so it cannot be reached by accident.
 *  2. **This guard reads the gateway's rules** and reports whether any is enabled.
 *  3. **Existing rules are never modified.** The brief is explicit — do not silently change a
 *     customer's system. We detect, refuse, and tell the operator; the decision to delete a rule
 *     stays theirs.
 *
 * An unreachable gateway yields `safe: false` with `activeRuleCount: null`. Treating "I could not
 * check" as "it is fine" is precisely the failure this guard exists to prevent.
 */
@Injectable()
export class WhatsAppAutomationGuard {
  private readonly logger = new AppLogger(WhatsAppAutomationGuard.name);

  constructor(private readonly client: OpenWaClient) {}

  async check(sessionId: string | null): Promise<AutomationGuardResult> {
    // No session yet means nothing can be autoreplying on it. This is the normal state between
    // registering an account and connecting it.
    if (!sessionId) {
      return {
        safe: true,
        activeRuleCount: 0,
        ruleNames: [],
        detail: 'No gateway session exists for this account yet; no automation rules can apply.',
      };
    }

    try {
      const rules = await this.client.listAutomationRules(sessionId);
      const active = (rules ?? []).filter((rule) => rule?.enabled);

      if (active.length === 0) {
        return {
          safe: true,
          activeRuleCount: 0,
          ruleNames: [],
          detail: 'No gateway automation rules are enabled for this session.',
        };
      }

      const names = active.map((rule) => String(rule.name ?? rule.id).slice(0, 120));
      this.logger.warn('Gateway automation rules are active on a Support CRM session', {
        sessionId,
        activeRuleCount: active.length,
        ruleNames: names,
      });

      return {
        safe: false,
        activeRuleCount: active.length,
        ruleNames: names,
        detail:
          `${active.length} gateway autoreply rule(s) are enabled on this session. ` +
          'The gateway would reply to customers independently of Support CRM, producing duplicate ' +
          'and contradictory answers. Disable them on the gateway before using this account. ' +
          'Support CRM will not modify them for you.',
      };
    } catch (error) {
      // 400 as well as 404 — see the note in whatsapp.adapter.ts on the gateway's uuid validation.
      if (error instanceof OpenWaError && (error.status === 404 || error.status === 400)) {
        // No such session yet — nothing can be autoreplying on it.
        return {
          safe: true,
          activeRuleCount: 0,
          ruleNames: [],
          detail: 'Session does not exist on the gateway yet; no automation rules can apply.',
        };
      }

      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('Could not verify gateway automation rules', { sessionId, error: message });
      return {
        safe: false,
        activeRuleCount: null,
        ruleNames: [],
        detail: `Could not verify gateway automation state (${message}). Treating as unsafe.`,
      };
    }
  }
}
