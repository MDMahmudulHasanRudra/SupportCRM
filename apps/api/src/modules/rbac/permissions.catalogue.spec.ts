import { PERMISSIONS, PERMISSION_KEYS, ROLES } from './permissions.catalogue';

describe('permissions catalogue', () => {
  it('has no duplicate permission keys', () => {
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length);
  });

  it('uses a consistent `resource.action` key shape', () => {
    for (const key of PERMISSION_KEYS) {
      expect(key).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });

  it('covers every permission PROJECT_SPEC.md §108 names', () => {
    // Verbatim from the spec. If a key is renamed, this test must be updated deliberately —
    // that is the point: the spec is canonical, so drift should be a conscious act.
    const specRequired = [
      'groups.read',
      'groups.update',
      'groups.bulk_update',
      'messages.read',
      'messages.send',
      'broadcast.create',
      'broadcast.send',
      'ai.configure',
      'ai.execute',
      'knowledge.create',
      'knowledge.approve',
      'automation.create',
      'automation.approve',
      'team.manage',
      'reports.view',
      'system.emergency_stop',
    ];
    for (const key of specRequired) {
      expect(PERMISSION_KEYS).toContain(key);
    }
  });

  it('defines the seven roles PROJECT_SPEC.md §108 names', () => {
    expect(ROLES.map((r) => r.key).sort()).toEqual(
      [
        'admin',
        'ai_manager',
        'knowledge_manager',
        'report_viewer',
        'support_executive',
        'support_manager',
        'super_admin',
      ].sort(),
    );
  });

  it('grants only permissions that exist — a typo here would fail closed at seed time', () => {
    for (const role of ROLES) {
      for (const key of role.permissions) {
        expect(PERMISSION_KEYS).toContain(key);
      }
    }
  });

  it('has exactly one super-admin role', () => {
    expect(ROLES.filter((r) => r.isSuperAdmin)).toHaveLength(1);
  });

  it('never grants a dangerous permission to a read-only or front-line role', () => {
    const dangerous = new Set(PERMISSIONS.filter((p) => p.isDangerous).map((p) => p.key));
    for (const roleKey of ['report_viewer', 'support_executive']) {
      const role = ROLES.find((r) => r.key === roleKey)!;
      const granted = role.permissions.filter((p) => dangerous.has(p));
      expect(granted).toEqual([]);
    }
  });

  it('does not let a non-admin role change roles, users or settings', () => {
    const escalation = ['roles.manage', 'users.manage', 'settings.manage', 'system.emergency_stop'];
    for (const role of ROLES) {
      if (role.key === 'admin' || role.key === 'super_admin') continue;
      for (const key of escalation) {
        expect(role.permissions).not.toContain(key);
      }
    }
  });

  it('gives every permission a label and a category', () => {
    for (const p of PERMISSIONS) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.category.length).toBeGreaterThan(0);
    }
  });
});
