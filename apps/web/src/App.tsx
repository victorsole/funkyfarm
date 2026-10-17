import { Component, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Outlet, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
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
import { CompliancePage, UpdatesPage } from './pages/Compliance';
import { CommunityPage } from './pages/Community';
import { AssistantConnect } from './pages/AssistantConnect';
import { mountWebMCP } from './webmcp';
import './pages/administration.css';
import './brand.css';

const primary = [
  { path: 'home', name: 'Home', detail: 'What needs doing', icon: 'home', label: 'nav.home' },
  { path: 'fields', name: 'My fields', detail: 'Land, crops and farm details', icon: 'farm', label: 'nav.fields' },
  { path: 'paperwork', name: 'Paperwork', detail: 'Requests and deadlines', icon: 'requests', label: 'nav.paperwork' },
  { path: 'record-work', name: 'Notebook', detail: 'Work, purchases and sales', icon: 'work', label: undefined },
  { path: 'tools', name: 'Tools', detail: 'All farm tools', icon: 'documents', label: undefined },
];

function BrandMark({ className = '' }: { className?: string }) {
  return <img className={`funkyfarmers-logo ${className}`} width="1397" height="1126" src="/assets/funkyfarmers-logo.png" alt="Funkyfarmers" />;
}

const visibleName = (value: string | undefined, fallback: string) => (value || '').replace(/^\s*FICTIONAL(?:[\s:—–_-]+|$)/i, '') || fallback;

function NavIcon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    home: 'M3 10 12 3l9 7v10H3V10Zm6 10v-7h6v7',
    work: 'M13 3 4 14h7l-1 7 10-12h-7l0-6Z',
    requests: 'M4 4h16v16H4V4Zm4 5h8M8 13h8M8 17h4',
    documents: 'M7 3h8l5 5v13H7V3Zm8 0v6h5M4 7v14',
    farm: 'M12 21V9m0 7C6 16 3 12 3 7c6 0 9 3 9 9Zm0-5c6 0 9-3 9-8-6 0-9 3-9 8Z',
    reports: 'M5 3h14v18H5V3Zm4 11 2 2 4-5M9 7h6',
  };
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] ?? paths.documents}/></svg>;
}

function Chevron({ className = '' }: { className?: string }) {
  return <svg className={className} width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m5 3 5 5-5 5"/></svg>;
}

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
  useEffect(() => mountWebMCP(), [session?.user.id, session?.workspace.id]);
  useEffect(() => {
    const page = caseSection ? 'Paperwork' : (primary.find(item => location.pathname.startsWith(`/app/${item.path}`))?.name
      ?? farmTools.find(tool => location.pathname.startsWith(`/app/${tool.path}`))?.title ?? 'Workspace');
    document.title = `${page} · Funkyfarmers`;
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
      <Link to="/app/home" className="brand" aria-label="Funkyfarmers home"><BrandMark /></Link>
      <div className="workspace-label"><label className="eyebrow" htmlFor="workspace-choice">Your workspace</label>{workspaces.length > 1 ? <select id="workspace-choice" aria-label="Switch workspace" value={session?.workspace.id} onChange={event => { void switchWorkspace(event.target.value).catch(() => undefined); }}>{workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{visibleName(workspace.name, 'Farm workspace')} · {workspace.role}</option>)}</select> : <strong>{visibleName(session?.workspace.name, 'Farm workspace')}</strong>}</div>
      <nav className="primary-nav" aria-label="Main navigation">{primary.map(item => <NavLink key={item.path} to={`/app/${item.path}`} aria-label={caseSection && item.path === 'paperwork' ? `${item.label ? t(item.label as TranslationKey) : item.name}, current section` : undefined} className={({ isActive }) => `nav-link${isActive || caseSection && item.path === 'paperwork' ? ' is-active' : ''}`}><NavIcon name={item.icon}/><span>{item.label ? t(item.label as TranslationKey) : item.name}<small>{item.detail}</small></span><Chevron className="nav-indicator"/></NavLink>)}</nav>
      <div className="sidebar-bottom"><span className="private-label"><svg width="12" height="14" viewBox="0 0 12 14" fill="none" stroke="currentColor" aria-hidden="true"><rect x="1.5" y="6" width="9" height="7" rx="1"/><path d="M3.5 6V3.5a2.5 2.5 0 0 1 5 0V6"/></svg> Private farm records</span></div>
    </aside>
    <div className="workspace-body">
      <header className="workspace-topbar">
        <Link className="hackathon-demo-link" to="/app/demo">Hackathon demo</Link>
        {!online && <div className="connection-status" role="status"><span className="connection-dot is-offline"/>Offline</div>}
        <details className="account-menu">
          <summary><span className="avatar" aria-hidden="true">{visibleName(session?.user.display_name, 'Farmer').slice(0, 1).toUpperCase()}</span><span className="account-name">{visibleName(session?.user.display_name, 'Farmer')}<small>{session?.workspace.role}</small></span><Chevron className="account-chevron"/></summary>
          <div className="account-dropdown">
            <p className="muted">{session?.user.email}</p>
            <Link to="/app/settings" onClick={event => event.currentTarget.closest('details')?.removeAttribute('open')}>Account and settings</Link>
            <p className="account-privacy">Signing out removes this account’s private form drafts from this browser.</p>
            <Button variant="ghost" loading={signingOut} onClick={() => void signOut()}><Text id="auth.signOut"/></Button>
          </div>
        </details>
      </header>
      <main id="main-content" className="main-content" tabIndex={-1}>
        {!online && <Notice kind="warning">You are offline. Forms with private drafts can keep your changes on this device. Check their save message before leaving. Saving farm records and loading new files need a connection.</Notice>}
        {sessionError && <Notice kind="error">{sessionError}</Notice>}
        {logoutError && <Notice kind="error">{logoutError}</Notice>}
        <div className="page-enter" key={JSON.stringify([session?.user.id, session?.workspace.id, session?.workspace.role, session?.workspace.farm_ids, session?.workspace.permissions, location.pathname])}><PageBoundary><Outlet /></PageBoundary></div>
      </main>
      <footer className="workspace-footer"><span>Funkyfarmers · The farm folio</span><Link to="/app/help">Help with the paperwork</Link><Link to="/app/assistant/connect">Connect an AI assistant</Link></footer>
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
  useEffect(() => { setError(null); document.title = `${registering ? 'Create an account' : 'Welcome back'} · Funkyfarmers`; }, [registering]);
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
      <div className="auth-story-content"><p className="eyebrow">The farm folio</p><h1>Good records.<br/>Room to grow.</h1><p>Keep farm work, field details and paperwork together, ready when you need them.</p>
        <div className="folio-illustration" aria-hidden="true"><div className="folio-back"/><div className="folio-sheet"><div className="sheet-heading"><BrandMark/><span>THE FARM<br/>FOLIO / 01</span></div><div className="sheet-line"/><div className="sheet-line short"/><div className="sheet-box"><span>Farm work. Fields. Paperwork.</span></div><div className="sheet-line"/><div className="sheet-line short"/><div className="sheet-signature">Ready when you need it.</div></div><div className="folio-stamp">KEPT<br/>TOGETHER</div></div>
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
      <p className="auth-switch">{registering ? 'Already have an account?' : 'New to Funkyfarmers?'} <Link to={`${registering ? '/login' : '/register'}${nextQuery}`}><Text id={registering ? 'auth.signIn' : 'auth.createAccount'}/></Link></p><p className="auth-privacy">Your farm records are private. You choose when to share a report or invite someone to help.</p>
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
      <Route path="satellite" element={<SatellitePage/>}/>
      <Route path="connections" element={<Connections/>}/>
      <Route path="help" element={<HelpPage/>}/>
      <Route path="checks" element={<CompliancePage/>}/>
      <Route path="compliance" element={<LegacyRedirect to="/app/checks"/>}/>
      <Route path="updates" element={<UpdatesPage/>}/>
      <Route path="community" element={<CommunityPage/>}/>
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
