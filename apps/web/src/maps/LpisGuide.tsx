import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import { useSession } from '../auth';
import { Button, Field, Notice } from '../components';
import type { RecordItem } from '../types';

type GuideProfile = {
  id: string; country: string; title: string; applies_to: string; official_url: string | null;
  campaign_year: number | null; steps: { title: string; text: string }[];
  authority_import_formats: string[]; app_export_formats: string[]; import_acceptance_verified: boolean;
  limits: string[]; sources: { title: string; url: string; edition: string }[];
};
type Guide = {
  farm_id: string; farm_revision: number; country: string | null; region: string | null;
  reporting_year: number | null; coverage: 'documented_steps' | 'general_guidance_only';
  profiles: GuideProfile[]; official_url: string | null; checked_date: string; notice: string;
  definition_hash: string;
};

function safeOfficialUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function OfficialLink({ href, children }: { href: string | null; children: string }) {
  const url = safeOfficialUrl(href);
  return url ? <a href={url} target="_blank" rel="noopener noreferrer">{children} (opens a new tab)</a> : <span>{children} — official link unavailable</span>;
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
}

function validateGuide(data: Guide, farm: RecordItem): Guide {
  if (!data || data.farm_id !== farm.id || data.farm_revision !== farm.revision
    || data.country !== (farm.data.country ?? null) || data.region !== (farm.data.region ?? null)
    || data.reporting_year !== (farm.data.reporting_year ?? null)) {
    throw new Error('These instructions do not match this saved farm. Reload the farm and open the guide again.');
  }
  if (!['documented_steps', 'general_guidance_only'].includes(data.coverage)
    || !Array.isArray(data.profiles) || typeof data.notice !== 'string' || typeof data.checked_date !== 'string'
    || !/^[a-f0-9]{64}$/i.test(data.definition_hash)
    || (data.coverage === 'documented_steps') !== (data.profiles.length > 0)
    || data.profiles.some((profile: GuideProfile) => !profile || typeof profile.id !== 'string' || profile.country !== data.country
      || typeof profile.title !== 'string' || typeof profile.applies_to !== 'string'
      || !(profile.campaign_year === null || Number.isInteger(profile.campaign_year))
      || !Array.isArray(profile.steps) || !profile.steps.length
      || profile.steps.some((step: GuideProfile['steps'][number]) => !step || typeof step.title !== 'string' || typeof step.text !== 'string')
      || !strings(profile.authority_import_formats) || !strings(profile.app_export_formats)
      || profile.import_acceptance_verified !== false || !strings(profile.limits)
      || !Array.isArray(profile.sources) || !profile.sources.length
      || profile.sources.some((source: GuideProfile['sources'][number]) => !source || typeof source.title !== 'string' || typeof source.url !== 'string' || typeof source.edition !== 'string'))) {
    throw new Error('The official-register guide could not be read completely. Please try again; no instructions have been assumed.');
  }
  return data;
}

const countryNames: Record<string, string> = { CZ: 'Czechia', NL: 'Netherlands', SK: 'Slovakia' };
const privateFormats: Record<string, string> = { geojson: 'GeoJSON', kml: 'KML', correction: 'Change summary (JSON)' };

function FarmGuide({ farm }: { farm: RecordItem }) {
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [guide, setGuide] = useState<Guide | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [task, setTask] = useState('');
  const selected = guide?.profiles.find(profile => profile.id === task);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let active = true;
    setGuide(null);
    setError(null);
    setTask('');
    api.downloadResponse(`/farms/${encodeURIComponent(farm.id)}/lpis-guide`, { signal: controller.signal })
      .then(response => response.json() as Promise<Guide>)
      .then(data => { const checked = validateGuide(data, farm); if (active) setGuide(checked); })
      .catch(reason => { if (active && !controller.signal.aborted) setError(errorMessage(reason)); });
    return () => { active = false; controller.abort(); };
  }, [open, attempt, farm.id, farm.revision, farm.data.country, farm.data.region, farm.data.reporting_year]);

  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>How do I update the official field register?</summary>
    {open && <>
      <p>Check the exact task before leaving Funkyfarm. This guide does not change an official register, send an application or establish a deadline.</p>
      {error ? <Notice kind="error">{error}<div className="actions"><Button variant="secondary" onClick={() => setAttempt(value => value + 1)}>Try opening the guide again</Button></div></Notice>
        : !guide ? <p role="status">Opening the instructions for this farm…</p>
        : <>
          <p><strong>Country:</strong> {guide.country ? `${countryNames[guide.country] ?? guide.country} (${guide.country})` : 'Not recorded'}{guide.region ? ` · Region: ${guide.region}` : ''}<br /><strong>Farm reporting year:</strong> {guide.reporting_year ?? 'Not recorded'}</p>
          <p>A file’s source year, the farm reporting year and an official campaign year are separate. Check each one in the source and official service; none is chosen automatically here.</p>
          <Notice>{guide.notice}</Notice>
          {guide.coverage === 'general_guidance_only' ? <section aria-label="Official starting point">
            <h3>Detailed steps are not yet known for this country</h3>
            <p>Only a general official starting page is known. The exact LPIS task, drawing steps and accepted import formats have not been established. Ask the authority or your adviser which process applies before uploading a file.</p>
            {guide.official_url ? <p><OfficialLink href={guide.official_url}>Open the official starting page</OfficialLink></p> : <p>An official starting link is not available for this farm’s recorded country.</p>}
          </section> : <>
            <Field label="What do you need to do?" hint="Choose only the task described by the official source. These instructions do not cover every map change or aid application.">
              <select value={task} onChange={event => setTask(event.target.value)}>
                <option value="">Choose a task</option>
                {guide.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.title}</option>)}
              </select>
            </Field>
            {!selected ? <p>Choose a task to see its steps and limits.</p> : <section aria-label={selected.title}>
              <h3>{selected.title}</h3>
              <p>{selected.applies_to}</p>
              <p><strong>Campaign named by the source:</strong> {selected.campaign_year ?? 'No specific campaign year stated'}{selected.campaign_year !== null && selected.campaign_year !== guide.reporting_year ? ' — different from this farm’s reporting year; check the current official process.' : ''}</p>
              <p><OfficialLink href={selected.official_url}>Open the official instructions for this task</OfficialLink></p>
              <ol>{selected.steps.map((step, index) => <li key={`${selected.id}-${index}`}><strong>{step.title}</strong><p>{step.text}</p></li>)}</ol>
              <h4>Files from this app</h4>
              {selected.app_export_formats.length ? <p>Private exports: {selected.app_export_formats.map(format => privateFormats[format] ?? format).join(', ')}. These are working copies, not official submissions.</p> : <p>No private export formats are listed in this guide.</p>}
              <h4>Formats named by the official source</h4>
              {selected.authority_import_formats.length ? <ul>{selected.authority_import_formats.map(format => <li key={format}>{format}</li>)}</ul> : <p>Accepted import formats are not established for this task.</p>}
              <p>This app has not verified a live import or acceptance. A format name alone does not mean a particular file is accepted or that anything has been sent.</p>
              <h4>What still needs checking</h4>
              <ul>{selected.limits.map((limit, index) => <li key={`${selected.id}-limit-${index}`}>{limit}</li>)}</ul>
              <h4>Sources and editions</h4>
              <ul>{selected.sources.map((source, index) => <li key={`${selected.id}-source-${index}`}><OfficialLink href={source.url}>{source.title}</OfficialLink><p>{source.edition}</p></li>)}</ul>
            </section>}
          </>}
          <p className="muted">Guide inventory checked {guide.checked_date}. Check the official current instructions before acting. Keep any actual sending confirmation or reply separately.</p>
          <Button variant="secondary" onClick={() => setAttempt(value => value + 1)}>Refresh these instructions</Button>
        </>}
    </>}
  </details>;
}

export function LpisGuide({ farm }: { farm: RecordItem }) {
  const { session, loading } = useSession();
  if (loading || !session) return null;
  if (farm.workspace_id !== session.workspace.id || (Array.isArray(session.workspace.farm_ids) && !session.workspace.farm_ids.includes(farm.id))) return null;
  const binding = JSON.stringify([session.user.id, session.workspace.id, session.workspace.role,
    session.workspace.permissions, session.workspace.farm_ids, farm.id, farm.revision,
    farm.data.country, farm.data.region, farm.data.reporting_year]);
  return <FarmGuide key={binding} farm={farm} />;
}
