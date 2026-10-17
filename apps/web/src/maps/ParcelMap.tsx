import { useEffect, useId, useRef, useState } from 'react';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Button, Field, Notice } from '../components';
import type { FieldGeometry, FieldPoint } from '../pages/FieldsMap';
import { mapSources, type MapSource } from './sources';
import { getSpanishDemoSnapshot, type SpanishDemoSelection } from './spanishDemo';
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
  /** Keep navigation and opt-in backgrounds, without geometry editing. */
  readOnly?: boolean;
  /** Other private saved fields, displayed only in read-only mode. */
  contextOutlines?: { id: string; label: string; geometry: FieldGeometry }[];
  /** Resolves only a retained code-owned public demo image and reference. */
  snapshot?: SpanishDemoSelection | null;
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
export function isDisplayableFieldGeometry(value: unknown): value is FieldGeometry {
  if (!value || typeof value !== 'object' || !('type' in value) || !('coordinates' in value)
    || !['Polygon', 'MultiPolygon'].includes(String(value.type)) || !Array.isArray(value.coordinates)) return false;
  const polygons = value.type === 'Polygon' ? [value.coordinates] : value.coordinates;
  return polygons.length > 0 && polygons.every(polygon => Array.isArray(polygon) && polygon.length > 0
    && polygon.every(edge => Array.isArray(edge) && edge.length >= 4 && edge.every(validPosition)
      && edge[0][0] === edge[edge.length - 1][0] && edge[0][1] === edge[edge.length - 1][1]));
}
function contextOutlinesOf(props: ParcelMapProps) {
  if (!props.readOnly || !Array.isArray(props.contextOutlines)) return [];
  const counts = new Map<string, number>();
  for (const item of props.contextOutlines) if (item && typeof item.id === 'string') counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  return props.contextOutlines.filter(item => item && typeof item.id === 'string' && !!item.id.trim()
    && counts.get(item.id) === 1 && typeof item.label === 'string' && isDisplayableFieldGeometry(item.geometry));
}
function latLng(position: number[]): L.LatLngTuple { return [position[1], position[0]]; }
function position(value: L.LatLng): number[] {
  const wrapped = value.wrap();
  return [Number(wrapped.lng.toFixed(8)), Number(Math.max(-85.05112878, Math.min(85.05112878, wrapped.lat)).toFixed(8))];
}
function positionsOf(props: ParcelMapProps): number[][] {
  const snapshot = getSpanishDemoSnapshot(props.snapshot);
  const points = [props.geometry, props.reference, snapshot?.field.geometry ?? null, ...contextOutlinesOf(props).map(item => item.geometry)].flatMap(geometry => partsOf(geometry).flat(2));
  if (props.point) points.push([props.point.longitude, props.point.latitude]);
  return [...points, ...props.sketch, ...props.splitLine].filter(validPosition);
}
function viewport(map: L.Map): ParcelMapBounds {
  const bounds = map.getBounds();
  return bounds.getEast() - bounds.getWest() >= 360 ? [-180, Math.max(-90, bounds.getSouth()), 180, Math.min(90, bounds.getNorth())]
    : [Math.max(-180, bounds.getWest()), Math.max(-90, bounds.getSouth()), Math.min(180, bounds.getEast()), Math.min(90, bounds.getNorth())];
}
function positionCount(parts: number[][][][]) { return parts.reduce((total, polygon) => total + polygon.reduce((sum, edge) => sum + edge.length, 0), 0); }
function cross(a: number[], b: number[], p: number[]) { return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]); }
function onSegment(a: number[], b: number[], p: number[]) {
  return Math.abs(cross(a, b, p)) < 1e-12 && p[0] >= Math.min(a[0], b[0]) - 1e-12 && p[0] <= Math.max(a[0], b[0]) + 1e-12 && p[1] >= Math.min(a[1], b[1]) - 1e-12 && p[1] <= Math.max(a[1], b[1]) + 1e-12;
}
function segmentsTouch(a: number[], b: number[], c: number[], d: number[]) {
  const x = cross(a, b, c), y = cross(a, b, d), z = cross(c, d, a), w = cross(c, d, b);
  return ((x > 1e-12 && y < -1e-12 || y > 1e-12 && x < -1e-12) && (z > 1e-12 && w < -1e-12 || w > 1e-12 && z < -1e-12)) || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}
function insideRing(point: number[], edge: number[][]) {
  let inside = false;
  for (let i = 0; i < edge.length - 1; i += 1) {
    const a = edge[i], b = edge[i + 1];
    if (onSegment(a, b, point)) return false;
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
function ringsTouch(a: number[][], b: number[][]) {
  return a.slice(0, -1).some((p, i) => b.slice(0, -1).some((q, j) => segmentsTouch(p, a[i + 1], q, b[j + 1])));
}
function excludedAreaError(points: number[][], polygon: number[][][]) {
  if (points.length < 3 || points.length > 499 || points.some(p => !validPosition(p))) return 'An excluded area needs between 3 and 499 valid corners.';
  if (new Set(points.map(p => `${p[0]},${p[1]}`)).size !== points.length) return 'Use each corner once; Close excluded area repeats the first corner for you.';
  const edge = [...points, points[0]];
  for (let i = 0; i < points.length; i += 1) for (let j = i + 1; j < points.length; j += 1) {
    if (j !== i + 1 && !(i === 0 && j === points.length - 1) && segmentsTouch(edge[i], edge[i + 1], edge[j], edge[j + 1])) return 'The excluded area cannot cross or touch itself. Undo a corner and redraw it.';
  }
  if (Math.abs(points.reduce((sum, p, i) => sum + p[0] * edge[i + 1][1] - edge[i + 1][0] * p[1], 0)) < 1e-12) return 'The excluded area must enclose an area, not just a line.';
  if (!polygon[0] || points.some(p => !insideRing(p, polygon[0])) || ringsTouch(edge, polygon[0])) return 'Keep the whole excluded area strictly inside the selected part, without touching its outer edge.';
  if (polygon.slice(1).some(hole => ringsTouch(edge, hole) || insideRing(points[0], hole) || insideRing(hole[0], edge))) return 'Excluded areas cannot touch, overlap or contain each other.';
  return '';
}
type EditSnapshot = { geometry: FieldGeometry; sketch: number[][]; part: number; ring: number; drawingHole: boolean };

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
  const snapshotImage = useRef<L.ImageOverlay | null>(null);
  const deviceLocation = useRef<L.LayerGroup | null>(null);
  const partRef = useRef(0);
  const ringRef = useRef(0);
  const drawingHoleRef = useRef(false);
  const snapRef = useRef(false);
  const editBinding = useRef('');
  const focusedCorner = useRef<number | null>(null);
  const cornerMarkers = useRef(new Map<number, L.Marker>());
  const nudgeDistance = useRef(1);
  const undo = useRef<EditSnapshot[]>([]);
  const acknowledgedGeometry = useRef(JSON.stringify(props.geometry));
  const expectedGeometry = useRef<string | null>(null);
  const fitted = useRef(false);
  const movedByUser = useRef(false);
  const [ready, setReady] = useState(false);
  const [part, setPart] = useState(0);
  const [selectedRing, setSelectedRing] = useState(0);
  const [selectedCorner, setSelectedCorner] = useState<number | null>(null);
  const [cornerPosition, setCornerPosition] = useState({ longitude: '', latitude: '' });
  const [nudgeMetres, setNudgeMetres] = useState(1);
  nudgeDistance.current = nudgeMetres;
  const [drawingHole, setDrawingHole] = useState(false);
  const [snapToComparison, setSnapToComparison] = useState(false);
  const [confirmation, setConfirmation] = useState<{ kind: 'close' | 'cancel' | 'remove'; binding: string } | null>(null);
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
  const [snapshotStatus, setSnapshotStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const alive = useRef(false);
  const locationRequest = useRef(0);
  const sources = mapSources(props.country, props.region);
  const source = sources.find(item => item.id === sourceId);
  const sourceSignature = JSON.stringify(source ?? null);
  const snapshot = getSpanishDemoSnapshot(props.snapshot);
  const snapshotBinding = snapshot ? `${snapshot.id}:${snapshot.field.reference}:${snapshot.image.sha256}` : '';
  const instructionId = useId();
  const parts = partsOf(props.geometry);
  const selectedPart = Math.min(part, Math.max(0, parts.length - 1));
  partRef.current = selectedPart;
  const ringIndex = Math.min(selectedRing, Math.max(0, (parts[selectedPart]?.length ?? 1) - 1));
  ringRef.current = ringIndex;
  drawingHoleRef.current = drawingHole && props.mode === 'edit';
  snapRef.current = snapToComparison && !!(props.reference || snapshot);
  const ring = parts[selectedPart]?.[ringIndex] ?? [];
  const binding = JSON.stringify([props.geometry, props.reference, props.sketch, props.mode, selectedPart, ringIndex, drawingHole]);
  editBinding.current = binding;

  function fitSupplied() {
    const instance = map.current;
    if (!instance) return;
    const points = positionsOf(latest.current);
    if (!points.length) { setMessage('No field location has been supplied. Pan and zoom to the place you know, or add coordinates before drawing.'); return; }
    instance.fitBounds(L.latLngBounds(points.map(latLng)), { padding: [36, 36], maxZoom: 19, animate: false });
    fitted.current = true;
    setMessage('Showing your supplied locations. The view did not change any field coordinates.');
  }
  function focusSelected() {
    const current = latest.current;
    const retained = getSpanishDemoSnapshot(current.snapshot);
    const points = [current.geometry, retained?.field.geometry ?? null].flatMap(geometry => partsOf(geometry).flat(2)).filter(validPosition);
    if (current.point && validPosition([current.point.longitude, current.point.latitude])) points.push([current.point.longitude, current.point.latitude]);
    if (!map.current || !points.length) return;
    map.current.fitBounds(L.latLngBounds(points.map(latLng)), { padding: [42, 42], maxZoom: 19, animate: false });
    fitted.current = true;
  }
  function rememberEdit() {
    const previous = latest.current.geometry;
    if (!previous) return;
    undo.current = [...undo.current.slice(-29), { geometry: structuredClone(previous), sketch: structuredClone(latest.current.sketch), part: partRef.current, ring: ringRef.current, drawingHole: drawingHoleRef.current }];
    setUndoCount(undo.current.length);
  }
  function undoLast() {
    if (latest.current.readOnly || latest.current.disabled) return;
    const previous = undo.current.pop();
    if (previous) {
      expectedGeometry.current = JSON.stringify(previous.geometry);
      latest.current.onGeometry(previous.geometry); latest.current.onSketch(previous.sketch);
      setPart(previous.part); setSelectedRing(previous.ring); setDrawingHole(previous.drawingHole);
      setSelectedCorner(null); focusedCorner.current = null; setConfirmation(null);
      setMessage('Last boundary adjustment undone, including its unfinished excluded-area points.');
    }
    setUndoCount(undo.current.length);
  }
  function commit(next: FieldGeometry) {
    if (latest.current.disabled || latest.current.readOnly) return;
    if (positionCount(partsOf(next)) > 1000) { setMessage('The whole boundary can contain at most 1,000 positions, including the closing corners.'); return; }
    rememberEdit();
    expectedGeometry.current = JSON.stringify(next);
    latest.current.onGeometry(next);
  }
  function movedCorner(index: number, nextPosition: number[]): FieldGeometry | null {
    if (latest.current.disabled || latest.current.readOnly) return null;
    const current = latest.current.geometry;
    const next = structuredClone(partsOf(current));
    const edge = next[partRef.current]?.[ringRef.current];
    if (!current || !edge || !edge[index] || !validPosition(nextPosition)) return null;
    edge[index] = nextPosition;
    if (index === 0) edge[edge.length - 1] = [...nextPosition];
    return current.type === 'Polygon' ? { type: 'Polygon', coordinates: next[0] } : { type: 'MultiPolygon', coordinates: next };
  }
  function moveCorner(index: number, nextPosition: number[]) {
    const next = movedCorner(index, nextPosition);
    if (next) commit(next);
  }
  function nudgeCorner(index: number, east: number, north: number, multiplier = 1) {
    const edge = partsOf(latest.current.geometry)[partRef.current]?.[ringRef.current];
    const point = edge?.[index];
    if (!point || latest.current.readOnly || latest.current.disabled) return;
    const distance = nudgeDistance.current * multiplier;
    const radians = 180 / Math.PI;
    const latitude = point[1] + north * distance / 6_371_000 * radians;
    const longitude = point[0] + east * distance / (6_371_000 * Math.max(.001, Math.cos(point[1] / radians))) * radians;
    moveCorner(index, [longitude, latitude]);
  }
  function changeCornerCount(index: number, insert: boolean) {
    const current = latest.current.geometry;
    const next = structuredClone(partsOf(current));
    const currentRing = next[partRef.current]?.[ringRef.current];
    if (!current || !currentRing || latest.current.disabled || latest.current.readOnly) return;
    const outer = currentRing.slice(0, -1);
    if (insert) {
      if (outer.length >= 499 || positionCount(next) >= 1000) return;
      const before = outer[index], after = outer[(index + 1) % outer.length];
      outer.splice(index + 1, 0, [(before[0] + after[0]) / 2, (before[1] + after[1]) / 2]);
    } else {
      if (outer.length <= 3) return;
      outer.splice(index, 1);
    }
    next[partRef.current][ringRef.current] = [...outer, [...outer[0]]];
    commit(current.type === 'Polygon' ? { type: 'Polygon', coordinates: next[0] } : { type: 'MultiPolygon', coordinates: next });
  }
  function pointerPosition(value: L.LatLng): number[] {
    const instance = map.current, reference = latest.current.reference ?? getSpanishDemoSnapshot(latest.current.snapshot)?.field.geometry;
    if (!instance || !snapRef.current || !reference) return position(value);
    const referenceParts = partsOf(reference);
    if (positionCount(referenceParts) > 1000) return position(value);
    const pointer = instance.latLngToContainerPoint(value);
    let best: L.Point | null = null, distance = 10 * 10;
    for (const polygon of referenceParts) for (const edge of polygon) for (let i = 0; i < edge.length - 1; i += 1) {
      if (!validPosition(edge[i]) || !validPosition(edge[i + 1])) continue;
      const a = instance.latLngToContainerPoint(latLng(edge[i])), b = instance.latLngToContainerPoint(latLng(edge[i + 1]));
      const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
      const t = length ? Math.max(0, Math.min(1, ((pointer.x - a.x) * dx + (pointer.y - a.y) * dy) / length)) : 0;
      const candidate = L.point(a.x + t * dx, a.y + t * dy);
      const gap = (candidate.x - pointer.x) ** 2 + (candidate.y - pointer.y) ** 2;
      if (gap <= distance) { best = candidate; distance = gap; }
    }
    return position(best ? instance.containerPointToLatLng(best) : value);
  }
  function requestConfirmation(kind: 'close' | 'cancel' | 'remove') {
    if (latest.current.disabled || latest.current.readOnly) return;
    if (kind === 'close') {
      const error = excludedAreaError(latest.current.sketch, partsOf(latest.current.geometry)[partRef.current] ?? []);
      if (error) { setMessage(error); return; }
    }
    setConfirmation({ kind, binding: editBinding.current });
  }
  function confirmChange() {
    if (!confirmation || latest.current.disabled || latest.current.readOnly || confirmation.binding !== editBinding.current) { setConfirmation(null); return; }
    const current = latest.current.geometry, next = structuredClone(partsOf(current)), polygon = next[partRef.current];
    if (!current || !polygon) return;
    if (confirmation.kind === 'close') {
      const points = latest.current.sketch, error = excludedAreaError(points, polygon);
      if (error) { setMessage(error); setConfirmation(null); return; }
      if (polygon.length >= 20 || positionCount(next) + points.length + 1 > 1000) { setMessage('Keep at most 19 excluded areas per part and 1,000 positions across the whole boundary.'); setConfirmation(null); return; }
      polygon.push([...structuredClone(points), [...points[0]]]);
      commit(current.type === 'Polygon' ? { type: 'Polygon', coordinates: next[0] } : { type: 'MultiPolygon', coordinates: next });
      setSelectedRing(polygon.length - 1); setDrawingHole(false); latest.current.onSketch([]);
      setMessage('Excluded area added to this boundary draft. This does not determine legal eligibility. You can undo this change.');
    } else if (confirmation.kind === 'cancel') {
      rememberEdit(); setDrawingHole(false); latest.current.onSketch([]);
      setMessage('Unfinished excluded area cancelled. The boundary is unchanged; Undo restores the unfinished points.');
    } else if (ringRef.current > 0 && polygon[ringRef.current]) {
      polygon.splice(ringRef.current, 1);
      commit(current.type === 'Polygon' ? { type: 'Polygon', coordinates: next[0] } : { type: 'MultiPolygon', coordinates: next });
      setSelectedRing(0);
      setMessage('Excluded area removed from this draft only. The earlier outline remains in history after saving. You can undo this change.');
    }
    focusedCorner.current = null; setConfirmation(null);
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
      zoomSnap: snapshot ? 0.1 : 1,
      zoomControl: false, attributionControl: true, scrollWheelZoom: false,
      doubleClickZoom: false, worldCopyJump: false, maxBounds: [[-85.05112878, -180], [85.05112878, 180]],
      zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false,
    });
    instance.attributionControl.setPrefix('<a href="https://leafletjs.com/" title="Map software">Leaflet</a>');
    map.current = instance;
    alive.current = true;
    outlines.current = L.layerGroup().addTo(instance);
    handles.current = L.layerGroup().addTo(instance);
    deviceLocation.current = L.layerGroup().addTo(instance);
    const announceView = () => { setZoom(instance.getZoom()); latest.current.onViewportChange?.(viewport(instance)); };
    const userMoved = (event: L.LeafletEvent) => {
      // Leaflet drag/zoom changes the viewport only. Geometry is separate.
      if (event.type === 'dragstart') movedByUser.current = true;
    };
    instance.on('moveend', announceView);
    instance.on('dragstart', userMoved);
    instance.on('click', (event: L.LeafletMouseEvent) => {
      const current = latest.current;
      if (current.disabled || current.readOnly) return;
      const addingHole = current.mode === 'edit' && drawingHoleRef.current;
      if ((current.mode === 'draw' || current.mode === 'split' || addingHole) && instance.getZoom() < 14) { setMessage('Zoom in closer before drawing. This view covers too large an area.'); return; }
      if (current.mode === 'draw' || addingHole) {
        if (current.sketch.length >= 499 || (addingHole && positionCount(partsOf(current.geometry)) + current.sketch.length + 2 > 1000)) { setMessage('This outline has reached its position limit. Undo a corner or finish this area before adding more.'); return; }
        const nextPosition = pointerPosition(event.latlng);
        if (addingHole) {
          const polygon = partsOf(current.geometry)[partRef.current];
          if (!polygon?.[0] || !insideRing(nextPosition, polygon[0]) || polygon.slice(1).some(hole => insideRing(nextPosition, hole) || hole.slice(0, -1).some((p, i) => onSegment(p, hole[i + 1], nextPosition)))) { setMessage('Place this excluded-area corner inside the selected part, away from its outer edge and existing excluded areas.'); return; }
        }
        current.onSketch([...current.sketch, nextPosition]); setConfirmation(null);
      } else if (current.mode === 'split') {
        if (current.splitLine.length >= 2) { setMessage('Two dividing-line points are recorded. Choose Redraw dividing line to start again.'); return; }
        current.onSplitLine([...current.splitLine, pointerPosition(event.latlng)]);
      }
    });
    const observer = new ResizeObserver(() => instance.invalidateSize({ animate: false, pan: false }));
    observer.observe(host.current);
    announceView();
    setReady(true);
    return () => { alive.current = false; locationRequest.current += 1; observer.disconnect(); instance.remove(); map.current = null; outlines.current = null; handles.current = null; outline.current = null; tiles.current = null; snapshotImage.current = null; deviceLocation.current = null; fitted.current = false; movedByUser.current = false; };
  }, []);

  useEffect(() => {
    snapshotImage.current?.remove(); snapshotImage.current = null;
    if (!ready || !map.current || !snapshot) return;
    let active = true; setSnapshotStatus('loading');
    const [west, south, east, north] = snapshot.image.bbox_3857;
    const bounds = L.latLngBounds(L.CRS.EPSG3857.unproject(L.point(west, south)), L.CRS.EPSG3857.unproject(L.point(east, north)));
    const layer = L.imageOverlay(snapshot.image.path, bounds, { pane: 'tilePane', interactive: false, opacity: 1, alt: 'Retained PNOA aerial photograph of the public Spanish demo area' });
    layer.on('load', () => { if (active) setSnapshotStatus('ready'); });
    layer.on('error', () => { if (active) { layer.remove(); setSnapshotStatus('failed'); } });
    snapshotImage.current = layer; layer.addTo(map.current);
    return () => { active = false; layer.off(); layer.remove(); if (snapshotImage.current === layer) snapshotImage.current = null; };
  }, [ready, snapshotBinding]);

  useEffect(() => {
    const instance = map.current;
    tiles.current?.remove(); tiles.current = null;
    setMapError(''); setOutsideCoverage(false);
    if (!ready || !instance || snapshot || !backgroundAllowed || !source) { setBackgroundStatus('off'); return; }
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
  }, [ready, backgroundAllowed, sourceSignature, backgroundAttempt, snapshotBinding]);
  useEffect(() => { hideBackground(); }, [props.country, props.region]);
  useEffect(() => { hideBackground(); }, [snapshotBinding]);

  useEffect(() => {
    const current = JSON.stringify(props.geometry);
    if (current === acknowledgedGeometry.current) return;
    // A different selected field or restored draft starts a different undo
    // history. Never restore another field's outline through this button.
    if (current !== expectedGeometry.current) {
      undo.current = []; setUndoCount(0); focusedCorner.current = null;
      setSelectedCorner(null);
      setPart(0); setSelectedRing(0); setDrawingHole(false); setConfirmation(null);
    }
    acknowledgedGeometry.current = current;
    expectedGeometry.current = null;
  }, [props.geometry]);
  useEffect(() => { undo.current = []; setUndoCount(0); focusedCorner.current = null; setPart(0); setSelectedRing(0); setDrawingHole(false); setConfirmation(null); }, [props.mode]);
  useEffect(() => { setSnapToComparison(false); }, [props.reference]);
  useEffect(() => { setSelectedCorner(null); }, [selectedPart, ringIndex, props.mode, drawingHole]);
  useEffect(() => {
    const point = selectedCorner === null ? null : ring[selectedCorner];
    setCornerPosition({ longitude: point ? String(point[0]) : '', latitude: point ? String(point[1]) : '' });
    for (const [index, marker] of cornerMarkers.current) {
      marker.getElement()?.classList.toggle('is-selected', index === selectedCorner);
      marker.setZIndexOffset(index === selectedCorner ? 1000 : 0);
    }
  }, [selectedCorner, props.geometry, selectedPart, ringIndex, ready]);
  useEffect(() => { setConfirmation(current => current && current.binding !== binding ? null : current); }, [binding]);

  useEffect(() => {
    if (!ready || fitted.current || movedByUser.current || !positionsOf(props).length) return;
    if (snapshot) focusSelected(); else fitSupplied();
  }, [ready, props.geometry, props.reference, props.point?.latitude, props.point?.longitude, props.contextOutlines, props.readOnly, snapshotBinding]);

  useEffect(() => {
    if (!ready || !outlines.current || !handles.current || !map.current) return;
    const instance = map.current, layers = outlines.current, cornerLayers = handles.current;
    layers.clearLayers(); cornerLayers.clearLayers(); outline.current = null;
    cornerMarkers.current.clear();
    function addShape(geometry: FieldGeometry | null, reference: boolean) {
      const shape = partsOf(geometry).filter(polygon => polygon.length && polygon.every(edge => edge.length >= 3 && edge.every(validPosition)));
      if (!shape.length) return null;
      return L.polygon(shape.map(polygon => polygon.map(edge => edge.map(latLng))), {
        color: reference ? '#945a16' : '#264c36', weight: reference ? 2 : 3,
        dashArray: reference ? '7 5' : undefined, fillColor: reference ? '#e0cba5' : '#91b589',
        fillOpacity: reference ? .12 : .35, fillRule: 'evenodd', interactive: false,
      }).addTo(layers);
    }
    // Private farm context stays below the selected outline and has no edit or
    // selection handler. Tooltip content is a text node, never source HTML.
    for (const context of contextOutlinesOf(props)) {
      const label = document.createElement('span');
      label.textContent = /^D\d{2}\b/.exec(context.label)?.[0] ?? context.label;
      label.title = context.label; label.setAttribute('aria-label', context.label);
      L.polygon(partsOf(context.geometry).map(polygon => polygon.map(edge => edge.map(latLng))), {
        color: '#557d98', weight: 2, dashArray: '5 5', fillColor: '#91b6cb', fillOpacity: .1,
        fillRule: 'evenodd', interactive: false, bubblingMouseEvents: false,
      }).bindTooltip(label, { permanent: true, direction: 'center', className: 'parcel-map-context-label', opacity: 1 }).addTo(layers);
    }
    // Read-only candidates are below the supplied outlines. Labels are plain
    // text in React controls, never interpolated into Leaflet popup HTML.
    for (const candidate of props.referenceCandidates ?? []) {
      const shape = partsOf(candidate.geometry).filter(polygon => polygon.length && polygon.every(edge => edge.length >= 3 && edge.every(validPosition)));
      if (!shape.length) continue;
      // A read-only candidate must not swallow clicks intended for drawing.
      const candidateLayer = L.polygon(shape.map(polygon => polygon.map(edge => edge.map(latLng))), { color: '#466e98', weight: 2, dashArray: '4 5', fillOpacity: .08, bubblingMouseEvents: false, interactive: !props.readOnly && props.mode === 'edit' && !drawingHole }).addTo(layers);
      candidateLayer.on('click', (event: L.LeafletMouseEvent) => { L.DomEvent.stopPropagation(event.originalEvent); if (!latest.current.readOnly) latest.current.onReferenceSelect?.(candidate.id); });
    }
    if (snapshot && isDisplayableFieldGeometry(snapshot.field.geometry)) {
      if (props.reference && JSON.stringify(props.reference) !== JSON.stringify(snapshot.field.geometry)) addShape(props.reference, true);
      L.polygon(partsOf(snapshot.field.geometry).map(polygon => polygon.map(edge => edge.map(latLng))), {
        color: '#194d36', weight: 4, fillColor: '#487f55', fillOpacity: .08, fillRule: 'evenodd', interactive: false,
      }).addTo(layers);
      if (isDisplayableFieldGeometry(props.geometry)) {
        outline.current = L.polygon(partsOf(props.geometry).map(polygon => polygon.map(edge => edge.map(latLng))), {
          color: '#c87524', weight: 3, dashArray: '8 5', fillColor: '#e4aa61', fillOpacity: .07, fillRule: 'evenodd', interactive: false,
        }).addTo(layers);
        const signature = (edge: number[][]) => edge.slice(0, -1).map(point => `${point[0]},${point[1]}`).sort().join(';');
        const privateHoles = new Set(partsOf(props.geometry).flatMap(polygon => polygon.slice(1)).map(signature));
        for (const hole of partsOf(snapshot.field.geometry).flatMap(polygon => polygon.slice(1))) {
          if (privateHoles.has(signature(hole))) continue;
          L.polygon(hole.map(latLng), { color: '#a73f32', weight: 3, fillColor: '#c9614e', fillOpacity: .3, interactive: false }).addTo(layers);
        }
      }
    } else {
      addShape(props.reference, true);
      outline.current = addShape(props.geometry, false);
    }
    if (props.point && validPosition([props.point.longitude, props.point.latitude])) L.circleMarker([props.point.latitude, props.point.longitude], { radius: 5, color: '#294c38', fillOpacity: 1, interactive: false }).addTo(layers);
    if ((props.mode === 'draw' || props.mode === 'edit') && props.sketch.length) {
      const color = props.mode === 'edit' ? '#984b35' : '#21543b';
      L.polyline(props.sketch.filter(validPosition).map(latLng), { color, weight: 3, dashArray: props.mode === 'edit' ? '4 4' : undefined, interactive: false }).addTo(layers);
      for (const p of props.sketch.filter(validPosition)) L.circleMarker(latLng(p), { radius: 4, color, fillOpacity: 1, interactive: false }).addTo(layers);
    }
    if (props.splitLine.length) {
      L.polyline(props.splitLine.filter(validPosition).map(latLng), { color: '#a13f27', weight: 3, dashArray: '7 4', interactive: false }).addTo(layers);
      for (const p of props.splitLine.filter(validPosition)) L.circleMarker(latLng(p), { radius: 5, color: '#a13f27', fillOpacity: 1, interactive: false }).addTo(layers);
    }
    if (props.mode !== 'edit' || props.readOnly) return;
    const polygon = partsOf(props.geometry)[selectedPart] ?? [];
    if (!drawingHole) polygon.slice(1).forEach((hole, index) => {
      if (!hole.every(validPosition)) return;
      const area = L.polyline(hole.map(latLng), { color: '#984b35', weight: index + 1 === ringIndex ? 5 : 3, bubblingMouseEvents: false }).addTo(layers);
      area.on('click', (event: L.LeafletMouseEvent) => { L.DomEvent.stopPropagation(event.originalEvent); if (!latest.current.disabled) { setSelectedRing(index + 1); focusedCorner.current = null; setConfirmation(null); } });
    });
    if (drawingHole) return;
    const selected = polygon[ringIndex] ?? [];
    const handleBinding = editBinding.current;
    const cleanups: (() => void)[] = [];
    selected.slice(0, -1).forEach((p, index) => {
      if (!validPosition(p)) return;
      const marker = L.marker(latLng(p), {
        icon: L.divIcon({ className: 'parcel-map-corner', html: '<span aria-hidden="true"></span>', iconSize: [44, 44], iconAnchor: [22, 22] }),
        draggable: !props.disabled, keyboard: true, autoPan: true, autoPanOnFocus: false,
        title: `${ringIndex ? 'Excluded area' : 'Outer edge'} corner ${index + 1}; longitude ${p[0]}, latitude ${p[1]}`,
      }).addTo(cornerLayers);
      cornerMarkers.current.set(index, marker);
      marker.on('click', () => { setSelectedCorner(index); focusedCorner.current = null; });
      marker.on('dragstart', () => { setSelectedCorner(index); });
      marker.on('drag', () => {
        if (latest.current.disabled || editBinding.current !== handleBinding) return;
        const nextPosition = pointerPosition(marker.getLatLng());
        marker.setLatLng(latLng(nextPosition));
        const next = movedCorner(index, nextPosition);
        if (next && outline.current) outline.current.setLatLngs(partsOf(next).map(polygon => polygon.map(edge => edge.map(latLng))));
      });
      marker.on('dragend', () => { if (!latest.current.disabled && editBinding.current === handleBinding) { focusedCorner.current = null; moveCorner(index, pointerPosition(marker.getLatLng())); } });
      const element = marker.getElement();
      if (!element) return;
      element.classList.toggle('is-selected', index === selectedCorner);
      element.setAttribute('data-corner', String(index + 1));
      marker.setZIndexOffset(index === selectedCorner ? 1000 : 0);
      element.setAttribute('role', 'button');
      element.setAttribute('aria-label', `${ringIndex ? 'Excluded area corner' : 'Corner'} ${index + 1}; longitude ${p[0]}, latitude ${p[1]}`);
      const selectCorner = () => setSelectedCorner(index);
      element.addEventListener('focus', selectCorner);
      const keydown = (event: KeyboardEvent) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        if (latest.current.disabled || editBinding.current !== handleBinding) return;
        setSelectedCorner(index);
        focusedCorner.current = index;
        nudgeCorner(index, event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0, event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0, event.shiftKey ? 10 : 1);
      };
      element.addEventListener('keydown', keydown);
      cleanups.push(() => element.removeEventListener('keydown', keydown));
      cleanups.push(() => element.removeEventListener('focus', selectCorner));
      if (focusedCorner.current === index) element.focus({ preventScroll: true });
    });
    return () => { cleanups.forEach(cleanup => cleanup()); };
  }, [ready, props.geometry, props.reference, props.point?.latitude, props.point?.longitude, props.sketch, props.splitLine, props.mode, props.disabled, props.readOnly, props.contextOutlines, props.referenceCandidates, selectedPart, ringIndex, drawingHole, snapshotBinding]);

  return <div className="parcel-map-editor" inert={props.disabled}>
    <div className="parcel-map-toolbar" aria-label="Map view controls">
      <Button variant="secondary" disabled={!ready} onClick={() => { movedByUser.current = true; map.current?.zoomIn(undefined, { animate: false }); }}>Zoom in</Button>
      <Button variant="secondary" disabled={!ready} onClick={() => { movedByUser.current = true; map.current?.zoomOut(undefined, { animate: false }); }}>Zoom out</Button>
      {snapshot && <Button variant="secondary" disabled={!ready} onClick={() => { movedByUser.current = true; focusSelected(); }}>Focus selected field</Button>}
      <Button variant="secondary" disabled={!ready} onClick={fitSupplied}>Fit supplied outlines</Button>
      {!props.readOnly && <Button variant="secondary" disabled={!ready || locating} onClick={useLocation}>{locating ? 'Finding my location…' : 'Use my location'}</Button>}
      {!props.readOnly && parts.length > 1 && <Field label="Part to edit"><select value={selectedPart} disabled={drawingHole} onChange={event => { focusedCorner.current = null; setPart(Number(event.target.value)); setSelectedRing(0); setConfirmation(null); }}>{parts.map((_, index) => <option value={index} key={index}>Part {index + 1}</option>)}</select></Field>}
    </div>
    {!props.readOnly && props.mode === 'edit' && <div className="parcel-map-edit-actions"><span>Select a corner to fine-tune it. Nothing is applied to the farm yet.</span><Button variant="secondary" disabled={!undoCount} onClick={undoLast}>Undo last boundary adjustment</Button></div>}
    {!props.readOnly && <div className="parcel-map-pan" aria-label="Move map view"><Button variant="ghost" disabled={!ready} onClick={() => pan(0, -160)}>Move north</Button><Button variant="ghost" disabled={!ready} onClick={() => pan(0, 160)}>Move south</Button><Button variant="ghost" disabled={!ready} onClick={() => pan(160, 0)}>Move east</Button><Button variant="ghost" disabled={!ready} onClick={() => pan(-160, 0)}>Move west</Button></div>}
    <p id={instructionId}>{props.readOnly ? 'Drag to look around, or zoom in for a closer view.' : props.mode === 'draw' ? 'Tap each corner around the field, then choose Close boundary. Drag the map to look around.' : props.mode === 'split' ? 'Tap outside one edge, then beyond the opposite edge to mark the dividing line.' : drawingHole ? 'Tap around the gap, then choose Close excluded area.' : 'Click a corner to select it, then drag or fine-tune it below. Drag between corners to look around.'}</p>
    {mapError && <Notice kind="warning">{mapError} {props.readOnly ? 'The saved outline remains available without a background.' : 'Your draft is still editable without a background.'}</Notice>}
    {!props.readOnly && (props.mode !== 'edit' || drawingHole) && zoom < 14 && <Notice>Zoom in closer before drawing. This overview does not show your farm's location.</Notice>}
    <div ref={host} className="parcel-map" role="group" aria-label="Field boundary map" aria-describedby={instructionId}/>
    {!props.readOnly && props.mode === 'edit' && !drawingHole && ring.length > 0 && <section className="parcel-map-fine-edit" aria-label="Fine-tune a boundary corner">
      <div className="parcel-map-fine-heading"><h3>Fine-tune a corner</h3><span>Draft only</span></div>
      <Field label="Selected boundary corner"><select value={selectedCorner ?? ''} onChange={event => { focusedCorner.current = null; setSelectedCorner(event.target.value === '' ? null : Number(event.target.value)); }}><option value="">Choose a corner, or click one on the map</option>{ring.slice(0, -1).map((_, index) => <option key={index} value={index}>Corner {index + 1}</option>)}</select></Field>
      {selectedCorner !== null && ring[selectedCorner] && <Button variant="ghost" onClick={() => { const instance = map.current; if (!instance) return; movedByUser.current = true; instance.setView(latLng(ring[selectedCorner]), Math.max(instance.getZoom(), 18), { animate: false }); }}>Focus this corner</Button>}
      {selectedCorner !== null && ring[selectedCorner] ? <><div className="parcel-map-fine-coordinates"><Field label="Selected corner longitude"><input inputMode="decimal" value={cornerPosition.longitude} onChange={event => setCornerPosition(previous => ({ ...previous, longitude: event.target.value }))}/></Field><Field label="Selected corner latitude"><input inputMode="decimal" value={cornerPosition.latitude} onChange={event => setCornerPosition(previous => ({ ...previous, latitude: event.target.value }))}/></Field><Button variant="secondary" onClick={() => { const point = [Number(cornerPosition.longitude), Number(cornerPosition.latitude)]; if (!cornerPosition.longitude.trim() || !cornerPosition.latitude.trim() || !validPosition(point)) { setMessage('Enter valid longitude and latitude with a decimal point. Your corner has not moved.'); return; } focusedCorner.current = null; moveCorner(selectedCorner, point); setMessage('Corner position changed in this draft. Undo restores the earlier position.'); }}>Apply corner position</Button></div><div className="parcel-map-nudges"><Field label="Nudge distance"><select value={nudgeMetres} onChange={event => setNudgeMetres(Number(event.target.value))}><option value={0.1}>About 10 cm</option><option value={1}>About 1 m</option><option value={5}>About 5 m</option></select></Field>{([['north',0,1],['south',0,-1],['east',1,0],['west',-1,0]] as const).map(([direction,east,north]) => <Button key={direction} variant="secondary" onClick={() => { focusedCorner.current = null; nudgeCorner(selectedCorner,east,north); }}>Nudge {direction}</Button>)}</div><p>Drag the selected corner, type its coordinates, or use arrow keys while that corner is focused. Shift moves ten nudge steps. Distances are approximate; typed coordinates and nudges do not snap.</p></> : <p>Click a white corner, or choose its number above. The selected corner turns blue. Dragging the map between corners only moves the view.</p>}
    </section>}
    {!snapshot && <details className="parcel-map-map-details"><summary>Map details and licence</summary><p>Your saved outline or draft is not an official LPIS update. Moving the view does not move any coordinates. <a href="/leaflet-LICENSE.txt" target="_blank" rel="noreferrer">Map software licence</a></p></details>}
    {!props.readOnly && <>
    <fieldset className="parcel-map-comparison"><legend>Comparison outline</legend><label className="parcel-map-consent"><input type="checkbox" checked={snapToComparison && !!(props.reference || snapshot)} disabled={!props.reference && !snapshot} onChange={event => setSnapToComparison(event.target.checked)}/>Help pointer clicks and drags follow the comparison outline</label><p>{props.reference || snapshot ? 'Optional: pointer moves within 10 screen pixels follow the selected comparison edge. Turning this on does not move any corners; typed coordinates and nudges remain exact inputs. The reference itself cannot be changed here.' : 'Choose a comparison outline first. Public candidates are not used until you choose one for comparison.'}</p></fieldset>
    {props.mode === 'edit' && parts[selectedPart] && <fieldset className="parcel-map-exclusions"><legend>Excluded area</legend><p>An excluded area is a hole in this private boundary draft, not a decision about legal eligibility. Other parts and rings are kept; saving a change retains the earlier field outline in history.</p><Field label="Edge to edit"><select value={ringIndex} disabled={drawingHole} onChange={event => { setSelectedRing(Number(event.target.value)); focusedCorner.current = null; setConfirmation(null); }}><option value={0}>Outer edge</option>{parts[selectedPart].slice(1).map((_, index) => <option value={index + 1} key={index}>Excluded area {index + 1}</option>)}</select></Field><div className="parcel-map-toolbar">
      {!drawingHole && !props.sketch.length && <Button variant="secondary" disabled={parts[selectedPart].length >= 20 || positionCount(parts) + 4 > 1000} onClick={() => { setDrawingHole(true); setSelectedRing(0); focusedCorner.current = null; setConfirmation(null); setMessage('Drawing an excluded area inside the selected part. No boundary change is made until you close and confirm it.'); }}>Draw excluded area</Button>}
      {!drawingHole && props.sketch.length > 0 && <Button variant="secondary" onClick={() => { setDrawingHole(true); focusedCorner.current = null; setConfirmation(null); }}>Resume excluded area in part {selectedPart + 1}</Button>}
      {drawingHole && <Button disabled={props.sketch.length < 3} onClick={() => requestConfirmation('close')}>Close excluded area</Button>}
      {!!props.sketch.length && <Button variant="secondary" onClick={() => { props.onSketch(props.sketch.slice(0, -1)); setConfirmation(null); }}>Undo excluded-area corner</Button>}
      {(drawingHole || props.sketch.length > 0) && <Button variant="secondary" onClick={() => requestConfirmation('cancel')}>Cancel excluded area</Button>}
      {!drawingHole && !props.sketch.length && ringIndex > 0 && <Button variant="secondary" onClick={() => requestConfirmation('remove')}>Remove excluded area</Button>}
    </div>{props.sketch.length > 0 && <p>{props.sketch.length} unfinished excluded-area corners kept in your private draft. {!drawingHole && 'Check the selected part and these points before resuming; the target part is not retained when the editor is reopened.'}</p>}{parts[selectedPart].length >= 20 && <p>This part already has the maximum 19 excluded areas.</p>}{confirmation && confirmation.binding === binding && <div className="parcel-map-confirmation" role="group" aria-label="Confirm excluded-area change"><p>{confirmation.kind === 'close' ? 'Add this closed excluded area to the selected part? The rest of the boundary stays as drawn.' : confirmation.kind === 'cancel' ? 'Discard these unfinished excluded-area points? The boundary stays unchanged. Undo can restore the points.' : 'Remove the selected excluded area from this draft? This fills its hole in the draft, without changing the retained original.'}</p><div className="parcel-map-toolbar"><Button onClick={confirmChange}>{confirmation.kind === 'close' ? 'Confirm excluded area' : confirmation.kind === 'cancel' ? 'Discard unfinished excluded area' : 'Confirm removal of excluded area'}</Button><Button variant="secondary" onClick={() => setConfirmation(null)}>Keep editing</Button></div></div>}</fieldset>}
    </>}
    {snapshot && <div className="parcel-map-snapshot-source"><p className="parcel-map-credit"><strong>Demo</strong> · PNOA © IGN/SCNE · SIGPAC © FEGA · <a href={snapshot.image.license_url} target="_blank" rel="noopener noreferrer">CC BY 4.0</a></p><p className="parcel-map-snapshot-legend"><span>Green: reference</span><span>Orange dashed: your outline</span><span>Red: gaps to leave out</span></p><details><summary>Photo, reference and date details</summary><p>{snapshot.image.attribution}<br />{snapshot.source.attribution}</p><p>Photo date: {snapshot.image.capture_date || 'unknown'}. Reference checked: {snapshot.retrieved_at}; campaign year in the source: {snapshot.source.campaign_year ?? 'unknown'}.</p><p><a href={snapshot.image.source_url} target="_blank" rel="noopener noreferrer">Original PNOA source</a> · <a href={snapshot.field.attributes_url} target="_blank" rel="noopener noreferrer">SIGPAC source for {snapshot.field.reference}</a> · <a href="/leaflet-LICENSE.txt" target="_blank" rel="noreferrer">Map software licence</a></p><p>Red marks follow the actual gaps in the reference, not a percentage cut out of the field.</p></details>{snapshotStatus === 'failed' && <Notice kind="warning">The photo could not open. Your outlines are still available.</Notice>}{snapshotStatus === 'loading' && <p role="status">Opening the cached aerial photograph…</p>}</div>}
    {!snapshot && <details className="parcel-map-background-options" open={props.readOnly ? undefined : true}><summary hidden={!props.readOnly}>Choose an optional background map</summary>
    <div className="parcel-map-background"><Field label="Background map"><select value={sourceId} onChange={event => { if (!event.target.value) hideBackground(); else { setSourceId(event.target.value); setMapError(''); } }}><option value="">No background map</option>{sources.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></Field>
      <label className="parcel-map-consent"><input type="checkbox" checked={backgroundAllowed && !!source} onChange={event => { if (!event.target.checked) hideBackground(); else { setSourceId(sourceId && source ? sourceId : sources[0]?.id ?? ''); setBackgroundAllowed(true); setBackgroundAttempt(value => value + 1); } }}/>Show background map</label>
      <p>The map provider receives the area you view and your IP address, but not your private farm records. Nothing is requested until you turn the background on.</p>
      {source && <p>Map from {source.provider}. <a href={source.sourceUrl} target="_blank" rel="noreferrer">About this map</a> · <a href={source.licenseUrl} target="_blank" rel="noreferrer">Licence and attribution</a>. Photos may have been taken in different years. They do not confirm a current crop, official boundary or claim.</p>}
      {backgroundAllowed && source && <p role="status">{backgroundStatus === 'loading' ? 'Loading the chosen background…' : backgroundStatus === 'failed' ? props.readOnly ? 'Background unavailable; the supplied outline remains on the neutral map.' : 'Background unavailable; editing remains available on the neutral map.' : outsideCoverage ? 'This view is outside the documented background coverage. Pan back into its coverage or choose another map.' : 'The chosen background is enabled. Its imagery date may be unknown.'}</p>}
      {outsideCoverage && <Notice kind="warning">This provider has no imagery here. Choose another map or move back into the covered area.</Notice>}
      {backgroundStatus === 'failed' && <Button variant="secondary" onClick={() => setBackgroundAttempt(value => value + 1)}>Try background again</Button>}
      {!backgroundAllowed && <p className="parcel-map-caption">{props.readOnly ? 'Background off. Your supplied outline is still shown.' : 'Background off. You can still draw, edit and save your outline.'}</p>}
    </div>
    </details>}
    {locationMessage && <p role="status">{locationMessage}</p>}
    {!props.readOnly && !!props.referenceCandidates?.length && <details className="parcel-map-candidates"><summary>Reference parcels on this map</summary><p>Blue dashed outlines are public references, not your fields. Choose one to compare it with your draft; your saved boundary will not change.</p><ul>{props.referenceCandidates.map(candidate => <li key={candidate.id}><Button variant="ghost" onClick={() => props.onReferenceSelect?.(candidate.id)} disabled={!props.onReferenceSelect}>{candidate.label}</Button></li>)}</ul></details>}
    {message && <p className="parcel-map-message" role="status">{message}</p>}
    {!props.readOnly && <>
    {props.mode === 'draw' && <div className="parcel-map-toolbar"><Button disabled={props.sketch.length < 3} onClick={() => { props.onGeometry({ type: 'Polygon', coordinates: [[...props.sketch, [...props.sketch[0]]]] }); props.onSketch([]); }}>Close boundary</Button><Button variant="secondary" disabled={!props.sketch.length} onClick={() => props.onSketch(props.sketch.slice(0, -1))}>Undo last corner</Button></div>}
    {props.mode === 'split' && <div className="parcel-map-toolbar"><Button variant="secondary" disabled={!props.splitLine.length} onClick={() => props.onSplitLine(props.splitLine.slice(0, -1))}>Undo dividing line point</Button><Button variant="secondary" disabled={!props.splitLine.length} onClick={() => props.onSplitLine([])}>Redraw dividing line</Button></div>}
    {props.mode === 'edit' && !drawingHole && ring.length > 0 && <details className="parcel-map-coordinates"><summary>Adjust corners using coordinates</summary><p>These controls change {ringIndex ? `excluded area ${ringIndex} in the selected part` : 'the selected outer edge'}. Other parts and rings remain as saved. Coordinates and arrow keys do not snap to a comparison. The server checks the resulting outline before saving.</p><div className="parcel-map-corners">{ring.slice(0, -1).map((p, index) => <div className="parcel-map-coordinate-row" key={index}><strong>Corner {index + 1}</strong><Field label="Longitude"><input type="number" min="-180" max="180" step="any" value={p[0]} onChange={event => { if (event.target.value !== '' && Number.isFinite(event.target.valueAsNumber)) moveCorner(index, [event.target.valueAsNumber, p[1]]); }}/></Field><Field label="Latitude"><input type="number" min="-90" max="90" step="any" value={p[1]} onChange={event => { if (event.target.value !== '' && Number.isFinite(event.target.valueAsNumber)) moveCorner(index, [p[0], event.target.valueAsNumber]); }}/></Field><div className="parcel-map-toolbar"><Button variant="ghost" disabled={ring.length >= 500 || positionCount(parts) >= 1000} onClick={() => changeCornerCount(index, true)}>Insert corner after {index + 1}</Button><Button variant="ghost" disabled={ring.length <= 4} onClick={() => changeCornerCount(index, false)}>Remove corner {index + 1}</Button></div></div>)}</div></details>}
    </>}
  </div>;
}
