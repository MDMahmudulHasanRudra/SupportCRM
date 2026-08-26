import { NotFoundException } from '@nestjs/common';
import { GroupAiStatusService } from './group-ai-status.service';
import { GroupMonitoringState } from './entities/group.entity';
import { EMERGENCY_STOPS } from '../settings/settings.service';

/**
 * The group AI status endpoint: what the console tells an operator about why AI is on or off.
 *
 * This is diagnosis, not enforcement — the engine gates on its own per-message permission and never
 * consults this. What these tests protect is that the *explanation* is correct and complete: every
 * condition holding AI back is reported, the most specific one is the one named, and a permitted
 * group is not reported as blocked (or the reverse), because an operator acting on a wrong
 * explanation changes the wrong switch.
 */

const GROUP_ID = 'g1';

function build(options: {
  group?: Partial<{
    aiEnabled: boolean;
    automationEnabled: boolean;
    patternAnalysisEnabled: boolean;
    monitoringState: GroupMonitoringState;
    automationProfileId: string | null;
    knowledgeProfileId: string | null;
  }>;
  profile?: { id: string; name: string; aiEnabled: boolean; automationEnabled: boolean } | null;
  accountStatus?: string;
  aiPaused?: boolean;
  automationPaused?: boolean;
  missing?: boolean;
}) {
  const group = options.missing
    ? null
    : {
        id: GROUP_ID,
        channelAccountId: 'a1',
        aiEnabled: true,
        automationEnabled: true,
        patternAnalysisEnabled: true,
        monitoringState: GroupMonitoringState.MONITORED,
        automationProfileId: options.profile ? options.profile.id : null,
        knowledgeProfileId: null,
        ...options.group,
      };

  return new GroupAiStatusService(
    { findOne: jest.fn(async () => group) } as never,
    { findOne: jest.fn(async () => options.profile ?? null) } as never,
    { findOne: jest.fn(async () => ({ status: options.accountStatus ?? 'CONNECTED' })) } as never,
    {
      isStopped: jest.fn(async (key: string) =>
        key === EMERGENCY_STOPS.ALL_AI_PAUSED
          ? (options.aiPaused ?? false)
          : (options.automationPaused ?? false),
      ),
    } as never,
  );
}

describe('group AI status', () => {
  it('reports a fully permitted group as able to reply', async () => {
    const status = await build({}).forGroup(GROUP_ID);

    expect(status.canReply).toBe(true);
    expect(status.blockedBy).toEqual([]);
    expect(status.primaryBlocker).toBeNull();
    // The permitted sentence must not promise a reply — rules and confidence still decide.
    expect(status.explanation).toContain('depends on the rules');
  });

  describe('each layer that can withhold AI', () => {
    it('names the group when the group has AI off', async () => {
      const status = await build({ group: { aiEnabled: false } }).forGroup(GROUP_ID);

      expect(status.canReply).toBe(false);
      expect(status.blockedBy).toEqual(['AI_DISABLED_GROUP']);
      expect(status.explanation).toBe('AI is off because this group has AI switched off.');
    });

    it('names the profile when a profile withholds AI from a permitted group', async () => {
      const status = await build({
        group: { aiEnabled: true },
        profile: { id: 'p1', name: 'Careful', aiEnabled: false, automationEnabled: true },
      }).forGroup(GROUP_ID);

      expect(status.canReply).toBe(false);
      expect(status.blockedBy).toEqual(['AI_DISABLED_PROFILE']);
    });

    it('reports monitoring off as a reason there is nothing to answer', async () => {
      const status = await build({
        group: { monitoringState: GroupMonitoringState.UNMONITORED },
      }).forGroup(GROUP_ID);

      expect(status.blockedBy).toEqual(['MONITORING_DISABLED']);
      expect(status.monitoring.collecting).toBe(false);
    });

    it('reports the system-wide AI emergency stop', async () => {
      const status = await build({ aiPaused: true }).forGroup(GROUP_ID);

      expect(status.canReply).toBe(false);
      expect(status.blockedBy).toContain('EMERGENCY_STOP');
    });

    it('reports the system-wide automation emergency stop', async () => {
      const status = await build({ automationPaused: true }).forGroup(GROUP_ID);

      expect(status.blockedBy).toContain('AUTOMATION_DISABLED');
    });

    it('reports a disconnected WhatsApp session', async () => {
      const status = await build({ accountStatus: 'DISCONNECTED' }).forGroup(GROUP_ID);

      expect(status.canReply).toBe(false);
      expect(status.blockedBy).toContain('SESSION_NOT_READY');
      expect(status.session.ready).toBe(false);
    });
  });

  describe('completeness of the explanation', () => {
    it('lists every blocker, not only the first', async () => {
      // Telling an operator to switch the group back on is half the truth when the emergency stop
      // is engaged too — they would flip the switch and see nothing change.
      const status = await build({
        group: { aiEnabled: false, monitoringState: GroupMonitoringState.UNMONITORED },
        aiPaused: true,
        accountStatus: 'DISCONNECTED',
      }).forGroup(GROUP_ID);

      expect(status.blockedBy).toEqual([
        'EMERGENCY_STOP',
        'SESSION_NOT_READY',
        'MONITORING_DISABLED',
        'AI_DISABLED_GROUP',
      ]);
    });

    it('names the most specific blocker as the one to act on', async () => {
      const status = await build({
        group: { aiEnabled: false },
        aiPaused: true,
      }).forGroup(GROUP_ID);

      // The group switch is closer to this group than the system-wide stop.
      expect(status.primaryBlocker).toBe('AI_DISABLED_GROUP');
    });

    it('keeps canReply consistent with blockedBy in every case', async () => {
      const cases = [
        {},
        { group: { aiEnabled: false } },
        { aiPaused: true },
        { accountStatus: 'DISCONNECTED' },
        { group: { monitoringState: GroupMonitoringState.UNMONITORED } },
        { profile: { id: 'p', name: 'n', aiEnabled: false, automationEnabled: true } },
      ];

      for (const options of cases) {
        const status = await build(options).forGroup(GROUP_ID);
        expect(status.canReply).toBe(status.blockedBy.length === 0);
        expect(status.primaryBlocker === null).toBe(status.canReply);
      }
    });
  });

  describe('honesty about scope', () => {
    it('states that conversations may still have AI off', async () => {
      // `canReply: true` must not be read as "every conversation here gets an AI reply".
      const status = await build({}).forGroup(GROUP_ID);
      expect(status.scope).toContain('conversations');
    });

    it('separates pattern analysis from AI permission', async () => {
      // A group can contribute patterns while being forbidden an automated reply.
      const status = await build({
        group: { aiEnabled: false, patternAnalysisEnabled: true },
      }).forGroup(GROUP_ID);

      expect(status.canReply).toBe(false);
      expect(status.group.patternAnalysisEnabled).toBe(true);
    });

    it('404s rather than reporting a permissive default for a missing group', async () => {
      await expect(build({ missing: true }).forGroup(GROUP_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
