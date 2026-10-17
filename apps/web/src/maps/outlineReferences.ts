import manifest from '../../../../shared/mapped-demo-references.json';
import dutchManifest from '../../../../shared/nl-demo-references.json';
import type { RecordItem } from '../types';

type ParcelIdentity = { id: string; external_id?: string | null };

/** Only retained, code-owned public references can supply a credit or link. */
export function communityReference(wayId?: number | null) {
  return manifest.references.find(reference => reference.way_id === wayId) ?? null;
}

export function resolveCommunityReference(farm: RecordItem, parcel?: ParcelIdentity | null): number | null {
  if (farm.data.origin !== 'osm_public_map_practice_2026_10_18') return null;
  const externalId = savedExternalId(farm, parcel);
  const reference = manifest.references.find(item => item.country === farm.data.country && externalId === `OSM way ${item.way_id}`);
  return reference?.way_id ?? null;
}

function savedExternalId(farm: RecordItem, parcel?: ParcelIdentity | null): string | null {
  if (!parcel || !Array.isArray(farm.data.parcels)) return null;
  const saved = farm.data.parcels.filter((item: { id?: string; active?: boolean; external_id?: string | null } | null) => item && item.active !== false && item.id === parcel.id);
  if (saved.length !== 1 || saved[0].external_id !== parcel.external_id) return null;
  return typeof parcel.external_id === 'string' ? parcel.external_id : null;
}

export function dutchReference(featureId?: string | null) {
  return dutchManifest.references.find(reference => reference.feature_id === featureId) ?? null;
}

export function resolveDutchReference(farm: RecordItem, parcel?: ParcelIdentity | null): string | null {
  if (farm.data.origin !== 'pdok_public_demo_2026_10_18' || farm.data.country !== 'NL') return null;
  return dutchReference(savedExternalId(farm, parcel))?.feature_id ?? null;
}
