import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { rbac, settings as settingsApi, type PermissionRow, type RoleRow, type SettingRow } from '../../api/client';
import { useAuth } from '../../auth-context';
import {
  IconBookOpen,
  IconMessageCircle,
  IconOctagonAlert,
  IconShieldAlert,
  IconSliders,
  IconSparkles,
  IconZap,
} from '../../components/icons';
import { Badge, Card, Empty, ErrorState, Loading, PageHeader, TableWrap, errorMessage, humanise } from '../../components/ui';

type Tab = 'general' | 'access' | 'raw';

/**
 * Settings.
 *
 * A hub rather than a second home for configuration that already has a screen: WhatsApp, automation,
 * AI, escalation and rate limits each own their settings, and duplicating those controls here would
 * create two places to change one thing. What lives here is what has nowhere else to be — the
 * effective feature flags, the permission catalogue, and the raw stored settings.
 *
 * Secret values are never returned by the API. A setting that holds a credential reports only that
 * one is set, and this screen shows exactly that and no more.
 */
export function SettingsPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>('general');

  const [flags, setFlags] = useState<{ featureFlags: Record<string, boolean>; emergencyStops: Record<string, boolean> } | null>(
    null,
  );
  const [rows, setRows] = useState<SettingRow[] | null>(null);
  const [roles, setRoles] = useState<RoleRow[] | null>(null);
  const [permissions, setPermissions] = useState<PermissionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canReadRoles = can('roles.read');

  const load = useCallback(async () => {
    try {
      const [flagPayload, settingPage] = await Promise.all([
        settingsApi.featureFlags(),
        settingsApi.list().catch(() => ({ items: [] as SettingRow[] })),
      ]);
      setFlags(flagPayload);
      setRows(settingPage.items);
      setError(null);

      if (canReadRoles) {
        const [rolePage, permissionPage] = await Promise.all([
          rbac.roles().catch(() => ({ items: [] as RoleRow[] })),
          rbac.permissions().catch(() => ({ items: [] as PermissionRow[], total: 0 })),
        ]);
        setRoles(rolePage.items);
        setPermissions(permissionPage.items);
      }
    } catch (failure) {
      setError(errorMessage(failure, 'Settings could not be loaded.'));
    }
  }, [canReadRoles]);

  useEffect(() => {
    void load();
  }, [load]);

  const stopsEngaged = flags ? Object.values(flags.emergencyStops).filter(Boolean).length : 0;

  return (
    <>
      <PageHeader
        title="Settings"
        description="What the system is configured to do, and who is allowed to change it."
      />

      {error && <ErrorState message={error} onRetry={() => void load()} />}

      {/* Configuration that already owns a screen is linked, never duplicated. */}
      <div className="settings-links">
        <SettingsLink to="/channels/whatsapp" icon={<IconMessageCircle size={17} />} title="WhatsApp" sub="Accounts, pairing, health" />
        <SettingsLink to="/automation" icon={<IconZap size={17} />} title="Automation" sub="Rules, profiles, bulk actions" />
        <SettingsLink to="/ai/providers" icon={<IconSparkles size={17} />} title="AI" sub="Providers, models, memory" />
        <SettingsLink to="/knowledge" icon={<IconBookOpen size={17} />} title="Knowledge" sub="Articles, documents, indexing" />
        <SettingsLink to="/escalations/config" icon={<IconShieldAlert size={17} />} title="Escalation" sub="When a human is needed" />
        <SettingsLink to="/settings/rate-limits" icon={<IconSliders size={17} />} title="Rate limits" sub="Sending ceilings per scope" />
        <SettingsLink
          to="/emergency"
          icon={<IconOctagonAlert size={17} />}
          title="Emergency"
          sub={stopsEngaged > 0 ? `${stopsEngaged} stop${stopsEngaged === 1 ? '' : 's'} engaged` : 'Stop everything, now'}
          tone={stopsEngaged > 0 ? 'bad' : undefined}
        />
      </div>

      <div className="row" style={{ margin: '18px 0 14px', gap: 6 }}>
        {(['general', 'access', 'raw'] as const).map((name) => (
          <button
            key={name}
            type="button"
            className={tab === name ? 'primary' : ''}
            onClick={() => setTab(name)}
            disabled={name === 'access' && !canReadRoles}
          >
            {name === 'general' ? 'General' : name === 'access' ? 'Users & permissions' : 'Stored settings'}
          </button>
        ))}
      </div>

      {tab === 'general' && (
        <div className="split">
          <Card title="Feature flags" actions={<span className="muted small">Effective values</span>}>
            {!flags ? (
              <Loading label="Loading…" />
            ) : Object.keys(flags.featureFlags).length === 0 ? (
              <Empty title="No feature flags" hint="Nothing is gated behind a flag." />
            ) : (
              <div className="rowlist">
                {Object.entries(flags.featureFlags).map(([key, enabled]) => (
                  <div key={key} className="rowlist-item">
                    <div className="rowlist-body">
                      <div className="rowlist-text">{humanise(key.replace(/[._]/g, ' '))}</div>
                      <div className="rowlist-sub mono">{key}</div>
                    </div>
                    <Badge tone={enabled ? 'ok' : 'neutral'}>{enabled ? 'On' : 'Off'}</Badge>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card
            title="Emergency stops"
            actions={
              <Link to="/emergency" className="small">
                Controls →
              </Link>
            }
          >
            {!flags ? (
              <Loading label="Loading…" />
            ) : (
              <div className="rowlist">
                {Object.entries(flags.emergencyStops).map(([key, stopped]) => (
                  <div key={key} className="rowlist-item">
                    <div className="rowlist-body">
                      <div className="rowlist-text">{humanise(key.replace(/[._]/g, ' '))}</div>
                      <div className="rowlist-sub mono">{key}</div>
                    </div>
                    {/* A stop being engaged is the notable state, so it is the one that is coloured. */}
                    <Badge tone={stopped ? 'bad' : 'ok'}>{stopped ? 'Engaged' : 'Normal'}</Badge>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === 'access' && canReadRoles && (
        <div className="stack">
          <Card title="Roles">
            {!roles ? (
              <Loading label="Loading…" />
            ) : roles.length === 0 ? (
              <Empty title="No roles" />
            ) : (
              <TableWrap>
                <table>
                  <thead>
                    <tr>
                      <th>Role</th>
                      <th>Key</th>
                      <th>Permissions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {roles.map((role) => (
                      <tr key={role.id}>
                        <td>
                          {role.name}
                          {role.description && <div className="muted small">{role.description}</div>}
                        </td>
                        <td className="mono">{role.key}</td>
                        <td>{role.permissions?.length ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </Card>

          <Card title="Permission catalogue" actions={<span className="muted small">{permissions?.length ?? 0} total</span>}>
            {!permissions ? (
              <Loading label="Loading…" />
            ) : (
              <div className="stack" style={{ gap: 10 }}>
                {Object.entries(
                  permissions.reduce<Record<string, PermissionRow[]>>((groups, permission) => {
                    const key = permission.category ?? 'other';
                    (groups[key] ??= []).push(permission);
                    return groups;
                  }, {}),
                ).map(([category, items]) => (
                  <div key={category}>
                    <div className="info-pane-label">{humanise(category)}</div>
                    <div className="chip-row">
                      {items.map((permission) => (
                        <Badge key={permission.id} title={permission.description ?? undefined}>
                          {permission.key}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === 'raw' && (
        <Card title="Stored settings" actions={<span className="muted small">Secrets are never returned</span>}>
          {!rows ? (
            <Loading label="Loading…" />
          ) : rows.length === 0 ? (
            <Empty title="Nothing stored" hint="Every value is still at its default." />
          ) : (
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Key</th>
                    <th>Category</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.key}>
                      <td className="mono">{row.key}</td>
                      <td className="small muted">{row.category ?? '—'}</td>
                      <td className="small">
                        {row.isSecret ? <Badge>Set — never shown</Badge> : <span className="mono">{String(row.value ?? '—')}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      )}
    </>
  );
}

function SettingsLink({
  to,
  icon,
  title,
  sub,
  tone,
}: {
  to: string;
  icon: React.ReactNode;
  title: string;
  sub: string;
  tone?: 'bad';
}) {
  return (
    <Link to={to} className="settings-link">
      <span className={tone === 'bad' ? 'rowlist-chip tone-bad' : 'rowlist-chip tone-accent'}>{icon}</span>
      <span style={{ minWidth: 0 }}>
        <span className="settings-link-title">{title}</span>
        <span className="settings-link-sub">{sub}</span>
      </span>
    </Link>
  );
}
