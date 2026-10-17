import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { Button, Field, Loading, Notice } from '../components';
import { useRecords } from '../hooks';
import { usePrivateDraft } from '../offline';
import type { RecordItem } from '../types';
import { useReviewAccess } from './Core';

type Evidence = { id: string; kind: string; revision: number; label: string; value?: unknown; quantity?: unknown; amount?: unknown; unit?: string; currency?: string; date?: string; period?: string; parcel_label?: string };
type LinkedTask = { id: string; revision: number; title: string; status: string; checklist_item_key?: string };
type ReviewItem = {
  key: string;
  mode: 'evidence' | 'human_review' | 'fact_evidence' | 'refresh_required';
  can_complete: boolean;
  issues: Array<{ message: string; href?: string } | string>;
  source_integrity_issues?: Array<{ message: string; href?: string }>;
  evidence: Evidence[];
  expected_input_fingerprint?: string;
  source_changed?: boolean;
  href?: string;
};
type Review = { checklist: RecordItem; items: ReviewItem[]; linked_tasks?: LinkedTask[]; needs_refresh?: boolean; source_changed?: boolean; expected_input_fingerprint?: string };
type ReviewDraft = { selected: Record<string, number>; note: string };
const reviewed = (item: Record<string, any>) => item.done === true || ['complete', 'review_recorded'].includes(item.status);
const localLink = (href?: string) => href?.startsWith('/app/') && !href.includes('\\') ? href : null;
function evidenceLabel(candidate: Evidence) {
  const kinds: Record<string, string> = { facts: 'Saved answer', operations: 'Work record', purchases: 'Purchase', sales: 'Sale', documents: 'Document' };
  const amount = candidate.value ?? candidate.quantity ?? candidate.amount;
  const value = typeof amount === 'boolean' ? amount ? 'Yes' : 'No' : Array.isArray(amount) ? amount.join(', ') : typeof amount === 'object' && amount !== null ? JSON.stringify(amount) : amount == null ? '' : String(amount);
  const unit = candidate.value != null || candidate.quantity != null ? candidate.unit : candidate.currency;
  return [kinds[candidate.label] || candidate.label, value ? `${value}${unit ? ` ${unit}` : ''}` : '', candidate.parcel_label, candidate.date || candidate.period].filter(Boolean).join(' · ');
}

export function FarmChecklists() {
  const checklists = useRecords('checklists');
  const [search] = useSearchParams();
  const selected = search.get('checklist_id');
  const focused = useRef<string | null>(null);
  useEffect(() => {
    if (!selected || focused.current === selected) return;
    const target = document.getElementById(`checklist-${selected}`);
    if (target) { target.scrollIntoView({ block: 'start' }); focused.current = selected; }
  }, [selected, checklists.items]);
  return <section className="card"><h2>Your evidence checklists</h2>
    {checklists.error && <Notice kind="error">{checklists.error}</Notice>}
    {checklists.loading && !checklists.items.length && <Loading>Opening your checklists…</Loading>}
    {!checklists.loading && !checklists.items.length && <p>No saved checklists yet. <Link to="/app/checks">Check your farm</Link> or choose a reporting pack above.</p>}
    {checklists.items.map(checklist => <Checklist key={checklist.id} record={checklist} selected={selected === checklist.id} reload={checklists.reload}/>)}
  </section>;
}

function Checklist({ record, selected, reload }: { record: RecordItem; selected: boolean; reload: () => Promise<void> }) {
  const canReview = useReviewAccess();
  const [open, setOpen] = useState(selected);
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [generation, refresh] = useState(0);
  const [reopening, setReopening] = useState<string[]>([]);
  useEffect(() => { setReopening([]); }, [record.revision]);
  useEffect(() => { if (selected) setOpen(true); }, [selected]);
  useEffect(() => {
    let active = true;
    setReview(null); setError('');
    if (open) void api.get<Review>(`/checklists/${record.id}/review`).then(value => { if (active) setReview(value); }).catch(cause => { if (active) setError(errorMessage(cause)); });
    return () => { active = false; };
  }, [open, record.id, record.revision, generation]);
  const data = review?.checklist.data ?? record.data;
  const completed = (data.items ?? []).filter(reviewed).length;
  const needsRefresh = review?.needs_refresh || review?.source_changed;
  async function updateChecklist() {
    if (!review || busy) return;
    setBusy(true); setError('');
    try {
      await api.post(`/checklists/${record.id}/refresh`, { expected_revision: review.checklist.revision, expected_input_fingerprint: review.expected_input_fingerprint });
      await reload(); refresh(value => value + 1);
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }
  return <details id={`checklist-${record.id}`} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{data.title} · {completed} of {(data.items ?? []).length} steps reviewed</summary>
    <p>{data.meaning || data.notes || 'Review the saved evidence before marking a step as done.'}</p>
    {data.compliance_rule_id && <p className="muted">This tracks your review work. It does not confirm legal compliance, eligibility or submission.</p>}
    {error && <Notice kind="error">{error}<div><Button variant="secondary" disabled={busy} onClick={() => refresh(value => value + 1)}>Reload checklist checks</Button></div></Notice>}
    {!review && !error && open && <Loading>Checking the latest records for these steps…</Loading>}
    {review && <>
      <Button variant="ghost" disabled={busy} onClick={() => refresh(value => value + 1)}>Check the latest records</Button>
      {needsRefresh && <Notice kind="warning">This checklist needs to be updated before you can review its steps. Earlier work will stay in history; the updated steps will need a fresh review.
        {canReview && <div><Button loading={busy} onClick={() => void updateChecklist()}>Update this checklist</Button></div>}
      </Notice>}
      {(data.items ?? []).map((item: Record<string, any>) => {
        const current = review.items.find(candidate => candidate.key === item.key);
        return <article className="panel stack" key={item.key}><h3>{item.label}</h3>
          {reviewed(item) && !reopening.includes(item.key) ? <><p>{item.status === 'review_recorded' ? 'Review saved. Check the farm checks page for any remaining follow-up.' : 'Evidence reviewed.'}</p>{item.review_note || item.note ? <p>{item.review_note || item.note}</p> : null}
            {current && !current.can_complete && !needsRefresh && <Notice kind="warning">Your earlier review is kept, but the current records need attention. Review this step again before relying on it.</Notice>}
            {canReview && current && !needsRefresh && <Button variant="secondary" disabled={busy} onClick={() => setReopening(keys => [...keys, item.key])}>Review this step again</Button>}
            {!needsRefresh && current?.can_complete && (review.linked_tasks ?? []).filter(task => task.checklist_item_key === item.key && !['done', 'complete', 'completed', 'cancelled'].includes(task.status)).map(task => <FinishTask key={task.id} task={task} busy={busy} allowed={canReview} saving={setBusy} changed={async () => { await reload(); refresh(value => value + 1); }}/>)}</>
            : !canReview ? <p>Ask the farm owner or an adviser with review permission to review this step.</p>
            : current && !needsRefresh ? <ItemReview key={`${item.key}:${review.expected_input_fingerprint ?? current.expected_input_fingerprint ?? ''}`} checklist={review.checklist} item={current} busy={busy} fingerprint={review.expected_input_fingerprint} saving={setBusy} changed={async () => { await reload(); refresh(value => value + 1); }}/>
            : !needsRefresh ? <p>This step needs a new check before it can be reviewed.</p> : null}
        </article>;
      })}
      {!needsRefresh && review.items.every(item => item.can_complete) && (data.items ?? []).length > 0 && (data.items ?? []).every(reviewed) && (review.linked_tasks ?? []).filter(task => !task.checklist_item_key && !['done', 'complete', 'completed', 'cancelled'].includes(task.status)).map(task => <FinishTask key={task.id} task={task} busy={busy} allowed={canReview} saving={setBusy} changed={async () => { await reload(); refresh(value => value + 1); }}/>) }
      {data.compliance_rule_id && <p><Link to={`/app/checks?farm_id=${data.farm_id}&year=${data.reporting_year ?? String(data.scheme ?? '').split(':').at(-1)}`}>See what still needs checking on this farm</Link></p>}
    </>}
  </details>;
}

function ItemReview({ checklist, item, busy, fingerprint, saving, changed }: { checklist: RecordItem; item: ReviewItem; busy: boolean; fingerprint?: string; saving: (value: boolean) => void; changed: () => Promise<void> }) {
  const draft = usePrivateDraft<ReviewDraft>(`checklist/${checklist.id}/${item.key}`, { selected: {}, note: '' });
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState('');
  const candidates = item.evidence ?? [];
  const selected = candidates.filter(candidate => draft.value.selected[candidate.id] === candidate.revision);
  const humanReview = item.mode === 'human_review';
  const generated = !!checklist.data.compliance_rule_id;
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !draft.ready) return;
    saving(true); setError('');
    try {
      const body = {
        expected_revision: checklist.revision,
        evidence_fact_ids: selected.filter(candidate => candidate.kind === 'facts').map(candidate => candidate.id),
        note: draft.value.note,
        ...(generated ? {
          evidence_operation_ids: selected.filter(candidate => candidate.kind === 'operations').map(candidate => candidate.id),
          evidence_document_ids: selected.filter(candidate => candidate.kind === 'documents').map(candidate => candidate.id),
          evidence_purchase_ids: selected.filter(candidate => candidate.kind === 'purchases').map(candidate => candidate.id),
          evidence_sale_ids: selected.filter(candidate => candidate.kind === 'sales').map(candidate => candidate.id),
          evidence_revisions: Object.fromEntries(selected.map(candidate => [candidate.id, candidate.revision])),
          expected_input_fingerprint: item.expected_input_fingerprint ?? fingerprint,
          review_acknowledged: acknowledged,
        } : {}),
      };
      await api.post(`/checklists/${checklist.id}/items/${encodeURIComponent(item.key)}/complete`, body);
      await draft.clear(); await changed();
    } catch (cause) { setError(errorMessage(cause)); } finally { saving(false); }
  }
  return <form className="stack" onSubmit={save}>
    {error && <Notice kind="error">{error} Your note is kept. Reload the checklist checks before retrying if the evidence changed.</Notice>}
    {draft.error && <Notice kind="warning">{draft.error}</Notice>}
    {[...(item.issues ?? []), ...(item.source_integrity_issues ?? [])].map((issue, index) => <p key={index}>{typeof issue === 'string' ? issue : issue.message}{typeof issue !== 'string' && localLink(issue.href) && <> <Link to={localLink(issue.href)!}>Open this step</Link></>}</p>)}
    {localLink(item.href) && <Link to={localLink(item.href)!}>Open the records for this step</Link>}
    <fieldset disabled={busy || !draft.ready} className="draft-fields">
      {!humanReview && <fieldset><legend>Which saved evidence did you check?</legend>
        {candidates.map(candidate => <label className="check-row" key={candidate.id}><input type="checkbox" checked={draft.value.selected[candidate.id] === candidate.revision} onChange={event => draft.setValue(previous => ({ ...previous, selected: { ...previous.selected, [candidate.id]: event.target.checked ? candidate.revision : -1 } }))}/>{evidenceLabel(candidate)}</label>)}
        {!candidates.length && <p>No suitable confirmed evidence is available yet. <Link to={`/app/fields/${checklist.data.farm_id}#facts`}>Add or review this farm’s records</Link>, then check this checklist again.</p>}
      </fieldset>}
      <Field label="What did you check?"><textarea required minLength={10} value={draft.value.note} onChange={event => draft.setValue(previous => ({ ...previous, note: event.target.value }))}/></Field>
      {humanReview && <label className="check-row"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)}/>I reviewed this step and recorded what still needs attention. This is not confirmation of legal compliance.</label>}
      {!item.can_complete && <p className="muted">Resolve the missing or conflicting records above, then check the latest records before saving this step.</p>}
      <Button type="submit" disabled={!item.can_complete || (humanReview ? !acknowledged : !selected.length)} loading={busy}>{humanReview ? 'Save this review' : 'Confirm evidence for this item'}</Button>
    </fieldset>
  </form>;
}

function FinishTask({ task, busy, allowed, saving, changed }: { task: LinkedTask; busy: boolean; allowed: boolean; saving: (value: boolean) => void; changed: () => Promise<void> }) {
  const draft = usePrivateDraft(`task/${task.id}/complete`, { note: '' });
  const [error, setError] = useState('');
  const [finished, setFinished] = useState(false);
  return <form className="stack" onSubmit={async event => {
    event.preventDefault(); if (!draft.ready || busy) return;
    saving(true); setError('');
    try { await api.post(`/tasks/${task.id}/complete`, { expected_revision: task.revision, note: draft.value.note }); await draft.clear(); await changed(); }
    catch (cause) { setError(errorMessage(cause)); } finally { saving(false); }
  }}><p><strong>Follow-up: {task.title}</strong></p>{error && <Notice kind="error">{error}</Notice>}
    {allowed ? <fieldset disabled={!draft.ready || busy} className="draft-fields"><Field label="What follow-up work did you finish?"><textarea required minLength={10} value={draft.value.note} onChange={event => draft.setValue({ note: event.target.value })}/></Field>
      <label className="check-row"><input type="checkbox" required checked={finished} onChange={event => setFinished(event.target.checked)}/>I finished this follow-up work.</label>
      <Button type="submit" disabled={!finished} loading={busy}>Finish follow-up</Button>
    </fieldset> : <p>Ask the farm owner or adviser to record when this follow-up is finished.</p>}
  </form>;
}
