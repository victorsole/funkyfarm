import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { useSession } from '../auth';
import { Button, Field, Notice } from '../components';
import type { RecordItem } from '../types';

const sections = { reports: 'Reports', facts: 'Farm answers', operations: 'Work records', requests: 'Paperwork', cases: 'Work linked to this change' };
type Section = keyof typeof sections;
type Related = {
  proposal_id: string; proposal_revision: number; section: Section;
  counts: Record<Section, number>;
  items: { id: string; revision: number; title: string; status: string | null; date: string | null; href: string }[];
  total: number; limit: number; offset: number; next_offset: number | null; notice: string;
};

export function FieldRelatedRecords({ proposal }: { proposal: RecordItem }) {
  const { session } = useSession();
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<Section>('reports');
  const [offset, setOffset] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; data: Related } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const scope = `${session?.user.id}:${session?.workspace.id}:${session?.workspace.permissions?.join(',')}:${session?.workspace.farm_ids?.join(',')}`;
  const key = `${scope}:${proposal.id}:${proposal.revision}:${section}:${offset}:${attempt}`;
  const current = result?.key === key ? result.data : null;
  const error = failure?.key === key ? failure.message : null;
  useEffect(() => {
    if (!open) return;
    let active = true;
    const query = new URLSearchParams({ section, limit: '10', offset: String(offset), expected_revision: String(proposal.revision) });
    api.get<Related>(`/field-proposals/${proposal.id}/related-records?${query}`).then(data => {
      if (data.proposal_id !== proposal.id || data.proposal_revision !== proposal.revision || data.section !== section || data.offset !== offset) throw new Error('These links belong to a different saved field change. Reload it before continuing.');
      if (active) setResult({ key, data });
    }).catch(reason => { if (active) setFailure({ key, message: errorMessage(reason) }); });
    return () => { active = false; };
  }, [open, key, proposal.id, proposal.revision, section, offset]);
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>What else uses these fields?</summary>
    {open && <>
      <p>Check related records before changing an application. Earlier work keeps its original field and date; it is not moved to a new field automatically.</p>
      <Field label="Which records?"><select value={section} onChange={event => { setSection(event.target.value as Section); setOffset(0); }}>{Object.entries(sections).map(([value, label]) => <option key={value} value={value}>{label}{current ? ` (${current.counts[value as Section]})` : ''}</option>)}</select></Field>
      {error ? <Notice kind="error">{error}<Button variant="secondary" onClick={() => setAttempt(value => value + 1)}>Check again</Button></Notice> : !current ? <p role="status">Looking for linked records…</p> : <>
        <p>{current.notice}</p>
        <p role="status">{current.items.length ? `Showing ${offset + 1} to ${offset + current.items.length} of ${current.total}` : `No records on this page (${current.total} linked in total).`}</p>
        <ul>{current.items.map(item => <li key={item.id}><Link to={item.href}>{item.title}</Link>{item.date && ` · ${item.date}`}{item.status && ` · ${item.status.replaceAll('_', ' ')}`}</li>)}</ul>
        <div className="actions"><Button variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - current.limit))}>Previous records</Button><Button variant="secondary" disabled={current.next_offset === null} onClick={() => { if (current.next_offset !== null) setOffset(current.next_offset); }}>More records</Button></div>
      </>}
    </>}
  </details>;
}
