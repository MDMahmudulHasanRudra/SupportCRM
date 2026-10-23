import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth-context';
import { availableNavigation, currentDestination } from '../navigation';
import { IconMessageCircle, IconSparkles } from './icons';

export function Brand({ subtitle = false }: { subtitle?: boolean }) {
  return <div className="brand"><span className="brand-mark"><IconMessageCircle size={20} /></span><span className="brand-word">Support<span className="brand-word-accent">CRM</span>{subtitle && <small>Your support workspace</small>}</span></div>;
}

function Sidebar({ mobile = false, onNavigate }: { mobile?: boolean; onNavigate?: () => void }) {
  const { can } = useAuth(); const items = availableNavigation(can);
  const groups = [...new Set(items.map(item => item.section))];
  return <nav className={`sidebar${mobile ? ' mobile-sidebar' : ''}`} aria-label={mobile ? 'Mobile navigation' : 'Main navigation'}><Brand subtitle /><div className="sidebar-scroll">{groups.map(section => <div className="sidebar-section" key={section}><div className="nav-group">{section}</div>{items.filter(i => i.section === section).map(({ to, label, icon: Icon, end }) => <NavLink key={to} to={to} end={end} onClick={onNavigate} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} title={label}><Icon size={18} /><span>{label}</span></NavLink>)}</div>)}</div><div className="sidebar-bottom"><span className="sidebar-bottom-icon"><IconSparkles size={17} /></span><div><strong>One connected workspace</strong><small>Support CRM · v0.2</small></div></div></nav>;
}

function SearchIcon() { return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>; }
function MenuIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16M4 12h10M4 18h16" /></svg>; }
function BellIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>; }

function PageFinder({ onClose }: { onClose: () => void }) {
  const { can } = useAuth(); const navigate = useNavigate(); const [query, setQuery] = useState(''); const [index, setIndex] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null); const input = useRef<HTMLInputElement>(null);
  const items = availableNavigation(can).filter(item => `${item.label} ${item.description} ${item.section} ${item.keywords || ''}`.toLowerCase().includes(query.toLowerCase().trim()));
  useEffect(() => { const el = dialog.current; el?.showModal(); input.current?.focus(); return () => el?.close(); }, []);
  function select(to: string) { navigate(to); onClose(); }
  return <dialog ref={dialog} className="page-finder" aria-label="Find a page" onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === dialog.current) onClose(); }}><div className="finder-input"><SearchIcon /><input ref={input} value={query} onChange={e => { setQuery(e.target.value); setIndex(0); }} placeholder="Where would you like to go?" aria-label="Search available pages" aria-controls="page-finder-results" onKeyDown={e => { if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(i => Math.min(i + 1, items.length - 1)); } if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(i => Math.max(i - 1, 0)); } if (e.key === 'Enter' && items[index]) { e.preventDefault(); select(items[index].to); } }} /><button onClick={onClose} aria-label="Close page finder"><kbd>Esc</kbd></button></div><div className="finder-label">{query ? `${items.length} matching pages` : 'JUMP TO A PAGE'}</div><div className="finder-results" id="page-finder-results">{items.map((item,i) => <button className={`finder-result${i === index ? ' selected' : ''}`} key={item.to} onClick={() => select(item.to)} onFocus={() => setIndex(i)}><span className="finder-result-icon"><item.icon size={19} /></span><span><strong>{item.label}</strong><small>{item.description}</small></span><span className="finder-section">{item.section}</span><span aria-hidden="true">↵</span></button>)}{!items.length && <div className="empty"><h2>No matching pages</h2><p className="muted">Try “WhatsApp”, “customers” or “knowledge”.</p></div>}</div><footer><span>Searches pages you can access</span><span><kbd>↑</kbd><kbd>↓</kbd> Navigate <kbd>↵</kbd> Open</span></footer></dialog>;
}

function MobileDrawer({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const el = ref.current; el?.showModal(); return () => el?.close(); }, []);
  return <dialog ref={ref} className="navigation-drawer" aria-label="Workspace navigation" onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === ref.current) onClose(); }}><button className="drawer-close" onClick={onClose} aria-label="Close navigation">×</button><Sidebar mobile onNavigate={onClose} /></dialog>;
}

export function WorkspaceFrame({ children, controls }: { children: ReactNode; controls: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false); const [mobile, setMobile] = useState(false); const [finder, setFinder] = useState(false);
  const [compact, setCompact] = useState(() => globalThis.matchMedia?.('(max-width: 860px)').matches ?? false);
  const location = useLocation(); const current = currentDestination(location.pathname);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 860px)');
    const change = (event: MediaQueryListEvent) => { setCompact(event.matches); if (!event.matches) setMobile(false); };
    media.addEventListener?.('change', change); return () => media.removeEventListener?.('change', change);
  }, []);
  useEffect(() => {
    function keyboard(e: KeyboardEvent) { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setFinder(open => !open); } }
    window.addEventListener('keydown', keyboard); return () => window.removeEventListener('keydown', keyboard);
  }, []);
  return <div className={`shell${collapsed ? ' collapsed' : ''}`}><a href="#main-content" className="skip-link">Skip to content</a><Sidebar /><div className="workspace-content"><header className="topbar"><button className="topbar-toggle" aria-label="Toggle navigation" aria-expanded={compact ? mobile : !collapsed} onClick={() => { if (compact) setMobile(true); else setCollapsed(v => !v); }}><MenuIcon /></button><div className="topbar-breadcrumb"><span>{current.section}</span><span aria-hidden="true">/</span><strong>{current.label}</strong></div><div className="topbar-spacer" /><button className="page-finder-trigger" onClick={() => setFinder(true)} aria-label="Find a page"><SearchIcon /><span>Find a page…</span><kbd>⌘ / Ctrl K</kbd></button><div className="topbar-divider" /><Link to="/notifications" className="topbar-notifications" aria-label="Open notifications"><BellIcon /></Link>{controls}</header><main className="main" id="main-content" tabIndex={-1} key={location.pathname.startsWith('/whatsapp')?'/whatsapp':location.pathname}>{children}</main><footer className="app-footer"><span>Support CRM</span><span>A little clarity. A better conversation.</span></footer></div>{mobile && <MobileDrawer onClose={() => setMobile(false)} />}{finder && <PageFinder onClose={() => setFinder(false)} />}</div>;
}
