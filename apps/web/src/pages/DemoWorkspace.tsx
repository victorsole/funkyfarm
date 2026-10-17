import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { useSession } from '../auth';
import { Button, Notice, PageHeader } from '../components';
import { saveDraft, usePrivateDraft } from '../offline';
import { caseStatusLabel, type CaseStatus } from './case-types';
import './demoWorkspace.css';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const FIXTURE = 'lpis-correction-2026-v1';
const DRAFT = 'examples/private-workspace-v1';
type StartLink = { title: string; href: string };
type Scenario = {
  id: string; title: string; description?: string; farmer_goal?: string; adviser_goal?: string;
  country?: string; expected_actions?: string[]; starts: StartLink[]; primary_start?: StartLink; record_ids: string[];
  cases: { id: string; revision: number; status: CaseStatus; checks: { can_review: boolean; next_action: string };
    items: { id: string; title: string; status: string }[] }[];
};
type Example = {
  run_id: string; revision: number; workspace: { id: string; name: string; role: string };
  fixture_id: string; fixture_version: number; notice: string; record_count: number; fixture_record_count: number;
  farm_ids: string[]; inventory: { kind: string; count: number }[]; scenarios: Scenario[];
  records: { id: string; kind: string; revision: number; label: string; href: string; farm_id: string | null }[];
  role: { actual: string; preview: false }; previous_run_id: string | null; source_workspace_id: string | null;
};
type Pending = { key: string; runId: string | null; revision: number | null };
type Saved = { pending: Pending | null; created: { runId: string; workspaceId: string } | null };

function localPath(href: string): string | null {
  if (typeof href !== 'string' || !href.startsWith('/app/') || /[\\\u0000-\u0020]/.test(href)) return null;
  try {
    const url = new URL(href, 'https://example.invalid');
    return url.origin === 'https://example.invalid' && url.pathname.startsWith('/app/') ? `${url.pathname}${url.search}${url.hash}` : null;
  } catch { return null; }
}

function checkedExample(value: Example, workspaceId?: string, runId?: string): Example {
  if (!value || !UUID.test(value.run_id) || !UUID.test(value.workspace?.id) || value.fixture_id !== FIXTURE ||
      !Number.isInteger(value.revision) || value.revision < 1 || value.role?.preview !== false ||
      value.role.actual !== value.workspace.role || !Array.isArray(value.scenarios) || value.scenarios.length > 7 ||
      !Array.isArray(value.records) || value.records.length > 200 || !Array.isArray(value.farm_ids) ||
      workspaceId && value.workspace.id !== workspaceId || runId && value.run_id !== runId) {
    throw new Error('The sample workspace could not be checked. No farm changes were made by this page.');
  }
  return value;
}

export function DemoWorkspacePage() {
  const { session } = useSession();
  if (!session) return <Notice>Sign in to open a private sample workspace.</Notice>;
  return <DemoRun key={`${session.user.id}/${session.workspace.id}`} scope={`${session.user.id}/${session.workspace.id}`}
    workspaceId={session.workspace.id} owner={session.workspace.role === 'owner'} />;
}

function DemoRun({ scope, workspaceId, owner }: { scope: string; workspaceId: string; owner: boolean }) {
  const { switchWorkspace } = useSession();
  const [params, setParams] = useSearchParams();
  const draft = usePrivateDraft<Saved>(DRAFT, { pending: null, created: null });
  const runId = params.get('run_id')?.toLowerCase() ?? null;
  const targetWorkspace = params.get('workspace_id')?.toLowerCase() ?? null;
  const validQuery = params.getAll('run_id').length <= 1 && params.getAll('workspace_id').length <= 1 &&
    (!runId || UUID.test(runId)) && (!targetWorkspace || UUID.test(targetWorkspace)) && (!targetWorkspace || !!runId);
  const differentWorkspace = !!targetWorkspace && targetWorkspace !== workspaceId;
  const [result, setResult] = useState<Example | null>(null);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [acknowledged, setAcknowledged] = useState(false);
  const [restart, setRestart] = useState(false);
  const [selected, setSelected] = useState<string | null>(() => params.get('scenario_id'));
  const detail = useRef<HTMLElement | null>(null);
  const mounted = useRef(false);
  const writing = useRef(false);
  const generation = useRef(0);

  useEffect(() => {
    mounted.current = true;
    const returned = () => { if (!writing.current) setRefresh(value => value + 1); };
    const visible = () => { if (document.visibilityState === 'visible') returned(); };
    window.addEventListener('focus', returned);
    document.addEventListener('visibilitychange', visible);
    return () => { mounted.current = false; generation.current += 1; window.removeEventListener('focus', returned); document.removeEventListener('visibilitychange', visible); };
  }, []);

  useEffect(() => {
    const sequence = ++generation.current;
    const controller = new AbortController();
    setResult(null); setLoadError(''); setRestart(false); setAcknowledged(false);
    if (validQuery && runId && !differentWorkspace) {
      api.downloadResponse(`/examples/workspace/${runId}`, { signal: controller.signal })
        .then(response => response.json() as Promise<Example>)
        .then(value => { const checked = checkedExample(value, workspaceId, runId); if (mounted.current && sequence === generation.current) setResult(checked); })
        .catch(error => { if (!controller.signal.aborted && mounted.current && sequence === generation.current) setLoadError(errorMessage(error)); });
    }
    return () => controller.abort();
  }, [validQuery, runId, differentWorkspace, workspaceId, refresh]);

  useEffect(() => {
    if (!selected || !result?.scenarios.some(scenario => scenario.id === selected)) return;
    const target = detail.current;
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }, [selected]);

  async function openWorkspace(run: { runId: string; workspaceId: string }) {
    setActionError('');
    setParams({ run_id: run.runId, workspace_id: run.workspaceId }, { replace: true });
    try { await switchWorkspace(run.workspaceId); }
    catch (error) { if (mounted.current) setActionError(errorMessage(error)); }
  }

  async function createExample() {
    if (!owner || !acknowledged || !draft.ready || writing.current || !validQuery || differentWorkspace) return;
    if (runId && (!restart || !result)) return;
    writing.current = true; setBusy(true); setActionError('');
    const pending = draft.value.pending ?? { key: crypto.randomUUID(), runId: result?.run_id ?? null, revision: result?.revision ?? null };
    try {
      if (!UUID.test(pending.key) || pending.runId !== (result?.run_id ?? null) ||
          pending.runId && (!Number.isInteger(pending.revision) || !pending.revision || pending.revision < 1)) {
        throw new Error('There is an unfinished start request for another sample. Open that saved sample before starting again.');
      }
      const saved = { ...draft.value, pending };
      await saveDraft(scope, DRAFT, saved);
      draft.setValue(saved);
      const value = checkedExample(await api.post<Example>(pending.runId ? `/examples/workspace/${pending.runId}/start-again` : '/examples/workspace',
        pending.runId ? { expected_revision: pending.revision, acknowledged: true } : { fixture_id: FIXTURE, acknowledged: true },
        { idempotencyKey: pending.key }));
      const created = { runId: value.run_id, workspaceId: value.workspace.id };
      const completed = { pending: null, created };
      await saveDraft(scope, DRAFT, completed);
      if (!mounted.current) return;
      draft.setValue(completed);
      await openWorkspace(created);
    } catch (error) { if (mounted.current) setActionError(errorMessage(error)); }
    finally { writing.current = false; if (mounted.current) setBusy(false); }
  }

  const activeScenario = result?.scenarios.find(scenario => scenario.id === selected);
  const startLinks = activeScenario ? [
    ...(activeScenario.primary_start ? [activeScenario.primary_start] : []),
    ...activeScenario.starts.filter(start => start.href !== activeScenario.primary_start?.href),
  ] : [];
  function chooseScenario(id: string) {
    setSelected(id);
    const next = new URLSearchParams(params);
    next.set('scenario_id', id);
    setParams(next, { replace: true });
  }
  return <div className="demo-workspace">
    <PageHeader title="Try the sample farms" description="Seven farm situations. Work through the real pages with made-up records, without changing your own farm." />
    <p className="demo-fictional">Demo</p>
    {!validQuery && <Notice kind="error">This sample link is incomplete. <Link to="/app/examples">Open the sample start page</Link>.</Notice>}
    {actionError && <Notice kind="error">{actionError} Your previous workspace and its records have not been deleted.</Notice>}
    {draft.error && <Notice kind="warning">{draft.error}</Notice>}
    {validQuery && differentWorkspace && <section className="card stack">
      <h2>Open the sample workspace</h2><p>This link belongs to a different workspace. We will check that your account has access before opening it.</p>
      <Button onClick={() => void openWorkspace({ runId: runId!, workspaceId: targetWorkspace! })}>Open this sample workspace</Button>
    </section>}
    {validQuery && !runId && <section className="card stack">
      <h2>Start with a separate set of records</h2>
      <p>This creates seven fictional farms and their letters, field changes and work records in a new private workspace. Your current farm stays as it is.</p>
      <p>You can edit, review and download the sample records through the same pages you would use for your farm. Nothing is sent to an authority.</p>
      {!owner ? <Notice>Only a workspace owner can create a sample workspace. Ask an owner to create one and invite you with the access you need.</Notice> : <>
        <label className="demo-ack"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} disabled={busy}/><span>I understand these are made-up records in a separate workspace.</span></label>
        <Button loading={busy} disabled={!acknowledged || !draft.ready} onClick={() => void createExample()}>{draft.value.pending ? 'Retry the same start request' : 'Create my sample workspace'}</Button>
      </>}
      {draft.ready && draft.value.created && <Button variant="secondary" onClick={() => void openWorkspace(draft.value.created!)}>Open my previous sample workspace</Button>}
    </section>}
    {validQuery && runId && !differentWorkspace && !result && !loadError && <Notice>Opening the saved sample farms…</Notice>}
    {loadError && <Notice kind="error">{loadError} <Button variant="secondary" onClick={() => setRefresh(value => value + 1)}>Try opening it again</Button></Notice>}
    {result && <>
      <section className="demo-overview card">
        <div><h2>Your private sample workspace</h2><p>Choose one of the {result.scenarios.length} situations below. Open it to see what to do.</p></div>
        <Button variant="secondary" onClick={() => setRefresh(value => value + 1)}>Refresh progress</Button>
      </section>
      <div className="demo-farm-grid">{result.scenarios.map((scenario, index) => <article key={scenario.id} className={`demo-farm-card${selected === scenario.id ? ' demo-farm-card-selected' : ''}`}>
        <span className="demo-scenario-number">Situation {index + 1}{scenario.country ? ` · ${scenario.country}` : ''}</span>
        <h2>{scenario.title.replace(/^FICTIONAL\s*[—–-]\s*/i, '')}</h2>
        {scenario.description && <p>{scenario.description}</p>}
        <p className="demo-saved-progress">{scenario.cases.length ? scenario.cases.map(savedCase => `${savedCase.items.filter(item => item.status === 'resolved').length} of ${savedCase.items.length} steps reviewed`).join('; ') : 'Open the saved records to check this situation.'}</p>
        <Button variant={selected === scenario.id ? 'primary' : 'secondary'} aria-expanded={selected === scenario.id} aria-controls="demo-scenario-detail" onClick={() => chooseScenario(scenario.id)}>Show me what to do</Button>
      </article>)}</div>
      {activeScenario && <section ref={detail} tabIndex={-1} id="demo-scenario-detail" className="demo-scenario-detail card" aria-labelledby="demo-active-title">
        <p className="eyebrow">Work through this situation</p><h2 id="demo-active-title">{activeScenario.title}</h2>
        {activeScenario.farmer_goal && <p><strong>For the farmer:</strong> {activeScenario.farmer_goal}</p>}
        {activeScenario.adviser_goal && <p><strong>For the adviser:</strong> {activeScenario.adviser_goal}</p>}
        {!!activeScenario.expected_actions?.length && <ol>{activeScenario.expected_actions.map((action, index) => <li key={index}>{action}</li>)}</ol>}
        {activeScenario.cases.map(savedCase => <div key={savedCase.id} className="demo-case-progress"><h3>Saved case progress</h3>
          <p>{caseStatusLabel[savedCase.status] ?? 'Open the case to check its status'}.</p>
          <ul>{savedCase.items.map(item => <li key={item.id}>{item.title}: <strong>{({ open: 'Still to do', in_progress: 'Started', resolved: 'Reviewed as done', cancelled: 'Set aside, not completed' } as Record<string, string>)[item.status] ?? 'Check in the saved case'}</strong></li>)}</ul>
          <p>{savedCase.checks.next_action}</p>
        </div>)}
        <div className="demo-start-links">{startLinks.map((start, index) => localPath(start.href) && <Link key={`${start.href}:${index}`} className={`button ${index === 0 ? 'button-primary' : 'button-secondary'}`} to={localPath(start.href)!}>{start.title}</Link>)}</div>
        <p className="muted">These links open the actual editable records. Return here and refresh progress after working through them.</p>
      </section>}
      <section className="card stack"><h2>Try it with an adviser</h2><p><Link to="/app/adviser">Open Adviser view</Link> to see what your current permission allows. To work with another person, <Link to="/app/adviser">send an adviser invitation</Link> and choose exactly which farms and actions to share. An invitation gives app access, not a government mandate.</p></section>
      <details className="card"><summary>Saved records and sample details</summary><p>{result.notice}</p><p>{result.fixture_record_count} starting records were created for these sample farms.</p><p>Your access: <strong>{result.role.actual}</strong>. This page does not give you an adviser’s access.</p><p>{result.record_count} saved sample records and history entries are currently visible to your account. This count does not include everything you later add.</p><ul>{result.records.map(record => <li key={record.id}>{localPath(record.href) ? <Link to={localPath(record.href)!}>{record.label}</Link> : record.label} <span className="muted">(saved version {record.revision})</span></li>)}</ul><p><Link to="/app/examples/cap">Try the three-step CAP example</Link> for a separate fictional field correction and missing-record exercise.</p></details>
      {owner && <section className="card stack"><h2>Try again with fresh samples</h2><p>Starting again creates another separate workspace. It keeps this one, including every change you made. Nothing here is reset or deleted.</p>
        {!restart ? <Button variant="secondary" onClick={() => { setRestart(true); setAcknowledged(false); }}>Start a fresh sample run</Button> : <>
          <label className="demo-ack"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} disabled={busy}/><span>Keep this workspace and my changes, and create another fictional sample workspace.</span></label>
          <div className="actions"><Button loading={busy} disabled={!acknowledged || !draft.ready} onClick={() => void createExample()}>{draft.value.pending ? 'Retry the same fresh sample request' : 'Create a fresh sample workspace'}</Button><Button variant="secondary" disabled={busy} onClick={() => { setRestart(false); setAcknowledged(false); }}>Keep working here</Button></div>
        </>}
        {result.source_workspace_id && <Button variant="ghost" onClick={() => { void switchWorkspace(result.source_workspace_id!).catch(error => setActionError(errorMessage(error))); }}>Return to the workspace I came from</Button>}
      </section>}
    </>}
  </div>;
}
