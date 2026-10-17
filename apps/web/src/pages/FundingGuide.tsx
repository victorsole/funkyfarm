import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import { useSession } from '../auth';
import { Button, Notice } from '../components';

type Programme = {
  id: string;
  title: string;
  description: string;
  relationship_to_cap: string;
  eligibility_status: string;
  applicant_summary: string;
  applicant_types: string[];
  applicant_limits: string;
  programme_models: { id: string; description: string }[];
  call_2026: { status: string; status_label: string; deadline: string; deadline_qualification: string };
  future_calls: { status: string; campaign: number; message: string };
  official_links: { url: string; title: string; purpose: string }[];
  sources: { id: string; url: string; title: string; edition: string; checked_date: string }[];
  limitations: string[];
};

type Guide = {
  farm: { id: string; name: string; country: string; country_name: string };
  version: string;
  checked_date: string;
  scope_notice: string;
  items: Programme[];
  personalised_eligibility: false;
  application_enabled: false;
};

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function checkedGuide(data: Guide, farmId: string): Guide {
  if (!data || data.farm?.id !== farmId || typeof data.farm.name !== 'string'
    || typeof data.farm.country !== 'string' || typeof data.farm.country_name !== 'string'
    || typeof data.version !== 'string' || typeof data.checked_date !== 'string'
    || typeof data.scope_notice !== 'string' || data.personalised_eligibility !== false || data.application_enabled !== false
    || !Array.isArray(data.items) || data.items.some(item => !item
      || typeof item.id !== 'string' || typeof item.title !== 'string' || typeof item.description !== 'string'
      || typeof item.relationship_to_cap !== 'string' || item.eligibility_status !== 'not_assessed'
      || typeof item.applicant_summary !== 'string' || !strings(item.applicant_types) || typeof item.applicant_limits !== 'string'
      || !Array.isArray(item.programme_models) || item.programme_models.some(model => !model || typeof model.id !== 'string' || typeof model.description !== 'string')
      || !item.call_2026 || typeof item.call_2026.status !== 'string' || typeof item.call_2026.status_label !== 'string'
      || typeof item.call_2026.deadline !== 'string' || typeof item.call_2026.deadline_qualification !== 'string'
      || !item.future_calls || typeof item.future_calls.status !== 'string' || !Number.isInteger(item.future_calls.campaign) || typeof item.future_calls.message !== 'string'
      || !Array.isArray(item.official_links) || item.official_links.some(link => !link || typeof link.url !== 'string' || typeof link.title !== 'string' || typeof link.purpose !== 'string')
      || !Array.isArray(item.sources) || !item.sources.length || item.sources.some(source => !source || typeof source.id !== 'string' || typeof source.url !== 'string'
        || typeof source.title !== 'string' || typeof source.edition !== 'string' || typeof source.checked_date !== 'string')
      || !strings(item.limitations))) {
    throw new Error('The funding guide could not be read completely for this farm. Please try again. No eligibility has been assumed.');
  }
  return data;
}

function OfficialLink({ url, title }: { url: string; title: string }) {
  let safe: string | null = null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' && parsed.hostname && !parsed.username && !parsed.password) safe = parsed.href;
  } catch { /* Keep the source title visible without opening an unsafe link. */ }
  return safe ? <a href={safe} target="_blank" rel="noopener noreferrer">{title} (opens a new tab)</a>
    : <span>{title} — link unavailable</span>;
}

function FarmFundingGuide({ farmId }: { farmId: string }) {
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [guide, setGuide] = useState<Guide | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let active = true;
    setGuide(null);
    setError(null);
    api.downloadResponse(`/farms/${encodeURIComponent(farmId)}/funding-guide`, { signal: controller.signal })
      .then(response => response.json() as Promise<Guide>)
      .then(data => { const checked = checkedGuide(data, farmId); if (active) setGuide(checked); })
      .catch(reason => { if (active && !controller.signal.aborted) setError(errorMessage(reason)); });
    return () => { active = false; controller.abort(); };
  }, [open, attempt, farmId]);

  return <details onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open); }}>
    <summary>Other funding programmes</summary>
    {open && <div className="stack">
      <p>Some funding is for organisations running joint projects, not for an individual farm payment. Check the official conditions before spending time on an application.</p>
      {error ? <Notice kind="error">{error}<div className="actions"><Button variant="secondary" onClick={() => setAttempt(value => value + 1)}>Try opening the funding guide again</Button></div></Notice>
        : !guide ? <p role="status">Opening the funding guide…</p>
        : <>
          <p><strong>{guide.farm.name || 'Selected farm'}</strong> · {guide.farm.country_name}<br />Sources checked {guide.checked_date}. This is saved guidance, not a live call check.</p>
          <Notice>{guide.scope_notice}</Notice>
          {!guide.items.length && <p>No other funding programmes are listed in this guide.</p>}
          {guide.items.map(item => <section key={item.id} className="card" aria-label={item.title}>
            <h3>{item.title}</h3>
            <p>{item.description}</p>
            <Notice kind="warning"><strong>{item.call_2026.status_label}</strong><p>{item.call_2026.deadline_qualification}</p><p>{item.future_calls.message}</p></Notice>
            <p>{item.relationship_to_cap}</p>
            <h4>Who can apply?</h4>
            <p>{item.applicant_summary}</p>
            <ul>{item.applicant_types.map((type, index) => <li key={index}>{type}</li>)}</ul>
            <p>{item.applicant_limits}</p>
            <p><strong>Your eligibility has not been checked.</strong> This guide does not apply for funding or send anything on your behalf.</p>
            <ul>{item.official_links.map((link, index) => <li key={index}><OfficialLink url={link.url} title={link.title} /><p className="muted">{link.purpose}</p></li>)}</ul>
            <details>
              <summary>Programme types, sources and limits</summary>
              <ul>{item.programme_models.map(model => <li key={model.id}><strong>{model.id}:</strong> {model.description}</li>)}</ul>
              <h4>What this guide does not establish</h4>
              <ul>{item.limitations.map((limit, index) => <li key={index}>{limit}</li>)}</ul>
              <h4>Official sources</h4>
              <ul>{item.sources.map(source => <li key={source.id}><OfficialLink url={source.url} title={source.title} /><p>{source.edition}<br />Checked {source.checked_date}.</p></li>)}</ul>
            </details>
          </section>)}
          <p className="muted">Guide version {guide.version}. The official call text and current authority guidance take precedence.</p>
          <div className="actions"><Button variant="secondary" onClick={() => setAttempt(value => value + 1)}>Reload saved funding guidance</Button></div>
        </>}
    </div>}
  </details>;
}

export function FundingGuide({ farmId }: { farmId: string }) {
  const { session, loading } = useSession();
  if (loading || !session || !farmId) return null;
  if (Array.isArray(session.workspace.farm_ids) && !session.workspace.farm_ids.includes(farmId)) return null;
  const binding = JSON.stringify([session.user.id, session.workspace.id, session.workspace.role,
    session.workspace.permissions, session.workspace.farm_ids, farmId]);
  return <FarmFundingGuide key={binding} farmId={farmId} />;
}
