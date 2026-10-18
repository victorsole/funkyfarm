import { Component, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Outlet, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ChevronRight, ClipboardList, House, Inbox, LayoutDashboard, Lock, Map as MapIcon, Monitor, Moon, NotebookPen, Sparkles, Sprout, Sun, Wrench, type LucideIcon } from 'lucide-react';
import { api, errorMessage } from './api';
import { useSession } from './auth';
import { Button, Loading, Notice } from './components';
import type { Session } from './types';
import { useI18n, Text, type TranslationKey } from './i18n';
import { HomePage, FarmPage, FarmDetailPage } from './pages/Core';
import { RequestsPage, RequestDetailPage } from './pages/Requests';
import { CasesPage, NewCasePage, CaseDetailPage } from './pages/Cases';
import { CapExamplePage } from './pages/CapExample';
import { DemoWorkspacePage } from './pages/DemoWorkspace';
import { HackathonDemoPage } from './pages/HackathonDemo';
import { EasyFarmFormPage } from './pages/EasyFarmForm';
import { PublicDemoPage } from './pages/PublicDemo';
import { ParcelCheckPage } from './pages/ParcelCheck';
import { CorrectionWizardPage } from './pages/CorrectionWizard';
import { TasksPage, TaskPage } from './pages/Task';
import { DocumentsPage, DocumentDetailPage } from './pages/Documents';
import { ReportsPage, ReportDetailPage } from './pages/Reports';
import { GuidancePage, GuidanceDetailPage, SettingsPage } from './pages/Support';
import { ToolsPage, farmTools } from './pages/Tools';
import { RecordWorkPage } from './pages/RecordWork';
import { AdviserPage } from './pages/Adviser';
import { ImportsPage } from './pages/ImportPage';
import { SatellitePage } from './pages/Satellite';
import { Connections } from './pages/Connections';
import { HelpPage } from './pages/Help';
import { CompliancePage, UpdatesPage, UpdateDetailPage } from './pages/Compliance';
import { CommunityPage, CommunityComposePage, CommunityThreadPage, PrivateCommunityPage } from './pages/Community';
import { FundingPage } from './pages/FundingPage';
import { AssistantConnect } from './pages/AssistantConnect';
import { mountWebMCP } from './webmcp';
import { readTheme, saveTheme, type ThemeChoice } from './theme';
import { DashboardTabs, dashboardFor, roleLabel } from './dashboard';
import { AdviserInboxPage, AdviserMapPage, FarmerMapPage, MyAdviserPage } from './pages/Dashboards';
import './pages/administration.css';
import './brand.css';

const primary = [
  { path: 'home', name: 'Home', detail: 'What needs doing', icon: 'home', label: 'nav.home' },
  { path: 'fields', name: 'My fields', detail: 'Land, crops and farm details', icon: 'farm', label: 'nav.fields' },
  { path: 'paperwork', name: 'Paperwork', detail: 'Requests and deadlines', icon: 'requests', label: 'nav.paperwork' },
  { path: 'record-work', name: 'Notebook', detail: 'Work, purchases and sales', icon: 'work', label: undefined },
  { path: 'tools', name: 'Tools', detail: 'All farm tools', icon: 'documents', label: undefined },
];
// Advisers (including civil servants at farmer-help offices) work across the farms that granted them access.
const adviserNav = [
  { path: 'adviser', name: 'Overview', detail: 'Farms and findings', icon: 'dashboard', label: undefined, end: true },
  { path: 'adviser/map', name: 'Map', detail: 'All farms on my desk', icon: 'map', label: undefined, end: false },
  { path: 'adviser/inbox', name: 'Inbox', detail: 'Farmers’ questions', icon: 'inbox', label: undefined, end: false },
  { path: 'tools', name: 'Tools', detail: 'All farm tools', icon: 'documents', label: undefined, end: false },
];

function BrandMark({ className = '' }: { className?: string }) {
  return <img className={`funkyfarm-logo ${className}`} width="640" height="571" src="/assets/funkyfarm-logo.png" alt="Funkyfarm" />;
}

const visibleName = (value: string | undefined, fallback: string) => (value || '').replace(/^\s*FICTIONAL(?:[\s:—–_-]+|$)/i, '') || fallback;

const navIcons: Record<string, LucideIcon> = { home: House, farm: Sprout, requests: ClipboardList, work: NotebookPen, documents: Wrench, dashboard: LayoutDashboard, map: MapIcon, inbox: Inbox };
function NavIcon({ name }: { name: string }) {
  const Icon = navIcons[name] ?? Wrench;
  return <Icon aria-hidden="true"/>;
}

function Chevron({ className = '' }: { className?: string }) {
  return <ChevronRight className={className} aria-hidden="true"/>;
}

const themeOptions: { value: ThemeChoice; label: string; icon: LucideIcon }[] = [
  { value: 'system', label: 'Auto', icon: Monitor }, { value: 'light', label: 'Light', icon: Sun }, { value: 'dark', label: 'Dark', icon: Moon },
];
function ThemeSwitch() {
  const [choice, setChoice] = useState<ThemeChoice>(readTheme);
  return <fieldset className="theme-choice"><legend>Appearance</legend><div className="theme-options">{themeOptions.map(({ value, label, icon: Icon }) =>
    <label key={value}><input type="radio" name="theme-choice" value={value} checked={choice === value} onChange={() => { saveTheme(value); setChoice(value); }}/><Icon aria-hidden="true"/>{label}</label>)}</div></fieldset>;
}

const funkyWords = [['F', 'Fields'], ['U', 'Uploaded'], ['N', 'Notified'], ['K', 'Kept'], ['Y', 'Yearly']];

function useConnection() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const connected = () => setOnline(true);
    const disconnected = () => setOnline(false);
    window.addEventListener('online', connected);
    window.addEventListener('offline', disconnected);
    return () => { window.removeEventListener('online', connected); window.removeEventListener('offline', disconnected); };
  }, []);
  return online;
}

function LegacyRedirect({ to }: { to: string }) {
  const { id } = useParams();
  const location = useLocation();
  return <Navigate replace to={{ pathname: id ? `${to}/${encodeURIComponent(id)}` : to, search: location.search, hash: location.hash }}/>;
}

class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <section className="panel"><h1>This page could not open.</h1><p>Your saved records are still in the workspace. Reload this page to try again.</p><Button onClick={() => window.location.reload()}>Reload page</Button></section> : this.props.children;
  }
}

function Shell() {
  const { session, logout, switchWorkspace, error: sessionError } = useSession();
  const { t } = useI18n();
  const location = useLocation();
  const online = useConnection();
  const [workspaces, setWorkspaces] = useState<Session['workspace'][]>([]);
  useEffect(() => {
    let active = true;
    let sequence = 0;
    const reloadWorkspaces = () => {
      const current = ++sequence;
      void api.get<{ items: Session['workspace'][] }>('/workspaces')
        .then(result => { if (active && current === sequence) setWorkspaces(result.items); })
        .catch(failure => { if (active && current === sequence) setLogoutError(errorMessage(failure)); });
    };
    reloadWorkspaces();
    window.addEventListener('workspaces-changed', reloadWorkspaces);
    return () => { active = false; sequence += 1; window.removeEventListener('workspaces-changed', reloadWorkspaces); };
  }, [session?.user.id, session?.workspace]);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const caseSection = location.pathname === '/app/cases' || location.pathname.startsWith('/app/cases/');
  // Two roles: Farmer and Adviser. Inside a client's workspace the Adviser dashboard is fixed; a person
  // who also farms chooses which dashboard to use (remembered in this browser only). Choosing Farmer from a
  // client's workspace returns to the person's own workspace, last used first.
  const hasAdviserAccess = workspaces.some(workspace => workspace.role === 'adviser');
  const ownWorkspaces = workspaces.filter(workspace => workspace.role !== 'adviser');
  useEffect(() => {
    if (session && session.workspace.role !== 'adviser') try { localStorage.setItem('funkyfarm.farmer-workspace', session.workspace.id); } catch { /* Optional browser storage. */ }
  }, [session?.workspace.id, session?.workspace.role]);
  const [preferred, setPreferred] = useState<'farmer' | 'adviser' | null>(() => { try { const stored = localStorage.getItem('funkyfarm.dashboard'); return stored === 'farmer' || stored === 'adviser' ? stored : null; } catch { return null; } });
  const mode: 'farmer' | 'adviser' = session?.workspace.role === 'adviser' ? 'adviser' : hasAdviserAccess ? preferred ?? 'adviser' : 'farmer';
  const navigateTo = useNavigate();
  async function chooseDashboard(next: 'farmer' | 'adviser') {
    setPreferred(next);
    try { localStorage.setItem('funkyfarm.dashboard', next); } catch { /* Optional browser storage. */ }
    document.querySelector('.account-menu')?.removeAttribute('open');
    if (next === 'farmer' && session?.workspace.role === 'adviser') {
      let last: string | null = null;
      try { last = localStorage.getItem('funkyfarm.farmer-workspace'); } catch { /* Optional browser storage. */ }
      const own = ownWorkspaces.find(workspace => workspace.id === last) ?? ownWorkspaces[0];
      if (own) await switchWorkspace(own.id).catch(() => undefined);
    }
    navigateTo(next === 'adviser' ? '/app/adviser' : '/app/home');
  }
  const tabs = dashboardFor(location.pathname, mode);
  useEffect(() => mountWebMCP(), [session?.user.id, session?.workspace.id]);
  useEffect(() => {
    const page = caseSection ? 'Paperwork' : (location.pathname === '/app/map' ? 'My map' : location.pathname === '/app/my-adviser' ? 'My adviser' : location.pathname.startsWith('/app/adviser') ? `Adviser ${[...adviserNav].reverse().find(item => location.pathname.startsWith(`/app/${item.path}`))?.name.toLowerCase() ?? 'desk'}` : primary.find(item => location.pathname.startsWith(`/app/${item.path}`))?.name
      ?? farmTools.find(tool => location.pathname.startsWith(`/app/${tool.path}`))?.title ?? 'Workspace');
    document.title = `${page} · Funkyfarm`;
    if (location.hash) {
      let fragment = location.hash.slice(1);
      try { fragment = decodeURIComponent(fragment); } catch { /* Keep malformed fragments harmless. */ }
      const target = document.getElementById(fragment);
      target?.scrollIntoView({ behavior: 'instant', block: 'start' });
    } else {
      document.getElementById('main-content')?.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: 'instant' });
    }
  }, [location.pathname, location.hash]);
  async function signOut() {
    setSigningOut(true);
    setLogoutError(null);
    try { await logout(); } catch (failure) { setLogoutError(errorMessage(failure)); } finally { setSigningOut(false); }
  }
  return <div className="workspace-shell">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside className="sidebar">
      <Link to="/app/home" className="brand" aria-label="Funkyfarm home"><BrandMark /></Link>
      <div className="workspace-label"><label className="eyebrow" htmlFor="workspace-choice">Your workspace</label>{workspaces.length > 1 ? <select id="workspace-choice" aria-label="Switch workspace" value={session?.workspace.id} onChange={event => { void switchWorkspace(event.target.value).catch(() => undefined); }}>{workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{visibleName(workspace.name, 'Farm workspace')} · {roleLabel(workspace.role)}</option>)}</select> : <strong>{visibleName(session?.workspace.name, 'Farm workspace')}</strong>}</div>
      <nav className="primary-nav" aria-label="Main navigation">{mode === 'adviser' ? adviserNav.map(item => <NavLink key={item.path} end={item.end} to={`/app/${item.path}`} className={({ isActive }) => `nav-link${isActive ? ' is-active' : ''}`}><NavIcon name={item.icon}/><span>{item.name}<small>{item.detail}</small></span><Chevron className="nav-indicator"/></NavLink>) : primary.map(item => <NavLink key={item.path} to={`/app/${item.path}`} aria-label={caseSection && item.path === 'paperwork' ? `${item.label ? t(item.label as TranslationKey) : item.name}, current section` : undefined} className={({ isActive }) => `nav-link${isActive || caseSection && item.path === 'paperwork' ? ' is-active' : ''}`}><NavIcon name={item.icon}/><span>{item.label ? t(item.label as TranslationKey) : item.name}<small>{item.detail}</small></span><Chevron className="nav-indicator"/></NavLink>)}</nav>
      <div className="sidebar-bottom"><span className="private-label"><Lock aria-hidden="true"/> Private farm records</span></div>
    </aside>
    <div className="workspace-body">
      <header className="workspace-topbar">
        <Link className="hackathon-demo-link" to="/app/demo"><Sparkles aria-hidden="true"/>Hackathon demo</Link>
        {!online && <div className="connection-status" role="status"><span className="connection-dot is-offline"/>Offline</div>}
        <details className="account-menu">
          <summary><span className="avatar" aria-hidden="true">{visibleName(session?.user.display_name, 'Farmer').slice(0, 1).toUpperCase()}</span><span className="account-name">{visibleName(session?.user.display_name, 'Farmer')}<small>{roleLabel(mode === 'adviser' ? 'adviser' : session?.workspace.role)}</small></span><Chevron className="account-chevron"/></summary>
          <div className="account-dropdown">
            <p className="muted">{session?.user.email}</p>
            <Link to="/app/settings" onClick={event => event.currentTarget.closest('details')?.removeAttribute('open')}>Account and settings</Link>
            {hasAdviserAccess && ownWorkspaces.length > 0 && <fieldset className="theme-choice"><legend>Dashboard</legend><div className="theme-options is-two">{(['farmer', 'adviser'] as const).map(option => <label key={option}><input type="radio" name="dashboard-choice" value={option} checked={mode === option} onChange={() => void chooseDashboard(option)}/>{option === 'farmer' ? <Sprout aria-hidden="true"/> : <LayoutDashboard aria-hidden="true"/>}{roleLabel(option)}</label>)}</div></fieldset>}
            <ThemeSwitch/>
            <p className="account-privacy">Signing out removes this account’s private form drafts from this browser.</p>
            <Button variant="ghost" loading={signingOut} onClick={() => void signOut()}><Text id="auth.signOut"/></Button>
          </div>
        </details>
      </header>
      <main id="main-content" className="main-content" tabIndex={-1}>
        {!online && <Notice kind="warning">You are offline. Forms with private drafts can keep your changes on this device. Check their save message before leaving. Saving farm records and loading new files need a connection.</Notice>}
        {sessionError && <Notice kind="error">{sessionError}</Notice>}
        {logoutError && <Notice kind="error">{logoutError}</Notice>}
        {tabs && <DashboardTabs role={mode} tabs={tabs}/>}
        <div className="page-enter" key={JSON.stringify([session?.user.id, session?.workspace.id, session?.workspace.role, session?.workspace.farm_ids, session?.workspace.permissions, location.pathname])}><PageBoundary><Outlet /></PageBoundary></div>
      </main>
      <footer className="workspace-footer"><span className="footer-brand"><b>Funkyfarm</b> · Fields Uploaded, Notified, Kept Yearly</span><Link to="/app/help">Help with the paperwork</Link><Link to="/app/assistant/connect">Connect an AI assistant</Link></footer>
    </div>
  </div>;
}

function AuthPage() {
  const { acceptSession, error: sessionError, refresh } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const registering = location.pathname === '/register';
  const nextValues = new URLSearchParams(location.search).getAll('next');
  const demoNext = nextValues.length === 1 && nextValues[0] === '/app/demo';
  const nextQuery = demoNext ? '?next=%2Fapp%2Fdemo' : '';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setError(null); document.title = `${registering ? 'Create an account' : 'Welcome back'} · Funkyfarm`; }, [registering]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const fields = new FormData(event.currentTarget);
    try {
      const body = { email: String(fields.get('email')).trim(), password: String(fields.get('password')), ...(registering ? { display_name: String(fields.get('display_name')).trim() } : {}) };
      const session = await api.post<Session>(registering ? '/auth/register' : '/auth/login', body);
      acceptSession(session);
      navigate(demoNext ? '/app/demo' : location.pathname.startsWith('/app/') ? location.pathname + location.search : session.workspace.role === 'adviser' ? '/app/adviser' : '/app/home', { replace: true });
    } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  return <div className="auth-layout">
    <section className="auth-story">
      <Link className="brand" to="/demo"><BrandMark/></Link>
      <div className="auth-story-content"><p className="eyebrow">Funkyfarm</p><h1>Good records.<br/>Room to grow.</h1><p>Keep farm work, field details and paperwork together, ready when you need them.</p>
        <ul className="funky-acronym">{funkyWords.map(([letter, word]) => <li key={letter}><b aria-hidden="true">{letter}</b><span>{word}</span></li>)}</ul>
      </div><p className="auth-footnote">Your farm records, kept together.</p>
    </section>
    <main className="auth-main"><div className="auth-form-wrap">
      <p className="eyebrow">{registering ? 'A fresh page' : 'Pick up where you left off'}</p><h2>{registering ? 'Make yourself at home.' : 'Welcome back.'}</h2><p className="muted">{registering ? 'Create your private farm workspace.' : 'Sign in to open your farm workspace.'}</p>
      {sessionError && <Notice kind="warning">{sessionError} <button className="text-button" type="button" onClick={() => void refresh()}><Text id="common.retry"/></button></Notice>}{error && <Notice kind="error">{error}</Notice>}
      <form className="auth-form stack" onSubmit={submit} aria-label={registering ? 'Create account' : 'Sign in'}>
        {registering && <label className="field"><span className="field-label"><Text id="auth.displayName"/></span><input name="display_name" autoComplete="name" required minLength={2} maxLength={100} placeholder="How should we call you?"/></label>}
        <label className="field"><span className="field-label"><Text id="auth.email"/></span><input type="email" name="email" autoComplete="email" required maxLength={254} placeholder="you@yourfarm.eu"/></label>
        <label className="field"><span className="field-label"><Text id="auth.password"/></span><input type="password" name="password" autoComplete={registering ? 'new-password' : 'current-password'} required minLength={registering ? 12 : 1} maxLength={256} aria-describedby={registering ? 'password-help' : undefined}/>{registering && <small className="muted" id="password-help">Use at least 12 characters.</small>}</label>
        <Button type="submit" loading={busy}><Text id={registering ? 'auth.createAccount' : 'auth.signIn'}/><Chevron/></Button>
      </form>
      <p className="auth-switch">{registering ? 'Already have an account?' : 'New to Funkyfarm?'} <Link to={`${registering ? '/login' : '/register'}${nextQuery}`}><Text id={registering ? 'auth.signIn' : 'auth.createAccount'}/></Link></p><p className="auth-privacy">Your farm records are private. You choose when to share a report or invite someone to help.</p>
    </div></main>
  </div>;
}

function NotFound() {
  return <section className="panel empty-state"><p className="eyebrow">A page out of place</p><h1>We could not find that page.</h1><p>Start with your home page to find the record you need.</p><Link className="button button-primary" to="/app/home">Back to home</Link></section>;
}

export default function App() {
  const { session, loading } = useSession();
  const location = useLocation();
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    // Vite's development client must stay outside the public offline cache.
    if (document.querySelector('script[src*="/@vite/client"]')) return;
    void navigator.serviceWorker.register('/service-worker.js', { scope: '/' }).catch(() => undefined);
  }, []);
  if (loading) return <div className="boot-screen"><BrandMark/><Loading /></div>;
  if (!session) return location.pathname === '/demo' ? <PublicDemoPage/> : <AuthPage />;
  return <Routes>
    <Route path="/demo" element={<PublicDemoPage/>}/>
    <Route path="/app" element={<Shell/>}>
      <Route index element={<Navigate to={session.workspace.role === 'adviser' ? 'adviser' : 'home'} replace/>}/>
      <Route path="home" element={<HomePage/>}/>
      <Route path="tools" element={<ToolsPage/>}/>
      <Route path="demo" element={<HackathonDemoPage/>}/>
      <Route path="easy-form" element={<EasyFarmFormPage/>}/>
      <Route path="examples" element={<DemoWorkspacePage/>}/>
      <Route path="examples/cap" element={<CapExamplePage/>}/>
      <Route path="examples/:scenarioId" element={<DemoWorkspacePage/>}/>
      <Route path="tasks" element={<TasksPage/>}/>
      <Route path="tasks/:id" element={<TaskPage/>}/>
      <Route path="record-work" element={<RecordWorkPage/>}/>
      <Route path="fields" element={<FarmPage/>}/>
      <Route path="fields/:id" element={<FarmDetailPage/>}/>
      <Route path="fields/:id/check" element={<ParcelCheckPage/>}/>
      <Route path="paperwork" element={<RequestsPage/>}/>
      <Route path="paperwork/:id" element={<RequestDetailPage/>}/>
      <Route path="cases" element={<CasesPage/>}/>
      <Route path="cases/new" element={<NewCasePage/>}/>
      <Route path="cases/:id" element={<CaseDetailPage/>}/>
      <Route path="cases/:id/correction" element={<CorrectionWizardPage/>}/>
      <Route path="documents" element={<DocumentsPage/>}/>
      <Route path="documents/:id" element={<DocumentDetailPage/>}/>
      <Route path="reports" element={<ReportsPage/>}/>
      <Route path="reports/:id" element={<ReportDetailPage/>}/>
      <Route path="imports" element={<ImportsPage/>}/>
      <Route path="adviser" element={<AdviserPage/>}/>
      <Route path="adviser/map" element={<AdviserMapPage/>}/>
      <Route path="adviser/inbox" element={<AdviserInboxPage/>}/>
      <Route path="map" element={<FarmerMapPage/>}/>
      <Route path="my-adviser" element={<MyAdviserPage/>}/>
      <Route path="satellite" element={<SatellitePage/>}/>
      <Route path="connections" element={<Connections/>}/>
      <Route path="help" element={<HelpPage/>}/>
      <Route path="checks" element={<CompliancePage/>}/>
      <Route path="compliance" element={<LegacyRedirect to="/app/checks"/>}/>
      <Route path="updates" element={<UpdatesPage/>}/>
      <Route path="updates/:updateId" element={<UpdateDetailPage/>}/>
      <Route path="funding" element={<FundingPage/>}/>
      <Route path="community" element={<CommunityPage/>}/>
      <Route path="community/new" element={<CommunityComposePage/>}/>
      <Route path="community/posts/:questionId" element={<CommunityThreadPage/>}/>
      <Route path="community/private" element={<PrivateCommunityPage/>}/>
      <Route path="assistant/connect" element={<AssistantConnect/>}/>
      <Route path="guidance" element={<GuidancePage/>}/>
      <Route path="guidance/:packId" element={<GuidanceDetailPage/>}/>
      <Route path="settings" element={<SettingsPage/>}/>
      <Route path="farm" element={<LegacyRedirect to="/app/fields"/>}/>
      <Route path="farm/:id" element={<LegacyRedirect to="/app/fields"/>}/>
      <Route path="requests" element={<LegacyRedirect to="/app/paperwork"/>}/>
      <Route path="requests/:id" element={<LegacyRedirect to="/app/paperwork"/>}/>
      <Route path="advisers" element={<LegacyRedirect to="/app/adviser"/>}/>
      <Route path="*" element={<NotFound/>}/>
    </Route>
    <Route path="*" element={<Navigate to={session.workspace.role === 'adviser' ? '/app/adviser' : '/app/home'} replace/>}/>
  </Routes>;
}
