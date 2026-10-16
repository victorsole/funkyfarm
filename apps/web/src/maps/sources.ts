export type MapSource = {
  id: string;
  label: string;
  provider: string;
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
};

// Code-owned, reviewed sources. No farm names or credentials enter these URLs.
// Images help locate a field; they are not an official LPIS boundary or dated
// evidence of a farmer's work. Rolling mosaics do not establish capture dates.
const streets: MapSource = {
  id: 'osm', label: 'Street map', provider: 'OpenStreetMap', kind: 'xyz',
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19,
  attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>',
  sourceUrl: 'https://operations.osmfoundation.org/policies/tiles/',
  licenseUrl: 'https://www.openstreetmap.org/copyright',
};

const dutchAerial: MapSource = {
  id: 'nl-pdok-aerial', label: 'Aerial photos · Netherlands', provider: 'Beeldmateriaal Nederland / PDOK', kind: 'xyz',
  url: 'https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/Actueel_ortho25/EPSG:3857/{matrix}/{x}/{y}.jpeg',
  matrixPad: 2, maxZoom: 21,
  bounds: [3.170655050418618, 50.5788239391456, 7.4887368679516655, 53.63760758138346],
  attribution: '<a href="https://www.pdok.nl/introductie/-/article/pdok-luchtfoto-rgb-open-" target="_blank" rel="noopener noreferrer">Beeldmateriaal Nederland / PDOK</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a>',
  sourceUrl: 'https://www.pdok.nl/introductie/-/article/pdok-luchtfoto-rgb-open-',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
};

const nrwAerial: MapSource = {
  id: 'de-nrw-aerial', label: 'Aerial photos · North Rhine-Westphalia', provider: 'Geobasis NRW', kind: 'wms',
  url: 'https://www.wms.nrw.de/geobasis/wms_nw_dop', layers: 'nw_dop_rgb', styles: 'default', format: 'image/jpeg', maxZoom: 21,
  bounds: [5.593338, 50.057798, 9.741582, 52.799797],
  attribution: '<a href="https://www.wms.nrw.de/geobasis/wms_nw_dop?SERVICE=WMS&amp;REQUEST=GetCapabilities" target="_blank" rel="noopener noreferrer">Geobasis NRW</a> · <a href="https://www.govdata.de/dl-de/zero-2-0" target="_blank" rel="noopener noreferrer">dl-de/zero-2-0</a>',
  sourceUrl: 'https://www.wms.nrw.de/geobasis/wms_nw_dop?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0',
  licenseUrl: 'https://www.govdata.de/dl-de/zero-2-0',
};

export function mapSources(country?: string | null, _region?: string | null): MapSource[] {
  return [streets, ...(country === 'NL' ? [dutchAerial] : country === 'DE' ? [nrwAerial] : [])];
}
