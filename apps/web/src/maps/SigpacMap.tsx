import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Layers, MapPin } from 'lucide-react';
import { api, ApiError, errorMessage } from '../api';
import { Button, Notice, WhoDecides } from '../components';
import type { FieldGeometry } from '../pages/FieldsMap';
import { brpGroup, landUseGroup, landUseGroups, statusStyles, usoNames, type FieldStatus, type LandUseGroup } from './landUse';
import { mapSources, type MapSource } from './sources';
import './sigpac-map.css';

// SIGPAC recintos (Spain) or BRP crop parcels (the Netherlands), as returned by the API (whitelisted attributes only).
type RecintoProperties = {
  reference: string; approximate_area_ha: number | null;
  uso_sigpac?: string | null; pendiente_media?: number | null; altitud?: number | null; incidencias?: string | null; provincia?: number; municipio?: number;
  agregado?: number; zona?: number; poligono?: number; parcela?: number; recinto?: number;
  category?: string | null; gewas?: string | null; gewascode?: string | null; jaar?: number | null;
};
type Recinto = { type: 'Feature'; id: string; geometry: FieldGeometry; properties: RecintoProperties };
type RecintoCollection = { type: 'FeatureCollection'; features: Recinto[]; source?: { attribution?: string; retrieved_at?: string; license?: string; documentation?: string }; notice?: string };
type Facts = { reference: string | null; superficie: number | null; admisibilidad: number | null; uso_sigpac: string | null; incidencias: string | null; pendiente_media: number | null; altitud: number | null; recinto: number };

export type MapField = { id: string; label: string; geometry: FieldGeometry; status?: FieldStatus; href?: string; detail?: string; group?: string; reference?: string | null };
type Props = {
  title: string;
  fields?: MapField[];
  colourBy?: 'landuse' | 'status';
  /** A retained public snapshot (no API calls), for signed-out pages. */
  staticData?: string;
  fallbackCenter?: [number, number];
  onFieldSelect?: (field: MapField) => void;
  /** False to show only the farm's own outlines, with no official register. */
  official?: boolean;
  /** Fit the view to the fields of this group (for example, one client farm). */
  focusGroup?: string | null;
  /** Official references to outline in ink, for example the parcels of a worked example. */
  highlight?: string[];
};

// Which official register covers a point: SIGPAC for Spain, BRP for the Netherlands.
type Source = 'sigpac' | 'brp';
const registers: Record<Source, { name: string; bounds: [number, number, number, number]; path: string; zoom: number; tiles: number; attribution: string }> = {
  sigpac: { name: 'SIGPAC', bounds: [-19, 27, 5, 44], path: '/sigpac/recintos', zoom: 15, tiles: 64, attribution: '' },
  brp: { name: 'BRP', bounds: [3.2, 50.7, 7.3, 53.6], path: '/brp/percelen', zoom: 14, tiles: 16, attribution: 'BRP Gewaspercelen © <a href="https://www.pdok.nl/introductie/-/article/basisregistratie-gewaspercelen-brp-" target="_blank" rel="noopener noreferrer">RVO / PDOK</a> · public domain' },
};
function sourceAt(point: L.LatLng | null): Source | null {
  if (!point) return null;
  return (Object.keys(registers) as Source[]).find(key => { const [w, s, e, n] = registers[key].bounds; return point.lng >= w && point.lng <= e && point.lat >= s && point.lat <= n; }) ?? null;
}
const isBrp = (recinto: Recinto) => recinto.properties.uso_sigpac === undefined && recinto.properties.category !== undefined;
const groupOf = (recinto: Recinto): LandUseGroup => isBrp(recinto) ? brpGroup(recinto.properties.category, recinto.properties.gewas) : landUseGroup(recinto.properties.uso_sigpac);
const MIN_ZOOM_FOR_PARCELS = 12; // Below this, parcels are too small to read; the tile count also caps the area.
const TILE_LIMIT = 64;
const SIGPAC_ATTRIBUTION = 'Recintos SIGPAC © <a href="https://sigpac-hubcloud.es/html/mvt/descServicio.html" target="_blank" rel="noopener noreferrer">FEGA</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a>';

function rings(geometry: FieldGeometry): number[][][][] {
  return geometry.type === 'Polygon' ? [geometry.coordinates as number[][][]] : geometry.coordinates as number[][][][];
}
function latLngs(geometry: FieldGeometry) {
  return rings(geometry).map(polygon => polygon.map(ring => ring.map(([lon, lat]) => L.latLng(lat, lon))));
}
function boundsOf(geometries: FieldGeometry[]) {
  const points = geometries.flatMap(geometry => rings(geometry).flat(2));
  if (!points.length) return null;
  return L.latLngBounds(points.map(([lon, lat]) => L.latLng(lat, lon)));
}
function tilesNeeded(bounds: L.LatLngBounds, zoom = 15) {
  const n = 2 ** zoom;
  const x = (lon: number) => Math.floor((lon + 180) / 360 * n);
  const y = (lat: number) => Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n);
  return (x(bounds.getEast()) - x(bounds.getWest()) + 1) * (y(bounds.getSouth()) - y(bounds.getNorth()) + 1);
}
const hectares = (value: number | null | undefined, digits = 2) => value == null ? 'Not published' : `${value.toLocaleString(undefined, { maximumFractionDigits: digits })} ha`;

export function SigpacMap({ title, fields = [], colourBy = 'landuse', staticData, fallbackCenter = [39.5, -6.46], onFieldSelect, official = true, focusGroup = null, highlight = [] }: Props) {
  const host = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const parcelLayer = useRef<L.LayerGroup | null>(null);
  const fieldLayer = useRef<L.LayerGroup | null>(null);
  const pinLayer = useRef<L.LayerGroup | null>(null);
  const shapes = useRef(new Map<string, L.Polygon>());
  const selectedRef = useRef<string | null>(null);
  const [recintos, setRecintos] = useState<Map<string, Recinto>>(new Map());
  const [view, setView] = useState<L.LatLngBounds | null>(null);
  const [zoom, setZoom] = useState(0);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'zoom' | 'outside' | 'error'>('idle');
  const [error, setError] = useState('');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [facts, setFacts] = useState<Record<string, Facts[] | 'loading' | string>>({});
  const [backgroundId, setBackgroundId] = useState('osm');
  const [retry, setRetry] = useState(0);
  const sources = useMemo(() => mapSources('ES').filter(source => source.id !== 'eox-satellite-2016').sort((a, b) => (a.id === 'osm' ? -1 : b.id === 'osm' ? 1 : 0)), []);
  const background: MapSource | undefined = sources.find(source => source.id === backgroundId);
  const active: Source | null = staticData ? 'sigpac' : official ? sourceAt(view?.getCenter() ?? null) : null;
  const register = active ? registers[active] : null;
  const fieldBounds = useMemo(() => boundsOf(fields.map(field => field.geometry)), [JSON.stringify(fields.map(field => field.id))]);

  // Create the map once.
  useEffect(() => {
    if (!host.current) return;
    // No animations: a map can unmount mid-zoom when the person moves on (Leaflet then throws), as in ParcelMap.
    const instance = L.map(host.current, { zoomControl: true, attributionControl: true, scrollWheelZoom: false, minZoom: 5, maxZoom: 19,
      zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false });
    instance.attributionControl.setPrefix('<a href="https://leafletjs.com/" title="Map software">Leaflet</a>');
    instance.createPane('farm-fields').style.zIndex = '450';
    parcelLayer.current = L.layerGroup().addTo(instance);
    fieldLayer.current = L.layerGroup().addTo(instance);
    pinLayer.current = L.layerGroup().addTo(instance);
    const changed = () => { setView(instance.getBounds()); setZoom(instance.getZoom()); };
    instance.on('moveend zoomend', changed);
    instance.on('click', () => setSelected(null));
    map.current = instance;
    if (fieldBounds) instance.fitBounds(fieldBounds, { padding: [12, 12], maxZoom: 16 });
    else instance.setView(fallbackCenter, 15);
    changed();
    return () => { instance.off(); instance.remove(); map.current = null; shapes.current.clear(); };
  }, []);

  // Refit when the set of fields changes (another farm chosen) or one group is focused.
  useEffect(() => {
    if (map.current && fieldBounds) map.current.fitBounds(fieldBounds, { padding: [12, 12], maxZoom: 16 });
  }, [fieldBounds]);
  useEffect(() => {
    if (!focusGroup || !map.current) return;
    const bounds = boundsOf(fields.filter(field => field.group === focusGroup).map(field => field.geometry));
    if (bounds) map.current.fitBounds(bounds, { padding: [12, 12], maxZoom: 16 });
  }, [focusGroup]);

  // Background tiles: OpenStreetMap by default; the provider sees the map area, not farm records.
  useEffect(() => {
    const instance = map.current;
    if (!instance || !background) return;
    const options = { crossOrigin: true, referrerPolicy: 'origin' as const, maxNativeZoom: background.maxZoom, maxZoom: 19, tileSize: 256, attribution: background.attribution };
    const layer = background.kind === 'wms'
      ? L.tileLayer.wms(background.url, { ...options, version: '1.3.0', layers: background.layers, styles: background.styles ?? '', format: background.format ?? 'image/jpeg', transparent: false })
      : L.tileLayer(background.url, options);
    layer.addTo(instance); layer.bringToBack();
    return () => { layer.remove(); };
  }, [backgroundId]);

  // Credit only the register whose parcels are on screen.
  useEffect(() => {
    const control = map.current?.attributionControl;
    const credit = active === 'sigpac' ? SIGPAC_ATTRIBUTION : active ? registers[active].attribution : '';
    if (!control || !credit) return;
    control.addAttribution(credit);
    return () => { control.removeAttribution(credit); };
  }, [active]);

  // Load official parcels for the visible area (or the retained snapshot).
  useEffect(() => {
    if (staticData) {
      let active = true;
      setStatus('loading');
      fetch(staticData, { cache: 'force-cache' }).then(response => {
        if (!response.ok) throw new Error('The saved SIGPAC example could not be opened.');
        return response.json() as Promise<RecintoCollection>;
      }).then(collection => {
        if (!active) return;
        setRecintos(new Map(collection.features.map(feature => [feature.properties.reference, feature])));
        setStatus('ready');
        const marked = boundsOf(collection.features.filter(feature => highlight.includes(feature.properties.reference)).map(feature => feature.geometry));
        if (marked && map.current) map.current.fitBounds(marked, { padding: [24, 24], maxZoom: 16 });
      }).catch(failure => { if (active) { setStatus('error'); setError(errorMessage(failure)); } });
      return () => { active = false; };
    }
    const source = official ? sourceAt(view?.getCenter() ?? null) : null;
    if (!view || !source) { setStatus(official && view ? 'outside' : 'idle'); return; }
    const register = registers[source];
    if (zoom < MIN_ZOOM_FOR_PARCELS || tilesNeeded(view, register.zoom) > register.tiles) { setStatus('zoom'); return; }
    let active = true;
    const timer = window.setTimeout(() => {
      setStatus('loading'); setError('');
      const bbox = [view.getWest(), view.getSouth(), view.getEast(), view.getNorth()].map(value => value.toFixed(5)).join(',');
      api.get<RecintoCollection>(`${register.path}?bbox=${bbox}`).then(collection => {
        if (!active) return;
        setRecintos(previous => {
          const next = new Map(previous);
          for (const feature of collection.features) next.set(feature.properties.reference, feature);
          return next;
        });
        setStatus('ready');
      }).catch(failure => {
        if (!active) return;
        if (failure instanceof ApiError && failure.code === 'area_too_large') { setStatus('zoom'); return; }
        setStatus('error'); setError(errorMessage(failure));
      });
    }, 350);
    return () => { active = false; window.clearTimeout(timer); };
  }, [view?.toBBoxString(), zoom, retry, staticData, official]);

  // Draw parcels: largest behind smallest, Bo's rule; hover and selection lift a parcel.
  const ordered = useMemo(() => [...recintos.values()].sort((a, b) => (b.properties.approximate_area_ha ?? 0) - (a.properties.approximate_area_ha ?? 0)), [recintos]);
  useEffect(() => {
    const layer = parcelLayer.current;
    if (!layer) return;
    layer.clearLayers(); shapes.current.clear();
    const muted = colourBy === 'status';
    for (const recinto of ordered) {
      const group = groupOf(recinto);
      if (hidden.has(group.id)) continue;
      const marked = highlight.includes(recinto.properties.reference);
      const rest = { color: marked ? '#14201A' : group.color, weight: marked ? 3 : 1.2, dashArray: marked ? '6 4' : undefined, opacity: muted ? .45 : .9, fillColor: group.color, fillOpacity: muted ? Math.min(group.fill, .12) : group.fill };
      const polygon = L.polygon(latLngs(recinto.geometry), { ...rest, bubblingMouseEvents: false });
      const lift = () => { polygon.setStyle({ weight: 4.5, opacity: 1, fillOpacity: Math.min(.6, rest.fillOpacity + .25) }); polygon.bringToFront(); };
      polygon.on('mouseover', lift);
      polygon.on('mouseout', () => { if (selectedRef.current !== recinto.properties.reference) polygon.setStyle(rest); });
      polygon.on('click', () => setSelected(recinto.properties.reference));
      polygon.bindTooltip(`${isBrp(recinto) ? recinto.properties.gewas ?? group.label : group.label} · ${recinto.properties.reference}`, { sticky: true, direction: 'top', className: 'sigpac-tooltip' });
      (polygon as L.Polygon & { restStyle?: L.PathOptions; lift?: () => void }).restStyle = rest;
      (polygon as L.Polygon & { lift?: () => void }).lift = lift;
      polygon.addTo(layer);
      shapes.current.set(recinto.properties.reference, polygon);
    }
  }, [ordered, hidden, colourBy, highlight.join()]);

  // Sticky selection lift.
  useEffect(() => {
    const previous = selectedRef.current;
    selectedRef.current = selected;
    if (previous && previous !== selected) {
      const shape = shapes.current.get(previous) as (L.Polygon & { restStyle?: L.PathOptions }) | undefined;
      if (shape?.restStyle) shape.setStyle(shape.restStyle);
    }
    if (selected) (shapes.current.get(selected) as (L.Polygon & { lift?: () => void }) | undefined)?.lift?.();
  }, [selected, ordered]);

  // The farm's own fields sit on top: outlined in ink, or filled by finding level for advisers.
  useEffect(() => {
    const layer = fieldLayer.current;
    if (!layer) return;
    layer.clearLayers();
    for (const field of fields) {
      const tint = colourBy === 'status' && field.status ? statusStyles[field.status].color : '#14201A';
      // Over an official parcel, a click shows that parcel's facts (the card links back to the field).
      const clickable = colourBy === 'status' || !official || !field.reference;
      const polygon = L.polygon(latLngs(field.geometry), {
        pane: 'farm-fields', color: tint, weight: 3, opacity: 1, dashArray: colourBy === 'status' ? undefined : '6 4',
        fillColor: tint, fillOpacity: colourBy === 'status' ? .35 : .04, bubblingMouseEvents: false, interactive: clickable,
      });
      polygon.bindTooltip(field.detail ? `${field.label} · ${field.detail}` : field.label, { sticky: true, direction: 'top', className: 'sigpac-tooltip' });
      polygon.on('click', () => onFieldSelect?.(field));
      polygon.addTo(layer);
    }
  }, [JSON.stringify(fields.map(field => [field.id, field.status, field.label, field.reference])), colourBy, official]);

  // Zoomed out, each farm shows as one pin in its status colour, so small fields stay findable.
  useEffect(() => {
    const layer = pinLayer.current;
    if (!layer) return;
    layer.clearLayers();
    if (zoom >= 13) return;
    const groups = new Map<string, MapField[]>();
    for (const field of fields) groups.set(field.group ?? field.id, [...(groups.get(field.group ?? field.id) ?? []), field]);
    for (const [group, members] of groups) {
      const bounds = boundsOf(members.map(member => member.geometry));
      if (!bounds) continue;
      const level = members.some(member => member.status === 'conflict') ? 'conflict' : members.some(member => member.status === 'gap') ? 'gap' : 'ok';
      const tint = colourBy === 'status' ? statusStyles[level].color : '#14201A';
      const pin = L.circleMarker(bounds.getCenter(), { pane: 'farm-fields', radius: 9, color: '#ffffff', weight: 2, fillColor: tint, fillOpacity: 1, bubblingMouseEvents: false });
      pin.bindTooltip(members[0].label.split(' · ')[0], { direction: 'top', className: 'sigpac-tooltip' });
      pin.on('click', () => map.current?.fitBounds(bounds, { padding: [12, 12], maxZoom: 16 }));
      pin.addTo(layer);
      void group;
    }
  }, [zoom >= 13, JSON.stringify(fields.map(field => [field.id, field.status])), colourBy]);

  // Load official facts for the selected parcel (one FEGA query per parcela, cached server-side).
  useEffect(() => {
    if (!selected || staticData) return;
    const recinto = recintos.get(selected);
    if (!recinto || isBrp(recinto)) return;
    const p = recinto.properties;
    const key = [p.provincia, p.municipio, p.agregado, p.zona, p.poligono, p.parcela].join('/');
    if (facts[key]) return;
    setFacts(previous => ({ ...previous, [key]: 'loading' }));
    api.get<{ items: Facts[] }>(`/sigpac/parcelas/${key}`)
      .then(result => setFacts(previous => ({ ...previous, [key]: result.items })))
      .catch(failure => setFacts(previous => ({ ...previous, [key]: errorMessage(failure) })));
  }, [selected]);

  const inView = useMemo(() => {
    if (!view) return [] as Recinto[];
    return ordered.filter(recinto => {
      const bounds = L.latLngBounds(rings(recinto.geometry)[0][0].map(([lon, lat]) => L.latLng(lat, lon)));
      return view.intersects(bounds);
    });
  }, [ordered, view?.toBBoxString()]);
  const counts = useMemo(() => {
    const result = new Map<string, number>();
    for (const recinto of inView) {
      const group = groupOf(recinto);
      result.set(group.id, (result.get(group.id) ?? 0) + 1);
    }
    return result;
  }, [inView]);
  const areaInView = inView.reduce((sum, recinto) => sum + (recinto.properties.approximate_area_ha ?? 0), 0);
  const chosen = selected ? recintos.get(selected) : undefined;
  const chosenKey = chosen && !isBrp(chosen) ? [chosen.properties.provincia, chosen.properties.municipio, chosen.properties.agregado, chosen.properties.zona, chosen.properties.poligono, chosen.properties.parcela].join('/') : '';
  const chosenFacts = chosenKey ? facts[chosenKey] : undefined;
  const chosenRow = Array.isArray(chosenFacts) ? chosenFacts.find(row => Number(row.recinto) === chosen?.properties.recinto) : undefined;

  function toggle(groupId: string) {
    setHidden(previous => { const next = new Set(previous); if (next.has(groupId)) next.delete(groupId); else next.add(groupId); return next; });
  }
  function focusRecinto(reference: string) {
    const shape = shapes.current.get(reference);
    if (shape && map.current) map.current.fitBounds(shape.getBounds(), { padding: [40, 40], maxZoom: 17 });
    setSelected(reference);
  }

  return <section className="sigpac-map" aria-label={title}>
    <div className="sigpac-stats" role="group" aria-label="Map figures">
      {register && <><span className="sigpac-stat"><b>{inView.length}</b> {register.name} parcels in view</span>
      <span className="sigpac-stat"><b>{Math.round(areaInView).toLocaleString()}</b> ha mapped</span></>}
      {fields.length > 0 && <button type="button" className="sigpac-stat" onClick={() => fieldBounds && map.current?.fitBounds(fieldBounds, { padding: [12, 12], maxZoom: 16 })}><MapPin aria-hidden="true"/><b>{fields.length}</b> {colourBy === 'status' ? 'farm fields' : 'of your fields'}</button>}
      <span className="sigpac-campaign">{staticData ? 'Saved public example' : active === 'sigpac' ? 'Current SIGPAC campaign' : active === 'brp' ? 'BRP, latest published year' : 'Official parcels: Spain and the Netherlands'}</span>
    </div>
    {colourBy === 'status' && <div className="sigpac-legend" role="group" aria-label="Farm status colours"><span className="sigpac-legend-label">Farm status</span>
      {(Object.keys(statusStyles) as FieldStatus[]).map(level => <span key={level} className="sigpac-chip is-status" style={{ '--chip': statusStyles[level].color } as CSSProperties}><i aria-hidden="true"/>{statusStyles[level].label}</span>)}
    </div>}
    {(register || staticData) && <div className="sigpac-legend" role="group" aria-label="Show or hide land uses"><span className="sigpac-legend-label">Land use</span>
      {landUseGroups.map(group => <button key={group.id} type="button" className="sigpac-chip" aria-pressed={!hidden.has(group.id)} onClick={() => toggle(group.id)} style={{ '--chip': group.color } as CSSProperties}>
        <i aria-hidden="true"/>{group.label}<span>{counts.get(group.id) ?? 0}</span></button>)}
    </div>}
    <div className="sigpac-frame">
      <div ref={host} className="sigpac-canvas" tabIndex={0} aria-label={`${title}. Use the list below to choose a parcel without the map.`}/>
      <div className="sigpac-status" role="status">
        {status === 'loading' && `Loading ${register?.name ?? 'official'} parcels…`}
        {status === 'zoom' && `Zoom in to see ${register?.name ?? 'official'} parcels.`}
        {status === 'outside' && 'No official parcel register connected here yet.'}
      </div>
      {chosen && <aside className="sigpac-card" aria-label={`Parcel ${chosen.properties.reference}`}>
        <div className="sigpac-card-head" style={{ '--chip': landUseGroup(chosen.properties.uso_sigpac).color } as CSSProperties}>
          <span className="eyebrow">{isBrp(chosen) ? 'BRP crop parcel' : 'SIGPAC recinto'}</span><h3>{chosen.properties.reference}</h3>
          <button type="button" className="text-button" onClick={() => setSelected(null)}>Close</button>
        </div>
{isBrp(chosen) ? <>
        <dl>
          <div><dt>Crop</dt><dd>{chosen.properties.gewas ?? 'Not published'}{chosen.properties.gewascode ? ` · code ${chosen.properties.gewascode}` : ''}</dd></div>
          <div><dt>Category</dt><dd>{chosen.properties.category ?? 'Not published'}</dd></div>
          <div><dt>Year</dt><dd>{chosen.properties.jaar ?? 'Not published'}</dd></div>
          <div><dt>Area from the outline</dt><dd>{chosen.properties.approximate_area_ha == null ? 'Not calculated' : `about ${hectares(chosen.properties.approximate_area_ha)}`}</dd></div>
        </dl>
        </> : <>
        <dl>
          <div><dt>Land use</dt><dd>{chosen.properties.uso_sigpac ?? 'Not published'} · {usoNames[chosen.properties.uso_sigpac ?? ''] ?? 'Use not published'}</dd></div>
          <div><dt>Official area</dt><dd>{chosenFacts === 'loading' ? 'Loading…' : chosenRow ? hectares(chosenRow.superficie, 4) : staticData ? 'Open the field check for official figures' : typeof chosenFacts === 'string' ? chosenFacts : 'Not published'}</dd></div>
          <div><dt>Eligibility coefficient (CSP)</dt><dd>{chosenRow?.admisibilidad != null ? `${chosenRow.admisibilidad}%` : 'Not published'}</dd></div>
          <div><dt>Incidences, as published</dt><dd>{chosenRow ? chosenRow.incidencias || 'None published' : chosen.properties.incidencias || 'None published'}</dd></div>
          <div><dt>Area from the outline</dt><dd>{chosen.properties.approximate_area_ha == null ? 'Not calculated' : `about ${hectares(chosen.properties.approximate_area_ha)}`}</dd></div>
          <div><dt>Slope · altitude</dt><dd>{chosen.properties.pendiente_media ?? '?'} · {chosen.properties.altitud ?? '?'} m</dd></div>
        </dl>
        </>}
        <WhoDecides who="agency">{isBrp(chosen) ? 'RVO decides eligibility' : 'Paying agency decides eligibility'}</WhoDecides>
        {fields.filter(field => field.reference === chosen.properties.reference && field.href).map(field => <p key={field.id} className="sigpac-card-field">Your field <strong>{field.label.split(' · ').pop()}</strong> · <Link to={field.href!}>Check this field</Link></p>)}
      </aside>}
    </div>
    {status === 'error' && <Notice kind="error">{error || 'Official parcels could not be loaded.'} <Button variant="secondary" onClick={() => setRetry(value => value + 1)}>Try again</Button></Notice>}
    <div className="sigpac-tools">
      <fieldset className="segmented"><legend>Background</legend><div className="segmented-options">
        {sources.map(source => <label key={source.id}><input type="radio" name={`${title}-background`} checked={backgroundId === source.id} onChange={() => setBackgroundId(source.id)}/>{source.id === 'osm' ? <MapPin aria-hidden="true"/> : <Layers aria-hidden="true"/>}{source.label}</label>)}
      </div></fieldset>
      <p className="muted">The background provider sees the map area and your IP address, not your farm records. Official parcels come through Funkyfarm's server from open data: SIGPAC (FEGA) in Spain and BRP (RVO, via PDOK) in the Netherlands. They show official land use or the declared crop, not ownership or payment.</p>
    </div>
    <details className="sigpac-list"><summary>Parcels in view ({inView.length}){highlight.length ? ', yours first' : ''}, then smallest first</summary>
      <ul>{[...inView.filter(recinto => highlight.includes(recinto.properties.reference)), ...[...inView].reverse().filter(recinto => !highlight.includes(recinto.properties.reference))].slice(0, 300).map(recinto => { const group = groupOf(recinto); return <li key={recinto.properties.reference}>
        <button type="button" onClick={() => focusRecinto(recinto.properties.reference)} style={{ '--chip': group.color } as CSSProperties}><i aria-hidden="true"/><span>{recinto.properties.reference}</span><small>{group.label} · about {hectares(recinto.properties.approximate_area_ha)}</small></button></li>; })}</ul>
      {fields.some(field => field.href) && <><h4>Fields on this map</h4><ul>{fields.filter(field => field.href).map(field => <li key={field.id}><Link to={field.href!}>{field.label}</Link>{field.detail ? ` · ${field.detail}` : ''}</li>)}</ul></>}
    </details>
  </section>;
}
