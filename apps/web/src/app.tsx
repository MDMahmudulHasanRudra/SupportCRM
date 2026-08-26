import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth-context';
import { humanise, ToastProvider } from './components/ui';
import {
  IconActivity,
  IconAlertCircle,
  IconBarChart,
  IconBookOpen,
  IconBot,
  IconChevronDown,
  IconGrid,
  IconInbox,
  IconLightbulb,
  IconLogOut,
  IconMegaphone,
  IconMessageCircle,
  IconMoon,
  IconOctagonAlert,
  IconRadio,
  IconShieldAlert,
  IconSliders,
  IconSettings,
  IconSparkles,
  IconSun,
  IconUserCircle,
  IconUsers,
  IconZap,
} from './components/icons';
import { AIProvidersPage } from './pages/ai/providers';
import { AIVoicePage } from './pages/ai/voice';
import { AutomationProfilesPage } from './pages/automation/profiles';
import { AutomationRuleEditorPage } from './pages/automation/rule-editor';
import { AutomationRulesPage } from './pages/automation/rules';
import { BulkActionsPage } from './pages/automation/bulk';
import { CandidatesPage } from './pages/automation/candidates';
import { BroadcastsPage } from './pages/broadcasts';
import { ConversationsPage } from './pages/conversations';
import { CopilotPage } from './pages/copilot';
import { CustomersPage } from './pages/customers';
import { DashboardPage } from './pages/dashboard';
import { DecisionsPage } from './pages/decisions';
import { EmergencyPage } from './pages/emergency';
import { EscalationConfigPage } from './pages/escalation-config';
import { EscalationsPage } from './pages/escalations';
import { GroupsPage } from './pages/groups';
import { GroupOperationsPage } from './pages/groups/operations';
import { GroupDetailPage } from './pages/groups/detail';
import { SupportMembersPage } from './pages/support/members';
import { SupportMemberDetailPage } from './pages/support/member-detail';
import { SupportActivityPage } from './pages/support/activity';
import { OnboardingRulesPage } from './pages/groups/onboarding';
import { KnowledgeBrowserPage } from './pages/knowledge/browser';
import { KnowledgeCandidatesPage } from './pages/knowledge/candidates';
import { KnowledgeEditorPage } from './pages/knowledge/editor';
import { LoginPage } from './pages/login';
import { ReportsPage } from './pages/reports';
import { SettingsPage } from './pages/settings';
import { RateLimitsPage } from './pages/settings/rate-limits';
import { WhatsAppAccountPage } from './pages/whatsapp-account';
import { WhatsAppAccountsPage } from './pages/whatsapp-accounts';

const CONSOLE_VERSION = 'v0.1.0';

/**
 * The operator console.
 *
 * Navigation is grouped by what somebody is trying to do rather than by which phase built it:
 * the daily work at the top, the things that configure it underneath, and the controls you reach
 * for when something is wrong at the bottom.
 *
 * Every entry is permission-gated. A link that leads to a 403 is worse than no link, so the rule
 * is that if it renders, it works for the person looking at it.
 */
export function App() {
  const { user, loading } = useAuth();
  const [collapsed, setCollapsed] = useState(false);

  // Held until the session check finishes, so a signed-in operator refreshing the page is never
  // bounced to the login screen for a frame.
  if (loading) {
    return (
      <div className="login">
        <div className="progress">
          <span className="spinner" aria-hidden="true" />
          <span className="muted">Loading…</span>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <ToastProvider>
      <div className={collapsed ? 'shell collapsed' : 'shell'}>
        <Sidebar />
        <div>
          <Topbar collapsed={collapsed} onToggle={() => setCollapsed((current) => !current)} />
          <main className="main">
            <Routes>
              <Route path="/" element={<DashboardPage />} />

              {/* Conversations and customers */}
              <Route path="/conversations" element={<ConversationsPage />} />
              <Route path="/customers" element={<CustomersPage />} />

              {/* Channels and groups */}
              <Route path="/channels/whatsapp" element={<WhatsAppAccountsPage />} />
              <Route path="/channels/whatsapp/:accountId" element={<WhatsAppAccountPage />} />
              <Route path="/channels/whatsapp/:accountId/groups" element={<GroupsPage />} />
              <Route path="/groups" element={<GroupOperationsPage />} />
              <Route path="/groups/onboarding" element={<OnboardingRulesPage />} />
              {/* Last: `onboarding` would otherwise be captured as a group id. */}
              <Route path="/groups/:id" element={<GroupDetailPage />} />

              {/* Support members: the team_member_identities rows, reported on. */}
              <Route path="/support-members" element={<SupportMembersPage />} />
              <Route path="/support-members/:id" element={<SupportMemberDetailPage />} />
              <Route path="/support-activity" element={<SupportActivityPage />} />

              {/* Knowledge */}
              <Route path="/knowledge" element={<KnowledgeBrowserPage />} />
              <Route path="/knowledge/articles/:id" element={<KnowledgeEditorPage />} />
              <Route path="/knowledge/candidates" element={<KnowledgeCandidatesPage />} />

              {/* Automation */}
              <Route path="/automation" element={<AutomationRulesPage />} />
              <Route path="/automation/rules/:id" element={<AutomationRuleEditorPage />} />
              <Route path="/automation/profiles" element={<AutomationProfilesPage />} />
              <Route path="/automation/bulk" element={<BulkActionsPage />} />
              <Route path="/automation/candidates" element={<CandidatesPage />} />

              {/* AI */}
              <Route path="/ai/providers" element={<AIProvidersPage />} />
              <Route path="/ai/voice" element={<AIVoicePage />} />

              {/* Operations */}
              <Route path="/decisions" element={<DecisionsPage />} />
              <Route path="/escalations" element={<EscalationsPage />} />
              <Route path="/escalations/config" element={<EscalationConfigPage />} />
              <Route path="/broadcasts" element={<BroadcastsPage />} />
              <Route path="/reports" element={<ReportsPage />} />
              <Route path="/copilot" element={<CopilotPage />} />

              {/* Controls */}
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/settings/rate-limits" element={<RateLimitsPage />} />
              <Route path="/emergency" element={<EmergencyPage />} />

              <Route path="/login" element={<Navigate to="/" replace />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </main>
        </div>
      </div>
    </ToastProvider>
  );
}

function Sidebar() {
  const { can } = useAuth();

  const item = (to: string, label: string, icon: ReactNode, end = false) => (
    <NavLink to={to} end={end} className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')} title={label}>
      {icon}
      <span>{label}</span>
    </NavLink>
  );

  return (
    <nav className="sidebar">
      <div className="brand">
        <span className="brand-mark">S</span>
        <span className="brand-word">Support CRM</span>
      </div>

      <div className="nav-group">Operations</div>
      {item('/', 'Dashboard', <IconGrid size={17} />, true)}
      {can('conversations.read') && item('/conversations', 'Conversations', <IconInbox size={17} />)}
      {can('customers.read') && item('/customers', 'Customers', <IconUserCircle size={17} />)}
      {can('conversations.read') && item('/decisions', 'Decisions', <IconActivity size={17} />)}
      {can('conversations.read') && item('/escalations', 'Waiting for a human', <IconAlertCircle size={17} />)}
      {can('conversations.read') && item('/escalations/config', 'Escalation', <IconShieldAlert size={17} />)}
      {can('reports.view') && item('/reports', 'Reports', <IconBarChart size={17} />)}

      <div className="nav-group">Channels</div>
      {can('channels.read') && item('/channels/whatsapp', 'WhatsApp', <IconMessageCircle size={17} />)}
      {can('groups.read') && item('/groups', 'Groups', <IconRadio size={17} />, true)}
      {can('groups.read') && item('/groups/onboarding', 'Group onboarding', <IconUsers size={17} />)}
      {can('team.manage') && item('/support-members', 'Support members', <IconUsers size={17} />, true)}
      {can('team.manage') && item('/support-activity', 'Support activity', <IconRadio size={17} />)}

      <div className="nav-group">Knowledge &amp; AI</div>
      {can('knowledge.read') && item('/knowledge', 'Knowledge', <IconBookOpen size={17} />)}
      {can('automation.read') && item('/automation', 'Automation', <IconZap size={17} />)}
      {can('automation.read') && item('/automation/candidates', 'Proposed automation', <IconLightbulb size={17} />)}
      {can('settings.read') && item('/ai/providers', 'AI', <IconSparkles size={17} />)}

      <div className="nav-group">Outbound</div>
      {can('broadcast.create') && item('/broadcasts', 'Broadcasts', <IconMegaphone size={17} />)}
      {can('automation.simulate') && item('/copilot', 'Copilot', <IconBot size={17} />)}

      <div className="nav-group">System</div>
      {can('settings.read') && item('/settings', 'Settings', <IconSettings size={17} />, true)}
      {can('settings.read') && item('/settings/rate-limits', 'Rate limits', <IconSliders size={17} />)}
      {can('settings.read') && item('/emergency', 'Emergency', <IconOctagonAlert size={17} />)}

      <div className="sidebar-version">Support CRM {CONSOLE_VERSION}</div>
    </nav>
  );
}

/** Sits above every screen: the sidebar collapse toggle and the account menu. Nothing here is
 * decorative — no search box or notification bell that leads nowhere, because this console does
 * not have a search-everything endpoint or a notifications feed to back one. */
function Topbar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <div className="topbar">
      <button type="button" className="topbar-toggle" onClick={onToggle} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
        <IconMenuLines />
      </button>
      <div className="topbar-spacer" />
      <ThemeToggle />
      <UserMenu />
    </div>
  );
}

type Theme = 'dark' | 'light';
const THEME_KEY = 'support-crm:theme';

/**
 * Light and dark, as a control rather than a guess.
 *
 * Defaults to whatever the operating system asks for — the stylesheet handles that on its own with
 * no attribute set — and only writes `data-theme` once somebody actually chooses, so a machine that
 * switches to dark in the evening keeps following along until the operator overrides it.
 */
function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(() => {
    const stored = globalThis.localStorage?.getItem(THEME_KEY);
    return stored === 'dark' || stored === 'light' ? stored : null;
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme) {
      root.setAttribute('data-theme', theme);
      globalThis.localStorage?.setItem(THEME_KEY, theme);
    } else {
      root.removeAttribute('data-theme');
      globalThis.localStorage?.removeItem(THEME_KEY);
    }
  }, [theme]);

  const systemDark = globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
  const showingDark = theme ? theme === 'dark' : systemDark;

  return (
    <button
      type="button"
      className="topbar-toggle"
      onClick={() => setTheme(showingDark ? 'light' : 'dark')}
      title={showingDark ? 'Switch to light' : 'Switch to dark'}
      aria-label={showingDark ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      {showingDark ? <IconSun size={17} /> : <IconMoon size={17} />}
    </button>
  );
}

function IconMenuLines() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
      <path d="M4 6h16" />
      <path d="M4 12h16" />
      <path d="M4 18h16" />
    </svg>
  );
}

function UserMenu() {
  const { user, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const displayName = user?.name ?? user?.username ?? '';
  const initials =
    displayName
      .trim()
      .split(/\s+/)
      .map((part) => part[0])
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?';
  const role = user?.roles?.[0] ? humanise(user.roles[0]) : 'Operator';

  return (
    <div className="user-menu" ref={ref}>
      <button type="button" className="user-menu-trigger" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="avatar">{initials}</span>
        <span>
          <div className="user-menu-name">{displayName}</div>
          <div className="user-menu-role">{role}</div>
        </span>
        <IconChevronDown size={15} />
      </button>
      {open && (
        <div className="user-menu-panel" role="menu">
          <div className="user-menu-panel-head">
            <div className="user-menu-name">{displayName}</div>
            <div className="user-menu-role">{user?.email}</div>
          </div>
          <button type="button" className="user-menu-item" onClick={() => void signOut()}>
            <IconLogOut size={15} />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
