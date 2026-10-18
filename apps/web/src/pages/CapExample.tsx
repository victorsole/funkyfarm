import { useEffect, useId, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { useSession } from '../auth';
import { Button, Notice, PageHeader } from '../components';
import { saveDraft, usePrivateDraft } from '../offline';
import type { RecordItem } from '../types';
import { caseStatusLabel, referenceHref, type CaseChecks, type CaseData } from './case-types';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const draftName = 'examples/cap-correction-v1';
type Geometry = { type: 'Polygon' | 'MultiPolygon'; coordinates: number[][][] | number[][][][] };
type Sample = { id: string; title: string; filename: string; mime_type: 'text/plain'; contents: string; notice: string };
type Example = {
  run_id: string; farm: RecordItem; case: RecordItem<CaseData>; proposal: RecordItem;
  scenario: { id: string; title: string; notice: string; claimed_geometry: Geometry; claimed_label: string;
    reference_geometry: Geometry; reference_label: string; reference_year: number;
    fictional_notice_date: string; fictional_deadline: string; original_reference: string;
    items: { key: string; id: string; title: string; description: string }[]; samples: Sample[] };
  checks: CaseChecks;
  progress: { case_status: CaseData['status']; proposal_status: string; total_items: number; resolved_items: number;
    open_items: number; cancelled_items: number; can_review: boolean; review_current: boolean; next_action: string;
    steps: { key: string; title: string; status: string; href: string }[]; notice: string };
};
type SavedExample = { runId: string; attemptId: string };
const itemStatus: Record<string, string> = { open: 'Still to do', in_progress: 'Started', resolved: 'Reviewed as done', cancelled: 'Set aside' };
const proposalStatus: Record<string, string> = { proposed: 'Waiting for your review', approved: 'Approved in the private workspace', rejected: 'Not approved', stale: 'Needs checking again' };
const label = (value: string) => value.replace(/\bFICTIONAL\b(?:\s+TRAINING)?(?:\s+EXAMPLE)?(?:\s*[—–:.-]\s*|\s+)?/gi, '')
  .replace(/^Authored\s+/i, '').replace(/\s*[—–-]\s*(?=,|$)/g, '').replace(/\s+,/g, ',').trim();
const taskText: Record<string, string> = {
  boundary: 'Compare the two outlines. Save the boundary you want to use, then review the change.',
  land_use: 'Upload the land-use record, select it in the case and review the requested item. A drawing alone does not prove a right to claim.',
  commitment: 'Upload the commitment record and check the notice’s conditions. A protected-area label alone does not decide eligibility.',
};
const appLink = (href: string | undefined) => {
  if (!href?.startsWith('/app/') || /[\\\u0000-\u0020]/.test(href)) return null;
  try { const url = new URL(href, 'https://farm.invalid'); return url.origin === 'https://farm.invalid' && url.pathname.startsWith('/app/') ? `${url.pathname}${url.search}${url.hash}` : null; }
  catch { return null; }
};

function polygons(geometry: Geometry): number[][][][] {
  return geometry?.type === 'Polygon' ? [geometry.coordinates as number[][][]] : geometry?.type === 'MultiPolygon' ? geometry.coordinates as number[][][][] : [];
}

function validGeometry(geometry: Geometry): boolean {
  const parts = polygons(geometry);
  let points = 0;
  return Array.isArray(parts) && parts.length > 0 && parts.length <= 20 && parts.every((part: number[][][]) => Array.isArray(part) && part.length > 0 && part.every((ring: number[][]) => Array.isArray(ring) && ring.length >= 4 && ring.every((point: number[]) => {
    points += 1;
    return points <= 2000 && Array.isArray(point) && point.length >= 2 && Number.isFinite(point[0]) && Math.abs(point[0]) <= 180 && Number.isFinite(point[1]) && Math.abs(point[1]) <= 90;
  })));
}

function checkedExample(data: Example, workspace: string, runId?: string): Example {
  if (!data || !UUID.test(data.run_id) || runId && data.run_id.toLowerCase() !== runId.toLowerCase()) throw new Error('The returned example is not the one you opened. Try reopening its saved link.');
  const records = [data.farm, data.case, data.proposal];
  if (records.some(record => !record || !UUID.test(record.id) || record.workspace_id !== workspace || !Number.isInteger(record.revision) || record.revision < 1 || !record.data)
    || data.case.data.farm_id !== data.farm.id || data.proposal.data.farm_id !== data.farm.id
    || data.farm.kind !== 'farms' || data.case.kind !== 'admin_cases' || data.proposal.kind !== 'field_change_proposals'
    || data.farm.data.country !== 'NL' || data.scenario?.id !== 'cap-correction-v1') throw new Error('The example does not match this farm workspace. No progress has been assumed.');
  const { scenario, progress, checks } = data;
  if (!validGeometry(scenario.claimed_geometry) || !validGeometry(scenario.reference_geometry)
    || !Array.isArray(scenario.items) || scenario.items.length !== 3 || !Array.isArray(scenario.samples) || scenario.samples.length !== 2
    || scenario.samples.some((sample: Sample) => !sample || typeof sample.id !== 'string' || typeof sample.title !== 'string' || typeof sample.notice !== 'string' || typeof sample.filename !== 'string' || sample.mime_type !== 'text/plain' || typeof sample.contents !== 'string')
    || !progress || !Array.isArray(progress.steps) || progress.steps.length !== 3 || !Array.isArray(data.case.data.items)
    || progress.steps.some((step: Example['progress']['steps'][number]) => {
      const authored = scenario.items.find((item: Example['scenario']['items'][number]) => item.key === step.key);
      return !authored || typeof step.title !== 'string' || typeof step.href !== 'string' || !Object.hasOwn(itemStatus, step.status)
        || data.case.data.items.find((item: CaseData['items'][number]) => item.id === authored.id)?.status !== step.status;
    })
    || ![progress.total_items, progress.resolved_items, progress.open_items, progress.cancelled_items].every(value => Number.isInteger(value) && value >= 0)
    || progress.total_items < 3 || progress.total_items !== data.case.data.items.length || progress.open_items + progress.resolved_items + progress.cancelled_items !== progress.total_items
    || progress.case_status !== data.case.data.status || progress.proposal_status !== data.proposal.data.status
    || typeof progress.can_review !== 'boolean' || typeof progress.review_current !== 'boolean'
    || !checks || checks.case_id !== data.case.id || checks.case_revision !== data.case.revision || !Array.isArray(checks.issues)) {
    throw new Error('The saved example or its checks could not be read completely. Please refresh; missing checks are not a completed step.');
  }
  return data;
}

function CompareOutlines({ scenario }: { scenario: Example['scenario'] }) {
  const id = useId();
  const claimed = polygons(scenario.claimed_geometry); const reference = polygons(scenario.reference_geometry);
  const points = [...claimed, ...reference].flat(2);
  const west = Math.min(...points.map(point => point[0])); const east = Math.max(...points.map(point => point[0]));
  const south = Math.min(...points.map(point => point[1])); const north = Math.max(...points.map(point => point[1]));
  const longitude = (west + east) / 2; const latitude = (south + north) / 2;
  const cosine = Math.max(0.001, Math.cos(latitude * Math.PI / 180));
  const scale = Math.min(520 / Math.max((east - west) * cosine, 0.000001), 260 / Math.max(north - south, 0.000001));
  const path = (part: number[][][]) => part.map(ring => ring.map((point, index) => `${index ? 'L' : 'M'}${300 + (point[0] - longitude) * cosine * scale} ${150 - (point[1] - latitude) * scale}`).join(' ') + ' Z').join(' ');
  return <figure style={{ margin: '1rem 0' }}>
    <svg viewBox="0 0 600 300" role="img" aria-labelledby={`${id}-title ${id}-description`} style={{ display: 'block', width: '100%', maxHeight: 360, background: 'var(--farm-soft)', border: '1px solid var(--line)', borderRadius: 14 }}>
      <title id={`${id}-title`}>Sample claim and supplied reference outlines</title><desc id={`${id}-description`}>The solid green outline is {scenario.reference_label}. The dashed blue outline is {scenario.claimed_label}. These are sample shapes, not satellite imagery or an official field map.</desc>
      {reference.map((part, index) => <path key={`reference-${index}`} d={path(part)} style={{ fill: 'var(--farm)', stroke: 'var(--farm-text)' }} fillOpacity=".3" fillRule="evenodd" strokeWidth="3" vectorEffect="non-scaling-stroke" />)}
      {claimed.map((part, index) => <path key={`claimed-${index}`} d={path(part)} style={{ fill: 'var(--eu)', stroke: 'var(--eu)' }} fillOpacity=".12" fillRule="evenodd" strokeWidth="3" strokeDasharray="9 5" vectorEffect="non-scaling-stroke" />)}
      <text x="12" y="284" style={{ fill: 'var(--muted)' }} fontSize="13">Sample field plan</text>
    </svg>
    <figcaption><p><strong>Dashed blue:</strong> {label(scenario.claimed_label)}<br /><strong>Solid green:</strong> {label(scenario.reference_label)} · {scenario.reference_year}</p><p className="muted">Compare the shapes; they do not establish ownership or eligible area.</p></figcaption>
  </figure>;
}

function downloadSample(sample: Sample, title: string) {
  if (sample.mime_type !== 'text/plain' || typeof sample.contents !== 'string' || new TextEncoder().encode(sample.contents).length > 512000) throw new Error('This sample text is unavailable or too large. No file was saved.');
  const blob = new Blob([`DEMO SAMPLE — NOT A REAL FARM RECORD\n${title}\n${sample.notice}\n\n`, sample.contents], { type: 'text/plain;charset=utf-8' });
  const href = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href = href; link.download = `DEMO-${sample.filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 140).replace(/^FICTIONAL-/i, '').replace(/\.txt$/i, '') || 'sample'}.txt`;
  link.click(); window.setTimeout(() => URL.revokeObjectURL(href), 1000);
}

function CapWalkthrough({ scope, workspaceId, owner }: { scope: string; workspaceId: string; owner: boolean }) {
  const [params, setParams] = useSearchParams();
  const [initial] = useState<SavedExample>(() => ({ runId: '', attemptId: crypto.randomUUID() }));
  const draft = usePrivateDraft<SavedExample>(draftName, initial);
  const queryRun = params.get('run_id');
  const runId = queryRun !== null ? queryRun : draft.ready ? draft.value.runId : '';
  const validRun = !!runId && UUID.test(runId) && params.getAll('run_id').length <= 1;
  const invalidRun = (queryRun !== null || !!runId) && !validRun;
  const [refresh, setRefresh] = useState(0);
  const [creating, setCreating] = useState(false); const [createError, setCreateError] = useState(''); const [sampleError, setSampleError] = useState('');
  const [result, setResult] = useState<{ binding: string; data?: Example; error?: string }>({ binding: '' });
  const binding = JSON.stringify([scope, params.getAll('run_id'), runId, refresh]); const currentBinding = useRef(binding); currentBinding.current = binding;
  const current = result.binding === binding ? result : null;
  const request = useRef<AbortController | null>(null); const generation = useRef(0); const mounted = useRef(false); const writing = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; request.current?.abort(); };
  }, []);

  useEffect(() => {
    if (!validRun) { request.current?.abort(); generation.current += 1; writing.current = false; setCreating(false); return; }
    const controller = new AbortController(); request.current?.abort(); request.current = controller;
    const sequence = ++generation.current; setResult({ binding }); setSampleError(''); setCreateError('');
    api.downloadResponse(`/examples/cap/${encodeURIComponent(runId)}`, { signal: controller.signal })
      .then(response => response.json() as Promise<Example>)
      .then(data => { const checked = checkedExample(data, workspaceId, runId); if (mounted.current && sequence === generation.current && currentBinding.current === binding) setResult({ binding, data: checked }); })
      .catch(reason => { if (mounted.current && !controller.signal.aborted && sequence === generation.current && currentBinding.current === binding) setResult({ binding, error: errorMessage(reason) }); });
    return () => { controller.abort(); generation.current += 1; };
  }, [binding, validRun, runId, workspaceId]);

  useEffect(() => {
    if (current?.data && draft.ready && draft.value.runId !== current.data.run_id) draft.setValue(previous => ({ ...previous, runId: current.data!.run_id }));
  }, [current?.data?.run_id, draft.ready]);

  async function create() {
    if (!owner || !draft.ready || creating || writing.current || runId || queryRun !== null) return;
    writing.current = true; setCreating(true); setCreateError('');
    const sequence = ++generation.current; const origin = binding; const controller = new AbortController(); request.current?.abort(); request.current = controller;
    const active = () => mounted.current && !controller.signal.aborted && sequence === generation.current && currentBinding.current === origin;
    try {
      if (!UUID.test(draft.value.attemptId)) throw new Error('The saved retry reference could not be read. Keep this page open and ask for help before creating another example.');
      await saveDraft(scope, draftName, draft.value);
      if (!active()) return;
      const data = checkedExample(await api.post<Example>('/examples/cap', { acknowledged: true }, { idempotencyKey: draft.value.attemptId, signal: controller.signal }), workspaceId);
      if (!active()) return;
      draft.setValue(previous => ({ ...previous, runId: data.run_id }));
      setCreating(false);
      const next = new URLSearchParams(params); next.set('run_id', data.run_id); setParams(next, { replace: true });
    } catch (reason) { if (active()) setCreateError(errorMessage(reason)); }
    finally { writing.current = false; if (mounted.current && currentBinding.current === origin) setCreating(false); }
  }

  const data = current?.data;
  const caseHref = data ? `/app/cases/${data.case.id}` : '';
  return <>
    <PageHeader title="Try a CAP correction" description="Check a sample claim, correct its field details and prepare the records." />
    <p><span className="badge">Demo</span></p>
    {!draft.ready && <p role="status">Looking for your saved example on this device…</p>}
    {draft.error && <Notice kind="warning">{draft.error} Keep the saved example link before leaving.</Notice>}
    {invalidRun && <Notice kind="error">This example link is incomplete or invalid. Open its original saved link; a new example has not been created.</Notice>}
    {!runId && !invalidRun && draft.ready && <section className="paper-section">
      <h2>Start with a sample Dutch farm</h2>
      <p>You will compare the claimed boundary with a supplied reference, check a correction, and attach the missing land-use and commitment records.</p>
      <p>Add sample records to this workspace. Your existing records stay unchanged.</p>
      {owner ? <Button onClick={() => void create()} loading={creating} disabled={draft.saving}>Start example</Button> : <Notice>Ask the workspace owner to start an example, or open its saved link.</Notice>}
      {createError && <Notice kind="error">{createError} Your retry reference has been kept; no second example should be started.</Notice>}
    </section>}
    {validRun && !data && !current?.error && <p role="status">Opening the saved example and checking its current records…</p>}
    {current?.error && <Notice kind="error">{current.error}<div className="actions"><Button variant="secondary" onClick={() => setRefresh(value => value + 1)}>Try opening the saved example again</Button></div></Notice>}
    {data && <>
      <section className="paper-section">
        <div className="section-heading"><h2>{label(data.scenario.title)}</h2><Button variant="secondary" onClick={() => setRefresh(value => value + 1)}>Refresh example progress</Button></div>
        <p><strong>Farm:</strong> {label(String(data.farm.data.name || 'Sample Dutch farm'))}</p>
        <CompareOutlines scenario={data.scenario} />
        <details><summary>Read the claim and notice details</summary><dl className="detail-grid"><div><dt>Original claim reference</dt><dd>{label(data.scenario.original_reference)}</dd></div><div><dt>Notice date</dt><dd>{data.scenario.fictional_notice_date}</dd></div><div><dt>Response date in this example</dt><dd>{data.scenario.fictional_deadline}</dd></div></dl><p>These are sample dates, not a national correction deadline. For a real case, check the actual notice and the rules that apply.</p></details>
      </section>
      <section className="paper-section">
        <h2>Work through these three things</h2>
        <p>{data.progress.resolved_items} of {data.progress.total_items} items reviewed as done; {data.progress.open_items} still open{data.progress.cancelled_items ? `; ${data.progress.cancelled_items} set aside, not completed` : ''}.</p>
        <ol>{data.progress.steps.map(step => <li key={step.key}><h3>{label(step.title)}</h3><p><strong>{itemStatus[step.status] ?? 'Status needs checking in the saved case'}</strong></p><p>{taskText[step.key] || 'Check the saved record and review what needs changing.'}</p>{appLink(step.href) ? <Link className="button button-secondary" to={appLink(step.href)!}>Open this step</Link> : <Link to={caseHref}>Open the saved case to check this step</Link>}</li>)}</ol>
        <p><strong>Saved field change:</strong> {proposalStatus[data.progress.proposal_status] ?? 'Open the proposal to check its status'}.</p>
        <p>Compare the outline before approving the private change. If its records changed, check the case again.</p>
        <Link className="button button-secondary" to={referenceHref({ kind: 'field_change_proposals', id: data.proposal.id, revision: data.proposal.revision }, data.farm.id)}>Open the actual saved field proposal</Link>
      </section>
      <section className="paper-section">
        <h2>Add the missing records yourself</h2>
        <p>Download the sample land-use and commitment records below. Then open Documents, choose each file, save it to this example farm, and return to the case. Select the right document and review each requested item separately.</p>
        <ul>{data.scenario.samples.map(sample => <li key={sample.id}><strong>{label(sample.title)}</strong><Button variant="secondary" onClick={() => { try { downloadSample(sample, data.scenario.title); setSampleError(''); } catch (reason) { setSampleError(errorMessage(reason)); } }}>Download {label(sample.title).toLowerCase()}</Button></li>)}</ul>
        {sampleError && <Notice kind="error">{sampleError}</Notice>}
        <p>Choose each document yourself. For a real farm, use your actual records.</p>
        <div className="actions"><Link className="button button-secondary" to={`/app/documents?${new URLSearchParams({ farm_id: data.farm.id })}`}>Open Documents for the example farm</Link><Link className="button button-secondary" to={caseHref}>Select evidence and review the case items</Link></div>
      </section>
      <section className="paper-section">
        <h2>Check the case, then prepare the folder</h2>
        <p><strong>Case:</strong> {caseStatusLabel[data.progress.case_status] ?? 'Open the saved case to check its status'}.</p>
        <p>{label(data.progress.next_action)}</p>
        {data.checks.issues.length > 0 ? <ul>{data.checks.issues.map((issue, index) => <li key={`${issue.code}-${index}`}>{label(issue.message)}{appLink(issue.href) && <> <Link to={appLink(issue.href)!}>Check the linked record</Link></>}</li>)}</ul> : <p>No issues were returned by the current case check. You still need to review the selected records yourself.</p>}
        <p>{data.progress.review_current ? 'The selected saved records currently match the case review.' : data.progress.can_review ? 'The current check allows you to open the case and review the selected records yourself.' : 'A new review is not available in the case’s present state. Open it to check the remaining issues or the next permitted action.'}</p>
        <p>Review the selected records in the case, then download the complete folder with its attachments.</p>
        <Link className="button button-primary" to={caseHref}>Open the case for review and its complete folder</Link>
        <p className="muted">Private changes do not update LPIS. Downloading does not send anything; do not file the sample documents. Sending and authority replies are separate steps.</p>
        <p className="muted">Choose Refresh example progress to check the saved result.</p>
      </section>
      <p><Link to={`/app/examples/cap?${new URLSearchParams({ run_id: data.run_id })}`}>Saved link to this example</Link></p>
    </>}
    <p><Link to="/app/paperwork">Back to Paperwork</Link></p>
  </>;
}

export function CapExamplePage() {
  const { session, loading, error } = useSession();
  if (loading) return <p role="status">Checking your farm workspace access…</p>;
  if (!session) return <Notice kind="error">{error || 'Sign in to open your private example.'}</Notice>;
  const binding = JSON.stringify([session.user.id, session.workspace.id, session.workspace.role, session.workspace.permissions, session.workspace.farm_ids]);
  return <CapWalkthrough key={binding} scope={`${session.user.id}/${session.workspace.id}`} workspaceId={session.workspace.id} owner={session.workspace.role === 'owner'} />;
}
