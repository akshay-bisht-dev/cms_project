import { describe, expect, it } from 'vitest';
import { PERMISSION_CATALOG, PERMISSIONS_BY_KEY, ROLE_TEMPLATES } from '../../src/modules/rbac/index.js';
import { templatePermissions } from '../../src/modules/rbac/rbac.service.js';
import { FIELD_GROUPS } from '../../src/modules/employees/fields.js';

describe('permission catalog', () => {
  it('has unique keys and valid scopes', () => {
    expect(PERMISSIONS_BY_KEY.size).toBe(PERMISSION_CATALOG.length);
    for (const p of PERMISSION_CATALOG) {
      expect(p.allowedScopes.length).toBeGreaterThan(0);
      for (const s of p.allowedScopes) expect(['self', 'team', 'department', 'project', 'org']).toContain(s);
    }
  });

  it('defines every permission referenced by employee field groups', () => {
    for (const def of Object.values(FIELD_GROUPS)) {
      expect(PERMISSIONS_BY_KEY.has(def.read)).toBe(true);
      if (def.update) expect(PERMISSIONS_BY_KEY.has(def.update)).toBe(true);
    }
  });
});

describe('system role templates', () => {
  it.each(ROLE_TEMPLATES.map((t) => [t.key, t]))('%s only grants catalog permissions at allowed scopes', (_key, template) => {
    for (const { permissionKey, scope } of templatePermissions(template)) {
      const def = PERMISSIONS_BY_KEY.get(permissionKey);
      expect(def, permissionKey).toBeDefined();
      expect(def.allowedScopes, `${permissionKey}:${scope}`).toContain(scope);
    }
  });

  it('gives the owner every permission at its widest scope', () => {
    const owner = templatePermissions(ROLE_TEMPLATES.find((t) => t.key === 'OWNER'));
    expect(owner).toHaveLength(PERMISSION_CATALOG.length);
  });

  it('keeps sensitive capabilities away from non-admin roles', () => {
    const grants = (key) => new Set(templatePermissions(ROLE_TEMPLATES.find((t) => t.key === key)).map((g) => g.permissionKey));
    for (const role of ['EMPLOYEE', 'TEAM_LEAD', 'PROJECT_MANAGER', 'FINANCE_MANAGER', 'CLIENT_USER']) {
      expect(grants(role).has('roles.manage'), role).toBe(false);
      expect(grants(role).has('monitoring.policy.manage'), role).toBe(false);
    }
    expect(grants('HR_MANAGER').has('monitoring.screenshots.read')).toBe(false);
    expect([...grants('CLIENT_USER')]).toEqual(['tickets.client']);
  });
});
