// Who decides for a farm: the public bodies behind the example farms, each with the official source
// it was read on (checked 18 October 2026). Only verified bodies are listed; nothing is inferred.
import { useId, useState, type ReactNode } from 'react';
import { ExternalLink, Info, Landmark } from 'lucide-react';
import './authorities.css';

type Role = 'paying_agency' | 'managing_authority' | 'coordinating_body';
type Body = { role: Role; name: string; part?: string; does: string; href: string; source: string; sourceLabel: string };
type Region = { label: string; bodies: Body[]; advisers?: { label: string; href: string } };

const roleNames: Record<Role, string> = { paying_agency: 'Paying agency', managing_authority: 'Managing authority', coordinating_body: 'Coordinating body' };
const roleHelp: Record<Role, string> = {
  paying_agency: 'Checks your aid application, decides what is eligible and pays you.',
  managing_authority: 'Writes the rules of the national CAP plan that your aid follows.',
  coordinating_body: 'Links all the regional paying agencies and reports to the European Commission.',
};

const eu = (country: string) => `https://eu-cap-network.ec.europa.eu/countries/${country}_en`;
const authorities: Record<string, Region> = {
  'ES-Extremadura': { label: 'Extremadura, Spain', bodies: [
    { role: 'paying_agency', name: 'Junta de Extremadura', part: 'Consejería de Agricultura, Ganadería y Medio Natural', does: 'Pays CAP aid in Extremadura and runs the SIGPAC map for the region.', href: 'https://www.juntaex.es/lajunta/directorio', source: 'https://doe.juntaex.es/pdfs/doe/2026/1050o/26040133.pdf', sourceLabel: 'Decreto 110/2026 (DOE)' },
    { role: 'managing_authority', name: 'Ministerio de Agricultura, Pesca y Alimentación', part: 'Secretaría General de Recursos Agrarios y Seguridad Alimentaria', does: 'Manages Spain’s CAP Strategic Plan 2023 to 2027.', href: 'https://www.mapa.gob.es/', source: 'https://www.boe.es/buscar/act.php?id=BOE-A-2022-23046', sourceLabel: 'Real Decreto 1046/2022, art. 2' },
    { role: 'coordinating_body', name: 'FEGA', part: 'Fondo Español de Garantía Agraria', does: 'Coordinates Spain’s 18 paying agencies.', href: 'https://www.fega.gob.es/', source: 'https://www.boe.es/buscar/act.php?id=BOE-A-2022-23046', sourceLabel: 'Real Decreto 1046/2022, art. 10' },
  ], advisers: { label: 'Officially recognised advisers in Extremadura (AKIS platform, MAPA)', href: 'https://akisplataforma.es/asesores?f%5B0%5D=entidades_reconocidas%3A1&f%5B1%5D=mix_ccaa%3A127' } },
  NL: { label: 'the Netherlands', bodies: [
    { role: 'paying_agency', name: 'RVO', part: 'Netherlands Enterprise Agency', does: 'Pays CAP aid in the Netherlands.', href: 'https://english.rvo.nl/topics/contact', source: eu('netherlands'), sourceLabel: 'EU CAP Network' },
    { role: 'managing_authority', name: 'Ministry of Agriculture, Fisheries, Food Security and Nature', does: 'Manages the Dutch CAP Strategic Plan.', href: 'https://www.government.nl/ministries/ministry-of-agriculture-fisheries-food-security-and-nature', source: eu('netherlands'), sourceLabel: 'EU CAP Network' },
  ] },
  CZ: { label: 'Czechia', bodies: [
    { role: 'paying_agency', name: 'SZIF', part: 'State Agricultural Intervention Fund', does: 'Pays CAP aid in Czechia.', href: 'https://www.szif.cz/en', source: eu('czechia'), sourceLabel: 'EU CAP Network' },
    { role: 'managing_authority', name: 'Ministry of Agriculture (MZe)', does: 'Manages the Czech CAP Strategic Plan.', href: 'https://mze.gov.cz/public/portal/mze', source: eu('czechia'), sourceLabel: 'EU CAP Network' },
  ] },
  SK: { label: 'Slovakia', bodies: [
    { role: 'paying_agency', name: 'PPA', part: 'Agricultural Paying Agency', does: 'Pays CAP aid in Slovakia.', href: 'https://www.apa.sk/en/', source: eu('slovakia'), sourceLabel: 'EU CAP Network' },
    { role: 'managing_authority', name: 'Ministry of Agriculture and Rural Development of the Slovak Republic', does: 'Manages the Slovak CAP Strategic Plan.', href: eu('slovakia'), source: eu('slovakia'), sourceLabel: 'EU CAP Network' },
  ] },
};

export function authoritiesFor(country: unknown, region: unknown): Region | null {
  const code = String(country ?? '').toUpperCase();
  return authorities[`${code}-${String(region ?? '')}`] ?? authorities[code] ?? null;
}

/** The paying agency's short name for a farm, to name who decides on a finding. */
export function payingAgencyFor(country: unknown, region: unknown) {
  return authoritiesFor(country, region)?.bodies.find(body => body.role === 'paying_agency')?.name ?? null;
}

/** A small "i" next to a label. Opens a short plain-language explanation on hover, focus or tap; never on its own. */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <span className={`info-tip${open ? ' is-open' : ''}`} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
    <button type="button" className="info-tip-button" aria-label={`What is ${label}?`} aria-describedby={open ? id : undefined} aria-expanded={open}
      onClick={event => { event.preventDefault(); event.stopPropagation(); setOpen(value => !value); }} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
      onKeyDown={event => { if (event.key === 'Escape') setOpen(false); }}><Info aria-hidden="true"/></button>
    {open && <span role="tooltip" id={id} className="info-tip-text">{children}</span>}
  </span>;
}

export function WhoDecidesForFarm({ country, region, compact = false }: { country: unknown; region: unknown; compact?: boolean }) {
  const area = authoritiesFor(country, region);
  if (!area) return null;
  if (compact) return <p className="authority-line"><Landmark aria-hidden="true"/>{area.bodies.map(body => `${roleNames[body.role]}: ${body.name}`).join(' · ')}</p>;
  return <section className="authority-card" aria-labelledby="authority-title">
    <h2 id="authority-title">Who decides for this farm <InfoTip label="who decides">These public bodies make the official decisions for farms in {area.label}. Funkyfarm and your adviser help you prepare; they do not decide.</InfoTip></h2>
    <ul className="authority-list">{area.bodies.map(body => <li key={body.role} className={`is-${body.role}`}>
      <span className="authority-role">{roleNames[body.role]} <InfoTip label={roleNames[body.role].toLowerCase()}>{roleHelp[body.role]}</InfoTip></span>
      <strong><a href={body.href} target="_blank" rel="noopener noreferrer">{body.name}<ExternalLink aria-hidden="true"/></a></strong>
      {body.part && <span className="authority-part">{body.part}</span>}
      <span className="authority-does">{body.does}</span>
      <small>Source: <a href={body.source} target="_blank" rel="noopener noreferrer">{body.sourceLabel}</a> · checked 18 Oct 2026</small>
    </li>)}</ul>
    {area.advisers && <p className="authority-advisers"><a href={area.advisers.href} target="_blank" rel="noopener noreferrer">{area.advisers.label}<ExternalLink aria-hidden="true"/></a></p>}
  </section>;
}
