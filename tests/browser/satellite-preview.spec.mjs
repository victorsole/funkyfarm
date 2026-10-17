import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { isEOXTile, backgroundTile } from './map-fixtures.mjs';

const fixture = JSON.parse(process.env.FUNKYFARM_BROWSER_FIXTURES || '{}');

// An authored four-by-four PNG tests browser decoding, not satellite retrieval.
function authoredPng() {
  function chunk(type, data) {
    const name = Buffer.from(type), bytes = Buffer.concat([name, data]);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, bytes, checksum]);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(4, 0); header.writeUInt32BE(4, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.from(Array.from({ length: 4 }, () => [0, ...Array.from({ length: 4 }, () => [80, 140, 60]).flat()]).flat());
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

test('satellite scenes open one field image with retry and keep metadata separate from farm work', async ({ page }) => {
  const pageErrors = [], analysisCalls = [], unexpectedWrites = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => {
    if (request.method() !== 'GET' && /^\/api\/v1\/(facts|operations|purchases|sales)(\/|$)/.test(new URL(request.url()).pathname)) unexpectedWrites.push(request.url());
  });
  let searchRecord, releaseFirst;
  const firstFailure = new Promise(resolve => { releaseFirst = resolve; });
  const png = authoredPng();
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
      if (isEOXTile(url)) return backgroundTile(route);
      await route.abort('blockedbyclient');
      throw new Error(`The image UI journey must not contact a public provider: ${url.origin}${url.pathname}`);
    }
    if (url.pathname === '/api/v1/satellite/searches' && request.method() === 'GET') return route.fulfill({ json: { items: [], total: 0, limit: 50, offset: 0 } });
    if (url.pathname === '/api/v1/satellite/search' && request.method() === 'POST') {
      const body = request.postDataJSON();
      const asset = band => ({ href: `https://e84-earth-search-sentinel-data.s3.us-west-2.amazonaws.com/sentinel-2-c1-l2a/authored/${band}.tif` });
      const scene = { id: 'AUTHORED-IMAGE', datetime: '2026-04-12T10:00:00Z', platform: 'sentinel-2a', cloud_cover: 5,
        collection: 'sentinel-2-c1-l2a', provider_url: 'https://earth-search.aws.element84.com/v1/collections/sentinel-2-c1-l2a/items/AUTHORED-IMAGE',
        assets: Object.fromEntries(['red', 'nir', 'scl', 'visual'].map(band => [band, asset(band)])) };
      const metadata = { ...scene, id: 'AUTHORED-METADATA', datetime: '2026-04-11T10:00:00Z', cloud_cover: null,
        provider_url: 'https://stac.dataspace.copernicus.eu/v1/collections/sentinel-2-l2a/items/AUTHORED-METADATA',
        collection: 'sentinel-2-l2a', assets: { unrelated1: asset('one'), unrelated2: asset('two'), unrelated3: asset('three'), unrelated4: asset('four') } };
      searchRecord = { id: randomUUID(), revision: 1, data: { ...body, field_name: 'Image review field', retrieved_at: '2026-04-20T12:00:00Z',
        provider: body.provider === 'earthsearch' ? 'Earth Search' : 'Copernicus', warnings: [], imagery_download: 'Authored catalogue transport for this browser journey.',
        interpretation_status: 'metadata_only', items: body.provider === 'earthsearch' ? [scene, metadata] : [metadata], analyses: [] } };
      return route.fulfill({ status: 201, json: searchRecord });
    }
    if (/^\/api\/v1\/satellite\/searches\/[^/]+\/analyse$/.test(url.pathname) && request.method() === 'POST') {
      analysisCalls.push({ path: url.pathname, body: request.postDataJSON() });
      if (analysisCalls.length === 1) {
        await firstFailure;
        return route.fulfill({ status: 502, json: { error: { code: 'satellite_pixels_unavailable', message: 'The public image could not be read. Try this image again.' } } });
      }
      searchRecord = { ...searchRecord, revision: 2, data: { ...searchRecord.data, analyses: [{ scene_id: 'AUTHORED-IMAGE', acquired_at: '2026-04-12T10:00:00Z',
        status: 'insufficient_clear_pixels', ndvi_mean: null, ndvi_median: null, valid_land_pixels: 4, total_field_pixels: 16, valid_fraction: .25,
        preview_png_base64: png, warnings: ['Not enough clear pixels; greenness is withheld.'] }] } };
      return route.fulfill({ json: searchRecord });
    }
    return route.continue();
  });

  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(fixture.accounts.land.email);
  await page.getByLabel('Password', { exact: true }).fill(fixture.accounts.land.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/home/);
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  const response = await page.request.post('/api/v1/farms', { headers: { 'X-CSRF-Token': session.csrf_token }, data: { data: {
    name: 'Authored satellite image review holding', country: 'CZ', region: null, reporting_year: 2026, area_ha: 2,
    parcels: [{ id: randomUUID(), name: 'Image review field', crop: 'Grass', geometry: { type: 'Polygon',
      coordinates: [[[16.6,49.2],[16.602,49.2],[16.602,49.201],[16.6,49.201],[16.6,49.2]]] } }],
  } } });
  expect(response.ok(), await response.text()).toBeTruthy();
  const farm = await response.json();
  const before = Object.fromEntries(await Promise.all(['facts', 'operations', 'purchases', 'sales'].map(async kind => [kind, (await (await page.request.get(`/api/v1/${kind}?farm_id=${farm.id}`)).json()).items])));
  await page.goto(`/app/satellite?farm_id=${farm.id}`);
  await expect(page.getByLabel('Field', { exact: true })).toHaveValue(farm.data.parcels[0].id);
  await page.getByLabel('From', { exact: true }).fill('2026-04-01');
  await page.getByLabel('To', { exact: true }).fill('2026-04-20');
  await page.getByRole('button', { name: 'Find satellite scenes', exact: true }).click();
  const imageScene = page.locator('article.sat-scene').filter({ has: page.locator('a[href$="/AUTHORED-IMAGE"]') });
  const metadataScene = page.locator('article.sat-scene').filter({ has: page.locator('a[href$="/AUTHORED-METADATA"]') });
  await expect(imageScene.getByRole('button', { name: 'Open field image', exact: true })).toBeVisible();
  await expect(metadataScene.getByRole('heading', { name: 'Scene details only', exact: true })).toBeVisible();
  await expect(metadataScene.getByRole('button', { name: 'Open field image', exact: true })).toHaveCount(0);
  expect(analysisCalls).toHaveLength(0);
  await imageScene.getByRole('button', { name: 'Open field image', exact: true }).click();
  await expect(imageScene.getByRole('heading', { name: 'Opening field image', exact: true })).toBeVisible();
  expect(analysisCalls).toHaveLength(1);
  expect(analysisCalls[0]).toEqual({ path: `/api/v1/satellite/searches/${searchRecord.id}/analyse`, body: { scene_id: 'AUTHORED-IMAGE', expected_revision: 1 } });
  releaseFirst();
  await expect(imageScene.getByRole('alert')).toHaveText('The public image could not be read. Try this image again.');
  await imageScene.getByRole('button', { name: 'Try field image again', exact: true }).click();
  const image = imageScene.getByRole('img', { name: /^Satellite image of Image review field/ });
  await expect(image).toBeVisible();
  await expect(image).toHaveJSProperty('naturalWidth', 4);
  await expect(image).toHaveJSProperty('naturalHeight', 4);
  await expect(imageScene.getByText('Greenness not measured', { exact: true })).toBeVisible();
  expect(analysisCalls).toHaveLength(2);
  expect(analysisCalls[1].body).toEqual({ scene_id: 'AUTHORED-IMAGE', expected_revision: 1 });

  await page.getByLabel('Public data provider', { exact: true }).selectOption('copernicus');
  await page.getByRole('button', { name: 'Find satellite scenes', exact: true }).click();
  await expect(page.locator('article.sat-scene')).toHaveCount(1);
  await expect(metadataScene.getByText('Scene details only', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open field image', exact: true })).toHaveCount(0);
  expect(analysisCalls).toHaveLength(2);
  expect(await (await page.request.get(`/api/v1/farms/${farm.id}`)).json()).toEqual(farm);
  const after = Object.fromEntries(await Promise.all(Object.keys(before).map(async kind => [kind, (await (await page.request.get(`/api/v1/${kind}?farm_id=${farm.id}`)).json()).items])));
  expect(after).toEqual(before);
  expect(unexpectedWrites).toEqual([]);
  expect(pageErrors).toEqual([]);
});
