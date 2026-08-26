import { COPILOT_TOOLS, findTool, validateArguments } from './copilot-tools';

/**
 * The Copilot's tool contract.
 *
 * These are cheap tests guarding an expensive mistake: a tool that reaches production without a
 * permission, or a write tool that is quietly classified as a read and therefore executes without
 * anybody confirming it (§90).
 */
describe('Copilot tools (§89–§91)', () => {
  it('gives every tool a permission to check', () => {
    for (const tool of COPILOT_TOOLS) {
      expect(tool.permission).toBeTruthy();
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  it('classifies anything that changes data as a WRITE', () => {
    // A write misclassified as a read executes with no confirmation. Naming the shape here means a
    // new tool called `set_…` or `propose_…` cannot slip through as a read.
    for (const tool of COPILOT_TOOLS) {
      if (/^(set|update|delete|disable|enable|propose|create)_/.test(tool.name)) {
        expect(tool.kind).toBe('WRITE');
      }
    }
  });

  it('has no tool that deletes anything or sends a message', () => {
    for (const tool of COPILOT_TOOLS) {
      expect(tool.name).not.toMatch(/delete|remove|send|broadcast/);
    }
  });

  it('finds tools by name and refuses unknown ones', () => {
    expect(findTool('count_groups')?.kind).toBe('READ');
    expect(findTool('rm_-rf')).toBeNull();
  });

  describe('argument validation', () => {
    const tool = findTool('set_group_automation')!;

    it('requires the required ones', () => {
      expect(validateArguments(tool, {})).toContain('enabled is required.');
      expect(validateArguments(tool, { enabled: true })).toHaveLength(0);
    });

    it('checks types rather than coercing them', () => {
      const problems = validateArguments(tool, { enabled: 'yes' });
      expect(problems[0]).toMatch(/should be a boolean/);
    });

    it('rejects arguments the tool does not declare', () => {
      // An unknown argument usually means the caller believes it does something.
      const problems = validateArguments(tool, { enabled: true, alsoDeleteEverything: true });
      expect(problems).toContain('alsoDeleteEverything is not an argument of set_group_automation.');
    });

    it('reports every problem at once rather than the first', () => {
      const problems = validateArguments(tool, { enabled: 'yes', bogus: 1 });
      expect(problems.length).toBeGreaterThanOrEqual(2);
    });

    it('treats an optional argument as absent when it is null', () => {
      expect(validateArguments(tool, { enabled: true, monitoringState: null })).toHaveLength(0);
    });
  });
});
