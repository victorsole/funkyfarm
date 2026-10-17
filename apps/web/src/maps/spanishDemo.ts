import manifest from '../../../../shared/spain-sigpac-demo.json';
import type { RecordItem } from '../types';
import type { FieldGeometry } from '../pages/FieldsMap';

export type SpanishDemoField = { label: string; reference: string; feature_id: string | number; geometry: FieldGeometry; area_ha: number; csp_percent: number; use_code: string; incidences: unknown; attributes_url: string };
export type SpanishDemoSnapshot = {
  id: string; origin: string; field: SpanishDemoField; retrieved_at: string;
  source: { attribution: string; license_url: string; campaign_year: number | null; collection_url: string };
  image: { path: string; bbox_3857: number[]; width: number; height: number; sha256: string; attribution: string; license_url: string; source_url: string; capture_date: string | null };
};
export type SpanishDemoSelection = { id: string; reference: string };
const data = manifest as unknown as { id: string; origin: string; retrieved_at: string; source: SpanishDemoSnapshot['source']; fields: SpanishDemoField[]; image: SpanishDemoSnapshot['image'] };
const ORIGIN = 'sigpac_public_demo_2026_10_17';
const ID = 'es-caceres-sigpac-2026-10-17';

/** URLs and official coordinates come only from the retained, code-owned asset. */
export function getSpanishDemoSnapshot(selection?: SpanishDemoSelection | null): SpanishDemoSnapshot | null {
  if (!selection || selection.id !== ID || data.id !== ID || data.origin !== ORIGIN || !Array.isArray(data.fields)) return null;
  const fields = data.fields.filter(field => field.reference === selection.reference);
  const image = data.image;
  if (fields.length !== 1 || !image || image.path !== '/assets/caceres-pnoa-2026.jpg'
    || !Array.isArray(image.bbox_3857) || image.bbox_3857.length !== 4 || !image.bbox_3857.every(Number.isFinite)
    || image.bbox_3857[0] >= image.bbox_3857[2] || image.bbox_3857[1] >= image.bbox_3857[3]
    || !/^[a-f0-9]{64}$/i.test(image.sha256) || typeof image.attribution !== 'string') return null;
  return { id: ID, origin: ORIGIN, field: fields[0], image, source: data.source, retrieved_at: data.retrieved_at };
}

/** Only the new, exact sample farm and its actual saved parcel can opt into it. */
export function resolveSpanishDemo(farm: RecordItem, parcel?: { id: string; external_id?: string | null } | null): SpanishDemoSnapshot | null {
  if (farm.data.origin !== ORIGIN || farm.data.country !== 'ES' || !parcel || typeof parcel.external_id !== 'string' || !Array.isArray(farm.data.parcels)) return null;
  const matches = farm.data.parcels.filter((item: { id?: string; active?: boolean; external_id?: string | null } | null) => item && item.active !== false && item.id === parcel.id);
  const references = farm.data.parcels.filter((item: { active?: boolean; external_id?: string | null } | null) => item && item.active !== false && item.external_id === parcel.external_id);
  if (matches.length !== 1 || references.length !== 1 || matches[0].external_id !== parcel.external_id) return null;
  return getSpanishDemoSnapshot({ id: ID, reference: parcel.external_id });
}

export function spanishDemoArea(value: number | null) {
  return value === null ? 'Not established' : `${value.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ha`;
}
