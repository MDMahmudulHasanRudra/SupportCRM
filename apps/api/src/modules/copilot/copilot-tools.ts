/**
 * What the admin Copilot is allowed to do (`PROJECT_SPEC.md` §89–§91, §137–§138).
 *
 * A declared, closed set. The Copilot cannot call anything that is not in this table, which is the
 * difference between "an assistant with tools" and "an assistant with a shell".
 *
 * The split that matters is `kind`:
 *
 *  * **READ** may execute immediately, if the asking user holds the permission. Answering "how many
 *    groups have AI on?" by running the query is the entire point of the feature.
 *  * **WRITE** never executes on its own. It is *proposed*, the blast radius is stated in words,
 *    and a human confirms it — and the confirmation is checked against the same RBAC the API uses,
 *    so the Copilot can never do something its caller could not do themselves (§90).
 *
 * Every tool names the permission it needs. That is not a courtesy: it is how the guard knows what
 * to check, and a tool added without one will not run.
 */

export type CopilotToolKind = 'READ' | 'WRITE';

export interface CopilotTool {
  name: string;
  kind: CopilotToolKind;
  description: string;
  /** The permission the *calling user* must hold. The Copilot borrows their authority, never more. */
  permission: string;
  /** Named arguments, for validation and for showing an operator what is about to happen. */
  parameters: Array<{ name: string; type: 'string' | 'uuid' | 'number' | 'boolean'; required: boolean }>;
}

export const COPILOT_TOOLS: readonly CopilotTool[] = [
  // --- read ---------------------------------------------------------------------------------
  {
    name: 'count_groups',
    kind: 'READ',
    description: 'How many groups exist, optionally filtered by monitoring or automation state.',
    permission: 'groups.read',
    parameters: [
      { name: 'monitoringState', type: 'string', required: false },
      { name: 'automationEnabled', type: 'boolean', required: false },
    ],
  },
  {
    name: 'dashboard_summary',
    kind: 'READ',
    description: 'The dashboard figures for a window: conversations, decisions, escalations, timings.',
    permission: 'reports.view',
    parameters: [
      { name: 'fromIso', type: 'string', required: false },
      { name: 'toIso', type: 'string', required: false },
    ],
  },
  {
    name: 'top_issues',
    kind: 'READ',
    description: 'What customers needed most in a window, by recorded decision reason.',
    permission: 'reports.view',
    parameters: [{ name: 'fromIso', type: 'string', required: false }],
  },
  {
    name: 'open_escalations',
    kind: 'READ',
    description: 'Conversations waiting for a person right now.',
    permission: 'conversations.read',
    parameters: [],
  },
  {
    name: 'knowledge_gaps',
    kind: 'READ',
    description: 'Questions the knowledge base repeatedly failed to answer.',
    permission: 'reports.view',
    parameters: [{ name: 'fromIso', type: 'string', required: false }],
  },

  // --- write: proposed, never executed without a person saying yes ------------------------------
  {
    name: 'propose_automation_candidate',
    kind: 'WRITE',
    description: 'Draft a rule proposal for review. Creates a candidate, never a live rule.',
    permission: 'automation.create',
    parameters: [
      { name: 'title', type: 'string', required: true },
      { name: 'rationale', type: 'string', required: true },
      { name: 'trigger', type: 'string', required: true },
      { name: 'reply', type: 'string', required: true },
    ],
  },
  {
    name: 'set_group_automation',
    kind: 'WRITE',
    description: 'Turn automation on or off for a set of groups. States the blast radius first.',
    permission: 'groups.bulk_update',
    parameters: [
      { name: 'monitoringState', type: 'string', required: false },
      { name: 'enabled', type: 'boolean', required: true },
    ],
  },
];

export function findTool(name: string): CopilotTool | null {
  return COPILOT_TOOLS.find((tool) => tool.name === name) ?? null;
}

/**
 * Validates the arguments a caller supplied against the tool's declaration.
 *
 * Returns the problems rather than throwing on the first, so an operator fixing a call sees all of
 * them at once. Unknown arguments are rejected rather than ignored: an argument the tool does not
 * understand usually means the caller believes it does something.
 */
export function validateArguments(
  tool: CopilotTool,
  args: Record<string, unknown>,
): string[] {
  const problems: string[] = [];

  for (const parameter of tool.parameters) {
    const value = args[parameter.name];

    if (value === undefined || value === null) {
      if (parameter.required) problems.push(`${parameter.name} is required.`);
      continue;
    }

    const actual = typeof value;
    const expected = parameter.type === 'uuid' ? 'string' : parameter.type;
    if (actual !== expected) {
      problems.push(`${parameter.name} should be a ${parameter.type}, not a ${actual}.`);
    }
  }

  const declared = new Set(tool.parameters.map((parameter) => parameter.name));
  for (const key of Object.keys(args)) {
    if (!declared.has(key)) problems.push(`${key} is not an argument of ${tool.name}.`);
  }

  return problems;
}
