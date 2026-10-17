import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { useSession } from '../auth';
import { Button, Notice, PageHeader } from '../components';
import { saveDraft, usePrivateDraft } from '../offline';
import { caseStatusLabel, type CaseStatus } from './case-types';
import './hackathonDemo.css';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const DRAFT = 'examples/hackathon-demo-v1';
type SavedRun = { runId: string; workspaceId: string };
type Saved = { retryKey: string; created: SavedRun | null };
type SavedRecord = { id: string; kind: string; revision: number; label: string; status?: string; farm_id: string | null; alias?: string; scenario_id: string };
type SavedCase = { id: string; revision: number; status: CaseStatus; checks: { next_action: string; can_review: boolean };
  items: { id: string; title: string; status: string }[] };
type Demo = {
  run_id: string; revision: number; fixture_id: string; notice: string; workspace: { id: string; name: string; role: string };
  fixture_record_count: number;
  role: { actual: string; preview: false }; records: SavedRecord[];
  scenarios: { id: string; key: string; title: string; description: string; farmer_goal: string; adviser_goal: string;
    record_ids: string[]; expected_actions: string[]; cases: SavedCase[] }[];
};
type StepId = 'fields' | 'values' | 'correction' | 'folder';
const stepIds: StepId[] = ['fields', 'values', 'correction', 'folder'];

function checked(value: Demo, workspaceId?: string, runId?: string): Demo {
  if (!value || !UUID.test(value.run_id) || !UUID.test(value.workspace?.id) || value.fixture_id !== 'lpis-correction-2026-v1' ||
      value.role?.preview !== false || value.role.actual !== value.workspace.role || !Array.isArray(value.scenarios) ||
      value.scenarios.length > 7 || !Array.isArray(value.records) || value.records.length > 200 ||
      workspaceId && value.workspace.id !== workspaceId || runId && value.run_id !== runId) {
    throw new Error('The saved demo could not be checked. Your existing farm records have not been changed.');
  }
  return value;
}

export function HackathonDemoPage() {
  const { session } = useSession();
  if (!session) return <Notice>Sign in to try the demo with private sample records.</Notice>;
  return <GuidedDemo key={`${session.user.id}/${session.workspace.id}`} scope={`${session.user.id}/${session.workspace.id}`}
    workspaceId={session.workspace.id} owner={session.workspace.role === 'owner'}/>;
}

function GuidedDemo({ scope, workspaceId, owner }: { scope: string; workspaceId: string; owner: boolean }) {
  const { switchWorkspace } = useSession();
  const [params, setParams] = useSearchParams();
  const [initial] = useState<Saved>(() => ({ retryKey: crypto.randomUUID(), created: null }));
  const draft = usePrivateDraft<Saved>(DRAFT, initial);
  const suppliedRun = params.get('run_id')?.toLowerCase() ?? null;
  const suppliedWorkspace = params.get('workspace_id')?.toLowerCase() ?? null;
  const remembered = draft.ready ? draft.value.created : null;
  const runId = suppliedRun ?? (remembered?.workspaceId === workspaceId ? remembered.runId : null);
  const targetWorkspace = suppliedWorkspace ?? (runId ? workspaceId : null);
  const valid = params.getAll('run_id').length <= 1 && params.getAll('workspace_id').length <= 1 &&
    (suppliedRun === null || UUID.test(suppliedRun)) && (suppliedWorkspace === null || UUID.test(suppliedWorkspace)) &&
    (!suppliedWorkspace || !!suppliedRun) && (!runId || UUID.test(runId));
  const differentWorkspace = !!targetWorkspace && targetWorkspace !== workspaceId;
  const [loaded, setData] = useState<Demo | null>(null);
  const data = valid && !differentWorkspace && loaded?.run_id === runId && loaded.workspace.id === workspaceId ? loaded : null;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const mounted = useRef(false);
  const writing = useRef(false);
  const generation = useRef(0);
  const stepPanel = useRef<HTMLElement | null>(null);

  useEffect(() => {
    mounted.current = true;
    const returned = () => { if (!writing.current) setRefresh(value => value + 1); };
    const visible = () => { if (document.visibilityState === 'visible') returned(); };
    window.addEventListener('focus', returned); document.addEventListener('visibilitychange', visible);
    return () => { mounted.current = false; generation.current += 1; window.removeEventListener('focus', returned); document.removeEventListener('visibilitychange', visible); };
  }, []);

  useEffect(() => {
    const sequence = ++generation.current;
    const controller = new AbortController();
    setData(null); setError('');
    if (valid && runId && !differentWorkspace) {
      api.downloadResponse(`/examples/workspace/${runId}`, { signal: controller.signal })
        .then(response => response.json() as Promise<Demo>)
        .then(value => { const saved = checked(value, workspaceId, runId); if (mounted.current && sequence === generation.current) setData(saved); })
        .catch(failure => { if (mounted.current && sequence === generation.current && !controller.signal.aborted) setError(errorMessage(failure)); });
    }
    return () => controller.abort();
  }, [valid, runId, differentWorkspace, workspaceId, refresh]);

  useEffect(() => {
    if (data && draft.ready && (draft.value.created?.runId !== data.run_id || draft.value.created.workspaceId !== workspaceId)) {
      draft.setValue(previous => ({ ...previous, created: { runId: data.run_id, workspaceId } }));
    }
  }, [data?.run_id, draft.ready, workspaceId]);

  const scenario = data?.scenarios.find(item => item.key === 'es-protected-unknown' || item.id === 'es-protected-unknown');
  const related = data && scenario ? data.records.filter(record => scenario.record_ids.includes(record.id)) : [];
  const farm = related.find(record => record.kind === 'farms');
  const factAliases = ['es-claimed-area', 'es-eligible-area', 'es-coefficient', 'es-corrected-area'];
  const facts = related.filter(record => record.kind === 'facts' && factAliases.includes(record.alias ?? ''));
  const evidenceTask = related.find(record => record.kind === 'tasks' && record.alias === 'es-lease-evidence');
  const savedCase = scenario?.cases.find(item => item.id === related.find(record => record.kind === 'admin_cases')?.id);
  const reviewedFacts = facts.filter(record => record.status === 'confirmed').length;
  const valuesReviewed = facts.length === 4 && reviewedFacts === 4;
  const allItemsResolved = !!savedCase?.items.length && savedCase.items.every(item => item.status === 'resolved');
  const suggested: StepId = valuesReviewed ? allItemsResolved ? 'folder' : 'correction' : 'fields';
  const requestedStep = params.get('step');
  const step = requestedStep && stepIds.includes(requestedStep as StepId) ? requestedStep as StepId : suggested;
  const contextReady = !!farm && facts.length === 4 && !!savedCase && [farm.id, savedCase.id, ...facts.map(record => record.id)].every(id => UUID.test(id));
  const fieldsHref = farm ? `/app/fields/${farm.id}/check?${new URLSearchParams({ expected_farm_revision: String(farm.revision), reporting_year: '2026' })}` : '';
  const factsHref = farm ? `/app/fields/${farm.id}#facts` : '';
  const caseHref = savedCase ? `/app/cases/${savedCase.id}` : '';
  const steps: { id: StepId; title: string; instruction: string; button: string; href: string; status: string }[] = [
    { id: 'fields', title: 'Check the parcel', instruction: 'Compare the fictional 6.70 ha pasture drawing with the saved claim and supplied SIGPAC-style record. The supplied pasture coefficient is 45%, giving a supplied maximum of 3.02 ha. Keep the whole physical outline: 45% is not a smaller boundary to draw.', button: 'Check the sample parcel', href: fieldsHref, status: 'Compare physical land and supplied claim values' },
    { id: 'values', title: 'Check the saved figures', instruction: 'Open the saved answers about this farm. Compare the claimed 6.70 ha, supplied 3.02 ha maximum, 45% coefficient and proposed 3.02 ha corrected claim with their original sample files. Confirm only the answers you checked. A confirmed source value is not an eligibility decision.', button: 'Review the four saved answers', href: factsHref, status: `${reviewedFacts} of ${facts.length} sample answers confirmed` },
    { id: 'correction', title: 'Prepare the correction', instruction: 'Keep the fictional original claim separate. Work through each answer to prepare a claim of 3.02 ha if that is the correction you choose. The difference from the claimed 6.70 ha is 3.68 ha. Preparing this correction does not change a submitted claim or prove the permitted route.', button: 'Work through the correction', href: savedCase ? `${caseHref}/correction` : '', status: savedCase ? `${savedCase.items.filter(item => item.status === 'resolved').length} of ${savedCase.items.length} case items reviewed` : 'Open the saved case' },
    { id: 'folder', title: 'Review and download', instruction: 'Review the answers and selected files in the case. When the checks allow it, approve the folder and download the ZIP. You decide what to send through the actual authority route.', button: 'Review the case and prepare the folder', href: caseHref, status: savedCase ? caseStatusLabel[savedCase.status] ?? 'Check the current case' : 'Not reviewed' },
  ];
  const active = steps.find(item => item.id === step)!;

  useEffect(() => {
    if (!requestedStep || !data || !stepPanel.current) return;
    stepPanel.current.focus({ preventScroll: true });
    stepPanel.current.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }, [requestedStep]);

  function chooseStep(id: StepId) {
    const next = new URLSearchParams(params);
    if (data) { next.set('run_id', data.run_id); next.set('workspace_id', data.workspace.id); }
    next.set('step', id); setParams(next, { replace: true });
  }

  async function openRun(run: SavedRun) {
    setParams({ run_id: run.runId, workspace_id: run.workspaceId }, { replace: true });
    try { await switchWorkspace(run.workspaceId); }
    catch (failure) { if (mounted.current) setError(errorMessage(failure)); }
  }

  async function start() {
    if (!owner || !acknowledged || !draft.ready || writing.current || runId || !valid) return;
    writing.current = true; setBusy(true); setError('');
    try {
      if (!UUID.test(draft.value.retryKey)) throw new Error('The saved start reference could not be read. No new sample has been requested.');
      await saveDraft(scope, DRAFT, draft.value);
      const result = checked(await api.post<Demo>('/examples/workspace', { fixture_id: 'lpis-correction-2026-v1', acknowledged: true }, { idempotencyKey: draft.value.retryKey }));
      const created = { runId: result.run_id, workspaceId: result.workspace.id };
      await saveDraft(scope, DRAFT, { ...draft.value, created });
      if (!mounted.current) return;
      draft.setValue(previous => ({ ...previous, created }));
      await openRun(created);
    } catch (failure) { if (mounted.current) setError(errorMessage(failure)); }
    finally { writing.current = false; if (mounted.current) setBusy(false); }
  }

  return <div className="hackathon-demo">
    <PageHeader title="One parcel. One correction." description="A Spanish sheep-farm example: check why a 6.70 ha claim differs from the supplied 3.02 ha maximum, then prepare the right paperwork."/>
    <p className="hackathon-demo-notice">Fictional sample farm. Not an official claim or a satellite finding.</p>
    {!valid && <Notice kind="error">This demo link is incomplete. <Link to="/app/demo">Open the demo start page</Link>.</Notice>}
    {error && <Notice kind="error">{error} <Button variant="secondary" onClick={() => setRefresh(value => value + 1)}>Refresh the saved demo</Button></Notice>}
    {draft.error && <Notice kind="warning">{draft.error}</Notice>}
    {valid && differentWorkspace && <section className="card stack"><h2>Open this saved demo</h2><p>We will check your real access to the sample workspace before opening it.</p><Button onClick={() => void openRun({ runId: runId!, workspaceId: targetWorkspace! })}>Open the demo workspace</Button></section>}
    {valid && !runId && <section className="card hackathon-demo-start"><h2>Try it without touching your farm</h2><p>Create a private workspace with seven made-up farm situations. We will start with a sheep farmer in Cáceres whose claim and supplied pasture figures differ. Your existing records stay unchanged.</p><p>You will use the normal parcel check, saved-answer review and paperwork pages. Nothing is submitted or sent.</p>
      {!owner ? <Notice>Ask a workspace owner to create a sample and invite you. Your actual permissions stay in place.</Notice> : <><label className="hackathon-demo-ack"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} disabled={busy}/><span>I understand this creates a separate workspace with made-up farm records.</span></label><Button loading={busy} disabled={!acknowledged || !draft.ready} onClick={() => void start()}>Start the guided demo</Button></>}
      {remembered && <Button variant="secondary" onClick={() => void openRun(remembered)}>Continue my saved demo</Button>}
    </section>}
    {valid && runId && !differentWorkspace && !data && !error && <Notice>Opening your saved demo…</Notice>}
    {data && !contextReady && <Notice kind="warning">The Cáceres pasture correction is not available in this saved run. <Link to={`/app/examples?${new URLSearchParams({ run_id: data.run_id, workspace_id: data.workspace.id })}`}>Open the situations available to your account or start a fresh sample</Link>. This saved run has not been replaced.</Notice>}
    {data && contextReady && <>
      <section className="hackathon-demo-story card"><p className="eyebrow">The situation</p><h2>{scenario!.title.replace(/^FICTIONAL\s*[—–-]\s*/i, '')}</h2><p>{scenario!.description}</p><p><strong>Your task:</strong> {scenario!.farmer_goal}</p></section>
      <nav className="hackathon-demo-steps" aria-label="Demo steps">{steps.map((item, index) => <button key={item.id} type="button" className={step === item.id ? 'is-current' : ''} aria-current={step === item.id ? 'step' : undefined} onClick={() => chooseStep(item.id)}><span className="hackathon-demo-step-number" aria-hidden="true">{index + 1}</span><span>{item.title}<small>{item.status}</small></span></button>)}</nav>
      <section ref={stepPanel} tabIndex={-1} className="card hackathon-demo-current" aria-labelledby="hackathon-demo-step-title"><p className="eyebrow">Step {stepIds.indexOf(step) + 1} of 4</p><h2 id="hackathon-demo-step-title">{active.title}</h2><p>{active.instruction}</p><p className="hackathon-demo-status"><strong>From the saved records:</strong> {active.status}.</p><Link className="button button-primary" to={active.href}>{active.button}</Link><p className="muted">Return to Hackathon demo from the page menu. Your progress comes from the saved records, not from clicking through these steps.</p>{step === 'values' && <details><summary>What if the farmer says the scrub was cleared?</summary><p>In this fictional alternative, the farmer says they cleared scrub last winter and disputes the supplied 45% coefficient. That is a reason to prepare a separate SIGPAC allegation, not to confirm a higher eligible area. Actual geotagged photographs and land-use or lease evidence are still needed; the authority decides.</p>{evidenceTask && <Link to={`/app/tasks/${evidenceTask.id}`}>Check the evidence still needed</Link>}<p>The default path in this demo prepares a 3.02 ha claim correction. It does not send an allegation or change SIGPAC.</p></details>}{step !== 'folder' && <Button variant="ghost" onClick={() => chooseStep(stepIds[stepIds.indexOf(step) + 1])}>Show the next step</Button>}</section>
      <div className="hackathon-demo-bottom"><Button variant="secondary" onClick={() => setRefresh(value => value + 1)}>Refresh saved progress</Button><Link to={`/app/examples?${new URLSearchParams({ run_id: data.run_id, workspace_id: data.workspace.id })}`}>Try the other six situations</Link></div>
      <details className="card"><summary>Adviser access and what this example means</summary><p>{scenario!.adviser_goal}</p><p><Link to="/app/adviser">Open Adviser view or invite an adviser</Link>. This uses actual account permissions, not a pretend adviser role.</p><p>{data.fixture_record_count} starting records across seven sample situations. {data.notice}</p><p>Private field changes do not update LPIS. A prepared ZIP is not a submission, a receipt or an acceptance. The physical 6.70 ha outline stays unchanged. The supplied coefficient and maximum are sample source values, not a current authority finding.</p></details>
    </>}
  </div>;
}
