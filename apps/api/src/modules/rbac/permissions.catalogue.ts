/**
 * The single source of truth for every permission key in Support CRM.
 *
 * `PROJECT_SPEC.md` §108 names a minimum set; this catalogue is that set plus the keys the phases
 * in `docs/IMPLEMENTATION_PLAN.md` need, so a permission does not require a schema change when its
 * feature lands. The seed reconciles the `permissions` table against this list on every boot:
 * new keys are inserted, and keys that disappear from here are reported rather than silently
 * deleted (deleting one would revoke access from every role that held it).
 *
 * `isDangerous` marks actions with irreversible or wide blast radius. The AI Copilot's write-tool
 * confirmation flow (Phase 10, `PROJECT_SPEC.md` §90) keys off this flag, and the UI uses it to
 * demand explicit confirmation.
 */
export interface PermissionDefinition {
  key: string;
  label: string;
  category: string;
  isDangerous?: boolean;
}

export const PERMISSIONS: readonly PermissionDefinition[] = [
  // --- Groups (spec §108) ---------------------------------------------------
  { key: 'groups.read', label: 'View groups', category: 'Groups' },
  { key: 'groups.update', label: 'Update a group', category: 'Groups' },
  { key: 'groups.bulk_update', label: 'Bulk-update groups', category: 'Groups', isDangerous: true },

  // --- Conversations & messages --------------------------------------------
  { key: 'conversations.read', label: 'View conversations', category: 'Inbox' },
  { key: 'conversations.manage', label: 'Assign, tag, resolve conversations', category: 'Inbox' },
  { key: 'conversations.takeover', label: 'Take over / release a conversation', category: 'Inbox' },
  { key: 'messages.read', label: 'Read messages', category: 'Inbox' },
  { key: 'messages.send', label: 'Send messages', category: 'Inbox' },

  // --- Customers & team -----------------------------------------------------
  { key: 'customers.read', label: 'View customers', category: 'CRM' },
  { key: 'customers.manage', label: 'Manage customers', category: 'CRM' },
  { key: 'team.manage', label: 'Manage support team members', category: 'CRM' },

  // --- Broadcast ------------------------------------------------------------
  { key: 'broadcast.create', label: 'Create a broadcast', category: 'Broadcast' },
  { key: 'broadcast.send', label: 'Send a broadcast', category: 'Broadcast', isDangerous: true },

  // --- AI -------------------------------------------------------------------
  { key: 'ai.configure', label: 'Configure AI providers and policy', category: 'AI', isDangerous: true },
  { key: 'ai.execute', label: 'Invoke AI', category: 'AI' },
  { key: 'ai.review', label: 'Review AI decisions and feedback', category: 'AI' },

  // --- Knowledge ------------------------------------------------------------
  { key: 'knowledge.read', label: 'View knowledge', category: 'Knowledge' },
  { key: 'knowledge.create', label: 'Create knowledge', category: 'Knowledge' },
  { key: 'knowledge.approve', label: 'Publish or archive knowledge', category: 'Knowledge', isDangerous: true },

  // --- Automation -----------------------------------------------------------
  { key: 'automation.read', label: 'View automation rules', category: 'Automation' },
  { key: 'automation.create', label: 'Create or edit automation rules', category: 'Automation' },
  { key: 'automation.approve', label: 'Publish or pause automation', category: 'Automation', isDangerous: true },
  { key: 'automation.simulate', label: 'Run the automation simulator', category: 'Automation' },

  // --- Channels -------------------------------------------------------------
  { key: 'channels.read', label: 'View channel accounts and sessions', category: 'Channels' },
  { key: 'channels.manage', label: 'Connect, disconnect and configure channel accounts', category: 'Channels', isDangerous: true },

  // --- Jobs -----------------------------------------------------------------
  { key: 'jobs.read', label: 'View the Job Center', category: 'Jobs' },
  { key: 'jobs.manage', label: 'Retry or cancel jobs', category: 'Jobs' },

  // --- Reporting & audit ----------------------------------------------------
  { key: 'reports.view', label: 'View reports', category: 'Reports' },
  // Separate from viewing: an export leaves the system as a file of customer data, and §109 asks
  // for least privilege on exactly that kind of operation.
  { key: 'reports.export', label: 'Export report data', category: 'Reports' },
  { key: 'audit.view', label: 'View the audit log', category: 'System' },

  // --- Users, roles, settings ----------------------------------------------
  { key: 'users.read', label: 'View users', category: 'Administration' },
  { key: 'users.manage', label: 'Create, edit and deactivate users', category: 'Administration', isDangerous: true },
  { key: 'roles.read', label: 'View roles and permissions', category: 'Administration' },
  { key: 'roles.manage', label: 'Change role permissions', category: 'Administration', isDangerous: true },
  { key: 'settings.read', label: 'View settings', category: 'Administration' },
  { key: 'settings.manage', label: 'Change settings and feature flags', category: 'Administration', isDangerous: true },

  // --- Emergency ------------------------------------------------------------
  { key: 'system.emergency_stop', label: 'Emergency stop (pause all AI / automation / sending)', category: 'System', isDangerous: true },
] as const;

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

/**
 * The seven roles `PROJECT_SPEC.md` §108 names, with a starting permission set each.
 *
 * These are DEFAULTS, not policy: every set is editable in the UI afterwards, and the seed only
 * applies them when creating a role for the first time — it never overwrites an operator's later
 * changes on a subsequent boot.
 */
export interface RoleDefinition {
  key: string;
  name: string;
  description: string;
  isSuperAdmin?: boolean;
  permissions: readonly string[];
}

const READ_ONLY = [
  'groups.read',
  'conversations.read',
  'messages.read',
  'customers.read',
  'knowledge.read',
  'automation.read',
  'channels.read',
  'jobs.read',
  'reports.view',
];

export const ROLES: readonly RoleDefinition[] = [
  {
    key: 'super_admin',
    name: 'Super Admin',
    description: 'Unrestricted access. Bypasses every permission check — keep the membership small.',
    isSuperAdmin: true,
    permissions: PERMISSION_KEYS,
  },
  {
    key: 'admin',
    name: 'Admin',
    description: 'Full operational access except super-admin bypass.',
    permissions: PERMISSION_KEYS,
  },
  {
    key: 'support_manager',
    name: 'Support Manager',
    description: 'Runs the support operation: inbox, groups, team, bulk actions, reports.',
    permissions: [
      ...READ_ONLY,
      'groups.update',
      'groups.bulk_update',
      'conversations.manage',
      'conversations.takeover',
      'messages.send',
      'customers.manage',
      'team.manage',
      'jobs.manage',
      'broadcast.create',
      'ai.review',
      'audit.view',
    ],
  },
  {
    key: 'support_executive',
    name: 'Support Executive',
    description: 'Front-line support: handles conversations, cannot change configuration.',
    permissions: [
      ...READ_ONLY,
      'conversations.manage',
      'conversations.takeover',
      'messages.send',
      'customers.manage',
    ],
  },
  {
    key: 'ai_manager',
    name: 'AI Manager',
    description: 'Owns AI configuration, policy, thresholds and AI decision review.',
    permissions: [...READ_ONLY, 'ai.configure', 'ai.execute', 'ai.review', 'automation.simulate'],
  },
  {
    key: 'knowledge_manager',
    name: 'Knowledge Manager',
    description: 'Authors and approves knowledge; drafts automation.',
    permissions: [
      ...READ_ONLY,
      'knowledge.create',
      'knowledge.approve',
      'automation.create',
      'automation.simulate',
    ],
  },
  {
    key: 'report_viewer',
    name: 'Report Viewer',
    description: 'Read-only access to reports and dashboards.',
    permissions: ['reports.view', 'groups.read', 'conversations.read'],
  },
] as const;
