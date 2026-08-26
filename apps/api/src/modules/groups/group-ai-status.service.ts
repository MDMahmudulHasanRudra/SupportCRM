import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AutomationProfile } from '../automation/entities/automation-profile.entity';
import { ChannelAccount } from '../channel/entities/channel-account.entity';
import { ChannelConnectionState } from '../channel/channel-connection';
import { composePermission } from '../decision/permission-chain';
import { EMERGENCY_STOPS, SettingsService } from '../settings/settings.service';
import { Group, GroupMonitoringState } from './entities/group.entity';

/**
 * Why AI can or cannot reply in one group.
 *
 * ## This explains a decision; it never makes one
 *
 * The engine gates on its own composed permission, built per message. Nothing here is consulted
 * before sending, and a caller that treated this as authorisation would be reading a description as
 * a permission. It exists so an operator gets "AI is off because the group has it off" instead of a
 * greyed-out switch with no explanation.
 *
 * It composes the layers with the same {@link composePermission} the engine uses, so the console
 * and the engine cannot give different answers about the same group.
 *
 * ## What it deliberately cannot tell you
 *
 * A group is not a conversation. Individual conversations inside this group may have AI switched
 * off on their own, and this endpoint does not know about them — reporting `canReply: true` here
 * means "nothing at the group level or above forbids it", not "every conversation will get an AI
 * reply". The response says so in `scope` rather than leaving the reader to assume the stronger
 * claim.
 */

export type AiBlocker =
  | 'EMERGENCY_STOP'
  | 'AI_DISABLED_GROUP'
  | 'AI_DISABLED_PROFILE'
  | 'MONITORING_DISABLED'
  | 'AUTOMATION_DISABLED'
  | 'SESSION_NOT_READY';

export interface GroupAiStatus {
  groupId: string;
  /** What this answer covers, so `canReply` is not mistaken for a per-conversation guarantee. */
  scope: string;

  monitoring: { state: string; collecting: boolean };
  group: { aiEnabled: boolean; automationEnabled: boolean; patternAnalysisEnabled: boolean };
  profile: { id: string; name: string; aiEnabled: boolean; automationEnabled: boolean } | null;
  system: { aiPaused: boolean; automationPaused: boolean };
  session: { status: string; ready: boolean };
  knowledge: { profileId: string | null };

  /** True when nothing at group level or above forbids an AI reply. */
  canReply: boolean;
  /** Every reason AI is held back, most specific last. Empty when it can reply. */
  blockedBy: AiBlocker[];
  /** The one an operator should act on first, and a sentence naming it. */
  primaryBlocker: AiBlocker | null;
  explanation: string;
}

@Injectable()
export class GroupAiStatusService {
  constructor(
    @InjectRepository(Group) private readonly groups: Repository<Group>,
    @InjectRepository(AutomationProfile) private readonly profiles: Repository<AutomationProfile>,
    @InjectRepository(ChannelAccount) private readonly accounts: Repository<ChannelAccount>,
    private readonly settings: SettingsService,
  ) {}

  async forGroup(groupId: string): Promise<GroupAiStatus> {
    const group = await this.groups.findOne({ where: { id: groupId } });
    if (!group) throw new NotFoundException(`Group ${groupId} not found`);

    const [profile, account, aiPaused, automationPaused] = await Promise.all([
      group.automationProfileId
        ? this.profiles.findOne({ where: { id: group.automationProfileId } })
        : Promise.resolve(null),
      this.accounts.findOne({ where: { id: group.channelAccountId } }),
      this.settings.isStopped(EMERGENCY_STOPS.ALL_AI_PAUSED),
      this.settings.isStopped(EMERGENCY_STOPS.ALL_AUTOMATION_PAUSED),
    ]);

    // The AI permission across the layers a group can see. `conversation: true` because there is no
    // conversation in scope here — the engine still applies the real one per message.
    const aiChain = composePermission({
      conversation: true,
      group: group.aiEnabled,
      profile: profile ? profile.aiEnabled : null,
    });

    const sessionReady = account?.status === ChannelConnectionState.CONNECTED;
    const collecting = group.monitoringState === GroupMonitoringState.MONITORED;

    /*
     * Ordered general → specific, so the list reads down the hierarchy and the *last* entry is the
     * switch closest to this group — the one worth changing first.
     *
     * Every condition is reported, not just the first. An operator who turns the group's AI back on
     * only to find the emergency stop still engaged has been told half the truth.
     */
    const blockedBy: AiBlocker[] = [];
    if (aiPaused) blockedBy.push('EMERGENCY_STOP');
    if (!sessionReady) blockedBy.push('SESSION_NOT_READY');
    if (automationPaused) blockedBy.push('AUTOMATION_DISABLED');
    if (aiChain.blockedBy.includes('PROFILE')) blockedBy.push('AI_DISABLED_PROFILE');
    if (!collecting) blockedBy.push('MONITORING_DISABLED');
    if (aiChain.blockedBy.includes('GROUP')) blockedBy.push('AI_DISABLED_GROUP');

    const blocker = blockedBy.length === 0 ? null : blockedBy[blockedBy.length - 1];

    return {
      groupId: group.id,
      scope:
        'Group level and above. Individual conversations in this group may still have AI switched off.',
      monitoring: { state: group.monitoringState, collecting },
      group: {
        aiEnabled: group.aiEnabled,
        automationEnabled: group.automationEnabled,
        patternAnalysisEnabled: group.patternAnalysisEnabled,
      },
      profile: profile
        ? {
            id: profile.id,
            name: profile.name,
            aiEnabled: profile.aiEnabled,
            automationEnabled: profile.automationEnabled,
          }
        : null,
      system: { aiPaused, automationPaused },
      session: { status: account?.status ?? 'UNKNOWN', ready: sessionReady },
      knowledge: { profileId: group.knowledgeProfileId },
      canReply: blockedBy.length === 0,
      blockedBy,
      primaryBlocker: blocker,
      explanation: blocker ? EXPLANATION[blocker] : PERMITTED,
    };
  }
}

const PERMITTED =
  'AI can reply in this group. Whether it does depends on the rules and confidence thresholds for each message.';

/**
 * One sentence per blocker, naming the switch rather than restating the state.
 *
 * "AI is disabled" tells an operator nothing they cannot see; "the group has AI switched off" tells
 * them which control to change.
 */
const EXPLANATION: Record<AiBlocker, string> = {
  AI_DISABLED_GROUP: 'AI is off because this group has AI switched off.',
  AI_DISABLED_PROFILE: 'AI is off because the automation profile applied to this group has AI switched off.',
  MONITORING_DISABLED:
    'AI is off because messages from this group are not being collected, so there is nothing for it to answer.',
  AUTOMATION_DISABLED: 'AI is off because automation is paused system-wide by the emergency control.',
  EMERGENCY_STOP: 'AI is off because AI is paused system-wide by the emergency control.',
  SESSION_NOT_READY:
    'AI cannot reply because this WhatsApp account is not connected. Nothing can be sent until it reconnects.',
};
