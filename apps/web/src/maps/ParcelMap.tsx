import { useEffect, useId, useRef, useState } from 'react';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Button, Field, Notice } from '../components';
import type { FieldGeometry, FieldPoint } from '../pages/FieldsMap';
import { mapSources, type MapSource } from './sources';
import './parcel-map.css';

export type ParcelMapBounds = [west: number, south: number, east: number, north: number];
export type ParcelMapProps = {
  geometry: FieldGeometry | null;
  reference: FieldGeometry | null;
  point?: FieldPoint | null;
  sketch: number[][];
  splitLine: number[][];
  mode: 'draw' | 'edit' | 'split';
  disabled?: boolean;
  onGeometry: (geometry: FieldGeometry) => void;
  onSketch: (positions: number[][]) => void;
  onSplitLine: (positions: number[][]) => void;
  country?: string | null;
  region?: string | null;
  onViewportChange?: (bbox: ParcelMapBounds) => void;
  referenceCandidates?: { id: string; label: string; geometry: FieldGeometry }[];
  onReferenceSelect?: (id: string) => void;
};

function partsOf(geometry: FieldGeometry | null): number[][][][] {
  return !geometry ? [] : geometry.type === 'Polygon' ? [geometry.coordinates as number[][][]] : geometry.coordinates as number[][][][];
}
function validPosition(position: number[]) {
  return Array.isArray(position) && position.length >= 2 && Number.isFinite(position[0]) && Number.isFinite(position[1]) && Math.abs(position[0]) <= 180 && Math.abs(position[1]) <= 90;
}
function latLng(position: number[]): L.LatLngTuple { return [position[1], position[0]]; }
function position(value: L.LatLng): number[] {
  const wrapped = value.wrap();
  return [Number(wrapped.lng.toFixed(8)), Number(Math.max(-85.05112878, Math.min(85.05112878, wrapped.lat)).toFixed(8))];
}
function positionsOf(props: ParcelMapProps): number[][] {
  const points = [props.geometry, props.reference].flatMap(geometry => partsOf(geometry).flat(2));
  if (props.point) points.push([props.point.longitude, props.point.latitude]);
  return [...points, ...props.sketch, ...props.splitLine].filter(validPosition);
}
function viewport(map: L.Map): ParcelMapBounds {
  const bounds = map.getBounds();
  return bounds.getEast() - bounds.getWest() >= 360 ? [-180, Math.max(-90, bounds.getSouth()), 180, Math.min(90, bounds.getNorth())]
    : [Math.max(-180, bounds.getWest()), Math.max(-90, bounds.getSouth()), Math.min(180, bounds.getEast()), Math.min(90, bounds.getNorth())];
}

/** Controlled geometry editor. Map movement never calls an editing callback. */
export function ParcelMap(props: ParcelMapProps) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const outlines = useRef<L.LayerGroup | null>(null);
  const handles = useRef<L.LayerGroup | null>(null);
  const outline = useRef<L.Polygon | null>(null);
  const tiles = useRef<L.TileLayer | null>(null);
  const deviceLocation = useRef<L.LayerGroup | null>(null);
  const partRef = useRef(0);
  const focusedCorner = useRef<number | null>(null);
  const undo = useRef<FieldGeometry[]>([]);
  const acknowledgedGeometry = useRef(JSON.stringify(props.geometry));
  const expectedGeometry = useRef<string | null>(null);
  const fitted = useRef(false);
  const movedByUser = useRef(false);
  const [ready, setReady] = useState(false);
  const [part, setPart] = useState(0);
  const [undoCount, setUndoCount] = useState(0);
  const [message, setMessage] = useState('');
  const [mapError, setMapError] = useState('');
  const [backgroundAllowed, setBackgroundAllowed] = useState(false);
  const [sourceId, setSourceId] = useState('');
  const [backgroundStatus, setBackgroundStatus] = useState<'off' | 'loading' | 'ready' | 'failed'>('off');
  const [backgroundAttempt, setBackgroundAttempt] = useState(0);
  const [outsideCoverage, setOutsideCoverage] = useState(false);
  const [zoom, setZoom] = useState(4);
  const [locating, setLocating] = useState(false);
  const [locationMessage, setLocationMessage] = useState('');
  const alive = useRef(false);
  const locationRequest = useRef(0);
  const sources = mapSources(props.country, props.region);
  const source = sources.find(item => item.id === sourceId);
  const sourceSignature = JSON.stringify(source ?? null);
  const instructionId = useId();
  const parts = partsOf(props.geometry);
  const selectedPart = Math.min(part, Math.max(0, parts.length - 1));
  partRef.current = selectedPart;
  const ring = parts[selectedPart]?.[0] ?? [];

  function fitSupplied() {
    const instance = map.current;
    if (!instance) return;
    const points = positionsOf(latest.current);
    if (!points.length) { setMessage('No field location has been supplied. Pan and zoom to the place you know, or add coordinates before drawing.'); return; }
    instance.fitBounds(L.latLngBounds(points.map(latLng)), { padding: [36, 36], maxZoom: 19, animate: false });
    fitted.current = true;
    setMessage('Showing your supplied locations. The view did not change any field coordinates.');
  }
  function commit(next: FieldGeometry) {
    if (latest.current.disabled) return;
    const previous = latest.current.geometry;
    if (previous) { undo.current = [...undo.current.slice(-29), structuredClone(previous)]; setUndoCount(undo.current.length); }
    expectedGeometry.current = JSON.stringify(next);
    latest.current.onGeometry(next);
  }
  function movedCorner(index: number, nextPosition: number[]): FieldGeometry | null {
    if (latest.current.disabled) return null;
    const current = latest.current.geometry;
    const next = structuredClone(partsOf(current));
    const outer = next[partRef.current]?.[0];
    if (!current || !outer || !outer[index] || !validPosition(nextPosition)) return null;
    outer[index] = nextPosition;
    if (index === 0) outer[outer.length - 1] = [...nextPosition];
    return current.type === 'Polygon' ? { type: 'Polygon', coordinates: next[0] } : { type: 'MultiPolygon', coordinates: next };
  }
  function moveCorner(index: number, nextPosition: number[]) {
    const next = movedCorner(index, nextPosition);
    if (next) commit(next);
  }
  function changeCornerCount(index: number, insert: boolean) {
    const current = latest.current.geometry;
    const next = structuredClone(partsOf(current));
    const currentOuter = next[partRef.current]?.[0];
    if (!current || !currentOuter) return;
    const outer = currentOuter.slice(0, -1);
    if (insert) {
      if (outer.length >= 499) return;
      const before = outer[index], after = outer[(index + 1) % outer.length];
      outer.splice(index + 1, 0, [(before[0] + after[0]) / 2, (before[1] + after[1]) / 2]);
    } else {
      if (outer.length <= 3) return;
      outer.splice(index, 1);
    }
    next[partRef.current][0] = [...outer, [...outer[0]]];
    commit(current.type === 'Polygon' ? { type: 'Polygon', coordinates: next[0] } : { type: 'MultiPolygon', coordinates: next });
  }
  function pan(x: number, y: number) {
    movedByUser.current = true;
    map.current?.panBy([x, y], { animate: false });
  }
  function hideBackground() {
    // Remove immediately in the trusted user action as well as effect cleanup.
    tiles.current?.remove(); tiles.current = null;
    setBackgroundAllowed(false); setSourceId(''); setMapError(''); setBackgroundStatus('off');
  }
  function useLocation() {
    if (!navigator.geolocation) { setLocationMessage('This browser cannot provide a location. Pan the map or supply known coordinates instead.'); return; }
    const request = ++locationRequest.current;
    setLocating(true); setLocationMessage('Waiting for your permission to show this device location. It will not be saved as a field or farm point.');
    navigator.geolocation.getCurrentPosition(result => {
      if (!alive.current || request !== locationRequest.current || !map.current) return;
      setLocating(false);
      const { latitude, longitude, accuracy } = result.coords;
      if (!validPosition([longitude, latitude]) || !Number.isFinite(accuracy) || accuracy < 0) { setLocationMessage('The device returned an unusable location. Pan the map or add known coordinates instead.'); return; }
      movedByUser.current = true;
      deviceLocation.current?.clearLayers();
      if (deviceLocation.current) {
        L.circle([latitude, longitude], { radius: accuracy, color: '#315779', weight: 1, fillOpacity: .08, interactive: false }).addTo(deviceLocation.current);
        L.circleMarker([latitude, longitude], { radius: 6, color: '#315779', fillOpacity: .9, interactive: false }).addTo(deviceLocation.current);
      }
      const area = L.latLng(latitude, longitude).toBounds(Math.max(20, accuracy) * 2);
      map.current.fitBounds(area, { padding: [36, 36], maxZoom: 17, animate: false });
      setLocationMessage(`Device location shown with about ${Math.ceil(accuracy).toLocaleString()} metres accuracy. This is not a boundary or a survey. Nothing was saved to your farm.${accuracy > 100 ? ' This location is rough. Find your field on the map before drawing.' : ''}`);
    }, error => {
      if (!alive.current || request !== locationRequest.current) return;
      setLocating(false);
      setLocationMessage(error.code === 1 ? 'Location permission was not granted. You can still pan the map or supply coordinates; no location was saved.' : error.code === 3 ? 'The location request timed out. You can still pan the map or supply coordinates; no location was saved.' : 'A reliable device location is unavailable. Pan the map or supply coordinates; no location was saved.');
    }, { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 });
  }

  useEffect(() => {
    if (!host.current) return;
    const instance = L.map(host.current, {
      crs: L.CRS.EPSG3857, center: [54, 15], zoom: 4, minZoom: 2, maxZoom: 22,
      zoomControl: false, attributionControl: true, scrollWheelZoom: false,
      doubleClickZoom: false, worldCopyJump: false, maxBounds: [[-85.05112878, -180], [85.05112878, 180]],
      zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false,
    });
    map.current = instance;
    alive.current = true;
    outlines.current = L.layerGroup().addTo(instance);
    handles.current = L.layerGroup().addTo(instance);
    deviceLocation.current = L.layerGroup().addTo(instance);
    instance.attributionControl.addAttribution('Your boundary draft · not an official LPIS boundary');
    const announceView = () => { setZoom(instance.getZoom()); latest.current.onViewportChange?.(viewport(instance)); };
    const userMoved = (event: L.LeafletEvent) => {
      // Leaflet drag/zoom changes the viewport only. Geometry is separate.
      if (event.type === 'dragstart') movedByUser.current = true;
    };
    instance.on('moveend', announceView);
    instance.on('dragstart', userMoved);
    instance.on('click', (event: L.LeafletMouseEvent) => {
      const current = latest.current;
      if (current.disabled) return;
      if ((current.mode === 'draw' || current.mode === 'split') && instance.getZoom() < 14) { setMessage('Zoom in closer before drawing. This view covers too large an area.'); return; }
      if (current.mode === 'draw') {
        if (current.sketch.length >= 499) { setMessage('This outline has reached 499 corners. Close it before adding another field.'); return; }
        current.onSketch([...current.sketch, position(event.latlng)]);
      } else if (current.mode === 'split') {
        if (current.splitLine.length >= 2) { setMessage('Two dividing-line points are recorded. Choose Redraw dividing line to start again.'); return; }
        current.onSplitLine([...current.splitLine, position(event.latlng)]);
      }
    });
    const observer = new ResizeObserver(() => instance.invalidateSize({ animate: false, pan: false }));
    observer.observe(host.current);
    announceView();
    setReady(true);
    return () => { alive.current = false; locationRequest.current += 1; observer.disconnect(); instance.remove(); map.current = null; outlines.current = null; handles.current = null; outline.current = null; tiles.current = null; deviceLocation.current = null; fitted.current = false; movedByUser.current = false; };
  }, []);

  useEffect(() => {
    const instance = map.current;
    tiles.current?.remove(); tiles.current = null;
    setMapError(''); setOutsideCoverage(false);
    if (!ready || !instance || !backgroundAllowed || !source) { setBackgroundStatus('off'); return; }
    const reviewed: MapSource = source;
    let failed = false;
    setBackgroundStatus('loading');
    const bounds = reviewed.bounds ? L.latLngBounds([reviewed.bounds[1], reviewed.bounds[0]], [reviewed.bounds[3], reviewed.bounds[2]]) : undefined;
    const options: L.TileLayerOptions & { matrix?: (data: { z: number }) => string } = {
      crossOrigin: true, referrerPolicy: 'origin', updateWhenIdle: true, keepBuffer: 0,
      detectRetina: false, noWrap: true, maxNativeZoom: reviewed.maxZoom, maxZoom: 22,
      bounds, tileSize: 256,
      ...(reviewed.matrixPad === undefined ? {} : { matrix: (data: { z: number }) => String(data.z).padStart(reviewed.matrixPad ?? 0, '0') }),
    };
    // Only this reviewed, code-owned source supplies a URL or WMS parameter.
    const layer = reviewed.kind === 'wms'
      ? L.tileLayer.wms(reviewed.url, { ...options, version: '1.3.0', crs: L.CRS.EPSG3857, layers: reviewed.layers, styles: reviewed.styles ?? '', format: reviewed.format ?? 'image/jpeg', transparent: false })
      : L.tileLayer(reviewed.url, options);
    const coverage = () => setOutsideCoverage(!!bounds && !bounds.intersects(instance.getBounds()));
    instance.attributionControl.addAttribution(reviewed.attribution);
    layer.on('load', () => { if (!failed) setBackgroundStatus('ready'); });
    layer.on('tileerror', () => {
      if (failed) return;
      failed = true; layer.remove(); tiles.current = null;
      setBackgroundStatus('failed');
      setMapError(`${reviewed.label} could not load. Its background was removed; the supplied outlines and editing controls are unchanged.`);
    });
    instance.on('moveend', coverage); coverage();
    tiles.current = layer; layer.addTo(instance);
    return () => { instance.off('moveend', coverage); layer.off(); layer.remove(); if (tiles.current === layer) tiles.current = null; instance.attributionControl.removeAttribution(reviewed.attribution); };
    // Metadata identity, not array/object creation on each geometry render, keeps
    // the tile layer stable while a corner is dragged or a draft is updated.
  }, [ready, backgroundAllowed, sourceSignature, backgroundAttempt]);
  useEffect(() => { hideBackground(); }, [props.country, props.region]);

  useEffect(() => {
    const current = JSON.stringify(props.geometry);
    if (current === acknowledgedGeometry.current) return;
    // A different selected field or restored draft starts a different undo
    // history. Never restore another field's outline through this button.
    if (current !== expectedGeometry.current) { undo.current = []; setUndoCount(0); focusedCorner.current = null; }
    acknowledgedGeometry.current = current;
    expectedGeometry.current = null;
  }, [props.geometry]);
  useEffect(() => { undo.current = []; setUndoCount(0); focusedCorner.current = null; }, [props.mode]);

  useEffect(() => {
    if (!ready || fitted.current || movedByUser.current || !positionsOf(props).length) return;
    fitSupplied();
  }, [ready, props.geometry, props.reference, props.point]);

  useEffect(() => {
    if (!ready || !outlines.current || !handles.current || !map.current) return;
    const instance = map.current, layers = outlines.current, cornerLayers = handles.current;
    layers.clearLayers(); cornerLayers.clearLayers(); outline.current = null;
    function addShape(geometry: FieldGeometry | null, reference: boolean) {
      const shape = partsOf(geometry).filter(polygon => polygon.length && polygon.every(edge => edge.length >= 3 && edge.every(validPosition)));
      if (!shape.length) return null;
      return L.polygon(shape.map(polygon => polygon.map(edge => edge.map(latLng))), {
        color: reference ? '#945a16' : '#264c36', weight: reference ? 2 : 3,
        dashArray: reference ? '7 5' : undefined, fillColor: reference ? '#e0cba5' : '#91b589',
        fillOpacity: reference ? .12 : .35, fillRule: 'evenodd', interactive: false,
      }).addTo(layers);
    }
    // Read-only candidates are below the supplied outlines. Labels are plain
    // text in React controls, never interpolated into Leaflet popup HTML.
    for (const candidate of props.referenceCandidates ?? []) {
      const shape = partsOf(candidate.geometry).filter(polygon => polygon.length && polygon.every(edge => edge.length >= 3 && edge.every(validPosition)));
      if (!shape.length) continue;
      const candidateLayer = L.polygon(shape.map(polygon => polygon.map(edge => edge.map(latLng))), { color: '#466e98', weight: 2, dashArray: '4 5', fillOpacity: .08, bubblingMouseEvents: false }).addTo(layers);
      candidateLayer.on('click', (event: L.LeafletMouseEvent) => { L.DomEvent.stopPropagation(event.originalEvent); latest.current.onReferenceSelect?.(candidate.id); });
    }
    addShape(props.reference, true);
    outline.current = addShape(props.geometry, false);
    if (props.point && validPosition([props.point.longitude, props.point.latitude])) L.circleMarker([props.point.latitude, props.point.longitude], { radius: 5, color: '#294c38', fillOpacity: 1, interactive: false }).addTo(layers);
    if (props.mode === 'draw' && props.sketch.length) {
      L.polyline(props.sketch.filter(validPosition).map(latLng), { color: '#21543b', weight: 3, interactive: false }).addTo(layers);
      for (const p of props.sketch.filter(validPosition)) L.circleMarker(latLng(p), { radius: 4, color: '#21543b', fillOpacity: 1, interactive: false }).addTo(layers);
    }
    if (props.splitLine.length) {
      L.polyline(props.splitLine.filter(validPosition).map(latLng), { color: '#a13f27', weight: 3, dashArray: '7 4', interactive: false }).addTo(layers);
      for (const p of props.splitLine.filter(validPosition)) L.circleMarker(latLng(p), { radius: 5, color: '#a13f27', fillOpacity: 1, interactive: false }).addTo(layers);
    }
    if (props.mode !== 'edit') return;
    const selected = partsOf(props.geometry)[partRef.current]?.[0] ?? [];
    const cleanups: (() => void)[] = [];
    selected.slice(0, -1).forEach((p, index) => {
      if (!validPosition(p)) return;
      const marker = L.marker(latLng(p), {
        icon: L.divIcon({ className: 'parcel-map-corner', html: '<span aria-hidden="true"></span>', iconSize: [44, 44], iconAnchor: [22, 22] }),
        draggable: true, keyboard: true, autoPan: true, autoPanOnFocus: false,
        title: `Corner ${index + 1}; longitude ${p[0]}, latitude ${p[1]}`,
      }).addTo(cornerLayers);
      marker.on('drag', () => {
        const next = movedCorner(index, position(marker.getLatLng()));
        if (next && outline.current) outline.current.setLatLngs(partsOf(next).map(polygon => polygon.map(edge => edge.map(latLng))));
      });
      marker.on('dragend', () => { focusedCorner.current = null; moveCorner(index, position(marker.getLatLng())); });
      const element = marker.getElement();
      if (!element) return;
      element.setAttribute('role', 'button');
      element.setAttribute('aria-label', `Corner ${index + 1}; longitude ${p[0]}, latitude ${p[1]}`);
      const keydown = (event: KeyboardEvent) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const distance = event.shiftKey ? 10 : 1;
        const pixel = instance.project(marker.getLatLng(), instance.getZoom());
        pixel.x += event.key === 'ArrowLeft' ? -distance : event.key === 'ArrowRight' ? distance : 0;
        pixel.y += event.key === 'ArrowUp' ? -distance : event.key === 'ArrowDown' ? distance : 0;
        focusedCorner.current = index;
        moveCorner(index, position(instance.unproject(pixel, instance.getZoom())));
      };
      element.addEventListener('keydown', keydown);
      cleanups.push(() => element.removeEventListener('keydown', keydown));
      if (focusedCorner.current === index) element.focus({ preventScroll: true });
    });
    return () => { cleanups.forEach(cleanup => cleanup()); };
  }, [ready, props.geometry, props.reference, props.point, props.sketch, props.splitLine, props.mode, props.referenceCandidates, selectedPart]);

  return <div className="parcel-map-editor" inert={props.disabled}>
    <div className="parcel-map-toolbar" aria-label="Map view controls">
      <Button variant="secondary" disabled={!ready} onClick={() => { movedByUser.current = true; map.current?.zoomIn(undefined, { animate: false }); }}>Zoom in</Button>
      <Button variant="secondary" disabled={!ready} onClick={() => { movedByUser.current = true; map.current?.zoomOut(undefined, { animate: false }); }}>Zoom out</Button>
      <Button variant="secondary" disabled={!ready} onClick={fitSupplied}>Fit supplied outlines</Button>
      <Button variant="secondary" disabled={!ready || locating} onClick={useLocation}>{locating ? 'Finding my location…' : 'Use my location'}</Button>
      {parts.length > 1 && <Field label="Part to edit"><select value={selectedPart} onChange={event => { focusedCorner.current = null; setPart(Number(event.target.value)); }}>{parts.map((_, index) => <option value={index} key={index}>Part {index + 1}</option>)}</select></Field>}
    </div>
    <div className="parcel-map-pan" aria-label="Move map view"><Button variant="ghost" disabled={!ready} onClick={() => pan(0, -160)}>Move north</Button><Button variant="ghost" disabled={!ready} onClick={() => pan(0, 160)}>Move south</Button><Button variant="ghost" disabled={!ready} onClick={() => pan(160, 0)}>Move east</Button><Button variant="ghost" disabled={!ready} onClick={() => pan(-160, 0)}>Move west</Button></div>
    <p id={instructionId}>{props.mode === 'draw' ? 'Tap each corner around the field, then choose Close boundary. Drag the map to move the view.' : props.mode === 'split' ? 'Tap outside one edge, then beyond the opposite edge to mark a dividing line. Drag the map to move the view.' : 'Drag a white corner to move it. You can also select a corner and use the arrow keys; hold Shift to move farther. Drag elsewhere to move the map.'}</p>
    {mapError && <Notice kind="warning">{mapError} Your draft is still editable without a background.</Notice>}
    {props.mode !== 'edit' && zoom < 14 && <Notice>Zoom in closer before drawing. This overview does not show your farm's location.</Notice>}
    <div ref={host} className="parcel-map" role="group" aria-label="Field boundary map" aria-describedby={instructionId}/>
    <p className="parcel-map-caption">Your boundary draft, not an official LPIS boundary. Moving or zooming the map does not move its corners. <a href="/leaflet-LICENSE.txt" target="_blank" rel="noreferrer">Map software licence</a></p>
    <div className="parcel-map-background"><Field label="Background map"><select value={sourceId} onChange={event => { if (!event.target.value) hideBackground(); else { setSourceId(event.target.value); setMapError(''); } }}><option value="">No background map</option>{sources.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></Field>
      <label className="parcel-map-consent"><input type="checkbox" checked={backgroundAllowed && !!source} onChange={event => { if (!event.target.checked) hideBackground(); else { setSourceId(sourceId && source ? sourceId : sources[0]?.id ?? ''); setBackgroundAllowed(true); setBackgroundAttempt(value => value + 1); } }}/>Show background map</label>
      <p>The map provider receives the area you view and your IP address, but not your private farm records. Nothing is requested until you turn the background on.</p>
      {source && <p>Map from {source.provider}. <a href={source.sourceUrl} target="_blank" rel="noreferrer">About this map</a> · <a href={source.licenseUrl} target="_blank" rel="noreferrer">Licence and attribution</a>. Photos may have been taken in different years. They do not confirm a current crop, official boundary or claim.</p>}
      {backgroundAllowed && source && <p role="status">{backgroundStatus === 'loading' ? 'Loading the chosen background…' : backgroundStatus === 'failed' ? 'Background unavailable; editing remains available on the neutral map.' : outsideCoverage ? 'This view is outside the documented background coverage. Pan back into its coverage or choose another map.' : 'The chosen background is enabled. Its imagery date may be unknown.'}</p>}
      {outsideCoverage && <Notice kind="warning">This provider has no imagery here. Choose another map or move back into the covered area.</Notice>}
      {backgroundStatus === 'failed' && <Button variant="secondary" onClick={() => setBackgroundAttempt(value => value + 1)}>Try background again</Button>}
      {!backgroundAllowed && <p className="parcel-map-caption">Background off. You can still draw, edit and save your outline.</p>}
    </div>
    {locationMessage && <p role="status">{locationMessage}</p>}
    {!!props.referenceCandidates?.length && <details className="parcel-map-candidates"><summary>Reference parcels on this map</summary><p>Blue dashed outlines are public references, not your fields. Choose one to compare it with your draft; your saved boundary will not change.</p><ul>{props.referenceCandidates.map(candidate => <li key={candidate.id}><Button variant="ghost" onClick={() => props.onReferenceSelect?.(candidate.id)} disabled={!props.onReferenceSelect}>{candidate.label}</Button></li>)}</ul></details>}
    {message && <p className="parcel-map-message" role="status">{message}</p>}
    {props.mode === 'draw' && <div className="parcel-map-toolbar"><Button disabled={props.sketch.length < 3} onClick={() => { props.onGeometry({ type: 'Polygon', coordinates: [[...props.sketch, [...props.sketch[0]]]] }); props.onSketch([]); }}>Close boundary</Button><Button variant="secondary" disabled={!props.sketch.length} onClick={() => props.onSketch(props.sketch.slice(0, -1))}>Undo last corner</Button></div>}
    {props.mode === 'split' && <div className="parcel-map-toolbar"><Button variant="secondary" disabled={!props.splitLine.length} onClick={() => props.onSplitLine(props.splitLine.slice(0, -1))}>Undo dividing line point</Button><Button variant="secondary" disabled={!props.splitLine.length} onClick={() => props.onSplitLine([])}>Redraw dividing line</Button></div>}
    {props.mode === 'edit' && <Button variant="secondary" disabled={!undoCount} onClick={() => { const previous = undo.current.pop(); if (previous) { expectedGeometry.current = JSON.stringify(previous); props.onGeometry(previous); } setUndoCount(undo.current.length); }}>Undo last boundary adjustment</Button>}
    {props.mode === 'edit' && ring.length > 0 && <details className="parcel-map-coordinates"><summary>Adjust corners using coordinates</summary><p>These controls change the selected outer edge. Other parts and excluded inner areas remain as saved. The server checks the resulting outline before saving.</p><div className="parcel-map-corners">{ring.slice(0, -1).map((p, index) => <div className="parcel-map-coordinate-row" key={index}><strong>Corner {index + 1}</strong><Field label="Longitude"><input type="number" min="-180" max="180" step="any" value={p[0]} onChange={event => { if (event.target.value !== '' && Number.isFinite(event.target.valueAsNumber)) moveCorner(index, [event.target.valueAsNumber, p[1]]); }}/></Field><Field label="Latitude"><input type="number" min="-90" max="90" step="any" value={p[1]} onChange={event => { if (event.target.value !== '' && Number.isFinite(event.target.valueAsNumber)) moveCorner(index, [p[0], event.target.valueAsNumber]); }}/></Field><div className="parcel-map-toolbar"><Button variant="ghost" disabled={ring.length >= 500} onClick={() => changeCornerCount(index, true)}>Insert corner after {index + 1}</Button><Button variant="ghost" disabled={ring.length <= 4} onClick={() => changeCornerCount(index, false)}>Remove corner {index + 1}</Button></div></div>)}</div></details>}
  </div>;
}
