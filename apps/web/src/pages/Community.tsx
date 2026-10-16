import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { useSession } from '../auth';
import { Button, Field, Loading, Notice, PageHeader } from '../components';
import { useRecords } from '../hooks';
import { usePrivateDraft } from '../offline';
import type { Page, RecordItem } from '../types';
import { countries } from './Core';
import './administration.css';

type PublicPost = { id: string; data: { title?: string; body: string; category?: string; country?: string | null }; is_author: boolean; status: string; created_at: string };
type Thread = { question: PublicPost; replies: PublicPost[] };
type PrivateQuestion = RecordItem<{ farm_id: string; asked_by: string; recipient_id: string; title: string; body: string; status: string; responses: Array<{ body: string; display_name?: string; created_at?: string }> }>;
const categories = ['general', 'paperwork', 'cap', 'inspections', 'sustainability', 'records'];
const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });

export function CommunityPage() {
  const [search] = useSearchParams();
  const [mode, setMode] = useState<'private' | 'public'>(() => search.has('question') ? 'public' : 'private');
  useEffect(() => { if (search.has('question')) setMode('public'); }, [search]);
  return <>
    <PageHeader title="Ask a person" description="A question about your farm, or a practical tip from another farmer. Choose who should see it." />
    <div className="admin-choice-row"><button type="button" className={`admin-choice${mode === 'private' ? ' is-selected' : ''}`} aria-pressed={mode === 'private'} onClick={() => setMode('private')}><strong>Ask my adviser</strong><span>Private, within the farm access you granted</span></button><button type="button" className={`admin-choice${mode === 'public' ? ' is-selected' : ''}`} aria-pressed={mode === 'public'} onClick={() => setMode('public')}><strong>Ask the community</strong><span>A deliberately public farming question</span></button></div>
    {mode === 'private' ? <PrivateQuestions/> : <PublicQuestions/>}
  </>;
}

function PrivateQuestions() {
  const { session } = useSession();
  const farms = useRecords('farms');
  const draft = usePrivateDraft('community/private-question', { farm_id: '', recipient_id: '', title: '', body: '' });
  const [recipients, setRecipients] = useState<Array<{ user_id: string; display_name: string }>>([]);
  const [questions, setQuestions] = useState<PrivateQuestion[]>([]);
  const [selected, setSelected] = useState<PrivateQuestion | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const replyDraft = usePrivateDraft(`community/private-reply/${selected?.id ?? 'none'}`, '');
  const farmId = draft.value.farm_id;
  const owner = session?.workspace.role === 'owner';
  const canReview = session?.workspace.role === 'owner' || session?.workspace.permissions?.includes('review') === true;
  const reload = useCallback(async () => {
    if (!farmId) { setQuestions([]); return; }
    setQuestions((await api.get<Page<PrivateQuestion>>(`/adviser/questions?farm_id=${encodeURIComponent(farmId)}`)).items);
  }, [farmId]);
  useEffect(() => {
    let active = true;
    setRecipients([]); setQuestions([]); setSelected(null); setError(''); setLoading(false);
    if (!farmId) return;
    setLoading(true);
    Promise.all([
      api.get<{ items: Array<{ user_id: string; display_name: string }> }>(`/adviser/recipients?farm_id=${encodeURIComponent(farmId)}`),
      api.get<Page<PrivateQuestion>>(`/adviser/questions?farm_id=${encodeURIComponent(farmId)}`),
    ]).then(([people, items]) => { if (active) { setRecipients(people.items); setQuestions(items.items); } }).catch(failure => { if (active) setError(errorMessage(failure)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [farmId]);
  async function send(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setSuccess('');
    try {
      if (!recipients.some(person => person.user_id === draft.value.recipient_id)) throw new Error('Choose an adviser who currently has access to this farm.');
      await api.post('/adviser/questions', draft.value);
      await draft.clear(); await reload(); setSuccess('Your question was sent privately to the adviser you selected.');
    } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  async function open(id: string) {
    setError(''); setBusy(true);
    try { setSelected(await api.get<PrivateQuestion>(`/adviser/questions/${id}`)); }
    catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  return <section className="panel admin-section">
    <h2>A private question about your farm</h2><p>Only the farm owner and the named adviser can open this question. An adviser must already have access to the selected farm.</p>
    {error && <Notice kind="error">{error}</Notice>}{success && <Notice kind="success">{success}</Notice>}
    {draft.error && <Notice kind="warning">{draft.error}</Notice>}{draft.saving && <p role="status" className="muted">Keeping your question in a private draft…</p>}
    {farms.error && <Notice kind="error">{farms.error}</Notice>}
    {!draft.ready || farms.loading ? <Loading>Opening your private question draft…</Loading> : <form className="stack" onSubmit={send}>
      <div className="form-grid"><Field label="Which farm?"><select required value={farmId} onChange={event => draft.setValue(previous => ({ ...previous, farm_id: event.target.value, recipient_id: '' }))}><option value="">Choose a farm</option>{farms.items.map(farm => <option key={farm.id} value={farm.id}>{farm.data.name}</option>)}</select></Field>{owner && <Field label="Who should receive it?"><select required value={draft.value.recipient_id} disabled={!farmId || loading} onChange={event => draft.setValue(previous => ({ ...previous, recipient_id: event.target.value }))}><option value="">Choose your adviser</option>{recipients.map(person => <option key={person.user_id} value={person.user_id}>{person.display_name}</option>)}</select></Field>}</div>
      {owner && farmId && !loading && !recipients.length && !error && <Notice>No adviser has been given access to this farm yet. <Link to="/app/adviser">Invite someone you trust</Link>, then return to ask them.</Notice>}
      {owner && <><Field label="What do you need a hand with?"><input value={draft.value.title} maxLength={180} required onChange={event => draft.setValue(previous => ({ ...previous, title: event.target.value }))}/></Field>
      <Field label="Your question"><textarea value={draft.value.body} maxLength={8000} required onChange={event => draft.setValue(previous => ({ ...previous, body: event.target.value }))}/></Field>
      <div><Button type="submit" loading={busy} disabled={!recipients.length || loading}>Send privately to my adviser</Button></div></>}
    </form>}
    {loading && <Loading>Checking current adviser access…</Loading>}
    {farmId && !loading && <div className="admin-subsection"><h3>Questions for this farm</h3>{!questions.length && <p className="muted">Your private questions and replies will appear here.</p>}<ul className="record-list">{questions.map(question => <li key={question.id}><Button variant="ghost" disabled={busy} onClick={() => void open(question.id)}>{question.data.title}</Button><span className="badge">{question.data.status}</span></li>)}</ul></div>}
    {selected && <article className="admin-thread"><h3>{selected.data.title}</h3><p className="preserve-lines">{selected.data.body}</p>{(selected.data.responses ?? []).map((response, index) => <div className="admin-reply" key={index}>{response.display_name && <strong>{response.display_name}</strong>}<p className="preserve-lines">{response.body}</p></div>)}
      {selected.data.status !== 'closed' && canReview && <form className="stack" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { setSelected(await api.post<PrivateQuestion>(`/adviser/questions/${selected.id}/reply`, { expected_revision: selected.revision, body: replyDraft.value })); await replyDraft.clear(); await reload(); } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); } }}><Field label="Private reply"><textarea value={replyDraft.value} onChange={event => replyDraft.setValue(event.target.value)} required maxLength={8000}/></Field><div><Button type="submit" loading={busy} disabled={!replyDraft.ready}>Send private reply</Button>{replyDraft.error && <Notice kind="warning">{replyDraft.error}</Notice>}{replyDraft.saving && <p role="status" className="muted">Keeping your unsent reply in a private draft…</p>}</div></form>}
      {selected.data.status !== 'closed' && (session?.workspace.role === 'owner' || selected.data.asked_by === session?.user.id) && <Button variant="secondary" loading={busy} onClick={async () => { setBusy(true); setError(''); try { setSelected(await api.post<PrivateQuestion>(`/adviser/questions/${selected.id}/close`, { expected_revision: selected.revision })); await reload(); } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); } }}>Mark question as resolved</Button>}
    </article>}
  </section>;
}

function PublicQuestions() {
  const [search, setSearch] = useSearchParams();
  const [country, setCountry] = useState('');
  const [category, setCategory] = useState('general');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<Page<PublicPost> | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [publish, setPublish] = useState(false);
  const [publishReply, setPublishReply] = useState(false);
  const [reportReason, setReportReason] = useState('');
  const draft = usePrivateDraft('community/public-question', { title: '', body: '', category: 'general', country: '' });
  const questionId = search.get('question');
  const replyDraft = usePrivateDraft(`community/public-reply/${questionId ?? 'none'}`, '');
  const reload = useCallback(async () => {
    setPage(await api.get<Page<PublicPost>>(`/community?category=${encodeURIComponent(category)}${country ? `&country=${encodeURIComponent(country)}` : ''}&limit=20&offset=${offset}`));
  }, [category, country, offset]);
  useEffect(() => {
    let active = true; setLoading(true); setPage(null); setError('');
    api.get<Page<PublicPost>>(`/community?category=${encodeURIComponent(category)}${country ? `&country=${encodeURIComponent(country)}` : ''}&limit=20&offset=${offset}`).then(value => { if (active) setPage(value); }).catch(failure => { if (active) setError(errorMessage(failure)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [category, country, offset]);
  useEffect(() => {
    let active = true; setThread(null); setPublishReply(false);
    if (questionId) api.get<Thread>(`/community/${encodeURIComponent(questionId)}`).then(value => { if (active) setThread(value); }).catch(failure => { if (active) setError(errorMessage(failure)); });
    return () => { active = false; };
  }, [questionId]);
  async function withdraw(postId: string) {
    setBusy(true); setError('');
    try { await api.post(`/community/${postId}/withdraw`); if (postId === questionId) setSearch({}); else if (questionId) setThread(await api.get<Thread>(`/community/${questionId}`)); await reload(); setSuccess('Your public text has been withdrawn.'); }
    catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  return <>
    <section className="panel admin-section"><h2>Practical questions from farmers</h2><p>Community posts are public. Keep private farm records, personal details and document contents out of your question. Replies are shared experience; check important decisions with your adviser or official source.</p>
      {error && <Notice kind="error">{error}</Notice>}{success && <Notice kind="success">{success}</Notice>}
      <div className="form-grid"><Field label="Topic"><select value={category} onChange={event => { setCategory(event.target.value); setOffset(0); }}>{categories.map(value => <option key={value} value={value}>{value === 'cap' ? 'CAP applications' : value[0].toUpperCase() + value.slice(1)}</option>)}</select></Field><Field label="Country"><select value={country} onChange={event => { setCountry(event.target.value); setOffset(0); }}><option value="">All EU countries</option>{countries.map(code => <option key={code} value={code}>{countryNames.of(code)}</option>)}</select></Field></div>
      {loading ? <Loading>Opening community questions…</Loading> : page && <><ul className="record-list">{page.items.map(post => <li key={post.id}><Link to={`/app/community?question=${post.id}`}><div className="record-main"><strong>{post.data.title}</strong><span>{post.data.country ? countryNames.of(post.data.country) : 'Across the EU'} · {new Date(post.created_at).toLocaleDateString()}</span></div></Link></li>)}</ul>{!page.items.length && <p className="empty-state">No public questions match these choices yet. You can start one below.</p>}<div className="actions"><Button variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>Previous questions</Button><span className="muted">{page.total} public questions</span><Button variant="secondary" disabled={offset + page.items.length >= page.total} onClick={() => setOffset(offset + 20)}>Next questions</Button></div></>}
    </section>
    {questionId && !thread && !error && <Loading>Opening this question…</Loading>}
    {thread && <section className="panel admin-section"><h2>{thread.question.data.title}</h2><p className="preserve-lines">{thread.question.data.body}</p>{thread.question.is_author && <Button variant="secondary" loading={busy} onClick={() => void withdraw(thread.question.id)}>Withdraw my question</Button>}<h3>Replies</h3>{!thread.replies.length && <p className="muted">No replies yet.</p>}{thread.replies.map(post => <article className="admin-reply" key={post.id}><p className="preserve-lines">{post.data.body}</p>{post.is_author && <Button variant="ghost" loading={busy} onClick={() => void withdraw(post.id)}>Withdraw my reply</Button>}</article>)}
      <form className="stack" onSubmit={async event => { event.preventDefault(); if (!publishReply) return; setBusy(true); setError(''); try { await api.post(`/community/${thread.question.id}/replies`, { body: replyDraft.value, publish: true }); await replyDraft.clear(); setPublishReply(false); setThread(await api.get<Thread>(`/community/${thread.question.id}`)); } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); } }}><Field label="Share a practical reply"><textarea required maxLength={8000} value={replyDraft.value} onChange={event => replyDraft.setValue(event.target.value)}/></Field><label className="check-row"><input type="checkbox" required checked={publishReply} onChange={event => setPublishReply(event.target.checked)}/>I want this reply published in the public community.</label><div><Button type="submit" disabled={!publishReply || !replyDraft.ready} loading={busy}>Publish reply</Button>{replyDraft.error && <Notice kind="warning">{replyDraft.error}</Notice>}{replyDraft.saving && <p role="status" className="muted">Keeping your unsent reply in a private draft…</p>}</div></form>
      <details className="admin-subsection"><summary>Report a problem with this question</summary><form className="stack" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { await api.post(`/community/${thread.question.id}/report`, { reason: reportReason }); setReportReason(''); setSuccess('Your report was sent for review.'); } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); } }}><Field label="What should a moderator check?"><textarea required maxLength={2000} value={reportReason} onChange={event => setReportReason(event.target.value)}/></Field><div><Button type="submit" variant="secondary" loading={busy}>Report this question</Button></div></form></details>
    </section>}
    <section className="panel admin-section"><h2>Ask the community</h2>{draft.error && <Notice kind="warning">{draft.error}</Notice>}{draft.saving && <p role="status" className="muted">Keeping your question in a private draft…</p>}{!draft.ready ? <Loading>Opening your question draft…</Loading> : <form className="stack" onSubmit={async event => { event.preventDefault(); if (!publish) return; setBusy(true); setError(''); try { const result = await api.post<PublicPost>('/community', { ...draft.value, country: draft.value.country || null, publish: true }); await draft.clear(); setPublish(false); await reload(); setSearch({ question: result.id }); setSuccess('Your question is now public.'); } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); } }}><Field label="Your question in a few words"><input required maxLength={180} value={draft.value.title} onChange={event => draft.setValue(previous => ({ ...previous, title: event.target.value }))}/></Field><Field label="What would you like to ask?"><textarea required maxLength={8000} value={draft.value.body} onChange={event => draft.setValue(previous => ({ ...previous, body: event.target.value }))}/></Field><div className="form-grid"><Field label="Topic"><select value={draft.value.category} onChange={event => draft.setValue(previous => ({ ...previous, category: event.target.value }))}>{categories.map(value => <option value={value} key={value}>{value === 'cap' ? 'CAP applications' : value}</option>)}</select></Field><Field label="Country, if relevant"><select value={draft.value.country} onChange={event => draft.setValue(previous => ({ ...previous, country: event.target.value }))}><option value="">Across the EU</option>{countries.map(code => <option key={code} value={code}>{countryNames.of(code)}</option>)}</select></Field></div><label className="check-row"><input type="checkbox" required checked={publish} onChange={event => setPublish(event.target.checked)}/>I have checked the text and want this question published publicly.</label><div><Button type="submit" loading={busy} disabled={!publish}>Publish my question</Button></div></form>}</section>
  </>;
}
