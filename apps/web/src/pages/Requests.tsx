import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { useSession } from '../auth';
import { Button, Field, Notice, PageHeader } from '../components';
import { useRecords } from '../hooks';
import { usePrivateDraft } from '../offline';
import type { Pack, Page, RecordItem } from '../types';
import { ReportAnswer } from './Reports';
import { CZECH_JOURNAL_PACK, CzechJournal, RetainedCzechJournals } from './CzechJournal';
import { PORTUGUESE_JOURNAL_PACK, PORTUGUESE_JOURNAL_KEY, portugueseJournalPath } from './RetainedPortugueseJournal';

type Requirement = { id?: string; key: string; label: string; required: boolean; unit?: string | null; temporal_basis?: string; period?: string | null; parcel_id?: string | null; physical_label?: string | null; value_type?: string; choices?: { value: unknown; label: string }[]; prompt?: string; state?: string; proposals?: RecordItem<FactData>[]; confirmed?: RecordItem<FactData>[] };
type GuidedQuestions = { questions: Requirement[]; completed_count: number; total_count: number; blocked_reasons: string[]; journals?: { schema_id: string; pack_id: string; title: string; entries: { operation_id: string; operation_revision: number; title: string; date: string; review_status: string; active: boolean; issues: { message: string }[]; completion_url: string; review_url: string }[]; counts: { total: number; confirmed: number; proposed: number; incomplete: number; pending: number }; pagination: { total: number; limit: number; offset: number; next_offset: number | null } }[]; source_tables?: { profile_id: string; label: string; confirmed_count: number; proposed_count: number; import_url: string; review_url: string }[] };
type CaptureCheck = { issues: { code: string; severity: string; message: string }[]; can_save: boolean; requires_acknowledgement: string[]; check_token: string };
type RequestData = {
  farm_id: string; title: string; recipient: string; country: string; region: string | null;
  reporting_year: number; deadline: string | null; pack_id: string; requirements: Requirement[];
  status: string; notes?: string;
};
type FactData = {
  farm_id: string; key: string; label: string; value: unknown; unit: string | null;
  period: string | null; temporal_basis: string; sources: unknown[]; review_status: string; parcel_id?: string | null;
};
type ReportData = {
  request_id?: string; status: string; can_approve?: boolean; approval_blocked_reason?: string; checksum?: string;
  snapshot?: { fields?: { field: string; label: string; value: unknown; unit?: string | null; period?: string | null; row_schema?: unknown }[]; journals?: unknown; operations?: unknown };
  current_blockers?: { code: string; message: string; fact_id?: string; field?: string }[];
  blockers?: { code: string; message: string; fact_id?: string; field?: string }[];
};
type FarmData = { name?: string; country?: string; region?: string; farm_type?: string; type?: string; parcels?: { id?: string; name?: string; external_id?: string }[] };
type DocumentData = { name?: string; filename?: string; title?: string; farm_id?: string };
type CountryProfile = { country: string; name: string; portal: { authority: string; name: string; url: string }; modules: { workflow_id: string; name: string; common_pack_id: string; coverage_limit: string }[]; mandate_requirement?: string; availability_limit?: string };
type RequestPreflight = { status: string; checked_at: string; notice: string; issues: { code: string; severity: string; field: string | null; message: string; fix_url: string; source: { title?: string; url?: string; document_id?: string } | null }[]; steps: { id: string; label: string; status: string; fix_url: string }[] };
type ComplianceOverview = { overall: string; obligations: { id: string; title: string; applicability: string; status: string; steps: { id: string; title: string; message: string; href: string }[]; citations: { title: string; url?: string }[] }[]; issues: { code: string; message: string; href: string }[]; limits: string[] };
const countries = 'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE'.split(' ');
const initialRequest = (): RequestData => ({ farm_id: '', title: '', recipient: '', country: '', region: null, reporting_year: new Date().getFullYear(), deadline: null, pack_id: '', requirements: [], status: 'draft', notes: '' });
const sampleName = (value: string) => value.replace(/^fictional(?:\s+(?:example|sample))?\s*[—–:-]?\s+/i, '');
const statusLabel = (value: string) => ({ draft: 'Draft', review: 'Details checked', waiting: 'Waiting for information', ready: 'Ready for review', responded: 'Response prepared', proposed: 'Needs review', confirmed: 'Checked', rejected: 'Rejected or replaced' } as Record<string, string>)[value] || value.replaceAll('_', ' ');
function literal(value: unknown): string { return value === null || value === undefined ? 'Not supplied' : value === '' ? 'Blank entry' : typeof value === 'boolean' ? value ? 'Yes' : 'No' : Array.isArray(value) ? value.length ? value.map(literal).join('; ') : 'No entries' : typeof value === 'object' ? Object.entries(value).map(([key, answer]) => `${key.replaceAll('_', ' ')}: ${literal(answer)}`).join(' · ') || 'No details supplied' : String(value); }
function SourceLinks({ sources }: { sources: unknown[] }) {
  return <ul>{sources.map((source, index) => {
    if (!source || typeof source !== 'object') return <li key={index}>{literal(source)}</li>;
    const entry = source as Record<string, unknown>;
    const url = typeof entry.url === 'string' && /^https:\/\//.test(entry.url) ? entry.url : null;
    const manual = ['manual', 'manual_transcription'].includes(String(entry.kind || entry.type || entry.source_kind));
    return <li key={index}>{typeof entry.document_id === 'string' ? <Link to={`/app/documents/${entry.document_id}`}>View source document</Link> : url ? <a href={url} target="_blank" rel="noopener noreferrer">{String(entry.title || 'Read source')}</a> : manual ? 'Recorded by hand' : String(entry.title || entry.filename || entry.file_name || 'Saved source')}{entry.location ? ` · ${String(entry.location)}` : ''}{entry.page !== undefined ? ` · page ${literal(entry.page)}` : ''}{entry.row !== undefined || entry.row_number !== undefined ? ` · row ${literal(entry.row ?? entry.row_number)}` : ''}{entry.quote ? <blockquote style={{ whiteSpace: 'pre-wrap' }}>{String(entry.quote)}</blockquote> : null}{entry.note ? <p>{String(entry.note)}</p> : null}{['license', 'licence', 'attribution', 'notice', 'warning', 'limitations'].filter(key => entry[key] !== undefined).map(key => <p key={key}>{literal(entry[key])}</p>)}</li>;
  })}</ul>;
}

function usePacks(country: string, year: number, region: string | null) {
  const [packs, setPacks] = useState<Pack[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    setPacks([]); setError(''); setLoading(false);
    if (!country || !Number.isInteger(year)) return;
    setLoading(true);
    const query = new URLSearchParams({ country, year: String(year) });
    if (region) query.set('region', region);
    api.get<Pack[] | Page<Pack>>(`/packs?${query}`).then(result => {
      if (current) setPacks(Array.isArray(result) ? result : result.items);
    }).catch(failure => { if (current) setError(errorMessage(failure)); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [country, year, region]);
  return { packs, loading, error };
}

function RequestChecks({ requestId, revision, documentIds, operationIds }: { requestId: string; revision: number; documentIds: string[]; operationIds?: string[] }) {
  const [result, setResult] = useState<RequestPreflight | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const selection = [...documentIds].sort().join(',');
  const operationSelection = operationIds === undefined ? 'automatic' : [...operationIds].sort().join(',');
  useEffect(() => {
    let active = true; setLoading(true); setResult(null); setError('');
    const query = new URLSearchParams({ selected_document_ids: selection });
    if (operationIds !== undefined) query.set('selected_operation_ids', operationSelection);
    api.get<RequestPreflight>(`/requests/${requestId}/checks?${query}`).then(value => { if (active) setResult(value); })
      .catch(failure => { if (active) setError(errorMessage(failure)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [requestId, revision, selection, operationSelection, refresh]);
  return <div className="stack"><div className="section-heading"><h3>Check before preparing your answer</h3><Button variant="secondary" disabled={loading} onClick={() => setRefresh(value => value + 1)}>Check again</Button></div><p>Check the requested answers, dates, evidence and available form before preparing a response.</p>
    {loading && <p role="status">Checking this request against your saved information…</p>}{error && <Notice kind="error">{error}</Notice>}
    {result && <><Notice kind={result.status === 'ready_for_review' ? 'success' : 'warning'}>{result.status === 'ready_for_review' ? 'The available checks are ready for your review.' : result.status === 'needs_adviser' ? 'Some details need an adviser’s judgement.' : 'A few details still need attention.'} {result.notice}</Notice>
      {result.issues.map((issue, index) => <article className="evidence-card" key={`${issue.code}-${index}`}><h4>{issue.severity === 'adviser' ? 'Ask an adviser to check this' : issue.field ? `Check ${issue.field.replaceAll('_', ' ')}` : 'Check this detail'}</h4><p>{issue.message}</p><div className="actions">{issue.fix_url?.startsWith('/app/') && <Link to={issue.fix_url}>Fix or review this detail</Link>}{issue.source?.document_id && <Link to={`/app/documents/${issue.source.document_id}`}>{issue.source.title ?? 'Read the source document'}</Link>}{issue.source?.url && /^https:\/\//.test(issue.source.url) && <a href={issue.source.url} target="_blank" rel="noreferrer">{issue.source.title ?? 'Read the official source'}</a>}{issue.severity === 'adviser' && <Link to="/app/adviser">Open adviser help</Link>}</div></article>)}
      {!!result.steps.length && <ol>{result.steps.map(step => <li key={step.id}>{step.label} · {step.status === 'complete' ? 'Done' : step.status === 'review' ? 'Needs review' : 'Still to do'}{step.fix_url?.startsWith('/app/') && <> · <Link to={step.fix_url}>Open this step</Link></>}</li>)}</ol>}
      <p className="muted">Checked {new Date(result.checked_at).toLocaleString()}. A prepared or approved draft is not an authority filing.</p>
    </>}
  </div>;
}

function FarmChecks({ farmId, year }: { farmId: string; year: number }) {
  const [overview, setOverview] = useState<ComplianceOverview | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true; setOverview(null); setError('');
    api.get<ComplianceOverview>(`/compliance/farms/${farmId}?year=${year}`).then(value => { if (active) setOverview(value); }).catch(failure => { if (active) setError(errorMessage(failure)); });
    return () => { active = false; };
  }, [farmId, year]);
  const needsAttention = overview?.obligations.filter(obligation => obligation.applicability !== 'does_not_apply' && obligation.status !== 'ready_for_review') ?? [];
  return <section className="panel"><div className="section-heading"><h2>What still needs checking</h2><Link to={`/app/checks?farm_id=${farmId}&year=${year}`}>Open all farm checks</Link></div><p>Use the farm’s recorded activities and evidence to see which questions need attention. Unknown applicability and deadlines stay unresolved.</p>{error && <Notice kind="error">{error}</Notice>}{!overview && !error && <p role="status">Checking the farm’s recorded information…</p>}
    {overview && <><p>{needsAttention.length ? `${needsAttention.length} checks need attention. The first three are shown here.` : 'Open all farm checks to review applicability, evidence and deadlines.'}</p>{needsAttention.slice(0, 3).map(obligation => <article className="evidence-card" key={obligation.id}><h3>{obligation.title}</h3><p>{obligation.applicability === 'unknown' ? 'First check whether this applies to your farm.' : obligation.applicability === 'conflict' ? 'Recorded answers disagree about whether this applies.' : obligation.status === 'needs_adviser' ? 'An adviser’s review is needed.' : 'More information is needed.'}</p>{obligation.steps.slice(0, 2).map(step => <p key={step.id}>{step.message}{step.href?.startsWith('/app/') && <> <Link to={step.href}>{step.title}</Link></>}</p>)}{!!obligation.citations.length && <details><summary>Sources for this check</summary><ul>{obligation.citations.map((source, index) => <li key={index}>{source.url && /^https:\/\//.test(source.url) ? <a href={source.url} target="_blank" rel="noreferrer">{source.title}</a> : source.title}</li>)}</ul></details>}</article>)}{overview.limits.map((limit, index) => <p className="muted" key={index}>{limit}</p>)}</>}
  </section>;
}

function RequestForm({ initial, draftKey, farms, busy, submitLabel, onSave }: {
  initial: RequestData; draftKey: string; farms: RecordItem<FarmData>[]; busy: boolean; submitLabel: string;
  onSave: (data: RequestData) => Promise<boolean>;
}) {
  const privateDraft = usePrivateDraft<RequestData>(draftKey, initial);
  const draft = privateDraft.value;
  const setDraft = privateDraft.setValue;
  const { packs, loading, error } = usePacks(draft.country, draft.reporting_year, draft.region);
  const selectedPack = packs.find(pack => pack.id === draft.pack_id);
  function change<K extends keyof RequestData>(key: K, value: RequestData[K]) {
    setDraft(previous => ({ ...previous, [key]: value }));
  }
  function jurisdiction(values: Partial<RequestData>) {
    setDraft(previous => ({ ...previous, ...values, pack_id: '' }));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await onSave(draft)) {
      // The hook retains and reports storage cleanup failures; the server save already succeeded.
      await privateDraft.clear().catch(() => undefined);
    }
  }
  if (!privateDraft.ready) return <p role="status">Opening your private draft…</p>;
  return <form onSubmit={submit} className="stack">
    {privateDraft.error && <Notice kind="error">{privateDraft.error}</Notice>}
    <p className="muted" role="status">{privateDraft.error ? 'Device draft storage failed. Keep this form open until you save it to your farm records.' : privateDraft.saving ? 'Saving draft on this device…' : 'Draft retained privately on this device until saved to your farm records.'}</p>
    <div className="form-grid">
      <Field label="Request title"><input required value={draft.title} onChange={event => change('title', event.target.value)} placeholder="Annual farm records request" /></Field>
      <Field label="Recipient"><input required value={draft.recipient} onChange={event => change('recipient', event.target.value)} placeholder="Authority or adviser named in the request" /></Field>
      <Field label="Farm"><select required value={draft.farm_id} onChange={event => {
        const farm = farms.find(item => item.id === event.target.value);
        setDraft(previous => ({ ...previous, farm_id: event.target.value, country: farm?.data.country ?? previous.country, region: farm?.data.region ?? previous.region, pack_id: '' }));
      }}><option value="">Choose a farm</option>{farms.map(farm => <option key={farm.id} value={farm.id}>{farm.data.name ?? farm.id}</option>)}</select></Field>
      <Field label="Country"><select required value={draft.country} onChange={event => jurisdiction({ country: event.target.value })}><option value="">Choose country</option>{countries.map(country => <option key={country} value={country}>{country}</option>)}</select></Field>
      <Field label="Reporting year"><input required type="number" min="1900" max="2200" value={draft.reporting_year} onChange={event => jurisdiction({ reporting_year: Number(event.target.value) })} /></Field>
      <Field label="Region, if specified"><input value={draft.region ?? ''} onChange={event => jurisdiction({ region: event.target.value || null })} placeholder="Use the region stated in the request" /></Field>
      <Field label="Deadline, if specified"><input type="date" value={draft.deadline ?? ''} onChange={event => change('deadline', event.target.value || null)} /></Field>
      <Field label="Reporting pack"><select required value={draft.pack_id} disabled={loading || !draft.country} onChange={event => change('pack_id', event.target.value)}>
        <option value="">{loading ? 'Loading supported packs…' : 'Choose a supported pack'}</option>
        {draft.pack_id && !selectedPack && <option value={draft.pack_id}>{draft.pack_id} — retained selection</option>}
        {packs.map(pack => <option key={pack.id} value={pack.id}>{pack.title ?? pack.name ?? pack.id}</option>)}
      </select></Field>
    </div>
    {error && <Notice kind="error">{error}</Notice>}
    {draft.country && !loading && !error && !packs.length && <Notice kind="warning">No pack is available for this country and year. Choose a supported jurisdiction or retain the request as a draft once a pack is available.</Notice>}
    {selectedPack && <Notice>{selectedPack.description ?? 'The selected pack defines the checks and fields used to prepare this response.'} {selectedPack.region && <>Region: {String(selectedPack.region)}. </>}{selectedPack.capability && <>Capability: {String(selectedPack.capability)}.</>}</Notice>}
    <fieldset><legend>Additional requirements from the request</legend><p className="muted">Write each extra thing the letter asks for as a clear question. The selected form supplies its own questions, and existing saved answers are reused where they fit.</p>
      {draft.requirements.map((requirement, index) => <div className="form-grid" key={index}>
        <Field label={`Requirement ${index + 1} question`}><input required value={requirement.label} onChange={event => change('requirements', draft.requirements.map((item, position) => position === index ? { ...item, label: event.target.value } : item))} /></Field>
        <details><summary>Match this question to an existing farm answer</summary><Field label={`Requirement ${index + 1} key`}><input required value={requirement.key} onChange={event => change('requirements', draft.requirements.map((item, position) => position === index ? { ...item, key: event.target.value } : item))} /></Field><p className="muted">Keep this reference unless you know the matching saved answer’s reference.</p></details>
        <Field label="Required"><select value={requirement.required ? 'yes' : 'no'} onChange={event => change('requirements', draft.requirements.map((item, position) => position === index ? { ...item, required: event.target.value === 'yes' } : item))}><option value="yes">Yes</option><option value="no">Optional</option></select></Field>
        <Button variant="ghost" onClick={() => change('requirements', draft.requirements.filter((_, position) => position !== index))}>Remove requirement {index + 1}</Button>
      </div>)}
      <Button variant="secondary" onClick={() => { let position = draft.requirements.length + 1; while (draft.requirements.some(item => item.key === `requested_${position}`)) position += 1; change('requirements', [...draft.requirements, { key: `requested_${position}`, label: '', required: true }]); }}>Add requirement</Button>
    </fieldset>
    <Field label="Notes"><textarea rows={3} value={draft.notes ?? ''} onChange={event => change('notes', event.target.value)} /></Field>
    <div className="actions"><Button type="submit" loading={busy} disabled={!privateDraft.ready || privateDraft.saving}>{submitLabel}</Button></div>
  </form>;
}

export function RequestsPage() {
  const { session } = useSession();
  const [params] = useSearchParams();
  const canWrite = session?.workspace.role === 'owner' || session?.workspace.permissions?.includes('review') === true;
  const records = useRecords<RequestData>('requests');
  const farms = useRecords<FarmData>('farms');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [farm, setFarm] = useState(params.get('farm_id') ?? '');
  const [moduleFarm, setModuleFarm] = useState(params.get('farm_id') ?? '');
  const [moduleYear, setModuleYear] = useState(Number(params.get('year')) || new Date().getFullYear());
  const [moduleRegion, setModuleRegion] = useState<string | null>(null);
  const [purposeWorkflow, setPurposeWorkflow] = useState(params.get('intent') === 'support' ? 'cap' : params.get('intent') === 'inspection' ? 'inspection' : '');
  const [profile, setProfile] = useState<CountryProfile | null>(null);
  const [commonPacks, setCommonPacks] = useState<Pack[]>([]);
  const [profileError, setProfileError] = useState('');
  const [newRequest, setNewRequest] = useState<RequestData>(initialRequest);
  const [creating, setCreating] = useState(false);
  const [showNewWorkflow, setShowNewWorkflow] = useState(!!params.get('intent'));
  const newWorkflow = useRef<HTMLDivElement>(null);
  const newRequestForm = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const currentFarm = farms.items.find(item => item.id === moduleFarm) ?? farms.items[0];
  useEffect(() => {
    if (!showNewWorkflow && !creating) return;
    const frame = window.requestAnimationFrame(() => {
      const panel = creating ? newRequestForm.current : newWorkflow.current;
      panel?.focus({ preventScroll: true });
      panel?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [showNewWorkflow, creating]);
  const modules = usePacks(currentFarm?.data.country ?? '', moduleYear, moduleRegion ?? currentFarm?.data.region ?? null);
  useEffect(() => {
    let active = true; setProfile(null); setCommonPacks([]); setProfileError('');
    if (!currentFarm?.data.country) return;
    api.get<CountryProfile>(`/countries/${currentFarm.data.country}`).then(async countryProfile => {
      if (!active) return;
      setProfile(countryProfile);
      const ids = [...new Set(countryProfile.modules.map(module => module.common_pack_id).filter(Boolean))];
      const results = await Promise.allSettled(ids.map(id => api.get<Pack>(`/packs/${encodeURIComponent(id)}`)));
      if (!active) return;
      setCommonPacks(results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []));
      if (results.some(result => result.status === 'rejected')) setProfileError('Some common paperwork modules could not be loaded. The available modules are shown below.');
    }).catch(failure => { if (active) setProfileError(errorMessage(failure)); });
    return () => { active = false; };
  }, [currentFarm?.data.country]);
  const availablePacks = [...new Map([...commonPacks, ...modules.packs].map(pack => [pack.id, pack])).values()].filter(pack => purposeWorkflow === 'all' || pack.workflow_id === purposeWorkflow);
  const filtered = records.items.filter(item => (!status || item.data.status === status) && (!farm || item.data.farm_id === farm) && `${item.data.title} ${item.data.recipient}`.toLowerCase().includes(query.toLowerCase()));
  async function create(data: RequestData) {
    setBusy(true); setError('');
    try { const item = await api.post<RecordItem<RequestData>>('/requests', { data }); navigate(`/app/paperwork/${item.id}`); return true; }
    catch (failure) { setError(errorMessage(failure)); return false; } finally { setBusy(false); }
  }
  return <>
    <PageHeader title="Paperwork" description="Pick up a saved request, or start with the letter in front of you." action={canWrite ? <Button onClick={() => { setShowNewWorkflow(value => !value); setCreating(false); }}>{showNewWorkflow ? 'Close new paperwork' : 'Add paperwork'}</Button> : undefined} />
    {error && <Notice kind="error">{error}</Notice>}
    {!canWrite && <Notice>Your access to these farms is read only. You can inspect the saved paperwork and evidence.</Notice>}
    {showNewWorkflow && <div ref={newWorkflow} tabIndex={-1} className="farm-reveal-panel" aria-label="Start new paperwork">
    <section className="panel"><h2>What do you need to do?</h2><p>Start with the request itself. We will reuse your farm’s answers and ask about the details that are missing or have changed.</p><div className="actions"><Link className="button button-secondary" to={`/app/documents?purpose=letter${currentFarm ? `&farm_id=${currentFarm.id}` : ''}`}>Start from a letter or notice</Link><Button variant="secondary" aria-pressed={purposeWorkflow === 'cap'} onClick={() => setPurposeWorkflow('cap')}>Apply for support</Button><Button variant="secondary" aria-pressed={purposeWorkflow === 'inspection'} onClick={() => setPurposeWorkflow('inspection')}>Prepare for an inspection</Button><Button variant="secondary" aria-pressed={purposeWorkflow === 'annual'} onClick={() => setPurposeWorkflow('annual')}>Prepare annual records</Button><Button variant="ghost" onClick={() => setPurposeWorkflow('all')}>Other forms</Button><Button variant="ghost" onClick={() => { setNewRequest({ ...initialRequest(), farm_id: currentFarm?.id || '', country: currentFarm?.data.country || '' }); setCreating(true); }}>Enter a request myself</Button></div>{purposeWorkflow === 'inspection' && <p><Link to={`/app/documents?purpose=inspection${currentFarm ? `&farm_id=${currentFarm.id}` : ''}`}>Add the inspection letter</Link> to keep the requested evidence and response deadline together.</p>}</section>
    {purposeWorkflow && <section className="panel"><div className="section-heading"><h2>For your farm</h2>{currentFarm && <span className="badge">{currentFarm.data.country} · {currentFarm.data.farm_type ?? currentFarm.data.type ?? 'Farm paperwork'}</span>}</div><div className="form-grid"><Field label="Farm"><select value={currentFarm?.id ?? ''} onChange={event => { setModuleFarm(event.target.value); setModuleRegion(null); }}><option value="">Choose farm</option>{farms.items.map(item => <option key={item.id} value={item.id}>{sampleName(String(item.data.name ?? 'Unnamed farm'))}</option>)}</select></Field><Field label="Year"><input type="number" min="1900" max="2200" value={moduleYear} onChange={event => setModuleYear(Number(event.target.value))} /></Field><Field label="Region for this paperwork"><input value={moduleRegion ?? currentFarm?.data.region ?? ''} onChange={event => setModuleRegion(event.target.value)} placeholder="Region stated in the form or request" /></Field></div>
      {profileError && <Notice kind="warning">{profileError}</Notice>}
      {profile && <p className="muted">{profile.name} · {profile.availability_limit ?? 'General farm records and national form guidance serve different purposes.'} Check the form’s scope against your farm’s activities before preparing it.</p>}
      {modules.loading ? <p role="status">Finding forms for this country, year and region…</p> : modules.error ? <Notice kind="error">{modules.error}</Notice> : <div className="form-grid">{availablePacks.map(pack => <article className="evidence-card" key={pack.id}><p className="eyebrow">{String(pack.workflow_id ?? 'Farm records').replaceAll('_', ' ')} · {pack.country ? (pack.region ?? 'National') : 'General farm records'}</p><h3>{pack.title ?? pack.name}</h3><p>{pack.description ?? 'Prepare the facts and evidence requested by this form.'}</p><p className="muted">{pack.capability === 'reference_only' ? 'Official guidance available; form preparation is not yet mapped.' : pack.country ? 'Some answers can be prepared here. Check the required national form and its listed limits.' : 'Reusable farm records; this is not an official national form.'}</p>{profile?.modules.find(module => module.workflow_id === pack.workflow_id)?.coverage_limit && <p className="muted">{profile.modules.find(module => module.workflow_id === pack.workflow_id)?.coverage_limit}</p>}<Button variant="secondary" disabled={!canWrite} onClick={() => { setNewRequest({ ...initialRequest(), farm_id: currentFarm?.id ?? '', country: pack.country || currentFarm?.data.country || '', region: pack.region ?? moduleRegion ?? currentFarm?.data.region ?? null, reporting_year: moduleYear, pack_id: pack.id, title: pack.title ?? pack.name ?? '', recipient: typeof pack.authority === 'string' ? pack.authority : '' }); setCreating(true); }}>{pack.capability === 'reference_only' ? 'Review guidance & request' : 'Prepare this paperwork'}</Button></article>)}</div>}
      {!farms.loading && !farms.items.length && <Notice><Link to="/app/farm">Add your farm</Link> to find the paperwork for its country and region.</Notice>}{currentFarm && !!purposeWorkflow && !modules.loading && !modules.error && !availablePacks.length && <Notice>No supported forms were found for this year and region. You can still record the original request for follow-up.</Notice>}
    </section>}
    {currentFarm && <details className="panel"><summary>Other checks for this farm</summary><FarmChecks farmId={currentFarm.id} year={moduleYear} /></details>}
    </div>}
    {creating && canWrite && <section ref={newRequestForm} tabIndex={-1} className="panel farm-reveal-panel" aria-label="New request details"><h2>Record a request</h2><p>Copy the details from the letter or adviser’s request. Save first, then review and confirm them.</p>{farms.loading ? <p role="status">Loading farms…</p> : farms.error ? <Notice kind="error">{farms.error}<Button variant="ghost" onClick={() => void farms.reload()}>Retry farms</Button></Notice> : !farms.items.length ? <Notice>Add your farm in <Link to="/app/farm">My farm</Link> before creating a request.</Notice> : <RequestForm key={`${newRequest.farm_id}:${newRequest.pack_id || 'letter'}`} initial={newRequest} draftKey={`request:new:${newRequest.farm_id}:${newRequest.pack_id || 'letter'}`} farms={farms.items} busy={busy} submitLabel="Save draft request" onSave={create} />}</section>}
    <section className="panel"><div className="form-grid">
      <Field label="Search requests"><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Title or recipient" /></Field>
      <Field label="Status"><select value={status} onChange={event => setStatus(event.target.value)}><option value="">All statuses</option>{['draft', 'review', 'ready', 'responded', 'waiting'].map(value => <option value={value} key={value}>{statusLabel(value)}</option>)}</select></Field>
      <Field label="Farm"><select value={farm} onChange={event => setFarm(event.target.value)}><option value="">All farms</option>{farms.items.map(item => <option key={item.id} value={item.id}>{sampleName(String(item.data.name ?? 'Unnamed farm'))}</option>)}</select></Field>
    </div>
      {records.loading ? <p role="status">Loading requests…</p> : records.error ? <Notice kind="error">{records.error}<Button variant="ghost" onClick={() => void records.reload()}>Retry</Button></Notice> : !filtered.length ? <div className="empty-state"><h2>{records.items.length ? 'No matching requests' : 'A clear place for the next request'}</h2><p>{records.items.length ? 'Change the filters to see other requests.' : 'Record a letter, inspection or adviser request, then gather the evidence in one place.'}</p></div> : <ul className="record-list">{filtered.map((item, index) => <li key={item.id}><Link to={`/app/paperwork/${item.id}`}><span className="record-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><div className="record-main"><strong>{sampleName(item.data.title)}</strong><span>{item.data.recipient} · {item.data.reporting_year}{item.data.deadline ? ` · Due ${item.data.deadline}` : ''}</span></div><span className="badge">{statusLabel(item.data.status)}</span></Link></li>)}</ul>}
    </section>
  </>;
}

function AnswerForm({ farmId, requestId, requestRevision, requirement, period, documents, existingFacts, onSaved }: { farmId: string; requestId: string; requestRevision: number; requirement: Requirement; period: number; documents: RecordItem<DocumentData>[]; existingFacts: RecordItem<FactData>[]; onSaved: () => Promise<void> }) {
  const answerDraft = usePrivateDraft(`paperwork/answer/${farmId}/${period}/${requirement.id ?? requirement.key}`, {
    kind: requirement.value_type === 'number' || requirement.value_type === 'boolean' || requirement.value_type === 'date' || requirement.value_type === 'choice' ? requirement.value_type : 'text', value: '', unit: requirement.unit ?? '', basis: requirement.temporal_basis ?? 'campaign_year',
    factPeriod: requirement.period ?? (requirement.temporal_basis === 'static' || requirement.temporal_basis === 'calendar_date' ? '' : String(period)),
    note: '', documentId: '', location: '', supersedesId: '',
  });
  const { kind, value, unit, basis, factPeriod, note, documentId, location, supersedesId } = answerDraft.value;
  function update(key: keyof typeof answerDraft.value, next: string) { answerDraft.setValue(previous => ({ ...previous, [key]: next })); }
  const setKind = (next: string) => update('kind', next);
  const setValue = (next: string) => update('value', next);
  const setUnit = (next: string) => update('unit', next);
  const setBasis = (next: string) => update('basis', next);
  const setFactPeriod = (next: string) => update('factPeriod', next);
  const setNote = (next: string) => update('note', next);
  const setDocumentId = (next: string) => update('documentId', next);
  const setLocation = (next: string) => update('location', next);
  const setSupersedesId = (next: string) => update('supersedesId', next);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [issues, setIssues] = useState<{ code: string; severity: string; message: string }[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setSaved(false);
    try {
      let parsed: unknown = value;
      if (kind === 'number') { if (!value.trim()) throw new Error('Enter a number.'); if (requirement.state && !supersedesId) parsed = value; else { if (!Number.isFinite(Number(value))) throw new Error('Enter a finite number.'); parsed = Number(value); } }
      if (kind === 'boolean') { if (!['true', 'false'].includes(value)) throw new Error('Choose true or false.'); parsed = value === 'true'; }
      if (kind === 'null') parsed = null;
      if (kind === 'json') parsed = JSON.parse(value);
      if (kind === 'choice') { const choice = requirement.choices?.[Number(value)]; if (!choice) throw new Error('Choose one of the supplied answers.'); parsed = choice.value; }
      const answerPeriod = requirement.period ?? (basis === 'static' ? null : basis === 'calendar_date' && kind === 'date' ? value || null : factPeriod || null);
      const parcelId = requirement.parcel_id ?? existingFacts.find(fact => fact.id === supersedesId)?.data.parcel_id ?? null;
      const proposed = { farm_id: farmId, key: requirement.key, label: requirement.label, value: parsed, unit: unit || null, period: answerPeriod, temporal_basis: basis, ...(parcelId ? { parcel_id: parcelId } : {}), sources: [{ type: documentId ? 'document' : 'manual', ...(documentId ? { document_id: documentId, location } : {}), note }], review_status: 'proposed', ...(supersedesId ? { supersedes_id: supersedesId } : {}) };
      const useGuidedAnswer = Boolean(requirement.state && !supersedesId);
      const guidedBody = { request_id: requestId, expected_request_revision: requestRevision, question_id: requirement.id, key: requirement.key, ...(parcelId ? { parcel_id: parcelId } : {}), value: parsed, unit: proposed.unit, temporal_basis: basis, period: answerPeriod, sources: proposed.sources, note };
      const validation = useGuidedAnswer
        ? (await api.post<{ check: CaptureCheck }>('/workflow/answer', { ...guidedBody, preview: true })).check
        : await api.post<CaptureCheck>('/workflow/check', { kind: 'facts', data: proposed, reporting_year: period });
      setIssues(validation.issues);
      if (!validation.can_save || (validation.requires_acknowledgement.length > 0 && !acknowledged)) return;
      const acknowledgedCodes = acknowledged ? validation.requires_acknowledgement : [];
      if (useGuidedAnswer) await api.post('/workflow/answer', { ...guidedBody, preview: false, check_token: validation.check_token, acknowledged_codes: acknowledgedCodes });
      else await api.post('/workflow/capture', { kind: 'facts', data: proposed, reporting_year: period, check_token: validation.check_token, acknowledged_codes: acknowledgedCodes });
      await onSaved(); setSaved(true); await answerDraft.clear().catch(() => undefined);
    } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  if (!answerDraft.ready) return <p role="status">Opening your private answer draft…</p>;
  return <form className="stack" onSubmit={submit} onChange={event => { const target: EventTarget = event.target; if (!(target instanceof HTMLInputElement && target.name === 'acknowledge')) { setAcknowledged(false); setIssues([]); } }}>
    <p className="muted">Save an answer as a proposal. Review it explicitly before it can support an approved response.</p>
    {requirement.physical_label && <Notice>Answer for {requirement.physical_label}{requirement.period ? ` · ${requirement.period}` : ''}. This answer stays attached to this field and date.</Notice>}
    {answerDraft.error && <Notice kind="error">{answerDraft.error}</Notice>}{answerDraft.saving && <p role="status">Saving private answer draft on this device…</p>}
    <div className="form-grid"><Field label="Answer type"><select value={kind} onChange={event => { setKind(event.target.value); setValue(''); }}><option value="text">Text</option><option value="number">Number</option><option value="boolean">Yes or no</option><option value="date">Date</option>{!!requirement.choices?.length && <option value="choice">One of the supplied choices</option>}<option value="null">Unknown / not supplied</option><option value="json">Structured value (advanced)</option></select></Field>
      {kind !== 'null' && <Field label="Answer">{kind === 'choice' ? <select required value={value} onChange={event => setValue(event.target.value)}><option value="">Choose an answer</option>{requirement.choices?.map((choice, index) => <option value={index} key={index}>{choice.label}</option>)}</select> : kind === 'boolean' ? <select required value={value} onChange={event => setValue(event.target.value)}><option value="">Choose an answer</option><option value="true">Yes</option><option value="false">No</option></select> : kind === 'date' ? <input required type="date" value={value} onChange={event => setValue(event.target.value)} /> : <textarea required={kind !== 'text'} value={value} onChange={event => setValue(event.target.value)} rows={2} />}</Field>}
      <Field label="Unit, if applicable"><input value={unit} onChange={event => setUnit(event.target.value)} placeholder="For example, ha or EUR" /></Field>
      <Field label="When does this answer apply?"><select value={basis} disabled={Boolean(requirement.id && requirement.temporal_basis)} onChange={event => { setBasis(event.target.value); setSupersedesId(''); setFactPeriod(event.target.value === 'campaign_year' ? String(period) : ''); }}><option value="campaign_year">Campaign year</option><option value="calendar_date">Calendar date</option><option value="static">Standing farm detail</option></select></Field>
      {basis !== 'static' && !(basis === 'calendar_date' && kind === 'date' && requirement.period == null) && <Field label={basis === 'calendar_date' ? 'Exact date' : 'Campaign year'}><input required type={basis === 'calendar_date' ? 'date' : 'text'} readOnly={Boolean(requirement.id && requirement.period)} value={factPeriod} onChange={event => { setFactPeriod(event.target.value); setSupersedesId(''); }} /></Field>}
      <Field label="Source document, if available"><select value={documentId} onChange={event => setDocumentId(event.target.value)}><option value="">Manually supplied information</option>{documents.map(document => <option key={document.id} value={document.id}>{document.data.name ?? document.data.filename ?? document.data.title ?? document.id}</option>)}</select></Field>
      {documentId && <Field label="Page or source location"><input required value={location} onChange={event => setLocation(event.target.value)} placeholder="Page 2, area field" /></Field>}
    </div>
    <Field label="Does this correct an existing confirmed answer?"><select value={supersedesId} onChange={event => setSupersedesId(event.target.value)}><option value="">Save as a separate proposal</option>{existingFacts.filter(fact => fact.data.review_status === 'confirmed' && fact.data.temporal_basis === basis && fact.data.period === (basis === 'static' ? null : factPeriod)).map(fact => <option value={fact.id} key={fact.id}>Replace {literal(fact.data.value)} {fact.data.unit ?? ''} · saved {new Date(fact.updated_at).toLocaleDateString()}</option>)}</select></Field>
    {supersedesId && <Notice>The prior answer remains in history. Confirming this correction requires a review note and explicitly supersedes that answer.</Notice>}
    <Field label="Where did this answer come from?"><textarea required rows={2} value={note} onChange={event => setNote(event.target.value)} placeholder="Describe the source and any uncertainty." /></Field>
    {error && <Notice kind="error">{error}</Notice>}{!!issues.length && <Notice kind={issues.some(issue => issue.severity === 'error') ? 'error' : 'warning'}><ul>{issues.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.message}</li>)}</ul></Notice>}
    {issues.some(issue => issue.severity === 'warning') && <label className="checkbox-field"><input type="checkbox" name="acknowledge" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />I have reviewed these warnings and want to retain this proposed answer.</label>}
    {saved && <Notice kind="success">Proposal saved. Check its value, unit, period and source, then confirm or reject it below.</Notice>}
    <Button type="submit" variant="secondary" disabled={answerDraft.saving} loading={busy}>{issues.length ? 'Check again & save proposal' : 'Check & save proposed answer'}</Button>
  </form>;
}

export function RequestDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { session } = useSession();
  const facts = useRecords<FactData>('facts');
  const farms = useRecords<FarmData>('farms');
  const documents = useRecords<DocumentData>('documents');
  const reports = useRecords<ReportData>('reports');
  const [request, setRequest] = useState<RecordItem<RequestData> | null>(null);
  const [pack, setPack] = useState<Pack | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [check, setCheck] = useState<RecordItem<ReportData> | null>(null);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);
  const journalSelection = usePrivateDraft(`paperwork/${id}/journal-selection`, { ids: [] as string[] });
  const selectedOperationIds = journalSelection.value.ids;
  const [questionIndex, setQuestionIndex] = useState(0);
  const [showAllAnswers, setShowAllAnswers] = useState(false);
  const [guided, setGuided] = useState<GuidedQuestions | null>(null);
  const [guidedError, setGuidedError] = useState('');
  const [guidedLoading, setGuidedLoading] = useState(false);
  const [journalOffset, setJournalOffset] = useState(0);
  const [journalRevision, setJournalRevision] = useState(0);
  async function loadQuestions() {
    setGuidedLoading(true); setGuidedError(''); setGuided(null);
    try { setGuided(await api.get<GuidedQuestions>(`/workflow/questions?request_id=${id}&journal_limit=50&journal_offset=${journalOffset}`)); }
    catch (failure) { setGuidedError(errorMessage(failure)); } finally { setGuidedLoading(false); }
  }
  async function load() {
    setLoading(true); setError('');
    try { setRequest(await api.get<RecordItem<RequestData>>(`/requests/${id}`)); }
    catch (failure) { setError(errorMessage(failure)); } finally { setLoading(false); }
  }
  useEffect(() => { setRequest(null); setCheck(null); setSelectedDocumentIds([]); setJournalOffset(0); void load(); }, [id]);
  useEffect(() => {
    let current = true; setPack(null);
    if (request?.data.pack_id) api.get<Pack>(`/packs/${encodeURIComponent(request.data.pack_id)}`).then(value => { if (current) setPack(value); }).catch(failure => { if (current) setError(errorMessage(failure)); });
    return () => { current = false; };
  }, [request?.data.pack_id]);
  useEffect(() => { setGuided(null); if (request) void loadQuestions(); }, [request?.id, request?.revision, journalOffset]);
  const reviewer = session?.workspace.role === 'owner' || session?.workspace.permissions?.includes('review') === true;
  async function save(data: RequestData) {
    if (!request) return false;
    setBusy(true); setError(''); setMessage('');
    try { const { status: _status, ...fields } = data; setRequest(await api.patch<RecordItem<RequestData>>(`/requests/${request.id}`, { expected_revision: request.revision, data: fields })); setEditing(false); setCheck(null); setMessage('Request details saved. Check the response again after changing its requirements.'); return true; }
    catch (failure) { setError(errorMessage(failure)); return false; } finally { setBusy(false); }
  }
  async function confirm() {
    if (!request) return;
    setBusy(true); setError('');
    try { setRequest(await api.patch<RecordItem<RequestData>>(`/requests/${request.id}`, { expected_revision: request.revision, data: { status: 'review' } })); setMessage('Request details confirmed. The evidence still needs its own review.'); }
    catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  async function review(fact: RecordItem<FactData>, decision: 'confirmed' | 'rejected') {
    setBusy(true); setError(''); setMessage('');
    try { if (decision === 'rejected' && !reviewNotes[fact.id]?.trim()) throw new Error('Add a review note explaining why this answer is being rejected.'); await api.post(`/facts/${fact.id}/review`, { expected_revision: fact.revision, decision, note: reviewNotes[fact.id] || '' }); await facts.reload(); await loadQuestions(); setCheck(null); setMessage(`Answer ${decision}. Run the response check to see the updated requirements.`); }
    catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  async function prepare() {
    if (!request) return;
    if (request.data.pack_id === PORTUGUESE_JOURNAL_PACK) { navigate(portugueseJournalPath(request.data.farm_id, { pt_journal_request: request.id })); return; }
    setBusy(true); setError(''); setMessage('');
    try { const report = await api.post<RecordItem<ReportData>>('/reports', { farm_id: request.data.farm_id, request_id: request.id, pack_id: request.data.pack_id, reporting_year: request.data.reporting_year, selected_document_ids: selectedDocumentIds, ...(request.data.pack_id === CZECH_JOURNAL_PACK ? { operation_ids: selectedOperationIds } : {}) }); setCheck(await api.get<RecordItem<ReportData>>(`/reports/${report.id}`)); await reports.reload(); }
    catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  if (loading) return <><PageHeader title="Opening request" /><p role="status">Loading saved request…</p></>;
  if (!request) return <><PageHeader title="Request unavailable" /><Notice kind="error">{error || 'This request could not be found.'}</Notice><Button onClick={() => void load()}>Retry</Button><Link to="/app/paperwork">Back to paperwork</Link></>;
  const data = request.data;
  const isCzechJournal = data.pack_id === CZECH_JOURNAL_PACK;
  const isPortugueseJournal = data.pack_id === PORTUGUESE_JOURNAL_PACK;
  const journalGuide = guided?.journals?.find(journal => journal.pack_id === data.pack_id);
  const journalFarm = farms.items.find(farm => farm.id === data.farm_id);
  const relevantFacts = facts.items.filter(fact => fact.data.farm_id === data.farm_id);
  const requirements = new Map<string, Requirement>();
  for (const field of pack?.requirements ?? pack?.fields ?? []) {
    if (field.fact_key_prefix) continue;
    const key = field.key ?? field.fact_key ?? field.field;
    if (typeof key === 'string' && !(isCzechJournal && key === 'cz.ppp.holder') && !(isPortugueseJournal && key === PORTUGUESE_JOURNAL_KEY)) requirements.set(key, { key, label: String(field.label ?? field.question ?? key), required: field.required !== false, unit: field.unit, temporal_basis: field.temporal_basis });
  }
  for (const field of data.requirements ?? []) {
    if (isCzechJournal && field.key === 'cz.ppp.holder' || isPortugueseJournal && field.key === PORTUGUESE_JOURNAL_KEY) continue;
    if (!(pack?.fields ?? []).some(item => item.fact_key_prefix === field.key)) requirements.set(field.key, field);
  }
  const requestReports = reports.items.filter(report => report.data.request_id === request.id);
  const questions = (guided?.questions ?? []).filter(question => !(isCzechJournal && question.key === 'cz.ppp.holder') && !(isPortugueseJournal && question.key === PORTUGUESE_JOURNAL_KEY));
  const allRequirements = [...requirements.values()].filter(requirement => !questions.some(question => question.key === requirement.key)).concat(questions);
  const activeQuestion = questions[Math.min(questionIndex, Math.max(0, questions.length - 1))];
  function matchingFacts(requirement: Requirement) {
    if (requirement.id && requirement.proposals && requirement.confirmed) return [...new Map([...requirement.proposals, ...requirement.confirmed].map(fact => [fact.id, fact])).values()];
    return relevantFacts.filter(fact => fact.data.key === requirement.key && (!requirement.id || ((fact.data.parcel_id ?? null) === (requirement.parcel_id ?? null) && (requirement.period == null || fact.data.period === requirement.period))));
  }
  function answerPlace(fact: RecordItem<FactData>) {
    if (!fact.data.parcel_id) return 'Farm-wide answer';
    const parcels = farms.items.find(farm => farm.id === fact.data.farm_id)?.data.parcels;
    const parcel = Array.isArray(parcels) ? parcels.find(item => item.id === fact.data.parcel_id) : undefined;
    return parcel?.name ? `Field / site: ${parcel.name}${parcel.external_id ? ` · reference ${parcel.external_id}` : ''}` : `Field / site reference: ${fact.data.parcel_id}`;
  }
  const blockers = check?.data.current_blockers ?? check?.data.blockers;
  async function approve() {
    if (!check) return;
    setBusy(true); setError('');
    try { await api.post(`/reports/${check.id}/approve`, { expected_revision: check.revision, ...(check.data.checksum ? { snapshot_checksum: check.data.checksum } : {}) }); setCheck(await api.get<RecordItem<ReportData>>(`/reports/${check.id}`)); await reports.reload(); await load(); setMessage('Response approved and retained. Use the official route to complete any filing; approval here does not file it.'); }
    catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  return <>
    <PageHeader title={sampleName(data.title)} description={<>{data.recipient} · {data.country}{data.region ? ` / ${data.region}` : ''} · {data.reporting_year}</>} action={reviewer ? <Button variant="secondary" onClick={() => setEditing(value => !value)}>{editing ? 'Close editor' : 'Edit request'}</Button> : undefined} />
    <Link className="text-link" to="/app/paperwork">All paperwork</Link>
    <p><Link to={`/app/cases/new?${new URLSearchParams({ farm_id: data.farm_id, job_type: pack?.workflow_id === 'inspection' ? 'inspection' : 'correction', reporting_year: String(data.reporting_year), reference_kind: 'requests', reference_id: request.id, reference_revision: String(request.revision), reference_role: pack?.workflow_id === 'inspection' ? 'notice' : 'original' })}`}>{pack?.workflow_id === 'inspection' ? 'Keep this inspection and its follow-up together' : 'Work through a correction with this request'}</Link></p>
    {error && <Notice kind="error">{error} If another device changed this record, reopen the request before retrying.<Button variant="ghost" onClick={() => void load()}>Reload saved request</Button></Notice>}
    {message && <Notice kind="success">{message}</Notice>}
    {editing && <section className="panel"><h2>Review the request details</h2>{farms.error ? <Notice kind="error">{farms.error}</Notice> : <RequestForm key={request.revision} initial={data} draftKey={`request:${request.id}:revision:${request.revision}`} farms={farms.items} busy={busy} submitLabel="Save request changes" onSave={save} />}</section>}
    <section className="panel"><div className="section-heading"><h2>The request at a glance</h2><span className="badge">{statusLabel(data.status)}</span></div><dl className="detail-grid"><div><dt>Farm</dt><dd><Link to={`/app/farm/${data.farm_id}`}>{sampleName(farms.items.find(farm => farm.id === data.farm_id)?.data.name ?? 'Open the farm')}</Link></dd></div><div><dt>Deadline</dt><dd>{data.deadline ?? 'No deadline recorded'}</dd></div><div><dt>Response format</dt><dd>{pack?.title ?? pack?.name ?? 'The selected response format'}</dd></div></dl>{data.notes && <p>{data.notes}</p>}
      {data.status === 'draft' && <Notice kind="warning">These request details are a draft. Check the recipient, period and requirements against the original before confirming.{reviewer && <div className="actions"><Button onClick={() => void confirm()} loading={busy}>Confirm request details</Button></div>}</Notice>}
    </section>
    {isPortugueseJournal && <section className="panel"><h2>Prepare the Portuguese record</h2><p>Use the journal to check the producer, individual rows and actual dates. Choose which rows answer this request before preparing its report. Unfinished rows can stay saved without an invented date.</p><Link className="button button-secondary" to={portugueseJournalPath(data.farm_id, { pt_journal_request: request.id })}>Open the Portuguese journal for this request</Link></section>}
    {isCzechJournal && journalFarm && <CzechJournal farm={journalFarm} year={data.reporting_year} journal={journalGuide} selectedIds={selectedOperationIds} onSelectionChange={ids => { journalSelection.setValue({ ids }); setCheck(null); }} onChanged={async () => { await facts.reload(); await loadQuestions(); setJournalRevision(value => value + 1); setCheck(null); }} />}
    {isCzechJournal && journalGuide && <section className="panel"><h3>Application checks for this request</h3><p>{journalGuide.counts.total} active application records · {journalGuide.counts.confirmed} checked · {journalGuide.counts.proposed} proposed · {journalGuide.counts.incomplete} incomplete · {journalGuide.counts.pending} with pending follow-up.</p><p>Showing checks {journalGuide.entries.length ? journalGuide.pagination.offset + 1 : 0}–{journalGuide.pagination.offset + journalGuide.entries.length} of {journalGuide.pagination.total} retained records. Original and replacement records remain distinct.</p><ul>{journalGuide.entries.map(entry => <li key={entry.operation_id}><strong>{entry.title} · {entry.date}</strong> · {entry.active ? entry.review_status === 'confirmed' ? 'Checked' : 'Needs checking' : 'Replaced record retained in history'}{entry.issues.map((issue, index) => <p key={index}>{issue.message}</p>)}<div className="actions"><Link to={entry.completion_url}>Complete or correct this application</Link><Link to={entry.review_url}>Review this saved application</Link></div></li>)}</ul><div className="actions"><Button variant="secondary" disabled={guidedLoading || journalGuide.pagination.offset === 0} onClick={() => setJournalOffset(Math.max(0, journalGuide.pagination.offset - journalGuide.pagination.limit))}>Previous application checks</Button><Button variant="secondary" disabled={guidedLoading || journalGuide.pagination.next_offset === null} onClick={() => { if (journalGuide.pagination.next_offset !== null) setJournalOffset(journalGuide.pagination.next_offset); }}>More application checks</Button></div></section>}
    <section className="panel" id="answers"><span id="questions" aria-hidden="true" /><h2>What needs your attention</h2><p>Saved answers are reused. Work through missing answers and changes, one question at a time; the final checks show what is still needed before approval.</p>
      {guidedLoading && <p role="status">Checking which answers are still needed…</p>}{guidedError && <Notice kind="error">{isCzechJournal ? 'Journal guidance is unavailable. No completion verdict is available. ' : ''}{guidedError}<Button variant="ghost" onClick={() => void loadQuestions()}>Retry questions</Button></Notice>}
      {guided && !isPortugueseJournal && guided.total_count > 0 && <><p role="status">{guided.completed_count} of {guided.total_count} questions have checked answers in the current review.</p><progress max={Math.max(1, guided.total_count)} value={guided.completed_count} aria-label="Questions with a confirmed answer" /></>}
      {!!guided?.source_tables?.length && <section aria-label="Original source tables"><h3>Review your original rows</h3><p>Bring the tables that apply to your farm. Check the rows before confirming them; these counts do not establish eligibility or a complete application.</p>{guided.source_tables.map(table => <article className="panel" key={table.profile_id}><h4>{table.label}</h4><p>{table.confirmed_count} confirmed rows · {table.proposed_count} rows waiting for review</p><div className="actions"><Link to={table.import_url}>Bring in this table</Link><Link to={table.review_url}>Review saved rows</Link></div></article>)}</section>}
      {!!guided?.blocked_reasons.length && <Notice kind="warning"><ul>{guided.blocked_reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul></Notice>}
      {!!questions.length && <div className="actions"><Button variant="ghost" disabled={questionIndex === 0} onClick={() => setQuestionIndex(value => Math.max(0, value - 1))}>Previous question</Button><span>Question {Math.min(questionIndex + 1, questions.length)} of {questions.length}</span><Button variant="ghost" disabled={questionIndex >= questions.length - 1} onClick={() => setQuestionIndex(value => Math.min(questions.length - 1, value + 1))}>Next question</Button></div>}
      {guided && !isPortugueseJournal && !questions.length && guided.total_count > 0 && (!isCzechJournal || guided.completed_count === guided.total_count) && <Notice>Saved answers are available for these questions. Check the response below for source conflicts, required evidence and other remaining conditions.</Notice>}
      <Button variant="ghost" onClick={() => setShowAllAnswers(value => !value)}>{showAllAnswers ? 'Return to guided questions' : 'Review all saved answers'}</Button>
      {facts.loading && <p role="status">Loading farm answers…</p>}{facts.error && <Notice kind="error">{facts.error}<Button variant="ghost" onClick={() => void facts.reload()}>Retry answers</Button></Notice>}
      {documents.error && <Notice kind="warning">Source documents could not be loaded: {documents.error}<Button variant="ghost" onClick={() => void documents.reload()}>Retry documents</Button></Notice>}
      {!isPortugueseJournal && !requirements.size && !guided?.source_tables?.length && !guided?.journals?.length && <Notice>No questions are available in this view yet. Run the response check below to see what is still needed.</Notice>}
      {(showAllAnswers ? allRequirements : activeQuestion ? [activeQuestion] : []).map(requirement => <article id={`question-${requirement.id ?? requirement.key}`} key={requirement.id ?? requirement.key} className="evidence-card"><h3>{requirement.prompt ?? requirement.label}</h3>{(requirement.physical_label || requirement.period) && <p><strong>{requirement.physical_label}</strong>{requirement.period ? ` · ${requirement.period}` : ''}</p>}<p className="muted">{requirement.required ? 'Required' : 'Optional'}{requirement.unit ? ` · Expected unit: ${requirement.unit}` : ''}{requirement.state === 'conflict' ? ' · Sources disagree; review the existing answers.' : ''}</p>
        {matchingFacts(requirement).map(fact => <div className="panel inset" key={fact.id}><p><strong>{answerPlace(fact)}</strong></p><div className="section-heading"><strong style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{literal(fact.data.value)}{fact.data.unit ? ` ${fact.data.unit}` : ''}</strong><span className="badge">{statusLabel(fact.data.review_status)}</span></div><p>{fact.data.temporal_basis === 'static' ? 'Standing farm detail' : fact.data.temporal_basis === 'calendar_date' ? 'Recorded on' : 'For campaign year'}{fact.data.period !== null ? ` ${fact.data.period}` : fact.data.temporal_basis === 'static' ? '' : ' — not supplied'}</p>
          {fact.data.temporal_basis !== 'static' && fact.data.period !== String(data.reporting_year) && <Notice kind="warning">This answer has a different period or an exact date. Review its applicability; the report’s checks decide whether it can be used.</Notice>}
          <h4>Check the source</h4><SourceLinks sources={fact.data.sources} /><details><summary>Saved version details</summary><p>Answer version {fact.revision}. Answer reference: {fact.id}.</p>{fact.data.parcel_id && <p>Field / site reference: {fact.data.parcel_id}.</p>}<p>Source values and their field/date links are retained with this answer.</p></details>
          {reviewer && ['proposed', 'confirmed'].includes(fact.data.review_status) && <div className="stack"><Field label="Review note"><input value={reviewNotes[fact.id] ?? ''} onChange={event => setReviewNotes(previous => ({ ...previous, [fact.id]: event.target.value }))} /></Field><div className="actions">{fact.data.review_status === 'proposed' && <Button disabled={busy} onClick={() => void review(fact, 'confirmed')}>Confirm this answer</Button>}<Button variant="secondary" disabled={busy} onClick={() => void review(fact, 'rejected')}>{fact.data.review_status === 'confirmed' ? 'Reject confirmed answer with note' : 'Reject proposal'}</Button></div></div>}
        </div>)}
        {reviewer && requirement.state !== 'conflict' && <details open={matchingFacts(requirement).length === 0}><summary>Add or correct an answer</summary><AnswerForm key={requirement.id ?? requirement.key} farmId={data.farm_id} requestId={request.id} requestRevision={request.revision} requirement={requirement} period={data.reporting_year} documents={documents.items} existingFacts={matchingFacts(requirement)} onSaved={async () => { await facts.reload(); await loadQuestions(); setCheck(null); }} /></details>}
      </article>)}
      {!reviewer && <Notice>An owner or a person with delegated review permission must confirm these answers.</Notice>}
    </section>
    <section className="panel"><h2>Prepare the response</h2><p>Check the chosen format, reviewed answers, dates and sources before preparing a draft. Preparing it does not approve or send it.</p>
      {isPortugueseJournal ? <p>The journal editor checks the selected rows and dates before creating the response. Choose supporting documents there; approving the final report is a separate step.</p> : <><RequestChecks requestId={request.id} revision={request.revision + journalRevision + relevantFacts.reduce((sum, fact) => sum + fact.revision, 0)} documentIds={selectedDocumentIds} operationIds={isCzechJournal ? selectedOperationIds : undefined} />
      <fieldset><legend>Include selected evidence</legend><p className="muted">Choose the documents relevant to this request. The response retains their references; original files remain private.</p>{documents.items.filter(document => !document.data.farm_id || document.data.farm_id === data.farm_id).map(document => <label className="checkbox-field" key={document.id}><input type="checkbox" checked={selectedDocumentIds.includes(document.id)} onChange={event => { setSelectedDocumentIds(previous => event.target.checked ? [...previous, document.id] : previous.filter(value => value !== document.id)); setCheck(null); }} /><span>{document.data.name ?? document.data.filename ?? document.data.title ?? document.id}</span></label>)}{!documents.loading && !documents.items.length && <p>No evidence documents yet. <Link to="/app/documents">Add a document</Link> when one is available.</p>}</fieldset></>}
      {isCzechJournal && journalSelection.error && <Notice kind="warning">{journalSelection.error}</Notice>}
      {reviewer && <Button loading={busy} disabled={isCzechJournal && (!journalSelection.ready || !selectedOperationIds.length)} onClick={() => void prepare()}>{isPortugueseJournal ? 'Choose journal rows for this request' : 'Check & prepare response'}</Button>}
      {check && <div className="stack"><h3>Preview the response</h3>{blockers?.length ? <Notice kind="warning"><p>These checks need attention before approval:</p><ul>{blockers.map((blocker, index) => <li key={`${blocker.code}-${index}`}>{blocker.message}</li>)}</ul></Notice> : blockers ? <Notice kind="success">No blocking requirements were found in this draft. Review the values before approving.</Notice> : <Notice>Open the response to see its current checks.</Notice>}
        {!!check.data.snapshot?.fields?.length && <div className="table-scroll"><table><thead><tr><th>Field</th><th>Value</th><th>Unit</th><th>Period</th></tr></thead><tbody>{check.data.snapshot.fields.map((field, index) => <tr key={`${field.field}-${index}`}><th scope="row">{field.label}</th><td><ReportAnswer field={field}/></td><td>{field.unit ?? 'Not specified'}</td><td>{field.period ?? 'Standing detail / not supplied'}</td></tr>)}</tbody></table></div>}
        <RetainedCzechJournals journals={check.data.snapshot?.journals} operations={check.data.snapshot?.operations} />
        <div className="actions">{check.data.status === 'draft' && check.data.can_approve && reviewer && <Button loading={busy} onClick={() => void approve()}>Approve this response</Button>}<Link className="button button-secondary" to={`/app/reports/${check.id}`}>{check.data.status === 'issued' ? 'Download & record response receipt' : 'Open full response & evidence'}</Link>{check.data.status === 'issued' && <Link className="button button-primary" to={`/app/connections?farm_id=${data.farm_id}&report_id=${check.id}`}>Continue to official route</Link>}</div>
        {check.data.status === 'issued' && <Notice>Approved locally. Complete the authority’s own filing steps, then record its actual reference or receipt.</Notice>}
      </div>}
      {!!pack?.sources?.length && <section><h3>Official instructions and limits</h3><ul>{pack.sources.map((source: { url?: string; title?: string; edition?: string }, index: number) => <li key={index}>{source.url && /^https:\/\//.test(source.url) ? <a href={source.url} target="_blank" rel="noreferrer">{source.title ?? 'Official source'}</a> : source.title}{source.edition ? ` · ${source.edition}` : ''}</li>)}</ul>{pack.limitations?.map((limitation: string, index: number) => <p className="muted" key={index}>{limitation}</p>)}<p>Opening an official route does not submit this response.</p></section>}
      {reports.error && <Notice kind="error">{reports.error}<Button variant="ghost" onClick={() => void reports.reload()}>Retry response history</Button></Notice>}
      {!!requestReports.length && <><h3>Retained responses</h3><ul className="record-list">{requestReports.map(report => <li key={report.id}><Link to={`/app/reports/${report.id}`}><div className="record-main"><strong>Response · {new Date(report.created_at).toLocaleDateString()}</strong><span>{report.data.status === 'issued' ? 'Approved version' : 'Draft response'}</span></div><span className="badge">{report.data.status === 'issued' ? 'Approved in this app' : 'Draft'}</span></Link></li>)}</ul></>}
    </section>
  </>;
}
