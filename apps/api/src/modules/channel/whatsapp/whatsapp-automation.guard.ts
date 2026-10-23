import { Injectable } from '@nestjs/common';
import { AppLogger } from '../../../common/logging/app-logger';
import { GatewayError } from './gateway-error';
import { GoWaClient } from './gowa.client';

export interface AutomationGuardResult {
  /** False when the gateway holds active autoreply rules for this session. */
  safe: boolean;
  /** Null when the check could not run — an unreachable gateway is unknown, not safe. */
  activeRuleCount: number | null;
  ruleNames: string[];
  detail: string;
}

/** Verifies the managed deployment policy; the provider has no remote auto-reply config probe. */
@Injectable()
export class WhatsAppAutomationGuard {
  private readonly logger = new AppLogger(WhatsAppAutomationGuard.name);

  constructor(private readonly client: GoWaClient) {}

  async check(sessionId: string | null): Promise<AutomationGuardResult> {
    if(this.client.autonomousReplyDisabled!==true)return {safe:false,activeRuleCount:null,ruleNames:[],detail:'Configure the managed Go WhatsApp deployment with autonomous replies disabled before connecting CRM accounts.'};
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
          detail: 'Managed gateway deployment declares autonomous replies disabled; CRM controls automation. This is a deployment-policy check, not a remote configuration probe.',
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
      if (error instanceof GatewayError && (error.status === 404 || error.status === 400)) {
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
