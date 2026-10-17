import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, NavLink, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { useSession } from '../auth';
import { Button, Field, Loading, Notice, PageHeader } from '../components';
import { useRecords } from '../hooks';
import { usePrivateDraft } from '../offline';
import type { Page, RecordItem } from '../types';
import { countries } from './Core';
import './administration.css';
import './people-pages.css';

type PublicPost = { id: string; kind?: string; data: { title?: string; body: string; category?: string; country?: string | null; question_id?: string }; is_author: boolean; status: string; created_at: string };
type Thread = { question: PublicPost; replies: PublicPost[] };
type PrivateQuestion = RecordItem<{ farm_id: string; asked_by: string; recipient_id: string; title: string; body: string; status: string; responses: Array<{ body: string; display_name?: string; created_at?: string }> }>;
const categories = ['general', 'paperwork', 'cap', 'inspections', 'sustainability', 'records'];
const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });
const topicName = (value = 'general') => value === 'cap' ? 'CAP applications' : `${value.charAt(0).toUpperCase()}${value.slice(1)}` || 'General';
const postPath = (post: PublicPost) => `/app/community/posts/${post.data.question_id ?? post.id}`;
const dateLabel = (value: string) => new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

function CommunityNav() {
  return <nav className="community-nav" aria-label="Community pages"><NavLink end to="/app/community">Community posts</NavLink><NavLink to="/app/community/private">Ask my adviser</NavLink></nav>;
}

function CommunityLayout({ title, description, children, action }: { title: string; description: string; children: ReactNode; action?: ReactNode }) {
  return <div className="community-page"><PageHeader title={title} description={description} action={action}/><CommunityNav/>{children}</div>;
}

function PostMeta({ post }: { post: PublicPost }) {
  return <div className="community-post-meta"><span className="community-topic">{post.kind === 'reply' ? 'Reply' : topicName(post.data.category)}</span><span>{post.data.country ? countryNames.of(post.data.country) : 'Across the EU'}</span><time dateTime={post.created_at}>{dateLabel(post.created_at)}</time>{post.is_author && <span className="community-owned">Your {post.kind === 'reply' ? 'reply' : 'post'}</span>}{post.status !== 'published' && <span className="badge">{post.status === 'withdrawn' ? 'Withdrawn' : post.status === 'hidden' ? 'Hidden after review' : 'Unpublished'}</span>}</div>;
}

export function CommunityPage() {
  const [search, setSearch] = useSearchParams();
  const location = useLocation();
  const mine = search.get('view') === 'mine';
  const category = categories.includes(search.get('topic') ?? '') ? search.get('topic')! : '';
  const country = countries.includes(search.get('country') ?? '') ? search.get('country')! : '';
  const suppliedOffset = Number(search.get('offset') ?? 0);
  const offset = Number.isSafeInteger(suppliedOffset) && suppliedOffset >= 0 ? suppliedOffset : 0;
  const [page, setPage] = useState<Page<PublicPost> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const legacyQuestion = search.get('question');
  useEffect(() => {
    if (legacyQuestion) return;
    let active = true; setLoading(true); setPage(null); setError('');
    const query = new URLSearchParams({ limit: '20', offset: String(offset) });
    if (!mine && category) query.set('category', category);
    if (!mine && country) query.set('country', country);
    api.get<Page<PublicPost>>(`/community${mine ? '/mine' : ''}?${query}`).then(value => { if (active) setPage(value); }).catch(failure => { if (active) setError(errorMessage(failure)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [mine, category, country, offset, retry, legacyQuestion]);
  if (legacyQuestion) return <Navigate replace to={`/app/community/posts/${encodeURIComponent(legacyQuestion)}`}/>;
  if (search.has('farm_id')) return <Navigate replace to={`/app/community/private?${search}`}/>;
  function filter(key: string, value: string) { const next = new URLSearchParams(search); next.delete('offset'); if (value) next.set(key, value); else next.delete(key); setSearch(next); }
  function turnPage(nextOffset: number) { const next = new URLSearchParams(search); if (nextOffset) next.set('offset', String(nextOffset)); else next.delete('offset'); setSearch(next); }
  return <CommunityLayout title="Community" description="Questions, tips and ideas from other farmers." action={<Link className="button button-primary" to="/app/community/new">Write a post</Link>}>
    {location.state?.communityMessage && <Notice kind="success">{String(location.state.communityMessage)}</Notice>}
    <div className="community-toolbar"><div className="community-feed-tabs" role="group" aria-label="Choose posts"><Button variant={mine ? 'ghost' : 'secondary'} aria-pressed={!mine} onClick={() => filter('view', '')}>All posts</Button><Button variant={mine ? 'secondary' : 'ghost'} aria-pressed={mine} onClick={() => filter('view', 'mine')}>My posts</Button></div>
      {!mine && <div className="community-filters"><Field label="Topic"><select value={category} onChange={event => filter('topic', event.target.value)}><option value="">All topics</option>{categories.map(value => <option key={value} value={value}>{topicName(value)}</option>)}</select></Field><Field label="Country"><select value={country} onChange={event => filter('country', event.target.value)}><option value="">All EU countries</option>{countries.map(code => <option key={code} value={code}>{countryNames.of(code)}</option>)}</select></Field></div>}
    </div>
    <p className="community-visibility">Shared with signed-in members. For private farm details, <Link to="/app/community/private">ask your adviser</Link>.</p>
    {error && <Notice kind="error">{error} <Button variant="ghost" onClick={() => setRetry(value => value + 1)}>Try again</Button></Notice>}
    {loading ? <Loading>Opening community posts…</Loading> : page && <>
      <div className="community-feed" aria-label={mine ? 'My posts' : 'Community posts'}>{page.items.map(post => <article className="panel community-post" key={post.id}><PostMeta post={post}/><h2>{post.status === 'published' ? <Link to={postPath(post)}>{post.data.title ?? 'Your reply'}</Link> : post.data.title ?? 'Your reply'}</h2><p className="community-excerpt preserve-lines">{post.data.body.length > 420 ? `${post.data.body.slice(0, 420).trimEnd()}…` : post.data.body}</p>{post.status === 'published' && <Link className="community-read" to={postPath(post)}>{post.kind === 'reply' ? 'Open conversation' : 'Read and reply'}</Link>}</article>)}</div>
      {!page.items.length && <section className="panel community-empty"><h2>{mine ? 'Your posts will appear here' : 'No posts yet'}</h2><p>{mine ? 'Your questions and replies stay together here, including posts you withdraw.' : category || country ? 'Try another topic or country, or start a conversation.' : 'Have a question or a useful tip? You can start the first conversation.'}</p><Link className="button button-primary" to="/app/community/new">Write a post</Link></section>}
      {(offset > 0 || page.total > 20) && <nav className="community-pagination" aria-label="Post pages"><Button variant="secondary" disabled={offset === 0} onClick={() => turnPage(Math.max(0, offset - 20))}>Previous posts</Button><span>{page.items.length ? `${offset + 1}–${offset + page.items.length}` : '0'} of {page.total}</span><Button variant="secondary" disabled={offset + page.items.length >= page.total} onClick={() => turnPage(offset + 20)}>Next posts</Button></nav>}
    </>}
  </CommunityLayout>;
}

export function PrivateCommunityPage() {
  return <CommunityLayout title="Ask my adviser" description="Private conversations with the people helping your farm."><PrivateQuestions/></CommunityLayout>;
}

function PrivateQuestions() {
  const { session } = useSession();
  const [query] = useSearchParams();
  const suppliedFarm = query.get('farm_id') || '';
  const initialFarm = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(suppliedFarm) ? suppliedFarm.toLowerCase() : '';
  const farms = useRecords('farms');
  const draft = usePrivateDraft(initialFarm ? `community/private-question/${initialFarm}` : 'community/private-question', { farm_id: initialFarm, recipient_id: '', title: '', body: '' });
  const [recipients, setRecipients] = useState<Array<{ user_id: string; display_name: string }>>([]);
  const [questions, setQuestions] = useState<PrivateQuestion[]>([]);
  const [questionTotal, setQuestionTotal] = useState(0);
  const [questionOffset, setQuestionOffset] = useState(0);
  const [selected, setSelected] = useState<PrivateQuestion | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [composing, setComposing] = useState(false);
  const threadHeading = useRef<HTMLHeadingElement>(null);
  const privateRetry = useRef({ body: '', key: '' });
  const replyDraft = usePrivateDraft(`community/private-reply/${selected?.id ?? 'none'}`, '');
  const farmId = farms.items.some(farm => farm.id === draft.value.farm_id) ? draft.value.farm_id : '';
  const owner = session?.workspace.role === 'owner';
  const canReview = session?.workspace.role === 'owner' || session?.workspace.permissions?.includes('review') === true;
  useEffect(() => { if (selected) threadHeading.current?.focus(); }, [selected?.id]);
  const reload = useCallback(async () => {
    if (!farmId) { setQuestions([]); return; }
    const page = await api.get<Page<PrivateQuestion>>(`/adviser/questions?farm_id=${encodeURIComponent(farmId)}&limit=20&offset=${questionOffset}`);
    setQuestions(page.items); setQuestionTotal(page.total);
  }, [farmId, questionOffset]);
  useEffect(() => {
    let active = true;
    setRecipients([]); setQuestions([]); setSelected(null); setError(''); setLoading(false);
    if (!farmId) return;
    setLoading(true);
    Promise.all([
      api.get<{ items: Array<{ user_id: string; display_name: string }> }>(`/adviser/recipients?farm_id=${encodeURIComponent(farmId)}`),
      api.get<Page<PrivateQuestion>>(`/adviser/questions?farm_id=${encodeURIComponent(farmId)}&limit=20&offset=${questionOffset}`),
    ]).then(([people, items]) => { if (active) { setRecipients(people.items); setQuestions(items.items); setQuestionTotal(items.total); } }).catch(failure => { if (active) setError(errorMessage(failure)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [farmId, questionOffset]);
  async function send(event: FormEvent) {
    event.preventDefault(); if (!composing || busy) return; setBusy(true); setError(''); setSuccess('');
    try {
      if (!recipients.some(person => person.user_id === draft.value.recipient_id)) throw new Error('Choose an adviser who currently has access to this farm.');
      const body = JSON.stringify(draft.value);
      if (privateRetry.current.body !== body) privateRetry.current = { body, key: crypto.randomUUID() };
      await api.post('/adviser/questions', draft.value, { idempotencyKey: privateRetry.current.key });
      draft.setValue(previous => ({ ...previous, title: '', body: '' })); setComposing(false); await reload(); setSuccess('Your question was sent privately to the adviser you selected.');
    } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  async function open(id: string) {
    setError(''); setBusy(true);
    try { setSelected(await api.get<PrivateQuestion>(`/adviser/questions/${id}`)); }
    catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  if (session?.workspace.role !== 'owner' && session?.workspace.role !== 'adviser') return <Notice>Private conversations are available to the farmer and their adviser. <Link to="/app/community">Read community posts</Link>.</Notice>;
  return <section className="panel admin-section community-private-inbox">
    <div className="section-heading"><h2>Your private questions</h2>{owner && !composing && <Button onClick={() => setComposing(true)}>Write a private question</Button>}</div><p>Choose a farm to see its conversations. Only the farmer and the adviser chosen for each question can read it.</p>
    {error && <Notice kind="error">{error}</Notice>}{success && <Notice kind="success">{success}</Notice>}
    {draft.error && <Notice kind="warning">{draft.error}</Notice>}{draft.saving && <p role="status" className="muted">Keeping your question in a private draft…</p>}
    {farms.error && <Notice kind="error">{farms.error}</Notice>}
    {!draft.ready || farms.loading ? <Loading>Opening your private question draft…</Loading> : <form className="stack" onSubmit={send}>
      <div className="form-grid"><Field label="Which farm?"><select required value={farmId} onChange={event => { setQuestionOffset(0); draft.setValue(previous => ({ ...previous, farm_id: event.target.value, recipient_id: '' })); }}><option value="">Choose a farm</option>{farms.items.map(farm => <option key={farm.id} value={farm.id}>{farm.data.name}</option>)}</select></Field>{owner && composing && <Field label="Who should receive it?"><select required value={draft.value.recipient_id} disabled={!farmId || loading} onChange={event => draft.setValue(previous => ({ ...previous, recipient_id: event.target.value }))}><option value="">Choose your adviser</option>{recipients.map(person => <option key={person.user_id} value={person.user_id}>{person.display_name}</option>)}</select></Field>}</div>
      {owner && composing && farmId && !loading && !recipients.length && !error && <Notice>No adviser has been given access to this farm yet. <Link to="/app/adviser">Invite someone you trust</Link>, then return to ask them.</Notice>}
      {owner && composing && <><Field label="What do you need a hand with?"><input value={draft.value.title} maxLength={180} required onChange={event => draft.setValue(previous => ({ ...previous, title: event.target.value }))}/></Field>
      <Field label="Your question"><textarea value={draft.value.body} maxLength={8000} required onChange={event => draft.setValue(previous => ({ ...previous, body: event.target.value }))}/></Field>
      <div className="actions"><Button type="submit" loading={busy} disabled={!recipients.length || loading}>Send privately to my adviser</Button><Button variant="secondary" disabled={busy} onClick={() => setComposing(false)}>Finish later</Button></div></>}
    </form>}
    {loading && <Loading>Checking current adviser access…</Loading>}
    {farmId && !loading && <div className="admin-subsection"><h3>Questions for this farm</h3>{!questions.length && <p className="muted">Your private questions and replies will appear here.</p>}<ul className="record-list">{questions.map(question => <li key={question.id}><Button variant="ghost" disabled={busy} onClick={() => void open(question.id)}>{question.data.title}</Button><span className="badge">{question.data.status === 'closed' ? 'Resolved' : question.data.status === 'answered' ? 'Replied' : 'Waiting for a reply'}</span></li>)}</ul>{(questionTotal > 20 || questionOffset > 0) && <nav className="community-pagination" aria-label="Private question pages"><Button variant="secondary" disabled={busy || questionOffset === 0} onClick={() => setQuestionOffset(value => Math.max(0, value - 20))}>Previous questions</Button><Button variant="secondary" disabled={busy || questionOffset + questions.length >= questionTotal} onClick={() => setQuestionOffset(value => value + 20)}>Next questions</Button></nav>}</div>}
    {selected && <article className="admin-thread"><h3 ref={threadHeading} tabIndex={-1}>{selected.data.title}</h3><p className="preserve-lines">{selected.data.body}</p>{(selected.data.responses ?? []).map((response, index) => <div className="admin-reply" key={index}>{response.display_name && <strong>{response.display_name}</strong>}<p className="preserve-lines">{response.body}</p></div>)}
      {selected.data.status !== 'closed' && canReview && <form className="stack" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { setSelected(await api.post<PrivateQuestion>(`/adviser/questions/${selected.id}/reply`, { expected_revision: selected.revision, body: replyDraft.value })); await replyDraft.clear(); await reload(); } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); } }}><Field label="Private reply"><textarea value={replyDraft.value} onChange={event => replyDraft.setValue(event.target.value)} required maxLength={8000}/></Field><div><Button type="submit" loading={busy} disabled={!replyDraft.ready}>Send private reply</Button>{replyDraft.error && <Notice kind="warning">{replyDraft.error}</Notice>}{replyDraft.saving && <p role="status" className="muted">Keeping your unsent reply in a private draft…</p>}</div></form>}
      {selected.data.status !== 'closed' && (session?.workspace.role === 'owner' || selected.data.asked_by === session?.user.id) && <Button variant="secondary" loading={busy} onClick={async () => { setBusy(true); setError(''); try { setSelected(await api.post<PrivateQuestion>(`/adviser/questions/${selected.id}/close`, { expected_revision: selected.revision })); await reload(); } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); } }}>Mark question as resolved</Button>}
    </article>}
  </section>;
}

export function CommunityComposePage() {
  const navigate = useNavigate();
  const draft = usePrivateDraft('community/public-question', { title: '', body: '', category: 'general', country: '' });
  const [preview, setPreview] = useState(false);
  const [publish, setPublish] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const retryKey = useRef(crypto.randomUUID());
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (preview) heading.current?.focus(); }, [preview]);
  function edit() { setPreview(false); setPublish(false); }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!preview) { setPreview(true); return; }
    if (!publish || !draft.ready || busy) return;
    setBusy(true); setError('');
    try {
      const result = await api.post<PublicPost>('/community', { ...draft.value, country: draft.value.country || null, publish: true }, { idempotencyKey: retryKey.current });
      await draft.clear();
      navigate(postPath(result), { replace: true, state: { communityMessage: 'Your post is shared with the community.' } });
    } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  return <CommunityLayout title="Write a post" description="Ask a question or share something that helped on your farm.">
    <Link className="community-back" to="/app/community">Back to community</Link>
    {error && <Notice kind="error">{error}</Notice>}{draft.error && <Notice kind="warning">{draft.error}</Notice>}
    {!draft.ready ? <Loading>Opening your saved draft…</Loading> : <form className="panel stack community-composer" onSubmit={submit}>
      {!preview ? <>
        <p className="community-visibility">Your draft stays private until you publish it.</p>
        <Field label="Your question in a few words"><input required maxLength={180} value={draft.value.title} onChange={event => { retryKey.current = crypto.randomUUID(); draft.setValue(previous => ({ ...previous, title: event.target.value })); }}/></Field>
        <Field label="What would you like to ask?"><textarea required rows={7} maxLength={8000} value={draft.value.body} onChange={event => { retryKey.current = crypto.randomUUID(); draft.setValue(previous => ({ ...previous, body: event.target.value })); }}/></Field>
        <div className="form-grid"><Field label="Topic"><select value={draft.value.category} onChange={event => { retryKey.current = crypto.randomUUID(); draft.setValue(previous => ({ ...previous, category: event.target.value })); }}>{categories.map(value => <option key={value} value={value}>{topicName(value)}</option>)}</select></Field><Field label="Country, if relevant"><select value={draft.value.country} onChange={event => { retryKey.current = crypto.randomUUID(); draft.setValue(previous => ({ ...previous, country: event.target.value })); }}><option value="">Across the EU</option>{countries.map(code => <option key={code} value={code}>{countryNames.of(code)}</option>)}</select></Field></div>
        <p className="community-visibility">Keep names, private farm details and document contents out of your post.</p>
        <div className="actions"><Button type="submit">Preview my post</Button><Link to="/app/community">Finish later</Link></div>
      </> : <>
        <h2 ref={heading} tabIndex={-1}>Check your post</h2><p>Other signed-in members will be able to read and reply.</p>
        <article className="community-preview"><div className="community-post-meta"><span className="community-topic">{topicName(draft.value.category)}</span><span>{draft.value.country ? countryNames.of(draft.value.country) : 'Across the EU'}</span></div><h3>{draft.value.title}</h3><p className="preserve-lines">{draft.value.body}</p></article>
        <label className="check-row"><input type="checkbox" required checked={publish} onChange={event => setPublish(event.target.checked)} disabled={busy}/>I have checked the text and want this question published publicly.</label>
        <div className="actions"><Button type="submit" loading={busy} disabled={!publish}>Publish my question</Button><Button variant="secondary" disabled={busy} onClick={edit}>Keep editing</Button></div>
      </>}
      {draft.saving && <p role="status" className="muted">Saving your private draft…</p>}
    </form>}
  </CommunityLayout>;
}

export function CommunityThreadPage() {
  const { questionId = '' } = useParams();
  return <CommunityThread key={questionId} questionId={questionId}/>;
}

function CommunityThread({ questionId }: { questionId: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [thread, setThread] = useState<Thread | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [retry, setRetry] = useState(0);
  const [publishReply, setPublishReply] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [reportReason, setReportReason] = useState('');
  const draft = usePrivateDraft(`community/public-reply/${questionId}`, '');
  const replyKey = useRef(crypto.randomUUID());
  useEffect(() => {
    let active = true; setError(''); setLoading(true);
    api.get<Thread>(`/community/${encodeURIComponent(questionId)}`).then(value => { if (active) setThread(value); }).catch(failure => { if (active) setError(errorMessage(failure)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [questionId, retry]);
  async function withdraw(id: string) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await api.post(`/community/${id}/withdraw`);
      if (id === questionId) navigate('/app/community', { replace: true, state: { communityMessage: 'Your public text has been withdrawn.' } });
      else { setThread(await api.get<Thread>(`/community/${questionId}`)); setSuccess('Your reply has been withdrawn.'); }
    } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  async function reply(event: FormEvent) {
    event.preventDefault(); if (!publishReply || !draft.ready || busy) return;
    setBusy(true); setError(''); setSuccess('');
    try {
      await api.post(`/community/${questionId}/replies`, { body: draft.value, publish: true }, { idempotencyKey: replyKey.current });
      await draft.clear(); setPublishReply(false); replyKey.current = crypto.randomUUID();
      setThread(await api.get<Thread>(`/community/${questionId}`)); setSuccess('Your reply is now shared.');
    } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  return <CommunityLayout title="Community conversation" description="Share your experience. Check important decisions with an adviser or official source.">
    <Link className="community-back" to="/app/community">Back to community</Link>
    {location.state?.communityMessage && <Notice kind="success">{String(location.state.communityMessage)}</Notice>}
    {error && <Notice kind="error">{error}{!thread && <Button variant="ghost" onClick={() => setRetry(value => value + 1)}>Try again</Button>}</Notice>}{success && <Notice kind="success">{success}</Notice>}
    {loading ? <Loading>Opening this conversation…</Loading> : thread && <>
      <article className="panel community-post community-full-post"><PostMeta post={thread.question}/><h2>{thread.question.data.title}</h2><p className="preserve-lines">{thread.question.data.body}</p><div className="community-post-actions">{thread.question.is_author && <Button variant="ghost" loading={busy} onClick={() => void withdraw(thread.question.id)}>Withdraw my question</Button>}<Button variant="ghost" aria-expanded={showReport} aria-controls="community-report-form" onClick={() => setShowReport(value => !value)}>Report a problem</Button></div></article>
      {showReport && <form id="community-report-form" className="panel stack community-report" onSubmit={async event => { event.preventDefault(); if (busy) return; setBusy(true); setError(''); try { await api.post(`/community/${thread.question.id}/report`, { reason: reportReason }); setReportReason(''); setShowReport(false); setSuccess('Your report was sent privately to a moderator.'); } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); } }}><h2>Report this post</h2><Field label="What should a moderator check?"><textarea required rows={3} maxLength={2000} value={reportReason} onChange={event => setReportReason(event.target.value)}/></Field><p className="community-visibility">Your reason is only shared with moderators.</p><div className="actions"><Button type="submit" loading={busy}>Send report</Button><Button variant="secondary" disabled={busy} onClick={() => setShowReport(false)}>Cancel</Button></div></form>}
      <section className="community-replies" aria-labelledby="community-replies-heading"><h2 id="community-replies-heading">Replies <span className="muted">({thread.replies.length})</span></h2>{!thread.replies.length && <p>No replies yet. You can start the conversation.</p>}{thread.replies.map(post => <article className="panel community-post community-reply" key={post.id}><div className="community-post-meta"><time dateTime={post.created_at}>{dateLabel(post.created_at)}</time>{post.is_author && <span className="community-owned">Your reply</span>}</div><p className="preserve-lines">{post.data.body}</p>{post.is_author && <Button variant="ghost" loading={busy} onClick={() => void withdraw(post.id)}>Withdraw my reply</Button>}</article>)}</section>
      <form className="panel stack community-composer" onSubmit={reply}><h2>Add a reply</h2>{draft.error && <Notice kind="warning">{draft.error}</Notice>}<Field label="Share a practical reply"><textarea required rows={4} maxLength={8000} disabled={!draft.ready || busy} value={draft.value} onChange={event => { replyKey.current = crypto.randomUUID(); draft.setValue(event.target.value); }}/></Field><label className="check-row"><input type="checkbox" required checked={publishReply} disabled={busy} onChange={event => setPublishReply(event.target.checked)}/>I want this reply published in the public community.</label><div><Button type="submit" disabled={!publishReply || !draft.ready} loading={busy}>Publish reply</Button></div>{draft.saving && <p role="status" className="muted">Saving your private reply draft…</p>}</form>
    </>}
  </CommunityLayout>;
}
