import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';

const fixture = JSON.parse(process.env.FUNKYFARM_BROWSER_FIXTURES || '{}');
const logoPath = '/assets/funkyfarmers-logo.png';
const logoHash = '5d6dfd5f04195567b0de6c0bc7e4b6d7f9a1f6ed333b84a7c6f5c29d6a8d7b6b';
const responseFor = (page, path, method = 'GET') => page.waitForResponse(response =>
  new URL(response.url()).pathname === `/api/v1${path}` && response.request().method() === method);
async function checked(response) {
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function read(page, path, workspaceId) {
  return checked(await page.request.get(`/api/v1${path}`, { headers: { 'X-Workspace-ID': workspaceId } }));
}
async function displayedLogo(image) {
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute('src', logoPath);
  await expect(image).toHaveJSProperty('naturalWidth', 1397);
  await expect(image).toHaveJSProperty('naturalHeight', 1126);
}
async function importActualReceipt(page, farmId, workspaceId) {
  const returnURL = page.url();
  const importing = page.getByRole('region', { name: 'Import a real file', exact: true });
  const kinds = ['facts', 'operations', 'purchases', 'sales', 'tasks'];
  const totals = await Promise.all(kinds.map(async kind => (await read(page, `/${kind}?farm_id=${farmId}`, workspaceId)).total));
  const receipt = Buffer.from('Supplier: Browser receipt merchant\nDate: 2026-09-14\nInvoice number: TEST-RECEIPT-007\nQuantity: 2.50\nUnit: litres\nTotal: 12.30 EUR\n');
  await importing.getByLabel('What are you importing?', { exact: true }).selectOption('document');
  await importing.getByLabel('File to read', { exact: true }).setInputFiles({ name: 'actual-browser-receipt.txt', mimeType: 'text/plain', buffer: receipt });
  const uploaded = responseFor(page, '/documents', 'POST');
  const extracted = page.waitForResponse(response => /^\/api\/v1\/documents\/[a-f0-9-]+\/extract$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST');
  await importing.getByRole('button', { name: 'Save and read receipt', exact: true }).click();
  const document = await checked(await uploaded); expect(document.data.farm_id).toBe(farmId);
  const extractedDocument = await checked(await extracted);
  const preview = page.getByRole('region', { name: 'Read values from the original', exact: true });
  await preview.getByRole('button', { name: 'Supplier Browser receipt merchant', exact: true }).click();
  await expect(preview.locator('[aria-label="Extracted source lines"] mark')).toHaveText('Supplier: Browser receipt merchant');
  await expect(preview.locator('blockquote p')).toHaveText('Supplier: Browser receipt merchant');
  const original = await page.request.get(`/api/v1/documents/${document.id}/file`, { headers: { 'X-Workspace-ID': workspaceId } });
  expect(original.status()).toBe(200); expect(original.headers()['cache-control']).toContain('no-store');
  expect(await original.body()).toEqual(receipt);
  await expect(page.getByRole('link', { name: 'Edit values and save a proposal', exact: true })).toHaveAttribute('href', `/app/documents/${document.id}?farm_id=${farmId}&purpose=purchases`);
  await importing.getByRole('button', { name: 'Refresh saved records', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Saved records from this source', exact: true }).locator('article')).toHaveCount(0);
  expect(await Promise.all(kinds.map(async kind => (await read(page, `/${kind}?farm_id=${farmId}`, workspaceId)).total))).toEqual(totals);
  await page.getByRole('link', { name: 'Edit values and save a proposal', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/app/documents/${document.id}\\?`));
  await page.getByLabel('Save as', { exact: true }).selectOption('purchases');
  await page.getByRole('region', { name: 'Supplier', exact: true }).getByRole('button', { name: 'Use this checked value', exact: true }).click();
  await page.getByLabel('Give this record a clear name', { exact: true }).fill('Checked receipt purchase from the demo import');
  await page.getByLabel('Purchase date (if known)', { exact: true }).fill('2026-09-14');
  await page.getByLabel('Quantity (if readable)', { exact: true }).fill('2.50');
  await page.getByLabel('Unit (leave blank if unknown)', { exact: true }).fill('l');
  await page.getByLabel('Invoice or receipt number', { exact: true }).fill('TEST-RECEIPT-007');
  await page.getByLabel('Total amount (if readable)', { exact: true }).fill('12.30');
  await page.getByLabel('Currency', { exact: true }).fill('EUR');
  await page.getByLabel('Category', { exact: true }).selectOption('inputs');
  const proposedResponse = responseFor(page, `/documents/${document.id}/records`, 'POST');
  await page.getByRole('button', { name: 'Save purchase for review', exact: true }).click();
  const purchase = await checked(await proposedResponse);
  expect(purchase.data).toMatchObject({ farm_id: farmId, document_id: document.id, review_status: 'proposed', quantity: 2.5, amount: 12.3, currency: 'EUR', date: '2026-09-14', supplier: 'Browser receipt merchant', document_review: { document_id: document.id, document_revision: extractedDocument.revision } });
  expect(purchase.data.sources.some(source => source.document_id === document.id && source.page === 1 && source.line_start === 1 && source.quote === 'Supplier: Browser receipt merchant')).toBe(true);
  expect((await read(page, `/purchases/${purchase.id}`, workspaceId)).data.review_status).toBe('proposed');
  await expect(page.getByRole('heading', { name: 'Saved purchase', exact: true })).toBeVisible();
  await expect(page.getByText('Confirmed. The original remains attached.', { exact: true })).toHaveCount(0);
  await page.getByLabel('What did you check? Explain any warning before confirming.', { exact: true }).fill('Checked the original supplier, actual date, 2.50 litres and printed EUR 12.30. Lowercase l denotes the same litre unit; no quantity was converted. No tax was supplied.');
  const confirmedResponse = responseFor(page, `/purchases/${purchase.id}/review`, 'POST');
  await page.getByRole('button', { name: 'Confirm this purchase', exact: true }).click();
  const confirmed = await checked(await confirmedResponse);
  expect(confirmed.data.review_status).toBe('confirmed'); expect(confirmed.data.tax_amount).toBeNull();
  await expect(page.getByText('Confirmed. The original remains attached.', { exact: true })).toBeVisible();
  await page.goto(returnURL);
  await expect(page.getByLabel('Switch workspace', { exact: true })).toHaveValue(workspaceId);
  const readback = page.getByRole('region', { name: 'Saved records from this source', exact: true }).locator('article').filter({ has: page.getByRole('heading', { name: 'Checked receipt purchase from the demo import', exact: true }) });
  await expect(readback).toBeVisible(); await expect(readback.getByText('Confirmed', { exact: true })).toBeVisible();
  await expect(readback).toContainText('12.3'); await expect(readback).toContainText('Browser receipt merchant');
  const expectedTotals = totals.map((total, index) => total + (kinds[index] === 'purchases' ? 1 : 0));
  expect(await Promise.all(kinds.map(async kind => (await read(page, `/${kind}?farm_id=${farmId}`, workspaceId)).total))).toEqual(expectedTotals);
  expect(await (await page.request.get(`/api/v1/documents/${document.id}/file`, { headers: { 'X-Workspace-ID': workspaceId } })).body()).toEqual(receipt);
  return document;
}
async function comparison(page, status) {
  const region = page.getByRole('region', { name: 'Claim area comparison', exact: true });
  await expect(region).toBeVisible();
  await expect(region.getByText(status, { exact: true })).toBeVisible();
  for (const [label, value] of [
    ['Area in the saved claim', '6.70 ha'],
    ['Maximum area supplied by the source', '3.02 ha'],
    ['Pasture coefficient supplied', '45%'],
    ['Claim above the supplied maximum', '3.68 ha'],
    ['Proposed corrected claim — not sent', '3.02 ha'],
  ]) {
    const metric = region.locator('dl > div').filter({ has: page.getByText(label, { exact: true }) });
    await expect(metric.locator('dd')).toHaveText(value);
  }
  return region;
}

test('hackathon demo separates a Spanish pasture claim from the physical parcel and missing evidence', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = []; const external = []; const writes = []; const starts = []; const expectedWrites = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path === '/api/v1/examples/workspace') starts.push(request);
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method()) &&
        (/\/cases(?:\/|$)/.test(path) || /\/farms\/[^/]+$/.test(path) || /\/field-proposals(?:\/|$)/.test(path))) writes.push(`${request.method()} ${path}`);
  });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['localhost', '127.0.0.1'].includes(url.hostname)) return route.continue();
    external.push(`${url.origin}${url.pathname}`); return route.abort('blockedbyclient');
  });
  await page.goto('/demo');
  await expect(page.getByRole('heading', { name: 'Farm paperwork, one clear step at a time.', exact: true })).toBeVisible();
  await displayedLogo(page.getByRole('img', { name: 'Funkyfarmers', exact: true }));
  const asset = await page.request.get(logoPath); expect(asset.ok()).toBeTruthy();
  const png = await asset.body(); expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(createHash('sha256').update(png).digest('hex')).toBe(logoHash);
  await page.getByRole('link', { name: 'Try the Spain case', exact: true }).click();
  await expect(page).toHaveURL(/\/login\?next=%2Fapp%2Fdemo$/i);
  await displayedLogo(page.locator('.auth-story > .brand img'));
  // The allowed demo destination must survive the normal account-form toggle.
  await page.getByRole('link', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/\/register\?next=%2Fapp%2Fdemo$/i);
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(fixture.accounts.owner.email);
  await page.getByLabel('Password', { exact: true }).fill(fixture.accounts.owner.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/demo$/);
  await displayedLogo(page.getByRole('complementary').getByRole('img', { name: 'Funkyfarmers', exact: true }));
  const originalFarm = await read(page, `/farms/${fixture.farm.id}`, fixture.accounts.owner.workspace_id);
  const start = page.getByRole('button', { name: 'Start the guided demo', exact: true });
  await expect(start).toBeDisabled(); expect(starts).toHaveLength(0);
  await page.getByRole('checkbox', { name: 'I understand this creates a separate workspace with made-up farm records.', exact: true }).check();
  const created = responseFor(page, '/examples/workspace', 'POST'); await start.click();
  const response = await created;
  expect(response.request().headers()['idempotency-key']).toMatch(/^[a-f0-9-]{36}$/i);
  const example = await checked(response); expect(example.fixture_record_count).toBe(39);
  const scenario = example.scenarios.find(item => item.key === 'es-protected-unknown'); expect(scenario).toBeTruthy();
  const own = example.records.filter(item => scenario.record_ids.includes(item.id));
  const farm = own.find(item => item.kind === 'farms'); const savedCase = own.find(item => item.kind === 'admin_cases');
  const facts = ['es-claimed-area', 'es-eligible-area', 'es-coefficient', 'es-corrected-area'].map(alias => own.find(item => item.alias === alias));
  expect(facts.every(Boolean)).toBe(true); expect(facts.every(item => item.status === 'proposed')).toBe(true);
  await expect(page.getByLabel('Switch workspace', { exact: true })).toHaveValue(example.workspace.id);
  await expect(page.getByRole('heading', { name: 'From field to paperwork.', exact: true })).toBeVisible();
  const demoURL = page.url(); const before = await read(page, `/farms/${farm.id}`, example.workspace.id);
  const checkPath = `/farms/${farm.id}/parcel-check?expected_farm_revision=${before.revision}&reporting_year=2026`;
  await page.getByRole('link', { name: 'Open the field map and checks', exact: true }).click();
  const firstCheck = await read(page, checkPath, example.workspace.id);
  expect(firstCheck.fields).toHaveLength(7);
  expect(firstCheck.fields.reduce((total, item) => total + item.outline_area_ha, 0)).toBeCloseTo(27.96, 2);
  const pasture = firstCheck.fields.find(item => item.claim_context?.declared === 6.7); expect(pasture).toBeTruthy();
  expect(pasture.outline_area_ha).toBeCloseTo(6.70, 2);
  expect(pasture.claim_context).toMatchObject({ status: 'unconfirmed', declared: 6.7, max: 3.02, coefficient: 45, excess: 3.68, proposed_claim: 3.02, proposed_claim_is_draft: true });
  await page.getByLabel('Field to look at', { exact: true }).selectOption(String(firstCheck.fields.indexOf(pasture)));
  const map = page.getByRole('group', { name: 'Field boundary map', exact: true });
  await expect(map).toHaveClass(/leaflet-container/);
  const outline = map.locator('.leaflet-overlay-pane path').first(); await expect(outline).toBeVisible();
  const savedOutline = await outline.getAttribute('d');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(outline).not.toHaveAttribute('d', savedOutline);
  await expect(page.getByRole('button', { name: /^Corner \d+;/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Draw excluded area|Close boundary|Save for comparison|Use my location)$/ })).toHaveCount(0);
  await page.getByText('Choose an optional background map', { exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Show background map', exact: true })).not.toBeChecked();
  expect(await read(page, `/farms/${farm.id}`, example.workspace.id)).toEqual(before);
  expect(writes).toEqual([]);
  const unconfirmed = await comparison(page, 'Proposed values — not yet checked');
  await unconfirmed.getByText('Original sources and limits of this comparison', { exact: true }).click();
  const originals = unconfirmed.getByRole('link', { name: 'Open the original document', exact: true });
  await expect(originals).toHaveCount(2);
  await originals.first().click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download original', exact: true }).click();
  const original = await downloaded; expect(await original.failure()).toBeNull();
  const chunks = []; let size = 0;
  for await (const chunk of await original.createReadStream()) { size += chunk.length; expect(size).toBeLessThan(100_000); chunks.push(chunk); }
  const sourceText = Buffer.concat(chunks).toString('utf8');
  expect(sourceText).toContain('DEMO RECORD'); expect(sourceText).toContain('6.70 ha');
  await page.getByRole('link', { name: 'Hackathon demo', exact: true }).click();
  const steps = page.getByRole('navigation', { name: 'Demo chapters', exact: true });
  await expect(steps.getByRole('button')).toHaveCount(3);
  await steps.getByRole('button', { name: /^Check my fields\b/ }).click();
  await expect(page.getByRole('heading', { name: 'D04: why does the claim need attention?', exact: true })).toBeVisible();
  await page.getByText('What if the pasture was cleared?', { exact: true }).click();
  await page.getByRole('link', { name: 'Open the evidence task', exact: true }).click();
  const evidenceTask = own.find(item => item.alias === 'es-lease-evidence'); expect(evidenceTask).toBeTruthy();
  await expect(page.getByRole('heading', { name: evidenceTask.label, exact: true })).toBeVisible();
  await expect(page.getByText(/No actual clearance date, geotagged photo, lease/)).toBeVisible();
  await page.goto(demoURL);
  await steps.getByRole('button', { name: /^Check my fields\b/ }).click();
  await page.getByRole('link', { name: 'Review D04’s saved figures', exact: true }).click();
  const answers = page.locator('#facts'); await expect(answers).toHaveAttribute('open', '');
  for (const fact of facts) {
    const card = answers.locator('article.panel').filter({ has: page.getByRole('heading', { name: fact.label, exact: true }) });
    await expect(card.getByText('proposed', { exact: true })).toBeVisible();
    await card.getByText('Source and history', { exact: true }).click();
    await expect(card.locator('pre').first()).toContainText('document_id');
    await card.getByLabel('Review note', { exact: true }).fill('Compared the exact fictional source value and campaign. This confirms the training transcription only, not eligibility or filing. The physical outline stays intact.');
    const reviewed = responseFor(page, `/facts/${fact.id}/review`, 'POST');
    await card.getByRole('button', { name: 'I checked this — confirm answer', exact: true }).click();
    expect((await checked(await reviewed)).data.review_status).toBe('confirmed');
    await expect(card.getByText('confirmed', { exact: true })).toBeVisible();
  }
  const after = await read(page, `/farms/${farm.id}`, example.workspace.id);
  expect(after).toEqual(before);
  expect((await read(page, `/farms/${farm.id}/field-proposals`, example.workspace.id)).total).toBe(0);
  const checkedClaim = await read(page, checkPath, example.workspace.id);
  expect(checkedClaim.fields.find(item => item.id === pasture.id).claim_context).toMatchObject({ status: 'confirmed', declared: 6.7, max: 3.02, coefficient: 45, excess: 3.68, proposed_claim: 3.02, proposed_claim_is_draft: true });
  await page.goto(`/app/fields/${farm.id}/check?parcel_id=${pasture.id}`);
  await comparison(page, 'Values checked by a person — not an authority decision');
  const savedFacts = await read(page, `/facts?farm_id=${farm.id}`, example.workspace.id);
  const missingCrop = before.data.parcels.find(item => !item.crop); expect(missingCrop).toBeTruthy();
  await page.goto(demoURL);
  await steps.getByRole('button', { name: /^Check my fields\b/ }).click();
  await expect(page.getByRole('link', { name: 'Easy form: fill it in step by step', exact: true })).toHaveAttribute('href', `/app/easy-form?farm_id=${farm.id}`);
  await page.getByRole('link', { name: 'Easy form: fill it in step by step', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your farm, one step at a time', exact: true })).toBeVisible();
  const questions = page.getByRole('region', { name: 'Farm questions', exact: true });
  await expect(questions.getByRole('heading', { name: 'Is this your farm?', exact: true })).toBeFocused();
  await questions.getByRole('button', { name: 'Yes, this is right', exact: true }).click();
  await questions.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(questions.getByRole('heading', { name: 'Do these fields look right?', exact: true })).toBeFocused();
  await expect(questions.getByRole('group', { name: 'Choose a field to see on the map', exact: true }).getByRole('button')).toHaveCount(7);
  await questions.getByRole('button', { name: 'Yes, this is right', exact: true }).click();
  await questions.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(questions.getByRole('heading', { name: 'What is growing here?', exact: true })).toBeFocused();
  const crops = questions.getByRole('group', { name: 'Choose a field to check its crop', exact: true });
  for (const field of before.data.parcels.filter(item => item.crop)) {
    await crops.getByRole('button').filter({ hasText: field.name }).click();
    await questions.getByRole('button', { name: 'Yes, this is right', exact: true }).click();
  }
  await crops.getByRole('button').filter({ hasText: missingCrop.name }).click();
  await expect(questions.locator('article.easy-form-crop')).toContainText('No crop recorded');
  await questions.getByRole('button', { name: 'I need to change this', exact: true }).click();
  await questions.getByLabel('Crop', { exact: true }).selectOption('other');
  await questions.getByLabel('Other crop name', { exact: true }).fill('Spring field beans — farmer-supplied');
  await questions.getByLabel('What changed? (optional)', { exact: true }).fill('Typed from this fictional farmer’s records. This is a proposal, not an official update.');
  await questions.getByRole('button', { name: 'Back', exact: true }).click();
  await questions.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(questions.getByLabel('Other crop name', { exact: true })).toHaveValue('Spring field beans — farmer-supplied');
  expect(writes).toEqual([]);
  const cropSaved = responseFor(page, `/farms/${farm.id}/field-proposals`, 'POST');
  await questions.getByRole('button', { name: 'Save crop change for review', exact: true }).click();
  const cropResponse = await cropSaved; expect(cropResponse.request().headers()['idempotency-key']).toMatch(/^[a-f0-9-]{36}$/i);
  const cropProposal = await checked(cropResponse);
  expect(cropProposal.data).toMatchObject({ status: 'proposed', farm_id: farm.id, parcel: { id: missingCrop.id, crop: 'Spring field beans — farmer-supplied', geometry: missingCrop.geometry } });
  expectedWrites.push(`POST /api/v1/farms/${farm.id}/field-proposals`);
  await expect(questions.getByRole('link', { name: 'Review and apply this crop change', exact: true })).toBeVisible();
  await page.reload();
  await expect(questions.getByRole('heading', { name: 'What is growing here?', exact: true })).toBeFocused();
  await crops.getByRole('button').filter({ hasText: missingCrop.name }).click();
  await expect(questions.getByLabel('Other crop name', { exact: true })).toHaveValue('Spring field beans — farmer-supplied');
  await expect(questions.getByRole('link', { name: 'Review and apply this crop change', exact: true })).toBeVisible();
  await expect(questions.getByText('7 of 7 fields answered.', { exact: true })).toBeVisible();
  await questions.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(questions.getByRole('heading', { name: 'What else is on the land?', exact: true })).toBeFocused();
  await questions.getByRole('button', { name: 'I am not sure', exact: true }).click();
  await questions.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(questions.getByRole('heading', { name: 'Do you need support paperwork?', exact: true })).toBeFocused();
  await questions.getByRole('button', { name: 'I am not sure', exact: true }).click();
  await questions.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(questions.getByRole('heading', { name: 'Check your answers', exact: true })).toBeFocused();
  await expect(questions.getByRole('link', { name: 'Review the saved crop change', exact: true })).toHaveAttribute('href', new RegExp(`proposal_id=${cropProposal.id}`));
  await expect(questions.getByRole('link', { name: 'Check my fields and saved figures', exact: true })).toHaveAttribute('href', new RegExp(`/app/fields/${farm.id}/check\\?`));
  await expect(questions.getByRole('link', { name: 'Open my support paperwork', exact: true })).toHaveAttribute('href', `/app/paperwork?farm_id=${farm.id}&intent=support`);
  expect(await read(page, `/farms/${farm.id}`, example.workspace.id)).toEqual(before);
  expect(await read(page, `/facts?farm_id=${farm.id}`, example.workspace.id)).toEqual(savedFacts);
  expect((await read(page, `/field-proposals/${cropProposal.id}`, example.workspace.id)).data.status).toBe('proposed');
  expect(writes).toEqual(expectedWrites);
  await page.goto(demoURL);
  const refreshed = responseFor(page, `/examples/workspace/${example.run_id}`);
  await page.getByRole('button', { name: 'Refresh saved records', exact: true }).click();
  const progress = await checked(await refreshed);
  expect(progress.records.filter(item => facts.some(fact => fact.id === item.id)).every(item => item.status === 'confirmed')).toBe(true);
  await steps.getByRole('button', { name: /^Before and after filing\b/ }).click();
  await expect(page.getByRole('region', { name: 'Saved correction date guidance', exact: true }).getByRole('heading', { name: 'Correction date not established', exact: true })).toBeVisible();
  const historical = page.getByTestId('demo-historical-deadlines');
  await historical.locator(':scope > summary').click();
  await expect(historical.locator('time[datetime="2026-05-15"]')).toHaveText('15 May 2026');
  await expect(historical.locator('time[datetime="2026-09-07"]')).toHaveText('7 September 2026');
  await expect(historical).toContainText('E1/E2 yellow/red monitoring incidents only');
  await expect(historical).toContainText('Neither is assigned to this case');
  for (const link of await historical.getByRole('link').all()) expect(await link.getAttribute('href')).toMatch(/^https:\/\/doe\.juntaex\.es\//);
  await page.getByRole('link', { name: 'Work through a correction', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/app/cases/${savedCase.id}/correction\\?step=1$`));
  const correction = page.getByRole('navigation', { name: 'Correction steps', exact: true });
  await correction.getByRole('button', { name: /Check the dates$/ }).click();
  await expect(page.getByRole('heading', { name: 'Which route applies to this application?', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'What do the instructions say about the deadline?', exact: true })).toBeFocused();
  await expect(page.getByLabel('National correction deadline stated in the applicable instructions', { exact: true })).toHaveValue('');
  await page.locator('details.correction-guidance-preview > summary').click();
  await expect(page.getByRole('heading', { name: 'Can I still change this?', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Which route applies to this application?', exact: true })).toBeFocused();
  expect(writes).toEqual(expectedWrites);
  await correction.getByRole('button', { name: /Check each answer$/ }).click();
  await expect(page.locator('article.correction-answer').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save these answer checks', exact: true })).toBeDisabled();
  // The full folder success path has its own journey. Here the deliberately
  // absent lease/photos and unchecked case items must remain visible blockers.
  await page.goto(demoURL);
  await steps.getByRole('button', { name: /^Before and after filing\b/ }).click();
  await page.getByRole('link', { name: 'Review the case and prepare the folder', exact: true }).click();
  const checkedCase = responseFor(page, `/cases/${savedCase.id}/checks`);
  await page.getByRole('button', { name: 'Check the saved case', exact: true }).click();
  const result = await checked(await checkedCase); expect(result.can_review).toBe(false);
  expect(result.issues.some(issue => issue.code === 'case_item_open' && /lease|photo|protected/i.test(issue.message))).toBe(true);
  await expect(page.getByRole('button', { name: 'Review this version for sending', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Open handoff and downloads', exact: true })).toBeDisabled();
  await page.goto(demoURL);
  await steps.getByRole('button', { name: /^Import my records\b/ }).click();
  await importActualReceipt(page, farm.id, example.workspace.id);
  await page.getByText('About this demo and adviser access', { exact: true }).click();
  await expect(page.getByRole('link', { name: 'Open Adviser view or invite an adviser', exact: true })).toHaveAttribute('href', '/app/adviser');
  await page.getByRole('link', { name: 'Try the other farm situations', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your private sample workspace', exact: true })).toBeVisible();
  expect((await read(page, `/cases/${savedCase.id}`, example.workspace.id)).data.status).toBe('draft');
  expect((await read(page, `/cases/${savedCase.id}/events?limit=100`, example.workspace.id)).items.some(item => ['sent', 'receipt', 'accepted'].includes(item.data.action))).toBe(false);
  expect(await read(page, `/farms/${fixture.farm.id}`, fixture.accounts.owner.workspace_id)).toEqual(originalFarm);
  expect(starts).toHaveLength(1); expect(writes).toEqual(expectedWrites); expect(errors).toEqual([]); expect(external).toEqual([]);
});
