import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { useSession } from '../auth';
import { Button, Notice, PageHeader } from '../components';
import { saveDraft, usePrivateDraft } from '../offline';
import type { RecordItem } from '../types';
import { caseStatusLabel, type CaseStatus } from './case-types';
import { ImportDemo } from './ImportDemo';
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
type StepId = 'fields' | 'import' | 'checks';
const stepIds: StepId[] = ['fields', 'import', 'checks'];
type Farm = RecordItem<{ name: string; parcels: { id: string; name: string; active?: boolean }[] }>;
type ClaimFact = RecordItem<{ farm_id: string; parcel_id?: string; key: string; value: unknown; unit?: string | null; temporal_basis?: string; period?: string | null }>;
type Guide = { case_id: string; case_revision: number; evaluation: {
  title: string; explanation: string; status: string;
  deadlines: { national: string | null; effective: string | null; eu_latest_possible: string | null; status: string };
  sources: { key: string; title: string; url: string; article?: string; version?: string }[];
} };
const sampleLabel = (value: string) => value.replace(/^FICTIONAL(?:\s+example)?\s*(?:[—–-]\s*)?/i, '');
function sourceHref(value: string) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
function suppliedNumber(facts: ClaimFact[] | undefined, id: string | undefined, key: string, unit: string) {
  const data = facts?.find(fact => fact.id === id)?.data;
  if (!data || data.key !== key || data.unit !== unit || data.temporal_basis !== 'campaign_year' || data.period !== '2026'
    || typeof data.value !== 'number' || !Number.isFinite(data.value)) return 'Needs checking';
  const raw = String(data.value);
  const displayed = unit === '%' || /e/i.test(raw) ? raw : !raw.includes('.') ? `${raw}.00` : raw.split('.')[1].length === 1 ? `${raw}0` : raw;
  return `${displayed}${unit === '%' ? '%' : ` ${unit}`}`;
}

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
    setError('');
    if (valid && runId && !differentWorkspace) {
      api.downloadResponse(`/examples/workspace/${runId}`, { signal: controller.signal })
        .then(response => response.json() as Promise<Demo>)
        .then(value => { const saved = checked(value, workspaceId, runId); if (mounted.current && sequence === generation.current) setData(saved); })
        .catch(failure => { if (mounted.current && sequence === generation.current && !controller.signal.aborted) { setData(null); setError(errorMessage(failure)); } });
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
  const claimFact = facts.find(record => record.alias === 'es-claimed-area');
  const evidenceTask = related.find(record => record.kind === 'tasks' && record.alias === 'es-lease-evidence');
  const savedCase = scenario?.cases.find(item => item.id === related.find(record => record.kind === 'admin_cases')?.id);
  const reviewedFacts = facts.filter(record => record.status === 'confirmed').length;
  const requestedStep = params.get('step');
  const step: StepId = requestedStep && stepIds.includes(requestedStep as StepId) ? requestedStep as StepId
    : requestedStep === 'correction' || requestedStep === 'folder' ? 'checks' : 'fields';
  const contextReady = !!farm && facts.length === 4 && !!savedCase && [farm.id, savedCase.id, ...facts.map(record => record.id)].every(id => UUID.test(id));
  const contextKey = contextReady ? `${data!.run_id}/${farm!.id}/${farm!.revision}/${facts.map(fact => `${fact.id}:${fact.revision}`).join(',')}/${savedCase!.id}/${savedCase!.revision}` : '';
  const [fieldContext, setFieldContext] = useState<{ key: string; farm?: Farm; facts?: ClaimFact[]; parcelId?: string; error?: string }>({ key: '' });
  const [guidance, setGuidance] = useState<{ key: string; guide?: Guide; error?: string }>({ key: '' });
  const currentFields = fieldContext.key === contextKey ? fieldContext : null;
  const currentGuide = guidance.key === contextKey ? guidance : null;
  const activeFields = currentFields?.farm?.data.parcels.filter(parcel => parcel.active !== false);
  const fieldQuery = new URLSearchParams({ expected_farm_revision: String(farm?.revision ?? ''), reporting_year: '2026' });
  if (savedCase) { fieldQuery.set('case_id', savedCase.id); fieldQuery.set('expected_case_revision', String(savedCase.revision)); }
  const fieldsHref = farm ? `/app/fields/${farm.id}/check?${fieldQuery}` : '';
  const parcelQuery = new URLSearchParams(fieldQuery);
  if (currentFields?.parcelId) parcelQuery.set('parcel_id', currentFields.parcelId);
  const pastureHref = farm && currentFields?.parcelId ? `/app/fields/${farm.id}?${parcelQuery}#boundaries-${farm.id}` : '';
  const factsHref = farm ? `/app/fields/${farm.id}#facts` : '';
  const caseHref = savedCase ? `/app/cases/${savedCase.id}` : '';
  const steps: { id: StepId; title: string; subtitle: string }[] = [
    { id: 'fields', title: 'Check my fields', subtitle: 'Map, crop and claim' },
    { id: 'import', title: 'Import my records', subtitle: 'Extract, check and save' },
    { id: 'checks', title: 'Before and after filing', subtitle: 'Checks, dates and correction' },
  ];
  const active = steps.find(item => item.id === step)!;

  useEffect(() => {
    if (!contextReady || !farm || !claimFact || !savedCase) return;
    const controller = new AbortController();
    const get = async <T,>(path: string) => (await api.downloadResponse(path, { signal: controller.signal })).json() as Promise<T>;
    void Promise.all([get<Farm>(`/farms/${farm.id}`), Promise.all(facts.map(fact => get<ClaimFact>(`/facts/${fact.id}`)))]).then(([savedFarm, savedFacts]) => {
      if (savedFarm.id !== farm.id || savedFarm.kind !== 'farms' || savedFarm.workspace_id !== workspaceId || savedFarm.revision !== farm.revision
        || !Array.isArray(savedFarm.data.parcels) || savedFarm.data.parcels.length > 2000
        || savedFacts.some((savedFact, index) => savedFact.id !== facts[index].id || savedFact.kind !== 'facts' || savedFact.workspace_id !== workspaceId
          || savedFact.revision !== facts[index].revision || savedFact.data.farm_id !== farm.id)) throw new Error('The farm changed. Refresh the saved demo before opening a particular field.');
      const parcelId = savedFacts.find(fact => fact.id === claimFact.id)?.data.parcel_id;
      const matches = savedFarm.data.parcels.filter(parcel => parcel.active !== false && parcel.id === parcelId);
      if (parcelId && (!UUID.test(parcelId) || matches.length !== 1)) throw new Error('D04’s saved field link needs checking. Open the whole map to review the current fields.');
      if (!controller.signal.aborted) setFieldContext({ key: contextKey, farm: savedFarm, facts: savedFacts, parcelId });
    }).catch(failure => { if (!controller.signal.aborted) setFieldContext({ key: contextKey, error: errorMessage(failure) }); });
    void get<Guide>(`/cases/${savedCase.id}/correction-guide`).then(guide => {
      if (guide.case_id !== savedCase.id || guide.case_revision !== savedCase.revision || !guide.evaluation
        || typeof guide.evaluation.title !== 'string' || typeof guide.evaluation.explanation !== 'string'
        || !guide.evaluation.deadlines || !Array.isArray(guide.evaluation.sources) || guide.evaluation.sources.length > 20
        || guide.evaluation.sources.some(source => !source || typeof source.key !== 'string' || typeof source.title !== 'string' || typeof source.url !== 'string')
        || guide.evaluation.deadlines.effective !== null && !/^\d{4}-\d{2}-\d{2}$/.test(guide.evaluation.deadlines.effective)) throw new Error('The saved date guidance changed. Open the correction to check its current details.');
      if (!controller.signal.aborted) setGuidance({ key: contextKey, guide });
    }).catch(failure => { if (!controller.signal.aborted) setGuidance({ key: contextKey, error: errorMessage(failure) }); });
    return () => controller.abort();
  }, [contextKey, refresh]);

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
    <PageHeader title="From field to paperwork." description="Check a sheep farm, bring in a record, then work through the checks and any correction."/>
    <p className="hackathon-demo-badge">Demo · private sample records</p>
    {!valid && <Notice kind="error">This demo link is incomplete. <Link to="/app/demo">Open the demo start page</Link>.</Notice>}
    {error && <Notice kind="error">{error} <Button variant="secondary" onClick={() => setRefresh(value => value + 1)}>Refresh the saved demo</Button></Notice>}
    {draft.error && <Notice kind="warning">{draft.error}</Notice>}
    {valid && differentWorkspace && <section className="card stack"><h2>Open this saved demo</h2><p>We will check your real access to the sample workspace before opening it.</p><Button onClick={() => void openRun({ runId: runId!, workspaceId: targetWorkspace! })}>Open the demo workspace</Button></section>}
    {valid && !runId && <section className="card hackathon-demo-start"><h2>Start with a farm ready to explore</h2><p>Create a separate sample workspace. Start in Cáceres: D04’s pasture claim needs comparing, D05 overlaps another field and D07 has no crop recorded.</p><p>Your existing farm stays unchanged. You will use the working map, record import and paperwork tools.</p>
      {!owner ? <Notice>Ask a workspace owner to create a sample and invite you. Your actual permissions stay in place.</Notice> : <><label className="hackathon-demo-ack"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} disabled={busy}/><span>I understand this creates a separate workspace with made-up farm records.</span></label><Button loading={busy} disabled={!acknowledged || !draft.ready} onClick={() => void start()}>Start the guided demo</Button></>}
      {remembered && <Button variant="secondary" onClick={() => void openRun(remembered)}>Continue my saved demo</Button>}
    </section>}
    {valid && runId && !differentWorkspace && !data && !error && <Notice>Opening your saved demo…</Notice>}
    {data && !contextReady && <Notice kind="warning">The Cáceres pasture correction is not available in this saved run. <Link to={`/app/examples?${new URLSearchParams({ run_id: data.run_id, workspace_id: data.workspace.id })}`}>Open the situations available to your account or start a fresh sample</Link>. This saved run has not been replaced.</Notice>}
    {data && contextReady && <>
      <nav className="hackathon-demo-steps" aria-label="Demo chapters">{steps.map((item, index) => <button key={item.id} type="button" className={step === item.id ? 'is-current' : ''} aria-current={step === item.id ? 'step' : undefined} onClick={() => chooseStep(item.id)}><span className="hackathon-demo-step-number" aria-hidden="true">{index + 1}</span><span>{item.title}<small>{item.subtitle}</small></span></button>)}</nav>
      <section ref={stepPanel} tabIndex={-1} className="card hackathon-demo-current" aria-labelledby="hackathon-demo-step-title">
        <p className="eyebrow">Chapter {stepIds.indexOf(step) + 1} of 3</p><h2 id="hackathon-demo-step-title">{active.title}</h2>
        {step === 'fields' && <div className="hackathon-demo-chapter">
          <p>See the whole farm first. Compare boundaries, fix a missing crop and keep a claim figure separate from the land’s physical outline.</p>
          <p className="hackathon-demo-status">{activeFields ? `${activeFields.length} active fields in the saved farm` : 'Open the map to see the current fields'} · {reviewedFacts} of {facts.length} supplied claim answers checked by a person.</p>
          <Link className="button button-primary" to={fieldsHref}>Open the field map and checks</Link>
          <div className="hackathon-demo-claim"><h3>D04: why does the claim need attention?</h3><dl><div><dt>Saved claim</dt><dd>{suppliedNumber(currentFields?.facts, claimFact?.id, 'cap.claimed_area_ha', 'ha')}</dd></div><div><dt>Supplied maximum</dt><dd>{suppliedNumber(currentFields?.facts, facts.find(fact => fact.alias === 'es-eligible-area')?.id, 'cap.supplied_max_eligible_area_ha', 'ha')}</dd></div><div><dt>Supplied pasture coefficient</dt><dd>{suppliedNumber(currentFields?.facts, facts.find(fact => fact.alias === 'es-coefficient')?.id, 'cap.pasture_coefficient_percent', '%')}</dd></div><div><dt>Proposed corrected claim</dt><dd>{suppliedNumber(currentFields?.facts, facts.find(fact => fact.alias === 'es-corrected-area')?.id, 'cap.proposed_claim_area_ha', 'ha')}</dd></div></dl><p>Compare these saved figures with the original sources. The coefficient is not a smaller boundary to draw.</p><div className="hackathon-demo-actions"><Link to={factsHref}>Review D04’s saved figures</Link>{pastureHref && <Link to={pastureHref}>Adjust D04 on the map</Link>}</div></div>
          {currentFields?.error && <Notice kind="warning">{currentFields.error}</Notice>}
          <Link className="hackathon-demo-easy" to={`/app/easy-form?farm_id=${farm!.id}`}>Easy form: fill it in step by step</Link>
          <details><summary>What if the pasture was cleared?</summary><p>Keep the physical outline. If the farmer disputes the supplied coefficient, gather dated photographs and land-use evidence for a separate SIGPAC allegation; the authority decides.</p>{evidenceTask && <Link to={`/app/tasks/${evidenceTask.id}`}>Open the evidence task</Link>}</details>
        </div>}
        {step === 'import' && <div className="hackathon-demo-chapter"><p>Bring in a real file, let the app extract suggestions, then check them against the original before saving.</p><ImportDemo farmId={farm!.id} farmName={sampleLabel(farm!.label)}/></div>}
        {step === 'checks' && <div className="hackathon-demo-chapter">
          <p className="hackathon-demo-status"><strong>Current saved case:</strong> {caseStatusLabel[savedCase!.status] ?? 'Check the current case'}.</p>
          <div className="hackathon-demo-check-jobs"><section><h3>Before you file</h3><p>Check fields and every prepared answer against its source.</p><Link to={fieldsHref}>Run the field checks</Link><Link to={`${caseHref}/correction?step=4`}>Check each answer</Link></section><section><h3>After you filed</h3><p>Keep the original, record what happened and prepare a correction through the right route.</p><Link to={`${caseHref}/correction?step=1`}>Work through a correction</Link><Link to={`${caseHref}/correction?step=3`}>Check the dates and conditions</Link></section></div>
          <section className="hackathon-demo-date" aria-label="Saved correction date guidance"><h3>{currentGuide?.guide?.evaluation.deadlines.effective ? `Source-linked date: ${currentGuide.guide.evaluation.deadlines.effective}` : 'Correction date not established'}</h3>{currentGuide?.guide ? <><p>{sampleLabel(currentGuide.guide.evaluation.title)}</p><details><summary>Source and conditions</summary><p>{currentGuide.guide.evaluation.explanation}</p><p>A source-linked supplied date is not independent legal verification. The relevant conditions and current authority route still need checking.</p><ul>{currentGuide.guide.evaluation.sources.map(source => { const href = sourceHref(source.url); return <li key={source.key}>{href ? <a href={href} target="_blank" rel="noopener noreferrer">{source.title}</a> : source.title}{source.article && <> · {source.article}</>}{source.version && <> · {source.version}</>}</li>; })}</ul></details></> : <p>{currentGuide?.error || 'Open the date questions to check the saved details and their sources.'}</p>}<Link to={`${caseHref}/correction?step=3`}>Review the date questions</Link></section>
          <details className="hackathon-demo-date" data-testid="demo-historical-deadlines"><summary>Historical deadline: 7 September 2026 · limited E1/E2 monitoring response, now past</summary><p>Extremadura campaign references. Neither is assigned to this case.</p><ul><li><strong><time dateTime="2026-05-15">15 May 2026</time> · ordinary filing · past</strong><p>The listed 2026/2027 Single Application presentation period, not an ordinary amendment deadline. A later exceptional late-filing announcement exists; its operative conditions were not checked here.</p><a href="https://doe.juntaex.es/otrosFormatos/html.php?anio=2026&doe=710o&xml=2026060825" target="_blank" rel="noopener noreferrer">DOE 71, 15 April 2026 · resolution of 8 April</a></li><li><strong><time dateTime="2026-09-07">7 September 2026</time> · limited monitoring response · past</strong><p>E1/E2 yellow/red monitoring incidents only: reason 5 modifications or reason 8 georeferenced-photo documents. Not a blanket amendment, appeal or correction date.</p><a href="https://doe.juntaex.es/otrosFormatos/html.php?anio=2026&doe=1720o&xml=2026081488" target="_blank" rel="noopener noreferrer">DOE 172, 4 September 2026 · announcement of 1 September</a></li></ul><p>The ordinary 2026 amendment date and this case’s matching notice remain unestablished. Select an actual matching notice and its saved source in the date questions before entering a date. A SIGPAC service window is a different procedure.</p><details><summary>Source review limits</summary><p>The full operative HTML acts for May (DOE 71) and September (DOE 172) were read. DOE identifies the linked official PDFs as authoritative; those PDFs were not fetched. These references do not establish applicability to this case or current permission to amend.</p></details></details>
          <Link className="button button-primary" to={`${caseHref}#case-checks`}>Review the case and prepare the folder</Link><p className="muted">Preparing a folder and recording actual sending are separate steps.</p>
        </div>}
        {step !== 'checks' && <Button variant="ghost" onClick={() => chooseStep(stepIds[stepIds.indexOf(step) + 1])}>Next: {steps[stepIds.indexOf(step) + 1].title.toLowerCase()}</Button>}
      </section>
      <div className="hackathon-demo-bottom"><Button variant="secondary" onClick={() => setRefresh(value => value + 1)}>Refresh saved records</Button><Link to={`/app/examples?${new URLSearchParams({ run_id: data.run_id, workspace_id: data.workspace.id })}`}>Try the other farm situations</Link></div>
      <details className="card"><summary>About this demo and adviser access</summary><p>The records are authored examples in your separate workspace. You use actual permissions and working save/review flows. Private field changes do not update LPIS; a prepared folder is not a submission, receipt or acceptance.</p><p><Link to="/app/adviser">Open Adviser view or invite an adviser</Link>.</p><p>{data.fixture_record_count} starting records across seven situations. Source figures are not a current eligibility decision; national correction dates remain unknown until their applicable source and conditions are checked.</p></details>
    </>}
  </div>;
}
