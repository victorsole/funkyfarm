import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError, errorMessage } from '../api';
import { Button, Field, Notice, PageHeader } from '../components';
import { useRecords } from '../hooks';
import { useSession } from '../auth';
import type { Pack, Page, RecordItem } from '../types';
import { countries, useReviewAccess } from './Core';
import { SsoButtons, ssoReturnMessage, startSso, useSsoProviders, type SsoProvider } from '../sso';

const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });
const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });
const languages = ['bg','hr','cs','da','nl','en','et','fi','fr','de','el','hu','ga','it','lv','lt','mt','pl','pt','ro','sk','sl','es','sv'];
const text = (v: unknown) => typeof v === 'string' ? v : JSON.stringify(v);
function ErrorNotice({ error }: { error: unknown }) { return error ? <Notice kind="error">{errorMessage(error)}{error instanceof ApiError && error.status === 409 && <p>Your entries are still here. Reload the latest record and compare before trying again.</p>}</Notice> : null; }
function FarmSelect({ farms, value, onChange, optional = false }: { farms: RecordItem[]; value?: string; onChange?: (id: string) => void; optional?: boolean }) {
  return <select name="farm_id" value={value} onChange={onChange ? e => onChange(e.target.value) : undefined} required={!optional} defaultValue={value === undefined ? '' : undefined}><option value="">{optional ? 'Choose later' : 'Choose a farm'}</option>{farms.map(f => <option key={f.id} value={f.id}>{f.data.name}</option>)}</select>;
}


export function GuidancePage() {
  const canReview = useReviewAccess();
  const farms = useRecords('farms'); const notifications = useRecords('guidance/notifications');
  const [checklistVersion,setChecklistVersion] = useState(0); const [country,setCountry] = useState(''); const [year,setYear] = useState(String(new Date().getFullYear())); const [packs,setPacks] = useState<Pack[]>([]); const [selected,setSelected] = useState<Pack | null>(null); const [guidance,setGuidance] = useState<any>(null); const [error,setError] = useState<unknown>(null); const [busy,setBusy] = useState(false); const [message,setMessage] = useState('');
  useEffect(() => {let active=true; setError(null); setSelected(null); setGuidance(null); api.get<Page<Pack>>(`/packs?${country ? `country=${country}&` : ''}year=${encodeURIComponent(year)}`).then(p => {if(active) setPacks(p.items);}).catch(e=> {if(active) setError(e);}); return()=>{active=false;};},[country,year]);
  async function choose(pack: Pack) {setSelected(pack); setGuidance(null); setError(null); try {setGuidance(await api.get(`/guidance?pack_id=${encodeURIComponent(pack.id)}`));} catch(e) {setError(e);} }
  return <><PageHeader title="Find the right guidance" description="Read the source, check the edition and see what each reporting pack can prepare."/><ErrorNotice error={error}/>{message && <Notice kind="success">{message}</Notice>}<section className="card"><div className="form-grid"><Field label="Country"><select value={country} onChange={e=>setCountry(e.target.value)}><option value="">All EU countries</option>{countries.map(c=><option key={c} value={c}>{countryNames.of(c)}</option>)}</select></Field><Field label="Reporting year"><input type="number" min="1900" max="2200" value={year} onChange={e=>setYear(e.target.value)}/></Field></div>{!packs.length && <p>No packs found for these choices. A missing format is not replaced with a different country's form.</p>}<ul className="record-list">{packs.map(p=><li key={p.id}><Button variant="ghost" onClick={()=>void choose(p)}>{p.name || p.title || p.id} · {countryNames.of(p.country)}</Button></li>)}</ul></section>{selected && <section className="card"><h2>{selected.title || selected.name || selected.id}</h2><p>{selected.description}</p>{!guidance ? <Notice>Opening source guidance…</Notice> : <><Notice>{guidance.message}</Notice><p>Edition {guidance.version}{guidance.effective_date ? ` · effective ${guidance.effective_date}` : ''}</p><p>Available preparation: {String(guidance.capability).replaceAll('_',' ')}</p><h3>What this pack can and cannot do</h3><ul>{(Array.isArray(guidance.limits) ? guidance.limits : [guidance.limits]).map((l: any,i: number)=><li key={i}>{text(l)}</li>)}</ul><h3>Official sources</h3><ul>{guidance.sources.map((s: any,i: number)=><li key={i}><a href={s.url} target="_blank" rel="noreferrer">{s.title || s.url}</a>{s.edition ? ` · ${s.edition}` : ''}</li>)}</ul><details><summary>Required answers and checks</summary><ul>{guidance.fields.map((f: any,i: number)=><li key={i}>{f.label || f.fact_key || f.field}{f.required ? ' · required' : ''}{f.description ? ` — ${f.description}` : ''}</li>)}</ul><pre>{JSON.stringify(guidance.checks,null,2)}</pre></details>{canReview && <form className="stack" onSubmit={async e=>{e.preventDefault(); const f=new FormData(e.currentTarget); setBusy(true); setError(null); setMessage(''); try {await api.post('/checklists/from-pack',{farm_id:f.get('farm_id'),pack_id:selected.id,...(f.get('deadline') ? {deadline:f.get('deadline')} : {})}); setChecklistVersion(v => v + 1); setMessage('Checklist created. Review the evidence checklist below.');} catch(e){setError(e);} finally{setBusy(false);}}}><h3>Prepare an evidence checklist</h3><Field label="Farm"><FarmSelect farms={farms.items}/></Field><Field label="Deadline (optional)"><input name="deadline" type="date"/></Field><div><Button type="submit" loading={busy}>Create checklist for this farm</Button></div></form>}</>}</section>}<FarmChecklists key={checklistVersion}/><section className="card"><h2>Changes that need your attention</h2>{notifications.error && <Notice kind="error">{notifications.error}</Notice>}{!notifications.items.length && <p className="muted">No reviewed changes recorded for your workspace.</p>}{notifications.items.map(n=><article className="panel" key={n.id}><h3>{n.data.title || 'Reviewed source change'}</h3><p>{n.data.explanation || n.data.message}</p><p>{n.data.required_action}</p><p>Effective {n.data.effective_date || 'date not supplied'}</p></article>)}</section></>;
}

function FarmChecklists() {
  const canReview = useReviewAccess();
  const checklists = useRecords('checklists');
  const facts = useRecords('facts');
  const [error,setError] = useState<unknown>(null);
  const [busy,setBusy] = useState(false);
  return <section className="card"><h2>Your evidence checklists</h2><ErrorNotice error={error}/>{checklists.error && <Notice kind="error">{checklists.error}</Notice>}{facts.error && <Notice kind="error">{facts.error}</Notice>}{!checklists.items.length && <p className="muted">Choose a pack above to prepare a checklist.</p>}{checklists.items.map(c => <details key={`${c.id}-${c.revision}`}><summary>{c.data.title} · {c.data.status === 'complete' ? 'Evidence reviewed' : 'Needs review'}</summary><p>{c.data.meaning}</p>{(c.data.items || []).map((item: any) => <article className="panel" key={item.key}><h3>{item.label}</h3>{item.status === 'complete' ? <p>Evidence reviewed. {item.note}</p> : !canReview ? <p className="muted">Ask the farm owner for review permission to complete this checklist.</p> : <form className="stack" onSubmit={async e => {e.preventDefault(); const f = new FormData(e.currentTarget); setBusy(true); setError(null); try {await api.post(`/checklists/${c.id}/items/${encodeURIComponent(item.key)}/complete`,{expected_revision:c.revision,evidence_fact_ids:f.getAll('fact_ids'),note:f.get('note')}); await checklists.reload();} catch(e) {setError(e);} finally {setBusy(false);} }}><fieldset><legend>Which confirmed evidence supports this answer?</legend>{facts.items.filter(f=>f.data.farm_id === c.data.farm_id && f.data.key === item.key && f.data.review_status === 'confirmed').map(f=><label className="field" key={f.id}><span><input type="checkbox" name="fact_ids" value={f.id}/> {text(f.data.value)} {f.data.unit || ''} · {f.data.period || 'Standing detail'}</span></label>)}</fieldset><p><Link to={`/app/farm/${c.data.farm_id}#facts`}>Add or review supporting facts</Link></p><Field label="What did you check? Explain any disagreement between sources."><textarea name="note" required/></Field><div><Button type="submit" loading={busy}>Confirm evidence for this item</Button></div></form>}</article>)}</details>)}</section>;
}

export function SettingsPage() {
  const {session,logout} = useSession(); const [settings,setSettings] = useState<RecordItem | null>(null); const [error,setError] = useState<unknown>(null); const [busy,setBusy] = useState(false); const [saved,setSaved] = useState(false);
  async function load(){setError(null);try{setSettings(await api.get('/account'));}catch(e){setError(e);}}
  useEffect(()=>{void load();},[]);
  return <><PageHeader title="Make yourself at home" description="Language and defaults belong to your account. Choosing a language never changes a farm's country."/><ErrorNotice error={error}/>{saved && <Notice kind="success">Your preferences are saved.</Notice>}{settings ? <section className="card"><form key={settings.revision} className="stack" onSubmit={async e=>{e.preventDefault();const f=new FormData(e.currentTarget);setBusy(true);setError(null);setSaved(false);try{setSettings(await api.patch('/account',{expected_revision:settings.revision,data:{language:f.get('language'),country:f.get('country')||null,region:f.get('region')||null,reporting_year:Number(f.get('reporting_year')),notifications:f.get('notifications')==='on'}}));setSaved(true);}catch(e){setError(e);}finally{setBusy(false);}}}><div className="form-grid"><Field label="Preferred language"><select name="language" defaultValue={settings.data.language || 'en'}>{languages.map(l=><option value={l} key={l}>{languageNames.of(l)}{l==='en'?'':' — draft interface labels'}</option>)}</select></Field><Field label="Default country"><select name="country" defaultValue={settings.data.country||''}><option value="">Choose when adding a farm</option>{countries.map(c=><option key={c} value={c}>{countryNames.of(c)}</option>)}</select></Field><Field label="Default region"><input name="region" defaultValue={settings.data.region||''}/></Field><Field label="Default reporting year"><input name="reporting_year" type="number" min="1900" max="2200" defaultValue={settings.data.reporting_year||new Date().getFullYear()} required/></Field></div><label><input name="notifications" type="checkbox" defaultChecked={settings.data.notifications===true}/> Show workspace notifications</label><p className="muted">Notifications are shown inside the workspace. Saving this preference does not enable email or device reminders.</p><div className="actions"><Button type="submit" loading={busy}>Save preferences</Button>{error instanceof ApiError && error.status===409 && <Button variant="secondary" onClick={()=>void load()}>Load latest preferences</Button>}</div></form></section>:!error&&<Notice>Opening preferences…</Notice>}<AccountSignInMethods/><section className="card"><h2>Your account</h2><p>{session?.user.display_name} · {session?.user.email}</p><p>{session?.workspace.name} · {session?.workspace.role}</p><Button variant="secondary" loading={busy} onClick={async()=>{setBusy(true);try{await logout();}catch(e){setError(e);}finally{setBusy(false);}}}>Sign out</Button></section></>;
}

type LinkedSso = { id: string; provider_id: string; provider_name: string; email?: string; can_unlink: boolean };
function AccountSignInMethods() {
  const sso = useSsoProviders();
  const { session } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const callbackMessage = ssoReturnMessage(location.search);
  const [accounts, setAccounts] = useState<LinkedSso[]>([]);
  const [passwordEnabled, setPasswordEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [providerBusy, setProviderBusy] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState<string | null>(null);
  const [remove, setRemove] = useState<LinkedSso | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  async function load() {
    setLoading(true); setError('');
    try {
      const result = await api.get<{ items: LinkedSso[]; password_enabled: boolean }>('/auth/sso/accounts');
      setAccounts(result.items); setPasswordEnabled(result.password_enabled);
    } catch (failure) { setError(errorMessage(failure)); } finally { setLoading(false); }
  }
  useEffect(() => {
    let active = true;
    api.get<{ items: LinkedSso[]; password_enabled: boolean }>('/auth/sso/accounts').then(result => { if (active) { setAccounts(result.items); setPasswordEnabled(result.password_enabled); } }).catch(failure => { if (active) setError(errorMessage(failure)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  async function link(provider: SsoProvider) {
    setProviderBusy(provider.id); setError(''); setMessage('');
    try { await startSso(provider, 'link', '/app/settings'); }
    catch (failure) { setError(errorMessage(failure)); setProviderBusy(null); }
  }
  async function unlink() {
    if (!remove || !confirmed) return;
    setUnlinking(remove.id); setError(''); setMessage('');
    try {
      const result = await api.post<{ unlinked: boolean; signed_out: boolean }>(`/auth/sso/accounts/${encodeURIComponent(remove.id)}/unlink`, {});
      if (result.unlinked && result.signed_out) {
        let outcome = 'unlinked';
        if (session) {
          try { const { purgeAccount } = await import('../offline'); await purgeAccount(`${session.user.id}/${session.workspace.id}`); }
          catch { outcome = 'unlinked_drafts_retained'; }
        }
        window.dispatchEvent(new Event('session-expired'));
        navigate(`/login?sso=${outcome}`, { replace: true });
        return;
      }
      setAccounts(previous => previous.filter(account => account.id !== remove.id));
      setRemove(null); setConfirmed(false);
      await load(); setMessage('The sign-in connection was removed. Your farm records and other sign-in methods have not been removed.');
    } catch (failure) { setError(errorMessage(failure)); } finally { setUnlinking(null); }
  }
  const available = sso.providers.filter(provider => !accounts.some(account => account.provider_id === provider.id));
  return <section className="card"><h2>How you sign in</h2><p>Link a provider to sign in to this same account. This does not grant an assistant access to your farm or change anyone’s farm permissions.</p>
    {callbackMessage && <Notice kind="warning">{callbackMessage}</Notice>}
    {error && <Notice kind="error">{error}<div><Button variant="ghost" onClick={() => void load()}>Reload sign-in methods</Button></div></Notice>}{message && <Notice kind="success">{message}</Notice>}
    {loading ? <p role="status" className="muted">Opening your sign-in methods…</p> : <>
      {passwordEnabled !== null && <p className="muted">Email and password sign-in: {passwordEnabled ? 'available' : 'not set up for this account'}.</p>}
      {accounts.length ? <ul className="record-list">{accounts.map(account => <li key={account.id}><div className="record-row"><div className="record-main"><strong>{account.provider_name}</strong>{account.email && <span className="muted">{account.email}</span>}<span className="muted">Linked to this account</span></div><Button variant="secondary" disabled={!account.can_unlink || providerBusy !== null || unlinking !== null} onClick={() => { setRemove(account); setConfirmed(false); }}>{`Unlink ${account.provider_name}`}</Button></div>{!account.can_unlink && <p className="muted text-small">Keep another working sign-in method before removing this connection.</p>}</li>)}</ul> : <p className="muted">No provider sign-in is linked to this account.</p>}
      {remove && <fieldset className="stack"><legend>{`Remove ${remove.provider_name} sign-in?`}</legend><p>Your farm records stay in your account. Removing this provider signs you out on all devices and removes this account’s unsaved encrypted form drafts from this device. Save any unfinished work to the farm workspace first. You will need another working sign-in method.</p><label className="check-row"><input type="checkbox" checked={confirmed} disabled={unlinking !== null} onChange={event => setConfirmed(event.target.checked)}/>I want to remove this provider as a way to sign in.</label><div className="actions"><Button variant="danger" disabled={!confirmed} loading={unlinking !== null} onClick={() => void unlink()}>{`Confirm unlink ${remove.provider_name}`}</Button><Button variant="secondary" disabled={unlinking !== null} onClick={() => { setRemove(null); setConfirmed(false); }}>Keep this connection</Button></div></fieldset>}
      {sso.loading && <p role="status" className="muted">Checking available providers…</p>}{sso.error && <Notice kind="warning">Other provider options could not be loaded. <button type="button" className="text-button" onClick={sso.retry}>Try provider options again</button></Notice>}
      {available.length > 0 && <div className="admin-subsection"><h3>Link another sign-in method</h3><p>You will continue on the provider’s own sign-in page. Choose the account you want to link.</p><SsoButtons providers={available} mode="link" disabled={unlinking !== null || remove !== null} busyProvider={providerBusy} onChoose={provider => void link(provider)}/>{providerBusy && <p role="status" className="muted">Opening the provider’s sign-in page…</p>}</div>}
      {!sso.loading && !sso.error && !sso.providers.length && <p className="muted">The site owner has not configured any provider sign-in options.</p>}
    </>}
  </section>;
}
