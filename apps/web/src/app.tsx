import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth-context';
import { humanise, ToastProvider } from './components/ui';
import { IconChevronDown, IconLogOut, IconMoon, IconSun } from './components/icons';
import { WorkspaceFrame } from './components/workspace-shell';
const AIProvidersPage = lazy(() => import('./pages/ai/providers').then(module => ({ default: module.AIProvidersPage })));
const AIVoicePage = lazy(() => import('./pages/ai/voice').then(module => ({ default: module.AIVoicePage })));
const AutomationProfilesPage = lazy(() => import('./pages/automation/profiles').then(module => ({ default: module.AutomationProfilesPage })));
const AutomationRuleEditorPage = lazy(() => import('./pages/automation/rule-editor').then(module => ({ default: module.AutomationRuleEditorPage })));
const AutomationRulesPage = lazy(() => import('./pages/automation/rules').then(module => ({ default: module.AutomationRulesPage })));
const BulkActionsPage = lazy(() => import('./pages/automation/bulk').then(module => ({ default: module.BulkActionsPage })));
const CandidatesPage = lazy(() => import('./pages/automation/candidates').then(module => ({ default: module.CandidatesPage })));
const BroadcastsPage = lazy(() => import('./pages/broadcasts').then(module => ({ default: module.BroadcastsPage })));
const ConversationsPage = lazy(() => import('./pages/conversations').then(module => ({ default: module.ConversationsPage })));
const CopilotPage = lazy(() => import('./pages/copilot').then(module => ({ default: module.CopilotPage })));
const CustomersPage = lazy(() => import('./pages/customers').then(module => ({ default: module.CustomersPage })));
const DashboardPage = lazy(() => import('./pages/dashboard').then(module => ({ default: module.DashboardPage })));
const DecisionsPage = lazy(() => import('./pages/decisions').then(module => ({ default: module.DecisionsPage })));
const EmergencyPage = lazy(() => import('./pages/emergency').then(module => ({ default: module.EmergencyPage })));
const EscalationConfigPage = lazy(() => import('./pages/escalation-config').then(module => ({ default: module.EscalationConfigPage })));
const EscalationsPage = lazy(() => import('./pages/escalations').then(module => ({ default: module.EscalationsPage })));
const GroupsPage = lazy(() => import('./pages/groups').then(module => ({ default: module.GroupsPage })));
const GroupOperationsPage = lazy(() => import('./pages/groups/operations').then(module => ({ default: module.GroupOperationsPage })));
const GroupDetailPage = lazy(() => import('./pages/groups/detail').then(module => ({ default: module.GroupDetailPage })));
const SupportMembersPage = lazy(() => import('./pages/support/members').then(module => ({ default: module.SupportMembersPage })));
const SupportMemberDetailPage = lazy(() => import('./pages/support/member-detail').then(module => ({ default: module.SupportMemberDetailPage })));
const SupportActivityPage = lazy(() => import('./pages/support/activity').then(module => ({ default: module.SupportActivityPage })));
const OnboardingRulesPage = lazy(() => import('./pages/groups/onboarding').then(module => ({ default: module.OnboardingRulesPage })));
const KnowledgeBrowserPage = lazy(() => import('./pages/knowledge/browser').then(module => ({ default: module.KnowledgeBrowserPage })));
const KnowledgeCandidatesPage = lazy(() => import('./pages/knowledge/candidates').then(module => ({ default: module.KnowledgeCandidatesPage })));
const KnowledgeEditorPage = lazy(() => import('./pages/knowledge/editor').then(module => ({ default: module.KnowledgeEditorPage })));
import { LoginPage } from './pages/login';
const ReportsPage = lazy(() => import('./pages/reports').then(module => ({ default: module.ReportsPage })));
const SettingsPage = lazy(() => import('./pages/settings').then(module => ({ default: module.SettingsPage })));
const RateLimitsPage = lazy(() => import('./pages/settings/rate-limits').then(module => ({ default: module.RateLimitsPage })));
const WhatsAppAccountPage = lazy(() => import('./pages/whatsapp-account').then(module => ({ default: module.WhatsAppAccountPage })));
const WhatsAppAccountsPage = lazy(() => import('./pages/whatsapp-accounts').then(module => ({ default: module.WhatsAppAccountsPage })));
import { OverviewPage } from './pages/workspace/overview';
const BillingPage = lazy(() => import('./pages/workspace/billing').then(module => ({ default: module.BillingPage })));
const TeamWorkspacePage = lazy(() => import('./pages/workspace/team').then(module => ({ default: module.TeamWorkspacePage })));
const NotificationsPage = lazy(() => import('./pages/workspace/notifications').then(module => ({ default: module.NotificationsPage })));
const SavedRepliesPage = lazy(() => import('./pages/workspace/replies').then(module => ({ default: module.SavedRepliesPage })));
const ReleasesPage = lazy(() => import('./pages/workspace/releases').then(module => ({ default: module.ReleasesPage })));
const JobsPage = lazy(() => import('./pages/workspace/jobs').then(module => ({ default: module.JobsPage })));
const SupportQueuePage = lazy(() => import('./pages/workspace/queue').then(module => ({ default: module.SupportQueuePage })));
const AccessPage = lazy(() => import('./pages/workspace/access').then(module => ({ default: module.AccessPage })));
const CustomerProfilePage = lazy(() => import('./pages/workspace/customer').then(module => ({ default: module.CustomerProfilePage })));



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
      <WorkspaceFrame controls={<><ThemeToggle /><UserMenu /></>}>
            <Suspense fallback={<div className="progress"><span className="spinner" /><span className="muted">Loading workspace?</span></div>}>
            <Routes>
              <Route path="/" element={<OverviewPage />} />
              <Route path="/analytics" element={<Access permission="reports.view"><DashboardPage /></Access>} />
              <Route path="/support-queue" element={<Access permission="conversations.read"><SupportQueuePage /></Access>} />
              <Route path="/billing" element={<Access permission="billing.read"><BillingPage /></Access>} />
              <Route path="/team" element={<Access permission="team.manage"><TeamWorkspacePage /></Access>} />
              <Route path="/saved-replies" element={<Access permission="messages.read"><SavedRepliesPage /></Access>} />
              <Route path="/jobs" element={<Access permission="jobs.read"><JobsPage /></Access>} />
              <Route path="/notifications" element={<NotificationsPage />} />
              <Route path="/changelog" element={<ReleasesPage />} />
              <Route path="/access" element={<Access permission="users.read"><AccessPage /></Access>} />

              {/* Conversations and customers */}
              <Route path="/conversations" element={<ConversationsPage />} />
              <Route path="/customers" element={<CustomersPage />} />
              <Route path="/customers/:id" element={<Access permission="customers.read"><CustomerProfilePage /></Access>} />

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
            </Suspense>
      </WorkspaceFrame>
    </ToastProvider>
  );
}

function Access({ permission, children }: { permission: string; children: ReactNode }) {
  const { can } = useAuth();
  return can(permission) ? children : <div className="empty"><h1>Access restricted</h1><p className="muted">Your role does not include access to this module.</p><Link to="/">Back to overview</Link></div>;
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
