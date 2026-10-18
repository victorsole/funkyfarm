import { test, expect } from '@playwright/test';
import { isEOXTile, backgroundTile } from './map-fixtures.mjs';
import { readFileSync } from 'node:fs';

const sharedFixture = JSON.parse(process.env.FUNKYFARM_BROWSER_FIXTURES || '{}');
// Keep these four journeys' sign-ins and original-farm assertions together,
// without consuming the unrelated report owner's per-email auth budget.
const fixture = { ...sharedFixture, farm: sharedFixture.focused_farm,
  accounts: { ...sharedFixture.accounts, owner: sharedFixture.accounts?.focused } };
const responseFor = (page, path, method = 'GET') => page.waitForResponse(response =>
  new URL(response.url()).pathname === `/api/v1${path}` && response.request().method() === method);
async function checked(response) {
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function signIn(page, who = 'owner') {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(fixture.accounts[who].email);
  await page.getByLabel('Password', { exact: true }).fill(fixture.accounts[who].password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/home/);
}
async function read(page, path, workspaceId) {
  return checked(await page.request.get(`/api/v1${path}`, { headers: { 'X-Workspace-ID': workspaceId } }));
}
async function inspectReadOnlyMap(page) {
  const map = page.getByRole('group', { name: 'Field boundary map', exact: true });
  await expect(map).toHaveClass(/leaflet-container/);
  const outline = map.locator('.leaflet-overlay-pane path').first();
  await expect(outline).toBeVisible();
  const before = await outline.getAttribute('d');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(outline).not.toHaveAttribute('d', before);
  const closer = await outline.getAttribute('d');
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await expect(outline).not.toHaveAttribute('d', closer);
  await map.click({ position: { x: 30, y: 30 } });
  await expect(page.getByRole('button', { name: /^Corner \d+;/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Draw excluded area|Close boundary|Save for comparison|Use my location)$/ })).toHaveCount(0);
  await expect(page.getByText('Background map', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Show background map', exact: true })).toBeChecked();
  await expect(page.getByLabel('Background map', { exact: true })).toHaveValue('osm');
  await expect(page.locator('.parcel-map-credit').filter({ hasText: 'Historical BRP outlines · 2025' })).toBeVisible();
}
async function isolated(page) {
  const errors = []; const external = []; const events = []; const writes = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && /\/api\/v1\/cases\/[^/]+\/events$/.test(path)) events.push(request.postDataJSON());
    if (path.startsWith('/api/v1/') && ['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method())) writes.push(`${request.method()} ${path}`);
  });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['localhost', '127.0.0.1'].includes(url.hostname)) return route.continue();
    if (isEOXTile(url)) return backgroundTile(route);
    if (url.protocol === 'https:' && (
      url.hostname === 'tile.openstreetmap.org' && /^\/\d+\/\d+\/\d+\.png$/.test(url.pathname)
      || url.hostname === 'service.pdok.nl' && /^\/hwh\/luchtfotorgb\/wmts\/v1_0\/Actueel_ortho25\/EPSG:3857\/(?:0\d|1\d|2[01])\/\d+\/\d+\.jpeg$/.test(url.pathname) && !url.search)) {
      return backgroundTile(route);
    }
    external.push(`${url.origin}${url.pathname}`);
    return route.abort('blockedbyclient');
  });
  return { errors, external, events, writes };
}
async function startExample(page) {
  await page.goto('/app/examples');
  const create = page.getByRole('button', { name: 'Start demo', exact: true });
  await expect(create).toBeEnabled();
  const saved = responseFor(page, '/examples/workspace', 'POST');
  await create.click();
  const response = await saved; expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).toEqual({ fixture_id: 'lpis-correction-2026-v1', acknowledged: true });
  expect(response.request().headers()['idempotency-key']).toMatch(/^[a-f0-9-]{36}$/i);
  const example = await checked(response);
  await expect(page.getByLabel('Switch workspace', { exact: true })).toHaveValue(example.workspace.id);
  await expect(page.getByRole('heading', { name: 'Choose a situation', exact: true })).toBeVisible();
  expect(example.scenarios).toHaveLength(7); expect(example.farm_ids).toHaveLength(7);
  return example;
}
const farmFor = (example, key) => {
  const scenario = example.scenarios.find(item => item.key === key);
  expect(scenario).toBeTruthy();
  const farm = example.records.find(item => item.kind === 'farms' && scenario.record_ids.includes(item.id));
  expect(farm).toBeTruthy();
  return farm;
};
async function approveProposal(page, proposalId, workspaceId) {
  const card = page.locator('article.boundary-proposal').filter({ has: page.locator(`a[href*="reference_id=${proposalId}"]`) });
  await expect(card).toHaveCount(1);
  await card.getByRole('checkbox', { name: 'I compared the field names, crops, outlines and reference details.', exact: true }).check();
  const overlap = card.getByRole('checkbox', { name: /^I checked the overlap with / });
  if (await overlap.count()) await overlap.check();
  const saved = responseFor(page, `/field-proposals/${proposalId}/approve`, 'POST');
  await card.getByRole('button', { name: 'Confirm private field change', exact: true }).click();
  const approved = await checked(await saved);
  expect(approved.proposal.data.status).toBe('approved');
  expect((await read(page, `/farms/${approved.farm.id}`, workspaceId)).revision).toBe(approved.farm.revision);
  return approved;
}

test('focused farmer checks a sample farm, edits an outline and adds a separately confirmed field', async ({ page }) => {
  test.setTimeout(240_000);
  const safety = await isolated(page); await signIn(page);
  const original = await read(page, `/farms/${fixture.farm.id}`, fixture.accounts.owner.workspace_id);
  const example = await startExample(page); const farm = farmFor(example, 'nl-overlap');
  const savedFarm = await read(page, `/farms/${farm.id}`, example.workspace.id);
  const savedProposals = await read(page, `/farms/${farm.id}/field-proposals`, example.workspace.id);
  const mapWrites = safety.writes.length;
  await page.goto('/app/home');
  await page.getByLabel('Farm', { exact: true }).selectOption(farm.id);
  await page.getByRole('link', { name: 'Check my fields', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/app/fields/${farm.id}/check`));
  await expect(page.getByRole('heading', { name: 'Check your fields', exact: true })).toBeVisible();
  const fields = await read(page, `/farms/${farm.id}/fields`, example.workspace.id);
  await expect(page.getByRole('heading', { name: fields.items[0].name, exact: true })).toBeVisible();
  await inspectReadOnlyMap(page);
  await expect(page.getByText('Unknown. The responsible authority decides.', { exact: true })).toBeVisible();
  const field = page.getByLabel('Field to look at', { exact: true });
  await field.focus(); await field.press('Home'); await field.press('ArrowDown');
  await expect(field).toHaveValue('1'); await field.press('ArrowUp'); await expect(field).toHaveValue('0');
  await page.getByRole('button', { name: /^Look at \d+ things? to check$/ }).click();
  const issueButtons = page.getByRole('navigation', { name: 'Things to check', exact: true }).getByRole('button');
  for (const issue of await issueButtons.all()) await issue.click();
  await page.getByText('Source, limits and who decides', { exact: true }).click();
  await expect(page.locator('.parcel-check-issue details')).toHaveAttribute('open', '');
  await page.getByRole('button', { name: 'Choose the next preparation step', exact: true }).click();
  await expect(page.getByText('Nothing on this page changes LPIS, sends an application or records an authority response.', { exact: true })).toBeVisible();
  const stages = page.getByRole('navigation', { name: 'Field check stages', exact: true });
  await stages.getByRole('button', { name: 'Fields and map', exact: true }).click();
  await field.selectOption('0');
  await stages.getByRole('button', { name: 'Prepare the next step', exact: true }).click();
  expect(await read(page, `/farms/${farm.id}`, example.workspace.id)).toEqual(savedFarm);
  expect(await read(page, `/farms/${farm.id}/field-proposals`, example.workspace.id)).toEqual(savedProposals);
  expect(safety.writes.slice(mapWrites)).toEqual([]);
  await page.getByRole('link', { name: 'Change or compare a field first', exact: true }).click();
  const workspace = page.locator('section.boundary-workspace');
  const openedField = workspace.getByRole('region', { name: 'Field opened from the parcel check', exact: true });
  await expect(openedField).toBeVisible();
  await openedField.getByRole('button', { name: `Adjust ${fields.items[0].name}`, exact: true }).click();
  await workspace.getByLabel('Which field?', { exact: true }).selectOption(fields.items[0].id);
  const corner = workspace.getByRole('button', { name: /^Corner 2; longitude / });
  const previousCorner = await corner.getAttribute('aria-label');
  await corner.press('ArrowLeft');
  await expect(corner).not.toHaveAttribute('aria-label', previousCorner);
  const fine = workspace.getByRole('region', { name: 'Fine-tune a boundary corner', exact: true });
  await fine.getByLabel('Selected boundary corner', { exact: true }).selectOption('1');
  await fine.getByRole('button', { name: 'Focus this corner', exact: true }).click();
  const longitude = fine.getByLabel('Selected corner longitude', { exact: true });
  const latitude = fine.getByLabel('Selected corner latitude', { exact: true });
  const priorLongitude = await longitude.inputValue(); const priorLatitude = await latitude.inputValue();
  await fine.getByLabel('Nudge distance', { exact: true }).selectOption('0.1');
  await fine.getByRole('button', { name: 'Nudge north', exact: true }).click();
  await expect(latitude).not.toHaveValue(priorLatitude);
  await workspace.getByRole('button', { name: 'Undo last boundary adjustment', exact: true }).click();
  // Undo clears corner selection; explicitly select the restored corner again.
  await fine.getByLabel('Selected boundary corner', { exact: true }).selectOption('1');
  await expect(latitude).toHaveValue(priorLatitude);
  await longitude.fill(String(Number(priorLongitude) + 0.000001));
  await fine.getByRole('button', { name: 'Apply corner position', exact: true }).click();
  await expect(longitude).not.toHaveValue(priorLongitude);
  await workspace.getByLabel('Field name', { exact: true }).fill('FICTIONAL browser west meadow');
  await workspace.getByLabel('What changed, or where did this outline come from?', { exact: true }).fill('FICTIONAL browser review of the original outline; no official LPIS update.');
  const tab = await page.context().newPage(); await tab.goto('about:blank'); await page.bringToFront(); await tab.close();
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); });
  await page.waitForLoadState('networkidle');
  await expect(workspace.getByLabel('Field name', { exact: true })).toHaveValue('FICTIONAL browser west meadow');
  await expect(longitude).not.toHaveValue(priorLongitude);
  const saved = responseFor(page, `/farms/${farm.id}/field-proposals`, 'POST');
  await workspace.getByRole('button', { name: 'Save for comparison', exact: true }).click();
  const proposal = await checked(await saved);
  expect((await read(page, `/farms/${farm.id}/fields`, example.workspace.id)).items.some(item => item.name === 'FICTIONAL browser west meadow')).toBe(false);
  await approveProposal(page, proposal.id, example.workspace.id);
  await page.getByRole('button', { name: 'Add a field', exact: true }).click();
  const editor = page.getByLabel('Add a field', { exact: true });
  await expect(editor).toBeVisible(); await expect(editor).toBeFocused();
  await editor.getByLabel('The name you use for this field', { exact: true }).fill('FICTIONAL browser new field');
  await editor.getByLabel('Crop this year', { exact: true }).fill('Barley');
  await editor.getByText('Add a location, boundary or official reference', { exact: true }).click();
  await editor.getByLabel('Latitude (optional)', { exact: true }).fill('52.453');
  await editor.getByLabel('Longitude (optional)', { exact: true }).fill('5.825');
  await editor.getByLabel('What changed, or where did these details come from?', { exact: true }).fill('FICTIONAL location supplied explicitly for a separate private field.');
  const added = responseFor(page, `/farms/${farm.id}/field-proposals`, 'POST');
  await editor.getByRole('button', { name: 'Save proposed field details', exact: true }).click();
  const newProposal = await checked(await added);
  expect((await read(page, `/farms/${farm.id}/fields`, example.workspace.id)).items).toHaveLength(2);
  await approveProposal(page, newProposal.id, example.workspace.id);
  const current = await read(page, `/farms/${farm.id}/fields`, example.workspace.id);
  expect(current.items).toHaveLength(3);
  const newField = current.items.find(item => item.name === 'FICTIONAL browser new field');
  expect(newField).toMatchObject({ point: { latitude: 52.453, longitude: 5.825 } }); expect(newField.geometry ?? null).toBeNull();
  expect(await read(page, `/farms/${fixture.farm.id}`, fixture.accounts.owner.workspace_id)).toEqual(original);
  expect(safety.errors).toEqual([]); expect(safety.external).toEqual([]); expect(safety.events).toEqual([]);
});

test('focused judge opens all seven sample situations and starts a fresh workspace without deleting edits', async ({ page }) => {
  test.setTimeout(240_000);
  const safety = await isolated(page); await signIn(page);
  const example = await startExample(page); const savedURL = page.url();
  const task = example.records.find(item => item.kind === 'tasks'); expect(task).toBeTruthy();
  await page.goto(task.href);
  await page.getByLabel('What has been done, or what is still needed?', { exact: true }).fill('FICTIONAL browser edit retained when a new example workspace is created.');
  await page.getByLabel('Task progress', { exact: true }).selectOption('in_progress');
  const changed = responseFor(page, `/tasks/${task.id}`, 'PATCH');
  await page.getByRole('button', { name: 'Save answer and progress', exact: true }).click();
  const editedTask = await checked(await changed);
  await page.goto(savedURL);
  await expect(page.getByRole('heading', { name: 'Choose a situation', exact: true })).toBeVisible();
  const cards = page.locator('article.demo-farm-card'); await expect(cards).toHaveCount(7);
  for (let index = 0; index < 7; index += 1) {
    const card = cards.nth(index);
    await card.getByRole('link', { name: 'Open this situation', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/app/examples/${example.scenarios[index].id}\\?`));
    const detail = page.getByRole('region', { name: 'Situation guide', exact: true });
    await expect(detail.getByRole('heading', { name: 'Your task', exact: true })).toBeVisible();
    await expect(detail.locator('ol > li')).toHaveCount(3);
    for (const link of await detail.getByRole('link').all()) expect(await link.getAttribute('href')).toMatch(/^\/app\//);
    const situationURL = page.url();
    const start = detail.getByRole('link', { name: 'Start this situation', exact: true });
    const destination = await start.getAttribute('href'); await start.click();
    await expect(page).toHaveURL(url => `${url.pathname}${url.search}${url.hash}` === destination);
    await page.goto(situationURL);
    await page.getByRole('link', { name: 'Back to all situations', exact: true }).click();
    await expect(cards).toHaveCount(7);
  }
  const refreshed = responseFor(page, `/examples/workspace/${example.run_id}`);
  await page.getByRole('button', { name: 'Refresh saved progress', exact: true }).click();
  expect((await checked(await refreshed)).run_id).toBe(example.run_id);
  const restarted = responseFor(page, `/examples/workspace/${example.run_id}/start-again`, 'POST');
  await page.getByRole('button', { name: 'Start a fresh demo', exact: true }).click();
  const response = await restarted;
  expect(response.request().postDataJSON()).toEqual({ expected_revision: example.revision, acknowledged: true });
  const next = await checked(response); expect(next.workspace.id).not.toBe(example.workspace.id); expect(next.run_id).not.toBe(example.run_id);
  await expect(page.getByLabel('Switch workspace', { exact: true })).toHaveValue(next.workspace.id);
  const retained = await read(page, `/examples/workspace/${example.run_id}`, example.workspace.id);
  expect(retained.records.map(item => item.id).sort()).toEqual(example.records.map(item => item.id).sort());
  expect(await read(page, `/tasks/${task.id}`, example.workspace.id)).toEqual(editedTask);
  await page.getByRole('button', { name: 'Return to the workspace I came from', exact: true }).click();
  await expect(page.getByLabel('Switch workspace', { exact: true })).toHaveValue(example.workspace.id);
  expect(safety.errors).toEqual([]); expect(safety.external).toEqual([]); expect(safety.events).toEqual([]);
});

test('focused farmer corrects individual answers, reads deadline limits and prepares an unsent folder', async ({ page }) => {
  test.setTimeout(300_000);
  const safety = await isolated(page); await signIn(page);
  const example = await startExample(page); const farm = farmFor(example, 'cz-mock-amendment-window');
  await page.goto(`/app/fields/${farm.id}/check`);
  await expect(page.getByLabel('Background map', { exact: true })).toHaveValue('osm');
  await expect(page.getByRole('checkbox', { name: 'Show background map', exact: true })).toBeChecked();
  await page.getByLabel('Background map', { exact: true }).selectOption('eox-satellite-2016');
  await expect(page.locator('.leaflet-control-attribution')).toContainText('Contains modified Copernicus Sentinel data 2016 & 2017');
  await expect(page.getByText('This satellite mosaic combines 2016–2017 images.', { exact: false })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Show background map', exact: true }).uncheck();
  await expect(page.getByRole('checkbox', { name: 'Show background map', exact: true })).not.toBeChecked();
  const mapCredit = page.locator('.parcel-map-credit').filter({ hasText: 'Community map outline, not an official LPIS reference.' });
  await expect(mapCredit).toBeVisible();
  await expect(mapCredit).toContainText('Map year: unknown.');
  await expect(mapCredit.getByRole('link', { name: '© OpenStreetMap contributors', exact: true })).toHaveAttribute('href', 'https://www.openstreetmap.org/way/1568293651');
  await expect(mapCredit.getByRole('link', { name: 'ODbL', exact: true })).toHaveAttribute('href', 'https://opendatacommons.org/licenses/odbl/1-0/');
  await page.goto('/app/home'); await page.getByLabel('Farm', { exact: true }).selectOption(farm.id);
  await page.getByRole('link', { name: 'Fix a mistake in filed paperwork', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Fix a mistake in filed paperwork', exact: true })).toBeVisible();
  const originalWrites = safety.writes.length;
  await expect(page.getByRole('heading', { name: 'Which application are you correcting?', exact: true })).toBeFocused();
  await page.getByLabel('Application year', { exact: true }).fill('2026');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'What did you actually send?', exact: true })).toBeFocused();
  await page.getByLabel('Original submission reference, if known', { exact: true }).fill('FICTIONAL-CAP-CZ-WINDOW-2026');
  await page.getByRole('textbox', { name: 'What did you actually send?', exact: true }).fill('FICTIONAL training original: an earlier field outline. This is not a real filing.');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Which application are you correcting?', exact: true })).toBeFocused();
  await expect(page.getByLabel('Application year', { exact: true })).toHaveValue('2026');
  await expect(page.getByLabel('Farm', { exact: true })).toHaveValue(farm.id);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByLabel('Original submission reference, if known', { exact: true })).toHaveValue('FICTIONAL-CAP-CZ-WINDOW-2026');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'When did you send it, and is the original saved here?', exact: true })).toBeFocused();
  await expect(page.getByLabel('Date you actually sent the original, if known', { exact: true })).toHaveValue('');
  const attachment = page.getByRole('region', { name: 'Attach a photo or document', exact: true });
  // A valid, local human-supplied PNG exercises attachment transport and pins,
  // not automatic image reading, geolocation or evidence of actual farm work.
  const photoBytes = readFileSync(new URL('../../apps/web/public/assets/funkyfarm-logo.png', import.meta.url));
  await attachment.locator('input[type="file"]').first().setInputFiles({ name: 'browser-original-photo.png', mimeType: 'image/png', buffer: photoBytes });
  await expect(attachment.getByRole('img', { name: 'Selected photo: browser-original-photo.png', exact: true })).toBeVisible();
  await expect(attachment.getByRole('checkbox', { name: 'Read the text for me, for checking only', exact: true })).not.toBeChecked();
  const uploaded = responseFor(page, '/documents', 'POST');
  await attachment.getByRole('button', { name: 'Save and attach file', exact: true }).click();
  const photo = await checked(await uploaded); expect(photo.data.farm_id).toBe(farm.id);
  await expect(page.getByText('File attached to your draft. Save this step to keep it in the case.', { exact: true })).toBeVisible();
  const originalPhoto = await page.request.get(`/api/v1/documents/${photo.id}/file`, { headers: { 'X-Workspace-ID': example.workspace.id } });
  expect(await originalPhoto.body()).toEqual(photoBytes);
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); });
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('link', { name: 'Read saved document: browser-original-photo.png', exact: true })).toBeVisible();
  await expect(page.getByLabel('Date you actually sent the original, if known', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Does this describe your original?', exact: true })).toBeFocused();
  await page.getByLabel('Name this correction', { exact: true }).fill('FICTIONAL browser correction');
  await expect(page.locator('.correction-readback')).toContainText('FICTIONAL-CAP-CZ-WINDOW-2026');
  expect(safety.writes.slice(originalWrites)).toEqual(['POST /api/v1/documents']);
  const create = page.getByRole('button', { name: 'Save original and continue', exact: true }); await expect(create).toBeDisabled();
  await page.getByRole('checkbox', { name: 'I have described an original I actually sent. A saved or approved app report alone does not establish that it was sent.', exact: true }).check();
  const created = responseFor(page, '/cases', 'POST'); await create.click();
  const record = await checked(await created); expect(record.data.focused_review_required).toBe(true);
  expect(record.data.references).toContainEqual(expect.objectContaining({ kind: 'documents', id: photo.id, revision: photo.revision, role: 'original' }));
  expect(record.data.original_submitted_at).toBeNull(); expect(record.data.cap_context.filed_on).toBeNull();
  await expect(page).toHaveURL(new RegExp(`/app/cases/${record.id}/correction\\?step=2$`));
  await page.getByRole('textbox', { name: 'What is wrong, and what should change?', exact: true }).fill('FICTIONAL training: compare the corrected east edge against the retained original; do not treat private preparation as filing.');
  const detailsWrites = safety.writes.length;
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Which corrected records support this change?', exact: true })).toBeFocused();
  await page.getByText('Choose corrected records and supporting evidence', { exact: true }).click();
  await page.getByLabel('Find a saved record', { exact: true }).selectOption('field_change_proposals');
  await page.getByLabel('Use this record as', { exact: true }).selectOption('change');
  const choices = page.locator('details.correction-sources');
  await choices.getByRole('button', { name: 'Choose this record', exact: true }).click();
  await page.getByLabel('Find a saved record', { exact: true }).selectOption('documents');
  await page.getByLabel('Use this record as', { exact: true }).selectOption('notice');
  const deadlineSource = example.records.find(item => item.alias === 'cz-window-notice'); expect(deadlineSource).toBeTruthy();
  await choices.locator('ul.record-list > li').filter({ has: page.locator(`a[href="/app/documents/${deadlineSource.id}"]`) }).getByRole('button', { name: 'Choose this record', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Check what you want to correct', exact: true })).toBeFocused();
  expect(safety.writes.slice(detailsWrites)).toEqual([]);
  await page.getByRole('checkbox', { name: 'I checked these entries against my records. Unknown details have not been guessed.', exact: true }).check();
  const details = responseFor(page, `/cases/${record.id}`, 'PATCH');
  await page.getByRole('button', { name: 'Save this step and continue', exact: true }).click();
  const amended = await checked(await details);
  await expect(page).toHaveURL(new RegExp(`step=3$`));
  await page.getByLabel('Which intervention or monitoring route applies?', { exact: true }).selectOption('ams');
  const datesWrites = safety.writes.length;
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'What do the instructions say about the deadline?', exact: true })).toBeFocused();
  await page.getByLabel('National correction deadline stated in the applicable instructions', { exact: true }).fill('2026-10-30');
  const notice = amended.data.references.find(item => item.kind === 'documents' && item.role === 'notice'); expect(notice).toBeTruthy();
  await page.getByLabel('Saved source for that national deadline', { exact: true }).selectOption(`documents/${notice.id}/notice`);
  await page.getByLabel('First instalment date, if specifically established', { exact: true }).fill('2026-12-01');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Which route applies to this application?', exact: true })).toBeFocused();
  await expect(page.getByLabel('Which intervention or monitoring route applies?', { exact: true })).toHaveValue('ams');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByLabel('National correction deadline stated in the applicable instructions', { exact: true })).toHaveValue('2026-10-30');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Has a check or finding changed the situation?', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Check the dates and unknowns before saving', exact: true })).toBeFocused();
  expect(safety.writes.slice(datesWrites)).toEqual([]);
  await page.getByRole('checkbox', { name: 'I checked these entries against my records. Unknown details have not been guessed.', exact: true }).check();
  const dates = responseFor(page, `/cases/${record.id}`, 'PATCH');
  await page.getByRole('button', { name: 'Save this step and continue', exact: true }).click(); await checked(await dates);
  await page.getByRole('navigation', { name: 'Correction steps', exact: true }).getByRole('button', { name: /Check the dates$/ }).click();
  await page.locator('details.correction-guidance-preview > summary').click();
  await expect(page.getByRole('heading', { name: 'Can I still change this?', exact: true })).toBeVisible();
  const latestDate = page.locator('.correction-guidance dl > div').filter({ has: page.getByText('EU latest possible date from the supplied first instalment', { exact: true }) }).locator('dd');
  await expect(latestDate).toBeVisible(); await expect(latestDate).toContainText('2026-11-16');
  await expect(page.getByText('2026-10-30', { exact: true }).first()).toBeVisible();
  await page.getByText('Read the rules and their limits', { exact: true }).click();
  for (const link of await page.locator('.correction-guidance').getByRole('link').all()) expect(await link.getAttribute('href')).toMatch(/^https:\/\//);
  await page.getByRole('navigation', { name: 'Correction steps', exact: true }).getByRole('button', { name: /Check each answer$/ }).click();
  let pages = 0;
  for (;;) {
    await expect(page.locator('article.correction-answer').first()).toBeVisible();
    const checks = page.locator('article.correction-answer').getByRole('checkbox');
    for (const checkbox of await checks.all()) if (await checkbox.isEnabled()) await checkbox.check();
    const save = page.getByRole('button', { name: 'Save these answer checks', exact: true });
    if (await save.isEnabled()) {
      const saved = responseFor(page, `/cases/${record.id}/answer-review`, 'POST'); await save.click();
      const result = await checked(await saved); expect(result.answer_review.checked_count).toBeGreaterThan(0);
      await expect(page.getByRole('checkbox', { name: 'Checked by a person for this saved version', exact: true }).first()).toBeDisabled();
    }
    pages += 1; expect(pages).toBeLessThanOrEqual(10);
    const next = page.getByRole('button', { name: 'Next answers', exact: true });
    if (!(await next.isEnabled())) break;
    const loaded = responseFor(page, `/cases/${record.id}/answer-review`); await next.click(); await checked(await loaded);
  }
  expect((await read(page, `/cases/${record.id}/answer-review?limit=5`, example.workspace.id)).all_checked).toBe(true);
  await page.getByRole('navigation', { name: 'Correction steps', exact: true }).getByRole('button', { name: /Prepare your folder$/ }).click();
  await page.getByRole('link', { name: 'Open final review and prepare the folder', exact: true }).click();
  const checkedCase = responseFor(page, `/cases/${record.id}/checks`);
  await page.getByRole('button', { name: 'Check the saved case', exact: true }).click();
  expect((await checked(await checkedCase)).can_review).toBe(true);
  await page.getByRole('checkbox', { name: 'I checked these saved records and their sources. I understand that this review does not send anything.', exact: true }).check();
  const reviewed = responseFor(page, `/cases/${record.id}/review`, 'POST');
  await page.getByRole('button', { name: 'Review this version for sending', exact: true }).click();
  expect((await checked(await reviewed)).data.status).toBe('ready_to_send');
  const handoff = responseFor(page, `/cases/${record.id}/handoff`);
  await page.getByRole('button', { name: 'Open handoff and downloads', exact: true }).click();
  expect((await checked(await handoff)).origin).toBe('current_review');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download complete prepared folder (ZIP)', exact: true }).click();
  const folder = await download; expect(await folder.failure()).toBeNull(); expect(folder.suggestedFilename()).toMatch(/\.zip$/);
  await expect(page.getByLabel('Text you can copy into the official process', { exact: true })).not.toHaveValue('');
  const official = page.getByRole('link', { name: 'Open the official route', exact: true });
  if (await official.count()) expect(await official.getAttribute('href')).toMatch(/^https:\/\//);
  expect((await read(page, `/cases/${record.id}`, example.workspace.id)).data.status).toBe('ready_to_send');
  expect(safety.events).toEqual([]); expect(safety.errors).toEqual([]); expect(safety.external).toEqual([]);
});

test('focused adviser opens only a delegated farm and its correction, then loses access when revoked', async ({ page, browser }) => {
  test.setTimeout(240_000);
  const ownerSafety = await isolated(page); await signIn(page);
  const example = await startExample(page); const farm = farmFor(example, 'nl-missing-documents');
  const otherFarm = farmFor(example, 'nl-overlap');
  const scenario = example.scenarios.find(item => item.key === 'nl-missing-documents');
  const savedCase = example.records.find(item => item.kind === 'admin_cases' && scenario.record_ids.includes(item.id));
  await page.goto('/app/adviser');
  await page.getByRole('button', { name: 'Give an adviser access', exact: true }).click();
  await page.getByLabel('Adviser’s email', { exact: true }).fill(fixture.accounts.adviser.email);
  await page.getByRole('group', { name: 'Farms this adviser may access', exact: true }).getByRole('checkbox', { name: farm.label, exact: true }).check();
  await page.getByRole('checkbox', { name: 'Allow checking and confirming records', exact: true }).check();
  const invited = responseFor(page, '/invitations', 'POST');
  await page.getByRole('button', { name: 'Create private invitation', exact: true }).click();
  const invitation = await checked(await invited);
  const context = await browser.newContext({ baseURL: process.env.FUNKYFARM_BROWSER_URL, reducedMotion: 'reduce' });
  try {
    const adviser = await context.newPage(); const adviserSafety = await isolated(adviser);
    await signIn(adviser, 'adviser'); await adviser.goto('/app/adviser');
    await adviser.getByRole('button', { name: 'Accept a farmer’s invitation', exact: true }).click();
    await adviser.getByLabel('Private invitation code', { exact: true }).fill(invitation.token);
    const accepted = responseFor(adviser, '/invitations/accept', 'POST');
    await adviser.getByRole('button', { name: 'Accept invitation', exact: true }).click(); await checked(await accepted);
    await adviser.getByLabel('Search farms or clients', { exact: true }).fill(farm.label);
    await adviser.getByRole('button', { name: `Open farm · ${farm.label}`, exact: true }).click();
    await adviser.getByRole('button', { name: 'Check parcels', exact: true }).click();
    await expect(adviser).toHaveURL(new RegExp(`/app/fields/${farm.id}/check`));
    await expect(adviser.getByLabel('Switch workspace', { exact: true })).toHaveValue(example.workspace.id);
    const identity = await read(adviser, '/auth/session', example.workspace.id);
    expect(identity.workspace.role).toBe('adviser');
    const memberships = await read(adviser, '/workspaces', example.workspace.id);
    expect(memberships.items.find(item => item.id === example.workspace.id).farm_ids).toEqual([farm.id]);
    const privateRead = await adviser.request.get(`/api/v1/farms/${otherFarm.id}`, { headers: { 'X-Workspace-ID': example.workspace.id } });
    expect([401, 403, 404]).toContain(privateRead.status());
    await adviser.goto('/app/adviser');
    await adviser.getByLabel('Search farms or clients', { exact: true }).fill(farm.label);
    await adviser.getByRole('button', { name: `Open farm · ${farm.label}`, exact: true }).click();
    await adviser.getByRole('button', { name: `Open correction · ${savedCase.label}`, exact: true }).click();
    await expect(adviser).toHaveURL(new RegExp(`/app/cases/${savedCase.id}/correction`));
    await expect(adviser.getByRole('heading', { name: savedCase.label, exact: true })).toBeVisible();
    const invitationRow = page.locator('li').filter({ hasText: fixture.accounts.adviser.email });
    const revoked = responseFor(page, `/invitations/${invitation.invitation.id}/revoke`, 'POST');
    await invitationRow.getByRole('button', { name: 'Revoke invitation & access', exact: true }).click(); await checked(await revoked);
    await adviser.reload();
    await expect(adviser.getByLabel('Switch workspace', { exact: true })).toHaveValue(fixture.accounts.adviser.workspace_id);
    const denied = await adviser.request.get(`/api/v1/cases/${savedCase.id}`, { headers: { 'X-Workspace-ID': example.workspace.id } });
    expect([401, 403, 404]).toContain(denied.status());
    expect(adviserSafety.errors).toEqual([]); expect(adviserSafety.external).toEqual([]); expect(adviserSafety.events).toEqual([]);
  } finally { await context.close(); }
  expect(ownerSafety.errors).toEqual([]); expect(ownerSafety.external).toEqual([]); expect(ownerSafety.events).toEqual([]);
});
