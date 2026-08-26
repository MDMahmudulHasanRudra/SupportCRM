import { GroupKnowledgeHarvestService } from './group-knowledge-harvest.service';
import { CandidateSource, KnowledgeScopeType } from './knowledge-types';

/**
 * Harvesting knowledge candidates from group messages.
 *
 * The rule worth protecting is consent: **a group that has not opted in contributes nothing.** It
 * is enforced in the SQL rather than in the caller, so no future code path — a job, an endpoint, a
 * refactor — can harvest a group that withheld permission by forgetting to check first.
 *
 * Verified against real rows as well: two groups with identical message content, one opted in and
 * one not, and the gated query reached only the group that opted in while the ungated version
 * reached both.
 */

function service(options: { groupCount?: number; rows?: Array<Record<string, unknown>> } = {}) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const created: Array<Record<string, unknown>> = [];

  const groups = {
    count: jest.fn(async () => options.groupCount ?? 1),
    manager: {
      query: jest.fn(async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        return options.rows ?? [];
      }),
    },
  };

  const candidates = {
    create: jest.fn(async (input: Record<string, unknown>) => {
      created.push(input);
      return { id: 'c1', occurrences: 1, ...input };
    }),
  };

  return {
    instance: new GroupKnowledgeHarvestService(groups as never, candidates as never),
    queries,
    created,
    groups,
  };
}

const ROW = {
  normalised: 'how do i reset my password',
  occurrences: '4',
  sample: 'How do I reset my password?',
  group_id: 'g1',
  group_name: 'Billing Help',
};

describe('group knowledge harvesting', () => {
  describe('consent is enforced in SQL', () => {
    it('requires the group to have opted in to knowledge contribution', async () => {
      const { instance, queries } = service();
      await instance.harvest();

      expect(queries[0].sql).toContain('g."knowledgeContributionEnabled" = true');
    });

    it('also requires pattern analysis, because they are separate permissions', async () => {
      // Counting that a question repeats and proposing its content as an answer are different
      // things to permit. A group may reasonably grant one and withhold the other.
      const { instance, queries } = service();
      await instance.harvest();

      expect(queries[0].sql).toContain('g."patternAnalysisEnabled" = true');
    });

    it('does nothing at all when no group has opted in', async () => {
      // Short-circuits before touching the message table — there is nothing it could legitimately
      // find, and scanning for it would be wasted work.
      const { instance, queries } = service({ groupCount: 0 });
      const result = await instance.harvest();

      expect(result).toEqual({ groupsConsidered: 0, questionsFound: 0, created: 0, updated: 0 });
      expect(queries).toHaveLength(0);
    });

    it('never joins in a way that could include a group without a row', async () => {
      // An outer join to `groups` would let a null-group message through the flag check, which is
      // how a direct chat could quietly bypass consent.
      const { instance, queries } = service();
      await instance.harvest();

      expect(queries[0].sql).toContain('JOIN groups g ON g.id = m."groupId"');
      expect(queries[0].sql).not.toContain('LEFT JOIN groups');
    });
  });

  describe('what it produces', () => {
    it('creates a candidate, not knowledge', async () => {
      // Nothing here writes an article or anything the AI can retrieve. A person still has to
      // convert it.
      const { instance, created } = service({ rows: [ROW] });
      await instance.harvest();

      expect(created).toHaveLength(1);
      expect(created[0].sourceType).toBe(CandidateSource.GROUP_MESSAGES);
    });

    it('marks the source so a reviewer knows it came from a customer conversation', async () => {
      // MANUAL means a colleague chose to write it down. These deserve more scepticism than that.
      const { instance, created } = service({ rows: [ROW] });
      await instance.harvest();

      expect(created[0].sourceType).not.toBe(CandidateSource.MANUAL);
    });

    it('scopes the candidate to the group it came from', async () => {
      // Global scope would answer one group's question for every group.
      const { instance, created } = service({ rows: [ROW] });
      await instance.harvest();

      expect(created[0].scopeType).toBe(KnowledgeScopeType.GROUP);
      expect(created[0].scopeId).toBe('g1');
    });

    it('only considers questions a person had to handle', async () => {
      // A question the AI already answers is not a knowledge gap.
      const { instance, queries } = service();
      await instance.harvest();

      expect(queries[0].sql).toContain("d.outcome IN ('HUMAN_HANDOFF', 'NO_RESPONSE')");
    });

    it('requires repetition before spending a reviewer on it', async () => {
      const { instance, queries } = service();
      await instance.harvest();

      expect(queries[0].sql).toContain('HAVING COUNT(*) >=');
      // The occurrence threshold is a bound parameter, not interpolated.
      expect(queries[0].params).toContain(3);
    });

    it('caps how much one run can queue', async () => {
      const { instance, queries } = service();
      await instance.harvest({ limit: 5_000 });

      // Asked for 5,000; the service refuses to exceed its own ceiling.
      expect(queries[0].params[3]).toBe(100);
    });
  });

  describe('counting', () => {
    it('reports a bumped existing candidate as updated, not created', async () => {
      const queries: Array<unknown> = [];
      const groups = {
        count: jest.fn(async () => 1),
        manager: { query: jest.fn(async () => [ROW, { ...ROW, group_id: 'g2' }]) },
      };
      const candidates = {
        // First call looks new, second reports an existing candidate whose count was raised.
        create: jest
          .fn()
          .mockResolvedValueOnce({ id: 'a', occurrences: 1 })
          .mockResolvedValueOnce({ id: 'b', occurrences: 7 }),
      };
      void queries;

      const instance = new GroupKnowledgeHarvestService(groups as never, candidates as never);
      const result = await instance.harvest();

      expect(result.created).toBe(1);
      expect(result.updated).toBe(1);
      expect(result.questionsFound).toBe(2);
    });
  });
});
