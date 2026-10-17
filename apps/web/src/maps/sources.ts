export type MapSource = {
  id: string;
  label: string;
  provider: string;
  aerial: boolean;
  kind: 'xyz' | 'wms';
  url: string;
  layers?: string;
  styles?: string;
  format?: string;
  matrixPad?: number;
  attribution: string;
  sourceUrl: string;
  licenseUrl: string;
  bounds?: [number, number, number, number];
  maxZoom: number;
  imageryNote?: string;
};

// Code-owned, reviewed sources. No farm names or credentials enter these URLs.
// Images help locate a field; they are not an official LPIS boundary or dated
// evidence of a farmer's work. Rolling mosaics do not establish capture dates.
const streets: MapSource = {
  id: 'osm', label: 'Street map', provider: 'OpenStreetMap', aerial: false, kind: 'xyz',
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19,
  attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>',
  sourceUrl: 'https://operations.osmfoundation.org/policies/tiles/',
  licenseUrl: 'https://www.openstreetmap.org/copyright',
};

const dutchAerial: MapSource = {
  id: 'nl-pdok-aerial', label: 'Aerial photos · Netherlands', provider: 'Beeldmateriaal Nederland / PDOK', aerial: true, kind: 'xyz',
  url: 'https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/Actueel_ortho25/EPSG:3857/{matrix}/{x}/{y}.jpeg',
  matrixPad: 2, maxZoom: 21,
  bounds: [3.170655050418618, 50.5788239391456, 7.4887368679516655, 53.63760758138346],
  attribution: '<a href="https://www.pdok.nl/introductie/-/article/pdok-luchtfoto-rgb-open-" target="_blank" rel="noopener noreferrer">Beeldmateriaal Nederland / PDOK</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a>',
  sourceUrl: 'https://www.pdok.nl/introductie/-/article/pdok-luchtfoto-rgb-open-',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
};

const nrwAerial: MapSource = {
  id: 'de-nrw-aerial', label: 'Aerial photos · North Rhine-Westphalia', provider: 'Geobasis NRW', aerial: true, kind: 'wms',
  url: 'https://www.wms.nrw.de/geobasis/wms_nw_dop', layers: 'nw_dop_rgb', styles: 'default', format: 'image/jpeg', maxZoom: 21,
  bounds: [5.593338, 50.057798, 9.741582, 52.799797],
  attribution: '<a href="https://www.wms.nrw.de/geobasis/wms_nw_dop?SERVICE=WMS&amp;REQUEST=GetCapabilities" target="_blank" rel="noopener noreferrer">Geobasis NRW</a> · <a href="https://www.govdata.de/dl-de/zero-2-0" target="_blank" rel="noopener noreferrer">dl-de/zero-2-0</a>',
  sourceUrl: 'https://www.wms.nrw.de/geobasis/wms_nw_dop?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0',
  licenseUrl: 'https://www.govdata.de/dl-de/zero-2-0',
};

// Same official service and layer as the retained Spanish demo photograph.
// Coverage comes from its retained GetCapabilities, not a guessed farm location.
const spanishAerial: MapSource = {
  id: 'es-pnoa-aerial', label: 'Aerial photos · Spain', provider: 'IGN / SCNE · PNOA', aerial: true, kind: 'wms',
  url: 'https://www.ign.es/wms-inspire/pnoa-ma', layers: 'OI.OrthoimageCoverage', format: 'image/jpeg', maxZoom: 21,
  bounds: [-19, 27, 5, 44],
  attribution: 'PNOA © <a href="https://www.ign.es/wms-inspire/pnoa-ma?SERVICE=WMS&amp;VERSION=1.3.0&amp;REQUEST=GetCapabilities" target="_blank" rel="noopener noreferrer">IGN / SCNE</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a>',
  sourceUrl: 'https://www.ign.es/wms-inspire/pnoa-ma?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
};

const satelliteMosaic: MapSource = {
  id: 'eox-satellite-2016', label: 'Satellite mosaic · 2016–2017', provider: 'EOX · modified Copernicus Sentinel data 2016 & 2017', aerial: false, kind: 'xyz',
  url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg',
  maxZoom: 14, bounds: [-180, -85.05112878, 180, 85.05112878],
  attribution: '<a href="https://cloudless.eox.at" target="_blank" rel="noopener noreferrer">EOxCloudless</a> by <a href="https://eox.at" target="_blank" rel="noopener noreferrer">EOX IT Services GmbH</a> (Contains modified Copernicus Sentinel data 2016 &amp; 2017) · <a href="https://maps.eox.at/" target="_blank" rel="noopener noreferrer">EOX Maps</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a>',
  sourceUrl: 'https://tiles.maps.eox.at/wmts/1.0.0/WMTSCapabilities.xml',
  licenseUrl: 'https://cloudless.eox.at/license-non-commercial',
  imageryNote: 'This satellite mosaic combines 2016–2017 images. It gives background context, not a current crop, survey, exact capture date or official field boundary.',
};

export function mapSources(country?: string | null, _region?: string | null): MapSource[] {
  return [...(country === 'NL' ? [dutchAerial] : country === 'DE' ? [nrwAerial] : country === 'ES' ? [spanishAerial] : []), satelliteMosaic, streets];
}

/** Prefer local aerial photos, then a dated mosaic, only for supplied locations. */
export function defaultMapSource(country: string | null | undefined, region: string | null | undefined, positions: number[][]): MapSource | undefined {
  if (!positions.length) return undefined;
  return mapSources(country, region).find(source => {
    const bounds = source.bounds;
    return (source.aerial || source.id === satelliteMosaic.id) && bounds && positions.every(point =>
      point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1])
      && point[0] >= bounds[0] && point[0] <= bounds[2]
      && point[1] >= bounds[1] && point[1] <= bounds[3]);
  });
}
