import { ForbiddenException } from '@nestjs/common';
import { CopilotService } from './copilot.service';
import { CopilotActionStatus } from './entities/copilot-action.entity';

/**
 * The Copilot's admin execution context, and the gates around it.
 *
 * ## Why this file exists
 *
 * Tool selection used to run through `AIGatewayService.decide`, which builds the customer-support
 * persona — *"You are a customer support assistant for an internet service provider. You answer
 * ONLY from the approved knowledge supplied in this request… escalate rather than guess."* Handed an
 * admin question and a tool catalogue as "knowledge", a model obeying that prompt correctly
 * concludes it cannot answer, and escalates. Two different models did exactly that, live.
 *
 * The fix was to give the Copilot its own system prompt rather than to soften the customer-support
 * one — weakening the prompt that governs what customers receive, to make an internal tool work,
 * would be trading the wrong thing. These tests pin the separation so it cannot quietly regress.
 *
 * ## What actually keeps this safe
 *
 * Not the prompt. The model only ever *names* a tool; `invoke` refuses anything outside the registry
 * and re-checks the caller's permission, and every WRITE stops at PROPOSED until a person confirms.
 * That ordering is asserted here directly, because it is the part a prompt change cannot weaken.
 */

const ADMIN = {
  id: 'u1',
  permissions: new Set(['groups.read', 'reports.view', 'groups.bulk_update', 'knowledge.create']),
} as never;

const READ_ONLY = { id: 'u2', permissions: new Set(['groups.read']) } as never;

function build(options: { decide?: jest.Mock; available?: boolean } = {}) {
  const saved: Array<Record<string, unknown>> = [];
  const decide =
    options.decide ??
    jest.fn(async () => ({
      result: { decision: 'ANSWER', answer: JSON.stringify({ tool: 'count_groups', arguments: {} }) },
    }));

  const actions = {
    save: jest.fn(async (row: Record<string, unknown>) => {
      const withId = { id: row.id ?? `a${saved.length + 1}`, ...row };
      saved.push(withId);
      return withId;
    }),
    create: jest.fn((row: Record<string, unknown>) => row),
    findOne: jest.fn(async () => saved[saved.length - 1] ?? null),
    findOneOrFail: jest.fn(async () => saved[saved.length - 1]),
    findAndCount: jest.fn(async () => [[], 0]),
    update: jest.fn(async (id: string, patch: Record<string, unknown>) => {
      const row = saved.find((entry) => entry.id === id);
      if (row) Object.assign(row, patch);
    }),
  };

  const service = new CopilotService(
    actions as never,
    { save: jest.fn(async (r: unknown) => r), create: jest.fn((r: unknown) => r) } as never,
    { count: jest.fn(async () => 9), update: jest.fn(async () => ({ affected: 9 })) } as never,
    { findAndCount: jest.fn(async () => [[], 0]) } as never,
    {} as never,
    {} as never,
    { create: jest.fn(async () => ({ id: 'kc1', status: 'OPEN', occurrences: 1 })) } as never,
    { create: jest.fn(async () => ({ id: 'i1', displayName: 'Test' })) } as never,
    { isAvailable: jest.fn(async () => options.available ?? true) } as never,
    { decide } as never,
    { increment: jest.fn() } as never,
  );

  return { service, decide, saved };
}

describe('Copilot admin context', () => {
  describe('it does not borrow the customer-support prompt', () => {
    it('sends its own system prompt when choosing a tool', async () => {
      const { service, decide } = build();
      await service.ask(ADMIN, 'how many groups do I have');

      expect(decide).toHaveBeenCalledTimes(1);
      const system = (decide.mock.calls[0][1] as { system: string }).system;

      // The admin framing.
      expect(system).toContain('administrator request');
      // And explicitly not the customer-support one, which is what made models escalate.
      expect(system).not.toContain('customer support assistant');
      expect(system).not.toContain('internet service provider');
    });

    it('passes the tool catalogue rather than customer knowledge', async () => {
      const { service, decide } = build();
      await service.ask(ADMIN, 'how many groups');

      const request = decide.mock.calls[0][0] as { knowledge: Array<{ id: string }> };
      expect(request.knowledge.map((entry) => entry.id)).toEqual(['tools']);
    });

    it('tells the model that choosing a tool does not run it', async () => {
      // The model should not believe it is taking an action; a WRITE still stops for a person.
      const { service, decide } = build();
      await service.ask(ADMIN, 'anything');

      expect((decide.mock.calls[0][1] as { system: string }).system).toContain('does not run it');
    });
  });

  describe('authorization is re-checked regardless of what the model said', () => {
    it('refuses a tool the caller lacks permission for', async () => {
      const { service } = build();
      await expect(
        service.invoke(READ_ONLY, { prompt: 'p', tool: 'set_group_ai', arguments: { enabled: true } }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses a tool that is not in the registry', async () => {
      // The registry is the boundary. A model naming something invented gets nothing.
      const { service } = build();
      await expect(
        service.invoke(ADMIN, { prompt: 'p', tool: 'drop_everything', arguments: {} }),
      ).rejects.toThrow(/no "drop_everything" tool/);
    });

    it('only offers tools the caller may actually run', async () => {
      const { service } = build();
      const names = service.tools(READ_ONLY).map((tool) => tool.name);

      expect(names).toContain('count_groups');
      expect(names).not.toContain('set_group_ai');
    });
  });

  describe('writes stop for a person', () => {
    it('records a WRITE as PROPOSED rather than executing it', async () => {
      const { service } = build();
      const action = await service.invoke(ADMIN, {
        prompt: 'turn AI on',
        tool: 'set_group_ai',
        arguments: { enabled: true },
      });

      expect(action.status).toBe(CopilotActionStatus.PROPOSED);
    });

    it('states the blast radius before anything happens', async () => {
      // "Are you sure?" is not consent. The operator sees the count first.
      const { service } = build();
      const action = await service.invoke(ADMIN, {
        prompt: 'turn AI off',
        tool: 'set_group_ai',
        arguments: { enabled: false },
      });

      expect(action.blastRadius).toContain('9 groups');
      // And that disabling is a veto nothing else overrides.
      expect(action.blastRadius).toContain('absolute');
    });

    it('runs a READ immediately, because reading changes nothing', async () => {
      const { service } = build();
      const action = await service.invoke(ADMIN, { prompt: 'count', tool: 'count_groups', arguments: {} });

      expect(action.status).toBe(CopilotActionStatus.EXECUTED);
    });
  });

  describe('provider trouble is reported honestly', () => {
    it('says no provider is configured rather than blaming the question', async () => {
      const { service } = build({ available: false });
      const answer = await service.ask(ADMIN, 'how many groups');

      expect(answer.answered).toBe(false);
      expect(answer.message).toContain('No AI provider is configured');
      // And still offers something useful.
      expect(answer.suggestions.length).toBeGreaterThan(0);
    });

    it('names a provider failure instead of implying the question was bad', async () => {
      // A 429 previously surfaced as "I could not match that to a tool I have", sending an operator
      // off rewording a perfectly good question while the provider was simply rate-limited.
      const decide = jest.fn(async () => {
        throw new Error('openrouter rate-limited the request (429).');
      });
      const { service } = build({ decide });

      const answer = await service.ask(ADMIN, 'how many groups');
      expect(answer.message).toContain('429');
      expect(answer.message).toContain('Your question was fine');
    });

    it('falls back to the catalogue when the model declines, without inventing a tool', async () => {
      const decide = jest.fn(async () => ({ result: { decision: 'ESCALATE', answer: null, reason: null } }));
      const { service } = build({ decide });

      const answer = await service.ask(ADMIN, 'something unanswerable');
      expect(answer.answered).toBe(false);
      expect(answer.action).toBeUndefined();
      expect(answer.suggestions.length).toBeGreaterThan(0);
    });
  });

  describe('recovering a tool from an imperfect answer', () => {
    it('accepts a fenced JSON block', async () => {
      const decide = jest.fn(async () => ({
        result: {
          decision: 'ANSWER',
          answer: '```json\n{"tool":"count_groups","arguments":{}}\n```',
          reason: null,
        },
      }));
      const { service } = build({ decide });

      const answer = await service.ask(ADMIN, 'how many groups');
      expect(answer.answered).toBe(true);
      expect(answer.action?.tool).toBe('count_groups');
    });

    it('recovers a tool named in prose when the envelope is wrong', async () => {
      // Safe because `invoke` still gates on the registry and the caller's permission — the model's
      // formatting was never what made this safe.
      const decide = jest.fn(async () => ({
        result: { decision: 'ESCALATE', answer: null, reason: 'You probably want count_groups here.' },
      }));
      const { service } = build({ decide });

      const answer = await service.ask(ADMIN, 'how many groups');
      expect(answer.action?.tool).toBe('count_groups');
    });

    it('does not invent a tool from unrelated prose', async () => {
      const decide = jest.fn(async () => ({
        result: { decision: 'ESCALATE', answer: null, reason: 'I am not sure what you mean.' },
      }));
      const { service } = build({ decide });

      expect((await service.ask(ADMIN, 'ambiguous')).answered).toBe(false);
    });
  });
});
