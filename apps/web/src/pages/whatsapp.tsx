import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { whatsapp, type WhatsAppAccount } from '../api/client';
import { useAuth } from '../auth-context';
import { onChannelStatus } from '../api/realtime';
import { WhatsAppIcon } from '../components/whatsapp-icons';
import { ErrorState, Loading } from '../components/ui';
import { WhatsAppToolsPage } from './whatsapp-tools';
import '../whatsapp.css';
const Chats = lazy(() => import('./conversations').then(m => ({ default: m.ConversationsPage })));
const Accounts = lazy(() => import('./whatsapp-accounts').then(m => ({ default: m.WhatsAppAccountsPage })));
const Account = lazy(() => import('./whatsapp-account').then(m => ({ default: m.WhatsAppAccountPage })));
const Groups = lazy(() => import('./groups/operations').then(m => ({ default: m.GroupOperationsPage })));
const Group = lazy(() => import('./groups/detail').then(m => ({ default: m.GroupDetailPage })));
const GroupDirectory = lazy(() => import('./groups').then(m => ({ default: m.GroupsPage })));
const Onboarding = lazy(() => import('./groups/onboarding').then(m => ({ default: m.OnboardingRulesPage })));
const Replies = lazy(() => import('./workspace/replies').then(m => ({ default: m.SavedRepliesPage })));
const Queue = lazy(() => import('./workspace/queue').then(m => ({ default: m.SupportQueuePage })));
const Broadcasts = lazy(() => import('./broadcasts').then(m => ({ default: m.BroadcastsPage })));
const Labels=lazy(()=>import('./whatsapp-labels').then(m=>({default:m.WhatsAppLabelsPage})));
const Updates = lazy(() => import('./whatsapp-updates').then(m => ({ default: m.WhatsAppUpdatesPage })));
const Explore = lazy(() => import('./whatsapp-explore').then(m => ({ default: m.WhatsAppExplorePage })));
const Schedules = lazy(() => import('./whatsapp-schedules').then(m => ({ default: m.WhatsAppSchedulesPage })));
const Events = lazy(() => import('./whatsapp-events').then(m => ({ default: m.WhatsAppEventsPage })));
const Settings = lazy(() => import('./whatsapp-settings').then(m => ({ default: m.WhatsAppSettingsPage })));
const rail = [['', 'Chats', 'chat', 'conversations.read'], ['updates', 'Updates', 'updates', 'messages.read'], ['channels', 'Channels', 'channels', 'channels.read'], ['groups', 'Groups', 'groups', 'groups.read'], ['scheduled', 'Scheduled', 'clock', 'messages.read'], ['tools', 'All features', 'tools', 'channels.read']] as const;
function Gate({ permission, children }: {
    permission: string;
    children: ReactNode;
}) { const { can } = useAuth(); return can(permission) ? children : <div className="wa-access"><WhatsAppIcon name="lock" size={40}/><h2>Access restricted</h2><p>Your role does not include this feature.</p></div>; }
export function WhatsAppWorkspacePage() {
    const { user, can } = useAuth();
    const [params, setParams] = useSearchParams();
    const [accounts, setAccounts] = useState<WhatsAppAccount[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const location = useLocation();
    const navigate = useNavigate();
    const account = params.get('account') ?? '';
    const active = accounts.find(a => a.id === location.pathname.match(/\/whatsapp\/accounts\/([0-9a-f-]{36})/)?.[1]) ?? accounts.find(a => a.id === account) ?? accounts.find(a => a.connected) ?? accounts[0];
    useEffect(() => { let live = true; const load = () => void whatsapp.overview().then(page => { if (live) {
        setAccounts(page.items);
        setLoading(false);
        setError(null);
    } }).catch(e => { if (live) {
        setError(e.message);
        setLoading(false);
    } }); load(); const off = onChannelStatus(load); return () => { live = false; off(); }; }, []);
    const suffix = active ? `?account=${active.id}` : '';
    const section = location.pathname.slice('/whatsapp'.length).split('/').filter(Boolean)[0] ?? '';
    return <section className="wa-workspace" aria-label="WhatsApp workspace"><nav className="wa-rail" aria-label="WhatsApp sections"><Link to={`/whatsapp${suffix}`} className="wa-brand" aria-label="WhatsApp"><WhatsAppIcon size={27}/></Link><div className="wa-rail-main">{rail.filter(([, , , p]) => can(p)).map(([to, label, icon]) => <NavLink key={to} to={`/whatsapp${to ? `/${to}` : ''}${suffix}`} end={!to} className={section === to ? 'wa-rail-link active' : 'wa-rail-link'} aria-label={label} title={label}><WhatsAppIcon name={icon}/><span>{label}</span>{to === '' && <i className="wa-active-dot"/>}</NavLink>)}</div><NavLink to={`/whatsapp/accounts${suffix}`} className="wa-rail-link" title="Linked devices" aria-label="Linked devices"><WhatsAppIcon name="account"/><span>Devices</span></NavLink><NavLink to={`/whatsapp/settings${suffix}`} className="wa-rail-link" title="WhatsApp settings" aria-label="WhatsApp settings"><WhatsAppIcon name="settings"/><span>Settings</span></NavLink><span className="wa-my-avatar" title={user?.name}>{user?.name?.charAt(0).toUpperCase() ?? 'U'}</span></nav>
 <div className="wa-window"><header className="wa-workspace-head"><div><strong>WhatsApp</strong><span className="wa-workspace-subtitle">Your conversations, connected.</span></div><div className="wa-account-switch"><span className={`wa-connection-dot${active?.connected ? ' connected' : ''}`}/><select aria-label="Active WhatsApp number" value={active?.id ?? ''} onChange={e => { const next = new URLSearchParams(params); next.set('account', e.target.value); if (/^\/whatsapp\/accounts\/[0-9a-f-]{36}/.test(location.pathname))
        navigate(`/whatsapp/accounts/${e.target.value}?${next}`);
    else
        setParams(next, { replace: true }); }}>{accounts.length ? accounts.map(a => <option key={a.id} value={a.id}>{a.name}{a.phoneNumber ? ` · ${a.phoneNumber}` : ''}</option>) : <option value="">No linked number</option>}</select>{can('channels.manage') && <Link to="/whatsapp/accounts" className="wa-head-add" aria-label="Link another number" title="Link another number"><WhatsAppIcon name="plus" size={20}/></Link>}</div></header>
 {error && <div className="wa-window-error"><ErrorState message={error}/></div>}
 <div className="wa-window-body"><Suspense fallback={<Loading label="Opening WhatsApp…"/>}>{loading ? <Loading label="Loading your accounts…"/> : <Routes>
  <Route index element={<Gate permission="conversations.read"><Chats embedded externalAccount={active?.id}/></Gate>}/>
  <Route path="chats" element={<Gate permission="conversations.read"><Chats embedded externalAccount={active?.id}/></Gate>}/>
  <Route path="tools" element={<WhatsAppToolsPage accountId={active?.id ?? ''}/>}/>
  <Route path="updates" element={<Gate permission="messages.read"><Updates key={active?.id} accountId={active?.id ?? ''}/></Gate>}/>
  <Route path="channels" element={<Gate permission="messages.read"><Explore key={active?.id} accountId={active?.id ?? ''} channels/></Gate>}/>
  <Route path="scheduled" element={<Gate permission="messages.read"><Schedules key={active?.id} accountId={active?.id ?? ''}/></Gate>}/>
  <Route path="labels" element={<Gate permission="conversations.read"><Labels key={active?.id} accountId={active?.id??''}/></Gate>}/>
  <Route path="history" element={<Gate permission="messages.read"><Explore key={active?.id} accountId={active?.id ?? ''}/></Gate>}/>
  <Route path="events" element={<Events accountId={active?.id ?? ''}/>}/>
  <Route path="settings" element={<Settings key={active?.id} accountId={active?.id ?? ''}/>}/>
  <Route path="accounts" element={<div className="wa-subpage"><Gate permission="channels.read"><Accounts /></Gate></div>}/>
  <Route path="accounts/:accountId" element={<div className="wa-subpage"><Gate permission="channels.read"><Account /></Gate></div>}/>
  <Route path="accounts/:accountId/groups" element={<div className="wa-subpage"><Gate permission="groups.read"><p className="wa-notice" role="status">WhatsApp group discovery may return approximately 500 joined groups. Previously stored groups stay available; refresh a known group individually when needed.</p><GroupDirectory /></Gate></div>}/>
  <Route path="groups" element={<div className="wa-subpage"><Gate permission="groups.read"><Groups /></Gate></div>}/>
  <Route path="groups/onboarding" element={<div className="wa-subpage"><Gate permission="groups.read"><Onboarding /></Gate></div>}/>
  <Route path="groups/:id" element={<div className="wa-subpage"><Gate permission="groups.read"><Group /></Gate></div>}/>
  <Route path="replies" element={<div className="wa-subpage"><Gate permission="messages.read"><Replies /></Gate></div>}/>
  <Route path="assignments" element={<div className="wa-subpage"><Gate permission="conversations.read"><Queue /></Gate></div>}/>
  <Route path="broadcasts" element={<div className="wa-subpage"><Gate permission="broadcast.create"><Broadcasts /></Gate></div>}/>
  <Route path="*" element={<Navigate to={`/whatsapp${suffix}`} replace/>}/>
 </Routes>}</Suspense></div></div></section>;
}
/** Retain bookmarked CRM destinations while presenting only one WhatsApp navigation entry. */
export function WhatsAppAlias({ section }: {
    section: string;
}) { const { accountId, id } = useParams(); const location = useLocation(); const target = section.replace(':accountId', accountId ?? '').replace(':id', id ?? ''); return <Navigate to={`/whatsapp${target ? `/${target}` : ''}${location.search}`} replace/>; }
