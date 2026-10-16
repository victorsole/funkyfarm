import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { Button, Field, Loading, Notice, PageHeader } from '../components';
import { useRecords } from '../hooks';
import { useI18n } from '../i18n';
import { usePrivateDraft } from '../offline';
import './administration.css';

type ChatStatus = { enabled: boolean; available: boolean; status: string; model: string | null; privacy_notice: string; limits: { message_max_chars: number; history_max_messages: number; history_message_max_chars: number } };
type Citation = { id: string; title: string; url?: string; kind: 'official' | 'workspace'; quote?: string; record_id?: string; revision?: number };
type Answer = { answer: string; citations: Citation[]; context_notice: string; model: string; status: 'answered' | 'unknown'; language: string };
type Exchange = { question: string; result: Answer };

function safeSource(url?: string) {
  if (!url) return null;
  try { const parsed = new URL(url); return ['https:', 'http:'].includes(parsed.protocol) ? parsed.href : null; }
  catch { return null; }
}

export function HelpPage() {
  const { language, languages } = useI18n();
  const farms = useRecords('farms');
  const draft = usePrivateDraft('help/question', { farm_id: '', message: '', include_farm_context: false });
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  async function loadStatus() {
    setStatusLoading(true); setError('');
    try { setStatus(await api.get<ChatStatus>('/assistant/chat/status')); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setStatusLoading(false); }
  }
  useEffect(() => {
    let active = true;
    api.get<ChatStatus>('/assistant/chat/status').then(value => { if (active) setStatus(value); }).catch(failure => { if (active) setError(errorMessage(failure)); }).finally(() => { if (active) setStatusLoading(false); });
    return () => { active = false; };
  }, []);
  async function ask(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const history = exchanges.flatMap(exchange => [{ role: 'user', content: exchange.question }, { role: 'assistant', content: exchange.result.answer }]).slice(-(status?.limits.history_max_messages ?? 4)).map(message => ({ ...message, content: message.content.slice(0, status?.limits.history_message_max_chars ?? 800) }));
      const result = await api.post<Answer>('/assistant/chat', { farm_id: draft.value.farm_id, message: draft.value.message.trim(), language, include_farm_context: draft.value.include_farm_context, history });
      setExchanges(previous => [...previous, { question: draft.value.message, result }]);
      draft.setValue(previous => ({ ...previous, message: '' }));
    } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  return <>
    <PageHeader title="A hand with the paperwork" description="Choose a person or assistant to help, then stay in control of your farm records." />
    <section className="panel admin-section admin-help-first"><p className="eyebrow">Start with the assistant you already use</p><h2>Bring your own Claude or ChatGPT</h2><p>Connect your own assistant to the farms you choose. It can look up permitted records and prepare suggestions. You review changes here before they become farm records.</p><div className="admin-choice-row"><div className="admin-choice"><strong>Claude</strong><span>Add the farm connector in a supported Claude account.</span></div><div className="admin-choice"><strong>ChatGPT</strong><span>Add the farm connector in a supported ChatGPT account.</span></div></div><Link className="button button-primary" to="/app/assistant/connect">Choose an assistant and its farm access</Link><p className="admin-footnote">Availability depends on your assistant account and service. FunkyFarm does not include a Claude or ChatGPT subscription. Information a connected assistant reads goes to that service under the permissions you approve.</p></section>
    <section className="panel admin-section"><h2>Prefer a person?</h2><p>Your adviser can help interpret a letter, compare evidence, or check an answer before you use it.</p><div className="actions"><Link className="button button-secondary" to="/app/community">Ask my adviser or the community</Link><Link to="/app/adviser">Manage adviser access</Link></div></section>
    <section className="panel admin-section"><h2>Find the next small step</h2><ul className="admin-task-list"><li><Link to="/app/record-work">Record work, a purchase or a sale</Link><span>Start with what happened on the farm.</span></li><li><Link to="/app/documents?purpose=letter">Understand a letter or add a document</Link><span>Keep the original and check extracted details.</span></li><li><Link to="/app/checks">See what needs checking</Link><span>Look at missing information, sources and next steps.</span></li><li><Link to="/app/guidance">Open the source handbook</Link><span>Read the original guidance for a reporting pack.</span></li></ul></section>
    <section className="panel admin-section"><h2>Ask inside FunkyFarm</h2><p>This is an alternative when you prefer to stay here. It uses the app owner’s hosted model when one is available. It does not connect to your Claude or ChatGPT subscription.</p>
      {statusLoading ? <Loading>Checking whether in-app help is available…</Loading> : status && <><p className="admin-footnote">{status.privacy_notice}</p>{!status.available && <Notice kind="warning">In-app chat is currently {status.status.replaceAll('_', ' ')}. You can connect your own assistant or ask your adviser above.<div><Button variant="ghost" onClick={() => void loadStatus()}>Check availability again</Button></div></Notice>}</>}
      {error && <Notice kind="error">{error}{!status && <div><Button variant="ghost" onClick={() => void loadStatus()}>Check help availability again</Button></div>}</Notice>}{farms.error && <Notice kind="error">{farms.error}</Notice>}{draft.error && <Notice kind="warning">{draft.error}</Notice>}
      {status?.available && (!draft.ready || farms.loading ? <Loading>Opening your private question draft…</Loading> : <form className="stack" onSubmit={ask}>
        <Field label="Which farm is the question about?"><select required value={draft.value.farm_id} onChange={event => { draft.setValue(previous => ({ ...previous, farm_id: event.target.value, include_farm_context: false })); setExchanges([]); }}><option value="">Choose a farm</option>{farms.items.map(farm => <option key={farm.id} value={farm.id}>{farm.data.name}</option>)}</select></Field>
        {!farms.items.length && <p><Link to="/app/fields">Add your farm first</Link> so the app can choose relevant guidance.</p>}
        <Field label="What would you like help with?" hint={`Up to ${status.limits.message_max_chars} characters. Replies use your language selection: ${languages.find(item => item.code === language)?.name ?? language}.`}><textarea required maxLength={status.limits.message_max_chars} value={draft.value.message} onChange={event => draft.setValue(previous => ({ ...previous, message: event.target.value }))} placeholder="For example: what should I check before answering an inspection letter?"/></Field>
        <label className="check-row"><input type="checkbox" checked={draft.value.include_farm_context} onChange={event => draft.setValue(previous => ({ ...previous, include_farm_context: event.target.checked }))}/>Include permitted farm records in this question. Leave this off for general guidance.</label>
        <p className="admin-footnote">Your question goes to the app’s server. This chat does not save a conversation history or make changes to farm records. Check important answers against the cited source or with your adviser.</p>
        <div className="actions"><Button type="submit" loading={busy} disabled={!draft.value.farm_id}>Ask for help</Button>{exchanges.length > 0 && <Button variant="secondary" disabled={busy} onClick={() => setExchanges([])}>Clear this conversation</Button>}</div>
        {draft.saving && <p role="status" className="muted">Keeping the unsent question in a private draft…</p>}
      </form>)}
      <div className="admin-conversation" aria-live="polite" aria-busy={busy}>{exchanges.map((exchange, index) => <article className="admin-exchange" key={index}><h3>Your question</h3><p className="preserve-lines">{exchange.question}</p><h3>Help from the hosted model</h3>{exchange.result.status === 'unknown' && <Notice kind="warning">This question needs more evidence or an adviser’s judgement.</Notice>}<p className="preserve-lines">{exchange.result.answer}</p><p className="admin-footnote">{exchange.result.context_notice}</p>{exchange.result.citations.length > 0 && <><h4>Sources to check</h4><ul>{exchange.result.citations.map(source => <li key={source.id}>{safeSource(source.url) ? <a href={safeSource(source.url)!} target="_blank" rel="noreferrer">{source.title}</a> : <span>{source.title}</span>}{source.revision && <span> · revision {source.revision}</span>}{source.quote && <blockquote>{source.quote}</blockquote>}</li>)}</ul></>}</article>)}</div>
    </section>
  </>;
}
