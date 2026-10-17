import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, errorMessage } from '../api';
import { useSession } from '../auth';
import { Button, Field, Notice } from '../components';
import { saveDraft, usePrivateDraft } from '../offline';
import { resolveSpanishDemo } from '../maps/spanishDemo';
import type { RecordItem } from '../types';
import type { FieldGeometry } from './FieldsMap';
import './spanishParcelDemo.css';

type Parcel = { id: string; external_id?: string | null; geometry?: FieldGeometry | null; [key: string]: unknown };
type Body = { expected_revision: number; parcel: Record<string, unknown>; note: string;
  reference: { geometry: FieldGeometry; external_id: string; crop: string | null; source: string; year: null } };
type ApprovalBody = { expected_revision: number; expected_farm_revision: number; note: string; accept_overlap: boolean };
type Draft = { retryKey: string; proposalId: string | null; body: Body | null; before: Parcel[] | null;
  approvalKey: string; approval: ApprovalBody | null };
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const excludedMetadata = new Set(['geometry', 'revision', 'reviewed_at', 'reviewed_by', 'active', 'lineage']);
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
const same = (left: unknown, right: unknown) => stable(left) === stable(right);
function holes(geometry: FieldGeometry | null | undefined) {
  if (!geometry) return 0;
  return geometry.type === 'Polygon' ? geometry.coordinates.length - 1
    : (geometry.coordinates as number[][][][]).reduce((total, polygon) => total + polygon.length - 1, 0);
}
const warningText = (value: unknown): string => typeof value === 'string' ? value
  : value && typeof value === 'object' && 'message' in value ? String(value.message) : JSON.stringify(value) ?? 'Unspecified warning';

/** A private, source-bound correction. No authority update or approval on read. */
export function SpanishParcelDemo({ farm, parcel, onChanged }: { farm: RecordItem; parcel: Parcel; onChanged: () => void }) {
  const { session } = useSession();
  const snapshot = resolveSpanishDemo(farm, parcel);
  if (!session || farm.workspace_id !== session.workspace.id || !snapshot) return null;
  return <Correction key={`${session.user.id}/${session.workspace.id}/${farm.id}/${parcel.id}/${snapshot.id}`}
    farm={farm} parcel={parcel} onChanged={onChanged}/>;
}

function Correction({ farm, parcel, onChanged }: { farm: RecordItem; parcel: Parcel; onChanged: () => void }) {
  const { session } = useSession();
  const snapshot = resolveSpanishDemo(farm, parcel)!;
  const scope = `${session!.user.id}/${session!.workspace.id}`;
  const name = `examples/spanish-boundary/${farm.id}/${parcel.id}/${snapshot.id}`;
  const [initial] = useState<Draft>(() => ({ retryKey: crypto.randomUUID(), proposalId: null, body: null, before: null,
    approvalKey: crypto.randomUUID(), approval: null }));
  const draft = usePrivateDraft<Draft>(name, initial);
  const [proposal, setProposal] = useState<RecordItem | null>(null);
  const [note, setNote] = useState('I compared the private outline with the retained SIGPAC reference and want to restore its holes without changing the crop.');
  const [acknowledged, setAcknowledged] = useState(false);
  const [overlapAcknowledged, setOverlapAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [issues, setIssues] = useState<unknown[]>([]);
  const [attempt, setAttempt] = useState(0);
  const request = useRef<AbortController | null>(null);
  const saving = useRef(false);
  const canReview = session!.workspace.role === 'owner' || session!.workspace.role === 'adviser' && session!.workspace.permissions?.includes('review') === true;
  const matched = same(parcel.geometry, snapshot.field.geometry);
  const stale = !!proposal && proposal.data.status === 'proposed' && proposal.data.base_farm_revision !== farm.revision;
  const overlaps = Array.isArray(proposal?.data.overlapping_fields) ? proposal.data.overlapping_fields : [];
  const warnings: unknown[] = Array.isArray(proposal?.data.warnings) ? proposal.data.warnings : [];
  const editorHref = `/app/fields/${farm.id}?${new URLSearchParams({ parcel_id: parcel.id, expected_farm_revision: String(farm.revision), reporting_year: String(farm.data.reporting_year) })}#boundaries-${farm.id}`;

  useEffect(() => {
    setAcknowledged(false); setOverlapAcknowledged(false); setBusy(false); saving.current = false;
    return () => request.current?.abort();
  }, [farm.revision]);
  useEffect(() => {
    setProposal(null); setAcknowledged(false); setOverlapAcknowledged(false);
    if (!draft.ready || !draft.value.proposalId) return;
    const controller = new AbortController();
    void readProposal(draft.value.proposalId, controller.signal).then(record => {
      if (!controller.signal.aborted) { setProposal(record); setAcknowledged(false); setOverlapAcknowledged(false); }
    }).catch(failure => { if (!controller.signal.aborted) { setProposal(null); setAcknowledged(false); setOverlapAcknowledged(false); setError(errorMessage(failure)); } });
    return () => controller.abort();
  }, [draft.ready, draft.value.proposalId, farm.revision, attempt]);

  function checkedProposal(record: RecordItem) {
    if (!record || !uuid.test(record.id) || record.kind !== 'field_change_proposals' || record.workspace_id !== farm.workspace_id
      || record.data.farm_id !== farm.id || !Number.isInteger(record.revision) || record.revision < 1
      || record.data.parcel?.id !== parcel.id || !same(record.data.parcel?.geometry, snapshot.field.geometry)
      || record.data.reference?.external_id !== snapshot.field.reference || record.data.reference?.year !== null
      || !same(record.data.reference?.geometry, snapshot.field.geometry)) throw new Error('This saved correction does not match the selected field and retained source. Open the normal map review.');
    const original = draft.value.before?.find(field => field.id === parcel.id);
    if (draft.value.body && (record.data.base_farm_revision !== draft.value.body.expected_revision || !original
      || Object.keys(original).some(key => !excludedMetadata.has(key) && !same(original[key], record.data.parcel[key])))) {
      throw new Error('The saved proposal does not retain the starting field details. Open the full map review before applying anything.');
    }
    return record;
  }
  async function readProposal(id: string, signal: AbortSignal) {
    if (!uuid.test(id)) throw new Error('The saved correction reference needs checking.');
    const record = checkedProposal(await (await api.downloadResponse(`/field-proposals/${id}`, { signal })).json() as RecordItem);
    if (record.id !== id) throw new Error('The returned correction does not match the saved reference. Open the normal map review.');
    return record;
  }
  function checkedDraft(value: Draft) {
    if (!uuid.test(value.retryKey) || !uuid.test(value.approvalKey)) throw new Error('The saved retry reference needs checking. Open the normal map review.');
    if (value.body && (value.body.parcel.id !== parcel.id || !Number.isInteger(value.body.expected_revision)
      || value.body.reference.external_id !== snapshot.field.reference || value.body.reference.year !== null
      || !same(value.body.reference.geometry, snapshot.field.geometry) || !same(value.body.parcel.geometry, snapshot.field.geometry))) {
      throw new Error('The saved correction no longer matches this reference. Open the normal map review; it has not been replaced.');
    }
    if (value.approval && (!Number.isInteger(value.approval.expected_revision) || !Number.isInteger(value.approval.expected_farm_revision)
      || typeof value.approval.note !== 'string' || !value.approval.note.trim() || value.approval.note.length > 4000
      || typeof value.approval.accept_overlap !== 'boolean')) throw new Error('The saved confirmation needs checking in the normal map review.');
  }
  async function remember(value: Draft) {
    await saveDraft(scope, name, value);
    draft.setValue(value);
  }
  function failure(reason: unknown) {
    setError(errorMessage(reason));
    setIssues(reason instanceof ApiError && Array.isArray(reason.details.overlapping_fields) ? reason.details.overlapping_fields.map(field => `Overlap: ${warningText(field)}`) : []);
  }
  async function save() {
    if (!canReview || !draft.ready || saving.current || proposal || draft.value.proposalId || matched) return;
    saving.current = true; setBusy(true); setError(''); setIssues([]); setMessage('');
    const controller = new AbortController(); request.current?.abort(); request.current = controller;
    try {
      checkedDraft(draft.value);
      let value = draft.value;
      if (!value.body) {
        const properties: Record<string, unknown> = {};
        for (const key of ['id', 'name', 'point', 'crop', 'greenhouse', 'notes', 'external_id']) if (key in parcel) properties[key] = parcel[key];
        value = { ...value, before: JSON.parse(JSON.stringify(farm.data.parcels)) as Parcel[], body: {
          expected_revision: farm.revision, parcel: { ...properties, geometry: JSON.parse(JSON.stringify(snapshot.field.geometry)) },
          note: 'Restore the retained public SIGPAC reference geometry in this private staged example; preserve the crop and other fields.',
          reference: { geometry: JSON.parse(JSON.stringify(snapshot.field.geometry)), external_id: snapshot.field.reference,
            crop: snapshot.field.use_code, source: `Retained public SIGPAC reference ${snapshot.field.reference}; ${snapshot.field.attributes_url}`.slice(0, 500), year: null },
        } };
        await remember(value);
      }
      if (controller.signal.aborted) return;
      const saved = checkedProposal(await api.post<RecordItem>(`/farms/${farm.id}/field-proposals`, value.body,
        { idempotencyKey: value.retryKey, signal: controller.signal }));
      if (saved.data.base_farm_revision !== value.body!.expected_revision) throw new Error('The saved correction has a different starting version. Open the map review.');
      await remember({ ...value, proposalId: saved.id });
      if (!controller.signal.aborted) setMessage('Correction saved for review. The field has not been changed.');
    } catch (reason) { if (!controller.signal.aborted) failure(reason); }
    finally { saving.current = false; if (!controller.signal.aborted) setBusy(false); }
  }
  async function apply() {
    if (!canReview || saving.current || !proposal || proposal.data.status !== 'proposed' || stale || !acknowledged
      || !note.trim() || overlaps.length > 0 && !overlapAcknowledged) return;
    saving.current = true; setBusy(true); setError(''); setIssues([]); setMessage('');
    const controller = new AbortController(); request.current?.abort(); request.current = controller;
    let recorded = false;
    try {
      checkedDraft(draft.value);
      const body: ApprovalBody = draft.value.approval ?? { expected_revision: proposal.revision, expected_farm_revision: farm.revision,
        note: note.trim(), accept_overlap: overlapAcknowledged };
      if (body.expected_revision !== proposal.revision || body.expected_farm_revision !== farm.revision) throw new Error('This saved confirmation refers to an older version. Reopen the map review.');
      await remember({ ...draft.value, approval: body });
      if (controller.signal.aborted) return;
      const result = await api.post<{ farm: RecordItem; proposal: RecordItem }>(`/field-proposals/${proposal.id}/approve`, body,
        { idempotencyKey: draft.value.approvalKey, signal: controller.signal });
      const applied = checkedProposal(result.proposal);
      if (applied.data.status !== 'approved') throw new Error('The returned proposal is not approved. Refresh the saved proposal before continuing.');
      recorded = true; setProposal(applied);
      if (result.farm.id !== farm.id || result.farm.workspace_id !== farm.workspace_id
        || result.farm.revision !== farm.revision + 1) throw new Error('The confirmation returned an unexpected version. Check the saved result before doing anything else.');
      const fresh = await (await api.downloadResponse(`/farms/${farm.id}`, { signal: controller.signal })).json() as RecordItem;
      const fields = Array.isArray(fresh.data?.parcels) ? fresh.data.parcels as Parcel[] : [];
      const targets = fields.filter(field => field.id === parcel.id && field.active !== false);
      const before = draft.value.before;
      const old = before?.find(field => field.id === parcel.id);
      if (fresh.id !== farm.id || fresh.kind !== 'farms' || fresh.workspace_id !== farm.workspace_id || fresh.revision !== result.farm.revision
        || targets.length !== 1 || !same(targets[0].geometry, snapshot.field.geometry) || !before || !old
        || !same(before.filter(field => field.id !== parcel.id), fields.filter(field => field.id !== parcel.id))
        || Object.keys(old).some(key => !excludedMetadata.has(key) && !same(old[key], targets[0][key]))) {
        throw new Error('The approval was recorded, but the fresh farm comparison needs checking. Do not apply it again; open the current map review.');
      }
      if (!controller.signal.aborted) { setMessage('Applied to the private field and checked against the saved farm. The public reference and other fields are unchanged.'); onChanged(); }
    } catch (reason) { if (!controller.signal.aborted) { failure(reason); if (recorded) setError(`Approval was recorded. ${errorMessage(reason)} Do not apply it again; open the current map review.`); } }
    finally { saving.current = false; if (!controller.signal.aborted) setBusy(false); }
  }
  function download() {
    const source = { type: 'Feature', geometry: snapshot.field.geometry, properties: {
      reference: snapshot.field.reference, source: snapshot.field.attributes_url, source_year: null,
      area_ha: snapshot.field.area_ha, use_code: snapshot.field.use_code, csp_percent: snapshot.field.csp_percent,
      meaning: 'Retained public reference, not ownership, a farmer claim or a new authority decision.',
    } };
    const url = URL.createObjectURL(new Blob([JSON.stringify(source, null, 2)], { type: 'application/geo+json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'sigpac-retained-reference.geojson'; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className="spanish-parcel-demo" aria-label="Guided public parcel correction">
    <p className="spanish-parcel-demo-notice">Demo · changes here do not update SIGPAC.</p>
    <section><h3>1. Spot the problem</h3><p>{snapshot.field.label} has {holes(snapshot.field.geometry)} gaps to keep outside the field. Compare the orange outline with the green reference.</p><p>Your drawing currently has {holes(parcel.geometry)} gaps.</p>
      {matched ? <Notice kind="success">The current saved outline matches the retained source geometry.</Notice> : <p>The demo starts with these gaps filled in. Check the drawing before correcting it.</p>}
      <p>Published area: {snapshot.field.area_ha} ha · land use {snapshot.field.use_code} · pasture coefficient {snapshot.field.csp_percent}%.</p>
      <div className="spanish-parcel-demo-actions"><a href={snapshot.field.attributes_url} target="_blank" rel="noopener noreferrer">Read the official source attributes</a><Button variant="ghost" onClick={download}>Download the retained source GeoJSON</Button></div>
    </section>
    <section><h3>2. Save a correction</h3><p>Save a new drawing with the gaps left out. The crop, name and other fields stay the same.</p>
      {!canReview && <p>Your current access is read-only. Ask an owner or a permitted adviser to review the change.</p>}
      {draft.error && <Notice kind="warning">{draft.error}</Notice>}
      <Button disabled={!canReview || !draft.ready || !!proposal || !!draft.value.proposalId || matched} loading={busy} onClick={() => void save()}>Save the boundary correction</Button>
    </section>
    <section><h3>3. Review and apply</h3>{!proposal ? <><p>{draft.value.proposalId ? 'Open your saved correction and check it before applying it.' : 'Save your correction first. Your field stays unchanged until you apply it.'}</p>{draft.value.proposalId && <Button variant="ghost" disabled={busy} onClick={() => { setError(''); setAttempt(value => value + 1); }}>Reload saved proposal</Button>}</> : <>
      <p><strong>Saved proposal:</strong> {proposal.data.status === 'approved' ? 'Approved in private farm records' : proposal.data.status === 'proposed' ? 'Awaiting your review' : 'Set aside'}.</p>
      <p>Crop unchanged: {String(proposal.data.parcel?.crop || 'Not recorded')} · gaps in the new drawing: {holes(proposal.data.parcel?.geometry)} · source year: unknown.</p>
      {!!warnings.length && <ul aria-label="Correction warnings">{warnings.map((warning, index) => <li key={index}>{warningText(warning)}</li>)}</ul>}
      {!!overlaps.length && <ul aria-label="Overlapping fields">{overlaps.map((field: { id: string; name: string }) => <li key={field.id}>{field.name}</li>)}</ul>}
      {stale && <Notice kind="warning">Your farm changed since this correction was saved. Check the current drawing in the full map review.</Notice>}
      {proposal.data.status === 'proposed' && <form onSubmit={event => { event.preventDefault(); void apply(); }}>
        <Field label="Review note"><textarea required maxLength={4000} value={draft.value.approval?.note ?? note} disabled={busy || !!draft.value.approval || !canReview || stale} onChange={event => setNote(event.target.value)}/></Field>
        <label><input type="checkbox" required checked={acknowledged} disabled={busy || !canReview || stale} onChange={event => setAcknowledged(event.target.checked)}/>I compared the current outline, proposed holes, crop and retained reference.</label>
        {!!overlaps.length && <label><input type="checkbox" required checked={overlapAcknowledged} disabled={busy || !canReview || stale} onChange={event => setOverlapAcknowledged(event.target.checked)}/>I checked the listed overlaps and want to retain them.</label>}
        <Button type="submit" loading={busy} disabled={!canReview || stale || !acknowledged || overlaps.length > 0 && !overlapAcknowledged}>Apply the reviewed private correction</Button>
      </form>}
      <Button variant="ghost" disabled={busy} onClick={() => { setError(''); setAttempt(value => value + 1); }}>Refresh saved proposal</Button>
    </> }</section>
    {message && <Notice kind="success">{message}</Notice>}{error && <Notice kind="error">{error}</Notice>}
    {!!issues.length && <ul>{issues.map((issue, index) => <li key={index}>{warningText(issue)}</li>)}</ul>}
    <Link to={editorHref}>Open the full map review</Link>
  </section>;
}
