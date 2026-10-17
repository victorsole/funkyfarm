import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
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
  id: string; key?: string; title: string; description?: string; farmer_goal?: string; adviser_goal?: string;
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
const label = (value: string) => value.replace(/^FICTIONAL(?:\s+example)?\s*(?:[—–-]\s*)?/i, '').replace(/\bfictional\s+(?:training\s+)?/gi, '').trim();
const itemStatus: Record<string, string> = { open: 'To do', in_progress: 'Started', resolved: 'Reviewed', cancelled: 'Set aside' };
const taskCopy: Record<string, string> = {
  'nl-overlap': 'Two field drawings overlap. Compare them, correct the boundary and review the change.',
  'cz-area-crop': 'Check the area and crop already filled in. Save any correction for review.',
  'es-protected-unknown': 'Compare D04’s drawing and claim figures with the source. Review any change before applying it.',
  'nl-missing-documents': 'Check the boundary and find the missing record before preparing the correction.',
  'cz-mock-amendment-window': 'Read the notice, check the dates and review the boundary correction.',
  'sk-announced-check': 'See what the inspection notice asks for and check your work record before answering.',
  'nl-ams-response': 'Check the observation date and choose the records needed for your response.',
};
const taskDescription = (scenario: Scenario) => taskCopy[scenario.key ?? scenario.id]
  || label(scenario.farmer_goal || scenario.description || 'Check the records and choose your next step.');

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
  const navigate = useNavigate();
  const { scenarioId } = useParams<{ scenarioId: string }>();
  const [params, setParams] = useSearchParams();
  const draft = usePrivateDraft<Saved>(DRAFT, { pending: null, created: null });
  const remembered = draft.ready ? draft.value.created : null;
  const runId = params.get('run_id')?.toLowerCase() ?? (remembered?.workspaceId === workspaceId ? remembered.runId : null);
  const targetWorkspace = params.get('workspace_id')?.toLowerCase() ?? (runId ? workspaceId : null);
  const validQuery = params.getAll('run_id').length <= 1 && params.getAll('workspace_id').length <= 1 &&
    (!runId || UUID.test(runId)) && (!targetWorkspace || UUID.test(targetWorkspace)) && (!targetWorkspace || !!runId);
  const differentWorkspace = !!targetWorkspace && targetWorkspace !== workspaceId;
  const [loaded, setResult] = useState<Example | null>(null);
  const result = validQuery && !differentWorkspace && loaded?.run_id === runId && loaded.workspace.id === workspaceId ? loaded : null;
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const selected = scenarioId ?? params.get('scenario_id');
  const mounted = useRef(false);
  const writing = useRef(false);
  const generation = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; };
  }, []);

  useEffect(() => {
    const sequence = ++generation.current;
    const controller = new AbortController();
    setLoadError('');
    if (validQuery && runId && !differentWorkspace) {
      api.downloadResponse(`/examples/workspace/${runId}`, { signal: controller.signal })
        .then(response => response.json() as Promise<Example>)
        .then(value => { const checked = checkedExample(value, workspaceId, runId); if (mounted.current && sequence === generation.current) setResult(checked); })
        .catch(error => { if (!controller.signal.aborted && mounted.current && sequence === generation.current) { setResult(null); setLoadError(errorMessage(error)); } });
    }
    return () => controller.abort();
  }, [validQuery, runId, differentWorkspace, workspaceId, refresh]);

  async function openWorkspace(run: { runId: string; workspaceId: string }, overview = false) {
    setActionError('');
    const query = { run_id: run.runId, workspace_id: run.workspaceId };
    if (overview) navigate(`/app/examples?${new URLSearchParams(query)}`, { replace: true });
    else setParams(query, { replace: true });
    try { await switchWorkspace(run.workspaceId); }
    catch (error) { if (mounted.current) setActionError(errorMessage(error)); }
  }

  async function createExample() {
    if (!owner || !draft.ready || writing.current || !validQuery || differentWorkspace) return;
    if (runId && !result) return;
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
      await openWorkspace(created, true);
    } catch (error) { if (mounted.current) setActionError(errorMessage(error)); }
    finally { writing.current = false; if (mounted.current) setBusy(false); }
  }

  const activeScenario = result?.scenarios.find(scenario => scenario.id === selected);
  const startLinks = activeScenario ? [
    ...(activeScenario.primary_start ? [activeScenario.primary_start] : []),
    ...activeScenario.starts.filter(start => start.href !== activeScenario.primary_start?.href),
  ] : [];
  const runQuery = result ? new URLSearchParams({ run_id: result.run_id, workspace_id: result.workspace.id }).toString() : '';
  const overviewHref = `/app/examples${runQuery ? `?${runQuery}` : ''}`;
  const scenarioHref = (id: string) => `/app/examples/${encodeURIComponent(id)}?${runQuery}`;
  const primary = startLinks.find(start => localPath(start.href));
  const otherLinks = startLinks.filter(start => localPath(start.href) && start.href !== primary?.href)
    .filter((start, index, all) => all.findIndex(item => item.href === start.href) === index);
  return <div className="demo-workspace">
    <PageHeader title={activeScenario ? label(activeScenario.title) : 'Choose a situation'} description={activeScenario ? activeScenario.country : 'Pick one job and work through it with saved records.'} />
    <p className="demo-label">Demo</p>
    {!validQuery && <Notice kind="error">This sample link is incomplete. <Link to="/app/examples">Open the sample start page</Link>.</Notice>}
    {actionError && <Notice kind="error">{actionError}</Notice>}
    {draft.error && <Notice kind="warning">{draft.error}</Notice>}
    {validQuery && differentWorkspace && <section className="card stack">
      <h2>Continue this demo</h2><Button onClick={() => void openWorkspace({ runId: runId!, workspaceId: targetWorkspace! })}>Open demo</Button>
    </section>}
    {validQuery && !runId && <section className="card stack">
      <h2>Try the working tools</h2><p>Your own farm stays unchanged.</p>
      {!owner ? <Notice>Ask an owner to start a demo and invite you.</Notice> : <Button loading={busy} disabled={!draft.ready} onClick={() => void createExample()}>Start demo</Button>}
      {draft.ready && draft.value.created && <Button variant="secondary" onClick={() => void openWorkspace(draft.value.created!)}>Continue my saved demo</Button>}
    </section>}
    {validQuery && runId && !differentWorkspace && !result && !loadError && <Notice>Opening the saved demo…</Notice>}
    {loadError && <Notice kind="error">{loadError} <Button variant="secondary" onClick={() => setRefresh(value => value + 1)}>Try opening it again</Button></Notice>}
    {result && <>
      <div className="demo-overview"><Link to={selected ? overviewHref : `/app/demo?${runQuery}`}>{selected ? 'Back to all situations' : 'Open the three guided demos'}</Link><Button variant="secondary" onClick={() => setRefresh(value => value + 1)}>Refresh saved progress</Button></div>
      {!selected && <div className="demo-farm-grid">{result.scenarios.map((scenario, index) => <article key={scenario.id} className="demo-farm-card">
        <span className="demo-scenario-number">Situation {index + 1}{scenario.country ? ` · ${scenario.country}` : ''}</span>
        <h2>{label(scenario.title)}</h2><p>{taskDescription(scenario)}</p>
        <Link className="button button-secondary" to={scenarioHref(scenario.id)}>Open this situation</Link>
      </article>)}</div>}
      {selected && !activeScenario && <Notice kind="warning">This situation is not available in this saved demo. <Link to={overviewHref}>Choose another situation</Link>.</Notice>}
      {activeScenario && <section className="demo-scenario-detail card" aria-label="Situation guide">
        <h2>Your task</h2><p>{taskDescription(activeScenario)}</p>
        <ol className="demo-instructions"><li>Open the map or case below.</li><li>Compare the details with the original and save any correction.</li><li>Review the change before applying it or preparing a folder.</li></ol>
        {primary && <Link className="button button-primary" to={localPath(primary.href)!}>Start this situation</Link>}
        {activeScenario.cases.map(savedCase => <section key={savedCase.id} className="demo-case-progress"><h3>Saved progress</h3>
          <p>{caseStatusLabel[savedCase.status] ?? 'Open the case to check its status'}.</p>
          <p>{savedCase.items.filter(item => item.status === 'resolved').length} of {savedCase.items.length} items reviewed.</p>
          <ul>{savedCase.items.map(item => <li key={item.id}>{label(item.title)}: <strong>{itemStatus[item.status] ?? 'Check the saved case'}</strong></li>)}</ul>
          <p>{label(savedCase.checks.next_action)}</p><Link to={`/app/cases/${savedCase.id}`}>Open saved case</Link>
        </section>)}
        {!!otherLinks.length && <section><h3>Related records</h3><ul className="demo-related-records">{otherLinks.map(start => <li key={start.href}><Link to={localPath(start.href)!}>{label(start.title)}</Link></li>)}</ul></section>}
        <p className="muted">Come back and refresh to see your changes. A prepared folder has not been sent.</p>
      </section>}
      <div className="demo-footer"><Link to="/app/adviser">Work with an adviser</Link><span>Changes here do not update the official register.</span></div>
      {owner && !selected && <section className="demo-new-run"><p>Want a clean start? Your current demo and changes will be kept.</p><Button variant="secondary" loading={busy} disabled={!draft.ready} onClick={() => void createExample()}>Start a fresh demo</Button>
        {result.source_workspace_id && <Button variant="ghost" onClick={() => { void switchWorkspace(result.source_workspace_id!).catch(error => setActionError(errorMessage(error))); }}>Return to the workspace I came from</Button>}
      </section>}
    </>}
  </div>;
}
