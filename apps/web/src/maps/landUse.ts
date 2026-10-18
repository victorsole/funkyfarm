// SIGPAC land-use groups, drawn in Bo's GI map palette: the outline is the pure colour and the
// fill is the same colour at the given opacity. Code names are FEGA's own list
// (https://sigpac-hubcloud.es/codigossigpac/cod_uso_sigpac.json, retrieved 18 October 2026).
export type LandUseGroup = { id: string; label: string; color: string; fill: number; codes: string[] };

export const landUseGroups: LandUseGroup[] = [
  { id: 'vineyard', label: 'Vineyard', color: '#530061', fill: .35, codes: ['VI', 'VF', 'VO', 'CV', 'FV'] },
  { id: 'olive', label: 'Olive', color: '#909B50', fill: .30, codes: ['OV', 'CO', 'OF', 'OC', 'FL'] },
  { id: 'fruit', label: 'Fruit, citrus and nuts', color: '#ED4C5C', fill: .35, codes: ['FY', 'CI', 'FS', 'CF', 'CS', 'FF', 'OP'] },
  { id: 'arable', label: 'Arable land', color: '#D4B156', fill: .35, codes: ['TA'] },
  { id: 'vegetables', label: 'Vegetables and greenhouses', color: '#53854B', fill: .35, codes: ['TH', 'IV'] },
  { id: 'pasture', label: 'Pasture', color: '#FFC34F', fill: .30, codes: ['PS', 'PR', 'PA'] },
  { id: 'forest', label: 'Forest and scrub', color: '#35582F', fill: .30, codes: ['FO', 'MT'] },
  { id: 'water', label: 'Water', color: '#4FA3D1', fill: .28, codes: ['AG'] },
  { id: 'other', label: 'Not farmed', color: '#8A8F87', fill: .15, codes: ['CA', 'ED', 'ZU', 'IM', 'IS', 'ZC', 'ZV', 'EP'] },
];

export const usoNames: Record<string, string> = {
  AG: 'Corrientes y superficies de agua', CA: 'Viales', CF: 'Asociación cítricos-frutales', CI: 'Cítricos', CO: 'Contorno olivar',
  CS: 'Asociación cítricos-frutales de cáscara', CV: 'Asociación cítricos-viñedo', ED: 'Edificaciones', EP: 'Elemento del paisaje',
  FF: 'Asociación frutales-frutales de cáscara', FL: 'Frutos secos y olivar', FO: 'Forestal', FS: 'Frutos secos', FV: 'Frutos secos y viñedo',
  FY: 'Frutales', IM: 'Improductivos', IS: 'Islas', IV: 'Invernaderos y cultivos bajo plástico', MT: 'Matorral', OC: 'Asociación olivar-cítricos',
  OF: 'Olivar-frutal', OP: 'Otros cultivos permanentes', OV: 'Olivar', PA: 'Pasto con arbolado', PR: 'Pasto arbustivo', PS: 'Pastizal',
  TA: 'Tierras arables', TH: 'Huerta', VF: 'Viñedo-frutal', VI: 'Viñedo', VO: 'Viñedo-olivar', ZC: 'Zona concentrada no incluida en la ortofoto',
  ZU: 'Zona urbana', ZV: 'Zona censurada',
};

const byCode = new Map(landUseGroups.flatMap(group => group.codes.map(code => [code, group] as const)));
export const unknownGroup: LandUseGroup = { id: 'unknown', label: 'Use not published', color: '#8A8F87', fill: .12, codes: [] };
export function landUseGroup(code: string | null | undefined): LandUseGroup {
  return (code && byCode.get(code.toUpperCase())) || unknownGroup;
}

// Adviser view: one colour per finding level, matching Bo's conflict / gap / ok findings.
export type FieldStatus = 'conflict' | 'gap' | 'ok';
// Fixed colours: they sit on map tiles, which do not change with the page theme.
export const statusStyles: Record<FieldStatus, { label: string; color: string }> = {
  conflict: { label: 'Needs action', color: '#C9502A' },
  gap: { label: 'Missing information', color: '#B57C0E' },
  ok: { label: 'No open findings', color: '#1E8556' },
};

// Dutch BRP crop parcels (RVO via PDOK): grouped by the published category and crop name.
const plain = (value: string | null | undefined) => (value ?? '').toLowerCase();
export function brpGroup(category: string | null | undefined, crop: string | null | undefined): LandUseGroup {
  const kind = plain(category), name = plain(crop);
  const group = (id: string) => landUseGroups.find(item => item.id === id)!;
  if (kind === 'landschapselement') {
    if (/sloot|poel|water|vijver|greppel/.test(name)) return group('water');
    if (/houtwal|houtsingel|heg|haag|bos|boom|struweel|hakhout|singel|knot/.test(name)) return group('forest');
    return group('other');
  }
  if (kind === 'grasland') return group('pasture');
  if (kind === 'natuurterrein') return group('forest');
  if (/druif|wijn/.test(name)) return group('vineyard');
  if (/fruit|appel|peer|kers|pruim|aardbei|bessen|boomgaard|noten|walnoot/.test(name)) return group('fruit');
  if (/kas|glas|groente|kool|prei|asperge|spinazie|witlof|courgette|pompoen|sla\b|wortel|peen|ui\b|uien/.test(name)) return group('vegetables');
  if (kind === 'bouwland' || kind === 'braakland') return group('arable');
  return unknownGroup;
}

// A farmer's own crop name (any of the example languages) to the same colour groups, for countries
// whose official register is not connected yet. Accents are stripped on both sides before matching.
const bare = (value: string | null | undefined) => (value ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
export function cropGroup(crop: string | null | undefined): LandUseGroup | null {
  const name = bare(crop);
  const group = (id: string) => landUseGroups.find(item => item.id === id)!;
  if (!name) return null;
  if (/vine|grape|vin[ea]|vid\b|wijn|druif|reva|vinic/.test(name)) return group('vineyard');
  if (/oliv/.test(name)) return group('olive');
  if (/orchard|apple|pear|cherr|plum|fruit|frut|ovoc|jablk|boomgaard/.test(name)) return group('fruit');
  if (/vegetable|greenhouse|tomat|pepper|lettuce|hortal|zelenin|sklenik|groente|kas\b/.test(name)) return group('vegetables');
  if (/grass|meadow|pastur|hay|clover|pasto|prado|louka|pastvin|trav|luka|grasland|weide/.test(name)) return group('pasture');
  if (/forest|wood|\bbos\b|\bles\b|monte/.test(name)) return group('forest');
  if (/wheat|barley|maize|corn|rye|oat|rape|sunflower|cereal|beet|potato|trigo|cebada|maiz|girasol|psenic|jecmen|kukuric|repk|jacmen|tarwe|gerst|mais|aardappel|biet/.test(name)) return group('arable');
  return null;
}
