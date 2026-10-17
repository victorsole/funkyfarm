import { test, expect } from '@playwright/test';

const fixture = JSON.parse(process.env.FUNKYFARM_BROWSER_FIXTURES || '{}');

async function signIn(page, who) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(fixture.accounts[who].email);
  await page.getByLabel('Password', { exact: true }).fill(fixture.accounts[who].password);
  const loginResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/v1/auth/login' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  expect((await loginResponse).status(), 'Sign-in HTTP response').toBe(200);
  await expect(page).toHaveURL(/\/app\/home/);
}

async function openMoreTool(page, path) {
  await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('link', { name: /^Tools\b/ }).click();
  await expect(page.getByRole('heading', { name: 'Farm tools', exact: true })).toBeVisible();
  await page.locator('main').locator(`a[href="${path}"]`).click();
  await expect(page).toHaveURL(new RegExp(`${path}$`));
}

async function api(page, path, body) {
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  const response = await page.request.post('/api/v1' + path, { data: body, headers: { 'X-CSRF-Token': session.csrf_token } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

async function saveAndReview(page) {
  await page.getByRole('button', { name: 'Check this entry', exact: true }).click();
  await page.getByRole('button', { name: 'Save entry for checking', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Entry saved. Check it now.', exact: true })).toBeVisible();
  await page.getByLabel('What did you check?', { exact: true }).fill('Checked the authored notebook against the actual work and date.');
  await page.getByRole('button', { name: 'I checked this — confirm entry', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Saved entry', exact: true })).toBeVisible();
}

async function collection(page, kind) {
  const response = await page.request.get(`/api/v1/${kind}?limit=50`);
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()).items;
}

async function chooseWorkspace(page, workspaceId) {
  const accepted = page.waitForResponse(response => response.url().endsWith('/api/v1/auth/session')
    && response.request().headers()['x-workspace-id'] === workspaceId && response.status() === 200);
  await page.getByLabel('Switch workspace', { exact: true }).selectOption(workspaceId);
  expect((await (await accepted).json()).workspace.id).toBe(workspaceId);
  await expect(page.getByLabel('Switch workspace', { exact: true })).toHaveValue(workspaceId);
}

async function authoredMapTiles(page) {
  const state = { calls: [], fail: false };
  const tile = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#dfe8d1"/><path d="M0 128H256M128 0V256" stroke="#b9c7a8"/><text x="12" y="24" font-size="12">Authored local map fixture</text></svg>';
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const query = Object.fromEntries([...url.searchParams].map(([key, value]) => [key.toLowerCase(), value]));
    if (['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
    const osm = url.hostname === 'tile.openstreetmap.org' && /^\/\d+\/\d+\/\d+\.png$/.test(url.pathname) && !url.search;
    const pdok = url.hostname === 'service.pdok.nl' && /^\/hwh\/luchtfotorgb\/wmts\/v1_0\/Actueel_ortho25\/EPSG:3857\/(?:0\d|1\d|2[01])\/\d+\/\d+\.jpeg$/.test(url.pathname) && !url.search;
    const wms = url.hostname === 'www.wms.nrw.de' && url.pathname === '/geobasis/wms_nw_dop'
      && query.request?.toLowerCase() === 'getmap' && query.version === '1.3.0'
      && query.format === 'image/jpeg' && query.crs === 'EPSG:3857';
    if (url.protocol !== 'https:' || !(osm || pdok || wms)) {
      await route.abort('blockedbyclient');
      throw new Error(`Unreviewed external browser request was blocked: ${url.origin}${url.pathname}`);
    }
    state.calls.push({ url: request.url(), headers: await request.allHeaders() });
    await route.fulfill({ status: state.fail ? 503 : 200, headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'image/svg+xml', body: state.fail ? '' : tile });
  });
  return state;
}

async function cornerLabels(workspace) {
  return workspace.getByRole('button', { name: /^Corner \d+; longitude / }).evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')));
}

test('new farmer onboards and records a purchase separately from actual use', async ({ page }) => {
  await signIn(page, 'onboarding');
  await page.getByLabel('Farm name', { exact: true }).fill('Browser authored smallholding');
  await page.getByLabel('Country', { exact: true }).selectOption('DE');
  await page.getByLabel('Region or state', { exact: true }).fill('Bavaria');
  await page.getByLabel('What kind of farm?', { exact: true }).selectOption('mixed');
  await page.getByLabel('Year you are preparing for', { exact: true }).fill('2026');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('radio', { name: /A notebook, receipt or letter/ }).check();
  await page.getByRole('button', { name: 'Set up farm and add document', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/documents/);
  await page.getByLabel('Choose a PDF, photo or text file', { exact: true }).setInputFiles({ name: 'authored-receipt.txt', mimeType: 'text/plain', buffer: Buffer.from('FICTIONAL RECEIPT\nSupplier: Fixture co-op\nQuantity: 2.50 L\nTotal: 12.50 EUR\n') });
  await page.getByLabel('What is it?', { exact: true }).selectOption('receipt');
  await page.getByRole('button', { name: 'Save and read document', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/documents\/[a-f0-9-]+/);
  await expect(page.getByRole('heading', { name: 'Check the suggested details', exact: true })).toBeVisible();
  const farms = await (await page.request.get('/api/v1/farms')).json();
  const farmId = farms.items[0].id;
  await page.goto(`/app/record-work?farm_id=${farmId}`);
  await page.getByLabel('What would you like to record?', { exact: true }).selectOption('purchase');
  await page.getByLabel('Purchase date', { exact: true }).fill('2026-05-10');
  await page.getByLabel('What did you buy?', { exact: true }).fill('Authored foliar fertiliser receipt');
  await page.getByLabel('What kind of purchase?', { exact: true }).selectOption('fertiliser');
  await page.getByLabel('Quantity bought (if shown)', { exact: true }).fill('2.50');
  await page.getByLabel('Unit', { exact: true }).selectOption('l');
  await page.getByLabel('Amount paid (a credit note can be negative)', { exact: true }).fill('12.50');
  await page.getByLabel('Currency', { exact: true }).fill('EUR');
  await saveAndReview(page);
  expect((await (await page.request.get('/api/v1/operations')).json()).total).toBe(0);
  await page.getByRole('button', { name: 'Record when and where I used it', exact: true }).click();
  await page.getByLabel('When did it happen?', { exact: true }).fill('2026-05-11');
  await page.getByLabel('Which field or growing area?', { exact: true }).fill('Meadow greenhouse');
  await page.getByLabel('Product used', { exact: true }).fill('Authored foliar fertiliser');
  await page.getByLabel('How much did you use?', { exact: true }).fill('0.50');
  await page.getByLabel('Unit', { exact: true }).selectOption('l');
  await saveAndReview(page);
  const purchases = (await (await page.request.get('/api/v1/purchases')).json()).items;
  const operations = (await (await page.request.get('/api/v1/operations')).json()).items;
  expect(purchases).toHaveLength(1);
  expect(operations).toHaveLength(1);
  expect(Number(purchases[0].data.quantity)).toBe(2.5);
  expect(Number(operations[0].data.quantity)).toBe(0.5);
  expect(operations[0].data.date).toBe('2026-05-11');
  expect(await page.evaluate(() => Object.entries(localStorage).some(([key, value]) => /password|bearer|access_token/i.test(key) || /"token"\s*:/.test(value)))).toBe(false);
});

test('owner reviews a response, exports PDF and starts an explicit correction', async ({ page }) => {
  await signIn(page, 'owner');
  await openMoreTool(page, '/app/reports');
  await page.getByLabel('Request to answer', { exact: true }).selectOption(fixture.request.id);
  await page.getByLabel('Response format', { exact: true }).selectOption('farm-evidence');
  await page.getByRole('checkbox', { name: /Browser reviewed holding area/ }).check();
  await page.getByRole('button', { name: 'Prepare preview', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/reports\/[a-f0-9-]+/);
  const reportId = page.url().split('/').pop();
  await expect(page.getByRole('heading', { name: 'Review your answer', exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'I reviewed this report and its sources and approve this version.', exact: true }).check();
  await page.getByRole('button', { name: 'Approve this version', exact: true }).click();
  await expect(page.getByText('Approval recorded. This report keeps the reviewed snapshot.', { exact: true })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PDF', exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/\.pdf$/);
  await page.getByLabel('Reference', { exact: true }).fill('FICTIONAL-BROWSER-MANUAL-REFERENCE');
  await page.getByLabel('Delivery date', { exact: true }).fill('2026-10-16');
  await page.getByRole('button', { name: 'Save manual reference', exact: true }).click();
  await expect(page.getByText('Your manual delivery reference is recorded. It does not establish acceptance by an authority.', { exact: true })).toBeVisible();
  const retained = (await (await page.request.get(`/api/v1/reports/${reportId}/download?format=json`)).json()).snapshot;
  const correction = await api(page, '/facts', { data: { ...fixture.fact.data, value: '4.25', review_status: 'proposed', supersedes_id: fixture.fact.id, reviewed_by: undefined, reviewed_at: undefined, review_note: undefined } });
  await api(page, `/facts/${correction.id}/review`, { expected_revision: correction.revision, decision: 'confirmed', note: 'Explicitly checked updated survey; original output retained.' });
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review an amendment', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Prepare amendment for review', exact: true }).click();
  await expect(page).not.toHaveURL(new RegExp(`${reportId}$`));
  const old = await (await page.request.get(`/api/v1/reports/${reportId}/download?format=json`)).json();
  expect(old.snapshot).toEqual(retained);
  expect(old.filing_status).toBe('not_filed');
});

test('adviser accepts a scoped grant, asks for evidence and loses access on revocation', async ({ page, browser }) => {
  await signIn(page, 'adviser');
  await openMoreTool(page, '/app/adviser');
  await expect(page.getByRole('heading', { name: 'Adviser desk', exact: true })).toBeVisible();
  await expect(page.getByLabel('Switch workspace', { exact: true })).toHaveValue(fixture.accounts.adviser.workspace_id);
  // A stale tab preference must not silently move the active page during refresh.
  const identity = await (await page.request.get('/api/v1/auth/session')).json();
  await page.evaluate(({ userId, workspaceId }) => sessionStorage.setItem('funkyfarm.workspace-selection.v1', JSON.stringify({ userId, workspaceId })), { userId: identity.user.id, workspaceId: fixture.accounts.peer.workspace_id });
  await page.getByRole('button', { name: 'Accept a farmer’s invitation', exact: true }).click();
  await page.getByLabel('Private invitation code', { exact: true }).fill(fixture.invitation.token);
  const acceptance = page.waitForResponse(response => response.url().endsWith('/api/v1/invitations/accept') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Accept invitation', exact: true }).click();
  expect((await acceptance).status()).toBe(200);
  await expect(page.getByText(/Invitation accepted\. The farm workspace/)).toBeVisible();
  await expect(page.getByLabel('Switch workspace', { exact: true })).toHaveValue(fixture.accounts.adviser.workspace_id);
  await page.getByRole('button', { name: `Open farm · ${fixture.farm.data.name}`, exact: true }).click();
  await expect(page.getByRole('heading', { name: fixture.farm.data.name, exact: true })).toBeVisible();
  await expect(page.getByText(fixture.private.data.name, { exact: true })).toHaveCount(0);
  await chooseWorkspace(page, fixture.accounts.owner.workspace_id);
  await page.reload();
  await expect(page.getByLabel('Switch workspace', { exact: true })).toHaveValue(fixture.accounts.owner.workspace_id);
  await page.getByRole('button', { name: `Open farm · ${fixture.farm.data.name}`, exact: true }).click();
  await page.getByRole('button', { name: 'Ask this farmer', exact: true }).click();
  await page.getByLabel('Farm', { exact: true }).selectOption(fixture.farm.id);
  await page.getByLabel('Question', { exact: true }).fill('Please check the actual date in the notebook');
  await page.getByLabel('What the farmer needs to provide', { exact: true }).fill('A receipt date alone does not establish when a field treatment happened.');
  await page.getByRole('button', { name: 'Save question for farmer', exact: true }).click();
  await expect(page.getByText('Question saved for the farmer in this workspace.', { exact: true })).toBeVisible();
  const ownerContext = await browser.newContext({ baseURL: process.env.FUNKYFARM_BROWSER_URL, reducedMotion: 'reduce' });
  try {
    const ownerPage = await ownerContext.newPage();
    await signIn(ownerPage, 'owner');
    await openMoreTool(ownerPage, '/app/adviser');
    await ownerPage.getByRole('button', { name: 'Give an adviser access', exact: true }).click();
    const invitationRow = ownerPage.locator('li').filter({ hasText: fixture.accounts.adviser.email });
    await invitationRow.getByRole('button', { name: /Revoke/ }).click();
    await expect(invitationRow.getByText('Revoked', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Adviser desk', exact: true })).toBeVisible();
    await expect(page.getByLabel('Switch workspace', { exact: true })).toHaveValue(fixture.accounts.adviser.workspace_id);
    const fallback = await page.request.get('/api/v1/auth/session');
    expect(fallback.status()).toBe(200);
    expect((await fallback.json()).workspace.id).toBe(fixture.accounts.adviser.workspace_id);
    await expect(page.getByText(fixture.private.data.name, { exact: true })).toHaveCount(0);
    const inaccessible = await page.request.get(`/api/v1/farms/${fixture.farm.id}`, { headers: { 'X-Workspace-ID': fixture.accounts.owner.workspace_id } });
    expect([401, 403, 404]).toContain(inaccessible.status());
  } finally {
    await ownerContext.close();
  }
});

test('crop sale is read back, confirmed and credited without inventing farm movements', async ({ page }) => {
  await signIn(page, 'seller');
  await page.goto(`/app/record-work?farm_id=${fixture.sales_farm.id}`);
  await page.getByLabel('What would you like to record?', { exact: true }).selectOption('sale');
  await expect(page.getByLabel('Currency shown on invoice', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Is this a credit note or refund?', { exact: true })).toHaveValue('');
  await page.getByLabel('Sale date', { exact: true }).fill('2026-06-11');
  await page.getByLabel('What did you sell?', { exact: true }).fill('Authored wheat sale');
  await page.getByLabel('What kind of sale?', { exact: true }).selectOption('crop');
  await page.getByLabel('Buyer', { exact: true }).fill('Fictional Mill');
  await page.getByLabel('Invoice number (if shown)', { exact: true }).fill('BROWSER-AUTHORED-SALE-001');
  await page.getByLabel('Quantity sold (if shown)', { exact: true }).fill('25,50');
  await page.getByLabel('Unit', { exact: true }).selectOption('kg');
  await page.getByLabel('Amount on invoice', { exact: true }).fill('125,50');
  await page.getByLabel('Currency shown on invoice', { exact: true }).fill('EUR');
  await page.getByLabel('Is this a credit note or refund?', { exact: true }).selectOption('no');
  await page.getByRole('button', { name: 'Check this entry', exact: true }).click();
  const readback = page.getByRole('heading', { name: 'Check before saving', exact: true }).locator('..');
  await expect(readback).toContainText('125.5');
  await expect(readback).toContainText('25.5');
  await expect(readback).toContainText('Fictional Mill');
  await expect(page.getByLabel('Amount on invoice', { exact: true })).toHaveValue('125,50');
  await expect(page.getByLabel('Quantity sold (if shown)', { exact: true })).toHaveValue('25,50');
  await expect(page.getByRole('button', { name: 'Save entry for checking', exact: true })).toBeDisabled();
  const acknowledgements = readback.getByRole('checkbox', { name: 'I checked this and want to keep these details.', exact: true });
  expect(await acknowledgements.count()).toBeGreaterThan(0);
  for (const acknowledgement of await acknowledgements.all()) await acknowledgement.check();
  await page.getByRole('button', { name: 'Save entry for checking', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Entry saved. Check it now.', exact: true })).toBeVisible();
  const proposed = (await (await page.request.get('/api/v1/sales')).json()).items;
  expect(proposed).toHaveLength(1);
  expect(proposed[0].data.review_status).toBe('proposed');
  expect(proposed[0].data.buyer).toBe('Fictional Mill');
  expect(Number(proposed[0].data.amount)).toBe(125.5);
  await page.getByLabel('What did you check?', { exact: true }).fill('Read actual invoice date, buyer, 25.50 kg and printed total 125.50 EUR; unreadable VAT remains unknown.');
  await page.getByRole('button', { name: 'I checked this — confirm entry', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Saved entry', exact: true })).toBeVisible();

  await page.getByLabel('What would you like to record?', { exact: true }).selectOption('sale');
  await page.getByLabel('Sale date', { exact: true }).fill('2026-06-12');
  await page.getByLabel('What did you sell?', { exact: true }).fill('Separate authored sales credit');
  await page.getByLabel('What kind of sale?', { exact: true }).selectOption('crop');
  await page.getByLabel('Buyer', { exact: true }).fill('Fictional Mill');
  await page.getByLabel('Invoice number (if shown)', { exact: true }).fill('BROWSER-AUTHORED-CREDIT-001');
  await page.getByLabel('Amount on invoice', { exact: true }).fill('-12,50');
  await page.getByLabel('Currency shown on invoice', { exact: true }).fill('EUR');
  await page.getByLabel('Is this a credit note or refund?', { exact: true }).selectOption('yes');
  await page.getByRole('button', { name: 'Check this entry', exact: true }).click();
  const creditReadback = page.getByRole('heading', { name: 'Check before saving', exact: true }).locator('..');
  await expect(creditReadback).toContainText('-12.5');
  for (const acknowledgement of await creditReadback.getByRole('checkbox', { name: 'I checked this and want to keep these details.', exact: true }).all()) await acknowledgement.check();
  await page.getByRole('button', { name: 'Save entry for checking', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Entry saved. Check it now.', exact: true })).toBeVisible();
  await page.getByLabel('What did you check?', { exact: true }).fill('Read this separate negative 12.50 EUR credit note. No returned stock or animal movement was asserted.');
  await page.getByRole('button', { name: 'I checked this — confirm entry', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Saved entry', exact: true })).toBeVisible();
  const sales = (await (await page.request.get('/api/v1/sales')).json()).items;
  expect(sales).toHaveLength(2);
  expect(sales.every(item => item.data.review_status === 'confirmed' && item.data.tax_amount == null && item.data.tax_rate == null)).toBe(true);
  const credit = sales.find(item => item.data.credit === true);
  expect(Number(credit.data.amount)).toBe(-12.5);
  expect(credit.data.quantity).toBeNull();
  expect((await (await page.request.get('/api/v1/purchases')).json()).total).toBe(0);
  expect((await (await page.request.get('/api/v1/operations')).json()).total).toBe(0);
  expect((await (await page.request.get('/api/v1/facts')).json()).total).toBe(0);
  await page.getByLabel('Show', { exact: true }).selectOption('sales');
  await expect(page.getByRole('heading', { name: 'Authored wheat sale', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Separate authored sales credit', exact: true })).toBeVisible();
});

test('field draft survives reload after invalid geometry and requires comparison before applying', async ({ page }) => {
  const tiles = await authoredMapTiles(page);
  const browserErrors = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: 48, longitude: 11, accuracy: 15 });
  await signIn(page, 'seller');
  await page.goto(`/app/fields/${fixture.sales_farm.id}`);
  const workspace = page.getByRole('region', { name: 'Change boundaries', exact: true });
  await workspace.getByRole('button', { name: 'Open boundary tools', exact: true }).click();
  await workspace.getByRole('button', { name: 'Draw a field', exact: true }).click();
  await workspace.getByLabel('Field name', { exact: true }).fill('Authored recoverable field draft');
  const note = 'Authored outline, retained after an error and page reload; not an official LPIS update.';
  await workspace.getByLabel('What changed, or where did this outline come from?', { exact: true }).fill(note);
  await expect(workspace.getByRole('checkbox', { name: 'Show background map', exact: true })).not.toBeChecked();
  await workspace.getByRole('button', { name: 'Use my location', exact: true }).click();
  await expect(workspace.getByText(/Device location shown with about 15 metres accuracy/)).toBeVisible();
  expect((await (await page.request.get(`/api/v1/farms/${fixture.sales_farm.id}/fields`)).json()).items).toHaveLength(0);
  const map = workspace.getByRole('group', { name: 'Field boundary map', exact: true });
  await expect(map).toBeVisible();
  for (const [x, y] of [[0.25, 0.25], [0.65, 0.25], [0.65, 0.65], [0.25, 0.65]]) {
    const box = await map.boundingBox();
    expect(box).not.toBeNull();
    await map.click({ position: { x: box.width * x, y: box.height * y } });
  }
  await workspace.getByRole('button', { name: 'Close boundary', exact: true }).click();
  await expect(workspace.getByRole('button', { name: /^Corner \d+; longitude / })).toHaveCount(4);
  const drawn = await cornerLabels(workspace);
  await workspace.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await workspace.getByRole('button', { name: 'Move north', exact: true }).click();
  await workspace.getByRole('button', { name: 'Fit supplied outlines', exact: true }).click();
  expect(await cornerLabels(workspace)).toEqual(drawn);
  await workspace.getByLabel('Background map', { exact: true }).selectOption('osm');
  expect(tiles.calls).toHaveLength(0);
  await workspace.getByRole('checkbox', { name: 'Show background map', exact: true }).check();
  await expect.poll(() => tiles.calls.length).toBeGreaterThan(0);
  await expect(workspace.getByText('The chosen background is enabled. Its imagery date may be unknown.', { exact: true })).toBeVisible();
  tiles.fail = true;
  await workspace.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await expect(workspace.getByText('Background unavailable; editing remains available on the neutral map.', { exact: true })).toBeVisible();
  await workspace.getByLabel('Background map', { exact: true }).selectOption('');
  await expect(workspace.getByRole('checkbox', { name: 'Show background map', exact: true })).not.toBeChecked();
  expect(await cornerLabels(workspace)).toEqual(drawn);
  await page.reload();
  await workspace.getByRole('button', { name: 'Open boundary tools', exact: true }).click();
  await expect(workspace.getByLabel('Field name', { exact: true })).toHaveValue('Authored recoverable field draft');
  await expect(workspace.getByRole('button', { name: /^Corner \d+; longitude / })).toHaveCount(4);
  expect(await cornerLabels(workspace)).toEqual(drawn);
  await workspace.getByText('Locate this field or load its outline', { exact: true }).click();
  const crossed = { type: 'Polygon', coordinates: [[[11, 48], [11.002, 48.001], [11.002, 48], [11, 48.001], [11, 48]]] };
  await workspace.getByLabel('Existing boundary file', { exact: true }).setInputFiles({ name: 'authored-crossed.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(crossed)) });
  await workspace.getByRole('button', { name: 'Fit supplied outlines', exact: true }).click();
  await expect(workspace.getByRole('button', { name: 'Corner 2; longitude 11.002, latitude 48.001', exact: true })).toBeVisible();
  await expect(workspace.getByText('Your unfinished draft is kept privately on this device. Save for comparison to keep it in the shared farm workspace.', { exact: true })).toBeVisible();
  let rejected = page.waitForResponse(response => response.url().endsWith(`/farms/${fixture.sales_farm.id}/field-proposals`) && response.request().method() === 'POST');
  await workspace.getByRole('button', { name: 'Save for comparison', exact: true }).click();
  expect((await rejected).status()).toBe(422);
  await page.reload();
  await workspace.getByRole('button', { name: 'Open boundary tools', exact: true }).click();
  await expect(workspace.getByLabel('Field name', { exact: true })).toHaveValue('Authored recoverable field draft');
  await expect(workspace.getByLabel('What changed, or where did this outline come from?', { exact: true })).toHaveValue(note);
  rejected = page.waitForResponse(response => response.url().endsWith(`/farms/${fixture.sales_farm.id}/field-proposals`) && response.request().method() === 'POST');
  await workspace.getByRole('button', { name: 'Save for comparison', exact: true }).click();
  expect((await rejected).status()).toBe(422);
  expect((await (await page.request.get(`/api/v1/farms/${fixture.sales_farm.id}/fields`)).json()).items).toHaveLength(0);
  const repaired = { type: 'MultiPolygon', coordinates: [
    [[[11, 48], [11.002, 48], [11.002, 48.001], [11, 48.001], [11, 48]],
      [[11.0003, 48.0003], [11.0006, 48.0003], [11.0006, 48.0006], [11.0003, 48.0006], [11.0003, 48.0003]]],
    [[[11.003, 48], [11.004, 48], [11.004, 48.001], [11.003, 48.001], [11.003, 48]]],
  ] };
  await workspace.getByText('Locate this field or load its outline', { exact: true }).click();
  await workspace.getByLabel('Existing boundary file', { exact: true }).setInputFiles({ name: 'authored-repaired.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(repaired)) });
  await workspace.getByRole('button', { name: 'Fit supplied outlines', exact: true }).click();
  await expect(workspace.getByRole('button', { name: 'Corner 2; longitude 11.002, latitude 48', exact: true })).toBeVisible();
  await workspace.getByLabel('Part to edit', { exact: true }).selectOption('1');
  await workspace.getByRole('button', { name: 'Corner 2; longitude 11.004, latitude 48', exact: true }).press('ArrowRight');
  await workspace.getByRole('button', { name: 'Undo last boundary adjustment', exact: true }).click();
  await workspace.getByLabel('Part to edit', { exact: true }).selectOption('0');
  await expect(workspace.getByRole('button', { name: 'Corner 2; longitude 11.002, latitude 48', exact: true })).toBeVisible();
  const savePath = `**/api/v1/farms/${fixture.sales_farm.id}/field-proposals`;
  let releaseSave;
  const holdSave = new Promise(resolve => { releaseSave = resolve; });
  await page.route(savePath, async route => { await holdSave; await route.continue(); });
  const pendingSave = page.waitForRequest(request => request.url().endsWith(`/farms/${fixture.sales_farm.id}/field-proposals`) && request.method() === 'POST');
  try {
    await workspace.getByRole('button', { name: 'Save for comparison', exact: true }).click();
    await pendingSave;
    await expect(workspace.locator('.parcel-map-editor')).toHaveAttribute('inert', '');
  } finally {
    releaseSave();
  }
  await expect(workspace.getByText('Your boundary change is saved in the workspace. Compare the old and proposed fields below before confirming.', { exact: true })).toBeVisible();
  await page.unroute(savePath);
  expect((await (await page.request.get(`/api/v1/farms/${fixture.sales_farm.id}/fields`)).json()).items).toHaveLength(0);
  await page.reload();
  await expect(workspace.getByRole('heading', { name: 'Authored recoverable field draft', exact: true })).toBeVisible();
  await workspace.getByRole('checkbox', { name: 'I compared the field names, crops, outlines and reference details.', exact: true }).check();
  await workspace.getByRole('button', { name: 'Confirm private field change', exact: true }).click();
  await expect(workspace.getByText('Your farm fields were updated and their earlier outlines retained in history. No official register was changed.', { exact: true })).toBeVisible();
  const current = (await (await page.request.get(`/api/v1/farms/${fixture.sales_farm.id}/fields`)).json()).items;
  expect(current).toHaveLength(1);
  expect(current[0].name).toBe('Authored recoverable field draft');
  expect(current[0].geometry).toEqual(repaired);
  expect(browserErrors).toEqual([]);
  expect(tiles.calls.every(call => !call.url.includes(fixture.sales_farm.id) && !call.url.includes(fixture.accounts.seller.email)
    && !String(call.headers.referer || '').includes(fixture.sales_farm.id) && !call.headers.authorization && !call.headers.cookie)).toBe(true);
});

test('Dutch dairy bookkeeper reviews a receipt and mapped CSV without losing uncertain source cells', async ({ page }) => {
  await signIn(page, 'intake');
  await page.goto(`/app/documents?farm_id=${fixture.intake_farm.id}`);
  await page.getByLabel('Choose a PDF, photo or text file', { exact: true }).setInputFiles({ name: 'fictional-feed-receipt.txt', mimeType: 'text/plain', buffer: Buffer.from('FICTIONAL FEED RECEIPT\nSupplier: Fictional co-op\nDate: 2026-05-10\nQuantity: 25 kg\nTotal: 45.00 EUR\n') });
  await page.getByLabel('What is it?', { exact: true }).selectOption('receipt');
  await page.getByRole('button', { name: 'Save and read document', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Check the suggested details', exact: true })).toBeVisible();
  const documentId = new URL(page.url()).pathname.split('/').pop();
  await expect(page.getByLabel('Save as', { exact: true })).toHaveValue('');
  await page.getByLabel('Save as', { exact: true }).selectOption('purchases');
  await page.getByLabel('Give this record a clear name', { exact: true }).fill('Authored dairy feed receipt');
  await page.getByLabel('Purchase date (if known)', { exact: true }).fill('2026-05-10');
  await page.getByLabel('Quantity (if readable)', { exact: true }).fill('25');
  await page.getByLabel('Unit (leave blank if unknown)', { exact: true }).fill('kg');
  await page.getByRole('region', { name: 'Check the purchase', exact: true }).getByRole('textbox', { name: 'Supplier', exact: true }).fill('Fictional co-op');
  await page.getByLabel('Total amount (if readable)', { exact: true }).fill('45.00');
  await page.getByLabel('Currency', { exact: true }).fill('EUR');
  await page.getByLabel('Category', { exact: true }).selectOption('inputs');
  await page.getByRole('button', { name: 'Save purchase for review', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Saved purchase', exact: true })).toBeVisible();
  let purchases = await collection(page, 'purchases');
  expect(purchases).toHaveLength(1);
  expect(purchases[0].data.review_status).toBe('proposed');
  expect(purchases[0].data.document_id).toBe(documentId);
  await page.getByLabel('What did you check? Explain any warning before confirming.', { exact: true }).fill('Compared the actual receipt date, 25 kg and printed 45.00 EUR total. No VAT amount was printed.');
  await page.getByRole('button', { name: 'Confirm this purchase', exact: true }).click();
  await expect(page.getByText('Confirmed. The original remains attached.', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Open saved purchase', exact: true }).click();
  await expect(page.getByText('Confirmed. The original remains attached.', { exact: true })).toBeVisible();
  purchases = await collection(page, 'purchases');
  expect(purchases[0].data.review_status).toBe('confirmed');
  expect(purchases[0].data.tax_amount).toBeNull();
  expect((await collection(page, 'operations'))).toHaveLength(0);

  await openMoreTool(page, '/app/imports');
  const csv = 'source_id,value,comment\r\n0007,0,\r\n0007,"-12,50",NULL\r\n0008,unreadable,unknown\r\n';
  await page.getByLabel('Which farm is this for?', { exact: true }).selectOption(fixture.intake_farm.id);
  await page.getByLabel('File or photo', { exact: true }).setInputFiles({ name: 'authored-earlier-ledger.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByRole('button', { name: 'Read this file', exact: true }).click();
  await page.getByRole('link', { name: 'Review rows and save', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'authored-earlier-ledger.csv', exact: true })).toBeVisible();
  const importId = new URL(page.url()).searchParams.get('import');
  await page.getByLabel('These rows contain', { exact: true }).selectOption('facts');
  await page.getByRole('button', { name: 'Change dates, units or other settings', exact: true }).click();
  await page.getByLabel('Time basis for all rows', { exact: true }).selectOption('campaign_year');
  await page.getByLabel('Year or date for all rows', { exact: true }).fill('2025');
  await page.getByLabel('Unit for all rows', { exact: true }).selectOption('manual');
  await page.getByLabel('Shared unit', { exact: true }).fill('EUR');
  await page.getByLabel('Shared fact reference (optional)', { exact: true }).fill('annual_feed_credit');
  await page.getByLabel('Shared fact description (optional)', { exact: true }).fill('Earlier feed credit');
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); });
  await page.waitForLoadState('networkidle');
  await expect(page.getByLabel('Year or date for all rows', { exact: true })).toHaveValue('2025');
  await expect(page.getByLabel('Shared unit', { exact: true })).toHaveValue('EUR');
  await page.getByRole('button', { name: 'Suggest column meanings again', exact: true }).click();
  await page.getByLabel('Value type for value', { exact: true }).selectOption('number');
  const numericColumn = page.locator('tr').filter({ has: page.getByLabel('Value type for value', { exact: true }) });
  await numericColumn.getByLabel('Source decimal mark', { exact: true }).selectOption(',');
  const identityColumn = page.locator('tr').filter({ has: page.getByLabel('Destination for source_id', { exact: true }) });
  await identityColumn.getByLabel('Reference check', { exact: true }).selectOption('identifier');
  await page.getByRole('button', { name: 'Check my rows', exact: true }).click();
  await expect(page.getByRole('heading', { name: '3. Review and save your rows', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Select row 3', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'Select row 1', exact: true }).check();
  await page.getByLabel('What did you check in the selected rows?', { exact: true }).fill('Preserved identifier 0007 and real zero. Explicit comma-decimal mapping does not change the original cells.');
  const rowWarnings = page.getByRole('checkbox', { name: 'I checked the warnings on each selected row and want to keep these proposed records.', exact: true });
  if (await rowWarnings.count()) await rowWarnings.check();
  await page.getByRole('button', { name: 'Save 1 selected proposal', exact: true }).click();
  await expect(page.getByText('1 proposal saved. The original source rows are retained.', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Select row 2', exact: true }).check();
  await expect(page.getByRole('button', { name: 'Save 1 selected proposal', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'I checked the warnings on each selected row and want to keep these proposed records.', exact: true }).check();
  await page.getByRole('button', { name: 'Save 1 selected proposal', exact: true }).click();
  await expect(page.getByText('Proposal saved', { exact: true })).toHaveCount(2);
  const facts = await collection(page, 'facts');
  expect(facts.map(item => Number(item.data.value)).sort((a, b) => a - b)).toEqual([-12.5, 0]);
  expect(facts.every(item => item.data.review_status === 'proposed' && item.data.period === '2025')).toBe(true);
  const sourceRows = (await (await page.request.get(`/api/v1/imports/${importId}/rows`)).json()).items;
  expect(sourceRows.map(item => item.data.original_row)).toEqual([['0007', '0', ''], ['0007', '-12,50', 'NULL'], ['0008', 'unreadable', 'unknown']]);
  await page.reload();
  await expect(page.getByRole('checkbox', { name: 'Select row 3', exact: true })).toBeDisabled();
  expect((await collection(page, 'facts'))).toHaveLength(2);
});

test('Slovak greenhouse grower separates profile review, actual facility use and inspection preparation', async ({ page }) => {
  await signIn(page, 'specialist');
  const farmId = fixture.specialist_farm.id;
  await page.goto(`/app/checks?farm_id=${farmId}&year=2026`);
  await page.getByLabel('Do you use plant-protection products professionally?', { exact: true }).selectOption('yes');
  await page.getByLabel('Is this farm an organic operator?', { exact: true }).selectOption('yes');
  await page.getByRole('button', { name: 'Save answers for review', exact: true }).click();
  await expect(page.getByRole('heading', { name: '2. Read and confirm each saved answer', exact: true })).toBeVisible();
  let proposed = (await collection(page, 'facts')).filter(item => item.data.key === 'uses_professional_plant_protection');
  expect(proposed).toHaveLength(1);
  expect(proposed[0].data.value).toBe(true);
  expect(proposed[0].data.review_status).toBe('proposed');
  let card = page.locator('article.admin-check').filter({ has: page.getByRole('heading', { name: 'Do you use plant-protection products professionally?', exact: true }) });
  await expect(card.getByRole('button', { name: 'Confirm this answer', exact: true })).toBeDisabled();
  await card.getByLabel('Where did you check this answer?', { exact: true }).fill('Fictional 2026 greenhouse notebook, checked by the grower.');
  await card.getByRole('checkbox', { name: 'I read this saved answer and checked that it is correct for this farm and year.', exact: true }).check();
  await card.getByRole('button', { name: 'Confirm this answer', exact: true }).click();
  await expect(card.getByText('This answer is confirmed. The checks below use the server’s latest saved evidence.', { exact: true })).toBeVisible();
  const organicAnswer = page.locator('article.admin-check').filter({ has: page.getByRole('heading', { name: 'Is this farm an organic operator?', exact: true }) });
  await organicAnswer.getByLabel('Where did you check this answer?', { exact: true }).fill('Fictional organic operator activity records for 2026; no certification is inferred from this answer.');
  await organicAnswer.getByRole('checkbox', { name: 'I read this saved answer and checked that it is correct for this farm and year.', exact: true }).check();
  await organicAnswer.getByRole('button', { name: 'Confirm this answer', exact: true }).click();
  await expect(organicAnswer.getByText('This answer is confirmed. The checks below use the server’s latest saved evidence.', { exact: true })).toBeVisible();
  await page.getByRole('group', { name: 'Which types of professional plant-protection use take place?', exact: true }).getByRole('checkbox', { name: 'closed space', exact: true }).check();
  await page.getByRole('button', { name: 'Save answers for review', exact: true }).click();
  card = page.locator('article.admin-check').filter({ has: page.getByRole('heading', { name: 'Which types of professional plant-protection use take place?', exact: true }) });
  await card.getByLabel('Where did you check this answer?', { exact: true }).fill('The authored operation is inside glasshouse A, not a surface-hectare treatment.');
  await card.getByRole('checkbox', { name: 'I read this saved answer and checked that it is correct for this farm and year.', exact: true }).check();
  await card.getByRole('button', { name: 'Confirm this answer', exact: true }).click();
  await expect(card.getByText('This answer is confirmed. The checks below use the server’s latest saved evidence.', { exact: true })).toBeVisible();
  await page.reload();
  const obligation = page.locator('article.admin-check').filter({ has: page.getByRole('heading', { name: 'Closed-space treatment record details', exact: true }) });
  await expect(obligation.getByText('Applies to recorded farm details', { exact: true })).toBeVisible();
  await expect(obligation).toContainText('No established date');
  await obligation.getByRole('checkbox', { name: 'Make a checklist and follow-up tasks for this check', exact: true }).check();
  const sustainability = page.locator('article.admin-check').filter({ has: page.getByRole('heading', { name: 'Keep activity and input evidence for organic production', exact: true }) });
  await expect(sustainability.getByText('Applies to recorded farm details', { exact: true })).toBeVisible();
  await sustainability.getByRole('checkbox', { name: 'Make a checklist and follow-up tasks for this check', exact: true }).check();
  await page.getByRole('button', { name: 'Save selected checklists and tasks', exact: true }).click();
  await expect(page.getByText(/2 checklists and \d+ follow-up tasks saved\./)).toBeVisible();
  const checklists = await collection(page, 'checklists');
  expect(checklists).toHaveLength(2);
  expect(checklists.every(record => record.data.items.every(item => !item.done && item.deadline == null))).toBe(true);
  expect((await collection(page, 'tasks')).every(item => item.data.status === 'open' && item.data.due_date == null)).toBe(true);

  await page.goto(`/app/record-work?farm_id=${farmId}`);
  await page.getByLabel('What would you like to record?', { exact: true }).selectOption('pesticide_application');
  await page.getByLabel('When did it happen?', { exact: true }).fill('2026-06-11');
  await page.getByLabel('Which field or growing area?', { exact: true }).fill('Glasshouse A');
  await page.getByLabel('Product used', { exact: true }).fill('Fictional greenhouse product, not authorisation evidence');
  await page.getByLabel('What did you treat?', { exact: true }).selectOption('closed_space');
  await page.getByLabel('Product authorisation number on the label', { exact: true }).fill('1234567');
  await page.getByLabel('Person who applied it', { exact: true }).fill('Fictional grower');
  await page.getByLabel('Dose used for this application', { exact: true }).fill('0.01');
  await page.getByLabel('Dose unit from the label or application record', { exact: true }).fill('l/m2');
  await page.getByLabel('Actual size of the treated facility', { exact: true }).fill('400');
  await page.getByLabel('Unit for the treated size', { exact: true }).selectOption('m2');
  await page.getByLabel('Actual field, facility or batch location', { exact: true }).fill('Glasshouse A, bench section 2');
  await page.getByLabel('Crop or use', { exact: true }).fill('Tomatoes');
  await page.getByLabel('Does the product label require a start time?', { exact: true }).selectOption('no');
  await page.getByLabel('Does the product label require a growth stage?', { exact: true }).selectOption('no');
  await expect(page.getByLabel('Total product quantity (optional, if recorded)', { exact: true })).toHaveValue('');
  await saveAndReview(page);
  const work = (await collection(page, 'operations'))[0];
  expect(work.data.review_status).toBe('confirmed');
  expect(work.data.quantity).toBeNull();
  expect(work.data.treated_unit).toBe('m2');
  expect(Number(work.data.treated_size)).toBe(400);
  expect(Number(work.data.dose)).toBe(0.01);
  expect(work.data.period).toBe('2026-06-11');
  expect((await collection(page, 'purchases'))).toHaveLength(0);
  await page.goto(`/app/checks?farm_id=${farmId}&year=2026`);
  await expect(page.getByText(/The authority still makes any official decision\./)).toBeVisible();
  await expect(obligation).toContainText('No established date');
  const liveChecks = await (await page.request.get(`/api/v1/compliance/farms/${farmId}?year=2026`)).json();
  expect(liveChecks.issues.some(issue => issue.code === 'national_deadline_unknown')).toBe(true);

  const treatmentChecklist = checklists.find(record => record.data.compliance_rule_id === 'eu-ppp-closed-space-use');
  expect(treatmentChecklist).toBeTruthy();
  await page.goto(`/app/guidance?checklist_id=${treatmentChecklist.id}`);
  const savedChecklist = page.locator(`#checklist-${treatmentChecklist.id}`);
  await expect(savedChecklist).toHaveAttribute('open', '');
  const actionReview = await (await page.request.get(`/api/v1/checklists/${treatmentChecklist.id}/review`)).json();
  const evidenceAction = actionReview.items.find(item => item.mode === 'evidence' && item.can_complete && item.evidence.some(record => record.id === work.id));
  expect(evidenceAction, 'The saved missing-record action must become reviewable using the actual confirmed application.').toBeTruthy();
  const evidenceLabel = actionReview.checklist.data.items.find(item => item.key === evidenceAction.key).label;
  const evidenceCard = savedChecklist.locator('article.panel').filter({ has: page.getByRole('heading', { name: evidenceLabel, exact: true }) });
  await expect(evidenceCard.getByRole('button', { name: 'Confirm evidence for this item', exact: true })).toBeDisabled();
  await evidenceCard.getByRole('group', { name: 'Which saved evidence did you check?', exact: true }).getByRole('checkbox', { name: work.data.title, exact: false }).check();
  await evidenceCard.getByLabel('What did you check?', { exact: true }).fill('Compared the actual 11 June glasshouse entry: 400 m² treated, 0.01 l/m² dose, with no invented total litres.');
  await evidenceCard.getByRole('button', { name: 'Confirm evidence for this item', exact: true }).click();
  await expect(evidenceCard.getByText('Evidence reviewed.', { exact: true })).toBeVisible();
  const followup = (await collection(page, 'tasks')).find(task => task.data.checklist_id === treatmentChecklist.id && task.data.checklist_item_key === evidenceAction.key);
  expect(followup).toBeTruthy();
  await evidenceCard.getByLabel('What follow-up work did you finish?', { exact: true }).fill('Finished checking the actual glasshouse notebook and its saved treatment evidence, while keeping the other follow-ups open.');
  await expect(evidenceCard.getByRole('button', { name: 'Finish follow-up', exact: true })).toBeDisabled();
  await evidenceCard.getByRole('checkbox', { name: 'I finished this follow-up work.', exact: true }).check();
  await evidenceCard.getByRole('button', { name: 'Finish follow-up', exact: true }).click();
  await expect(evidenceCard.getByRole('button', { name: 'Finish follow-up', exact: true })).toHaveCount(0);
  expect((await (await page.request.get(`/api/v1/tasks/${followup.id}`)).json()).data.status).toBe('done');
  expect((await collection(page, 'tasks')).some(task => task.id !== followup.id && task.data.status === 'open')).toBe(true);
  const humanAction = actionReview.items.find(item => item.mode === 'human_review');
  expect(humanAction).toBeTruthy();
  const humanLabel = actionReview.checklist.data.items.find(item => item.key === humanAction.key).label;
  const humanCard = savedChecklist.locator('article.panel').filter({ has: page.getByRole('heading', { name: humanLabel, exact: true }) });
  await humanCard.getByLabel('What did you check?', { exact: true }).fill('Read the cited source and recorded that national timing still needs an adviser; this is not legal acceptance.');
  await expect(humanCard.getByRole('button', { name: 'Save this review', exact: true })).toBeDisabled();
  await humanCard.getByRole('checkbox', { name: 'I reviewed this step and recorded what still needs attention. This is not confirmation of legal compliance.', exact: true }).check();
  await humanCard.getByRole('button', { name: 'Save this review', exact: true }).click();
  await expect(humanCard.getByText('Review saved. Check the farm checks page for any remaining follow-up.', { exact: true })).toBeVisible();
  await page.reload();
  await expect(evidenceCard.getByText('Evidence reviewed.', { exact: true })).toBeVisible();
  await expect(humanCard.getByText('Review saved. Check the farm checks page for any remaining follow-up.', { exact: true })).toBeVisible();
  const persistedChecklist = await (await page.request.get(`/api/v1/checklists/${treatmentChecklist.id}`)).json();
  expect(persistedChecklist.data.items.find(item => item.key === evidenceAction.key).evidence_operation_ids).toContain(work.id);
  expect(persistedChecklist.data.items.find(item => item.key === humanAction.key).status).toBe('review_recorded');
  const afterReview = await (await page.request.get(`/api/v1/compliance/farms/${farmId}?year=2026`)).json();
  expect(afterReview.issues.some(issue => issue.code === 'national_deadline_unknown')).toBe(true);
  await page.goto('/app/home');
  await expect(page.getByRole('heading', { name: 'Home at Slovak greenhouse', exact: true })).toBeVisible();
  await expect(page.locator('#next-task')).toBeVisible();
  await expect(page.locator('#next-task').getByText(followup.data.title, { exact: true })).toHaveCount(0);
  const homeProgress = await (await page.request.get(`/api/v1/workflow/home?farm_id=${farmId}`)).json();
  expect(homeProgress.next_actions.some(action => action.record_id === followup.id)).toBe(false);

  await page.goto(`/app/paperwork/${fixture.inspection.id}`);
  await page.getByRole('button', { name: 'Confirm request details', exact: true }).click();
  await expect(page.getByText('Request details confirmed. The evidence still needs its own review.', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Fix or review this detail', exact: true }).first()).toBeVisible();
  const answerCard = page.locator('#answers article.evidence-card').first();
  const answerEditor = answerCard.locator('details').filter({ has: page.getByText('Add or correct an answer', { exact: true }) });
  // A missing answer is already open; clicking its summary would close it.
  if (await answerEditor.getAttribute('open') === null) await answerEditor.locator(':scope > summary').click();
  await expect(answerEditor).toHaveAttribute('open', '');
  await expect(answerCard.getByLabel('Answer type', { exact: true })).toBeVisible();
  await answerCard.getByLabel('Answer type', { exact: true }).selectOption('number');
  await answerCard.getByLabel('Answer', { exact: true }).fill('0.40');
  await answerCard.getByLabel('Where did this answer come from?', { exact: true }).fill('Fictional checked holding plan. This is standing holding area, not the treated facility area.');
  await answerCard.getByRole('button', { name: 'Check & save proposed answer', exact: true }).click();
  await expect(answerCard.getByText('Needs review', { exact: true })).toBeVisible();
  await answerCard.getByLabel('Review note', { exact: true }).fill('Compared the holding plan; exact 0.40 ha, distinct from 400 m² treated inside a facility.');
  await answerCard.getByRole('button', { name: 'Confirm this answer', exact: true }).click();
  await expect(page.getByRole('progressbar', { name: 'Questions with a confirmed answer', exact: true })).toHaveAttribute('value', '1');
  await page.getByRole('button', { name: 'Check & prepare response', exact: true }).click();
  await expect(page.getByText('No blocking requirements were found in this draft. Review the values before approving.', { exact: true })).toBeVisible();
  const reports = await collection(page, 'reports');
  expect(reports).toHaveLength(1);
  expect(reports[0].data.status).toBe('draft');
  await page.reload();
  await expect(page.getByRole('progressbar', { name: 'Questions with a confirmed answer', exact: true })).toHaveAttribute('value', '1');
  expect((await (await page.request.get(`/api/v1/requests/${fixture.inspection.id}`)).json()).data.status).toBe('review');

  await page.goto(`/app/checks?farm_id=${farmId}&year=2026`);
  await page.getByText('Change a saved farm answer', { exact: true }).click();
  const corrections = page.locator('details').filter({ has: page.getByText('Change a saved farm answer', { exact: true }) });
  const organicCorrection = corrections.locator('article.admin-check').filter({ has: page.getByRole('heading', { name: 'Is this farm an organic operator?', exact: true }) });
  await organicCorrection.getByRole('button', { name: 'Change this answer', exact: true }).click();
  await organicCorrection.getByLabel('Is this farm an organic operator?', { exact: true }).selectOption('no');
  const usesCorrection = corrections.locator('article.admin-check').filter({ has: page.getByRole('heading', { name: 'Which types of professional plant-protection use take place?', exact: true }) });
  await usesCorrection.getByRole('button', { name: 'Change this answer', exact: true }).click();
  await expect(usesCorrection.getByRole('checkbox', { name: 'closed space', exact: true })).toBeChecked();
  await usesCorrection.getByRole('checkbox', { name: 'surface', exact: true }).check();
  const correctionResponse = page.waitForResponse(response => response.url().endsWith(`/compliance/farms/${farmId}/profile`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save answers for review', exact: true }).click();
  const correctionRecords = (await (await correctionResponse).json()).facts;
  expect(correctionRecords).toHaveLength(2);
  expect(correctionRecords.find(record => record.data.key === 'organic_operator').data.value).toBe(false);
  expect(correctionRecords.find(record => record.data.key === 'ppp_use_type').data.value).toEqual(['closed_space', 'surface']);
  for (const record of correctionRecords) {
    expect(record.data.review_status).toBe('proposed');
    expect((await (await page.request.get(`/api/v1/facts/${record.data.supersedes_id}`)).json()).data.review_status).toBe('confirmed');
    const proposedCard = page.locator('article.admin-check').filter({ has: page.getByRole('heading', { name: record.data.label, exact: true }) })
      .filter({ has: page.getByRole('button', { name: 'Confirm this answer', exact: true }) });
    await proposedCard.getByLabel('Where did you check this answer?', { exact: true }).fill('Corrected the fictional 2026 activity notebook: native No and both actual use types, with earlier answers retained in history.');
    await proposedCard.getByRole('checkbox', { name: 'I read this saved answer and checked that it is correct for this farm and year.', exact: true }).check();
    await proposedCard.getByRole('button', { name: 'Confirm this answer', exact: true }).click();
    await expect(proposedCard).toHaveCount(0);
    expect((await (await page.request.get(`/api/v1/facts/${record.data.supersedes_id}`)).json()).data.review_status).toBe('rejected');
  }
  await page.reload();
  await page.getByText('Change a saved farm answer', { exact: true }).click();
  await expect(organicCorrection).toContainText('Saved answer: No');
  await expect(usesCorrection).toContainText('Saved answer: closed space, surface');
  const correctedProfile = await (await page.request.get(`/api/v1/compliance/farms/${farmId}?year=2026`)).json();
  expect(correctedProfile.profile_review.find(item => item.key === 'organic_operator').current_value).toBe(false);
  expect(correctedProfile.profile_review.find(item => item.key === 'ppp_use_type').current_value).toEqual(['closed_space', 'surface']);

  // The ordinary farm answer editor must retain native values too, and may
  // not silently rebase an encrypted unsaved draft after another client saves.
  const organicSource = correctionRecords.find(record => record.data.key === 'organic_operator');
  await page.goto(`/app/fields/${farmId}#facts`);
  await expect(page.locator('#facts').getByRole('heading', { name: 'Check answers saved about this farm', exact: true })).toBeVisible();
  const organicFact = page.locator('#facts article.panel').filter({ has: page.getByRole('heading', { name: organicSource.data.label, exact: true }) })
    .filter({ has: page.getByText('Propose a correction', { exact: true }) });
  await organicFact.getByText('Propose a correction', { exact: true }).click();
  const ordinaryCorrection = organicFact.locator('form');
  await expect(ordinaryCorrection.getByLabel('Kind of value', { exact: true })).toHaveValue('boolean');
  await expect(ordinaryCorrection.getByLabel('Value', { exact: true })).toHaveValue('no');
  await ordinaryCorrection.getByLabel('Value', { exact: true }).selectOption('yes');
  await ordinaryCorrection.getByLabel('Where did you check this?', { exact: true }).fill('Authored ordinary-editor correction; this Boolean must remain a proposal until separately reviewed.');
  const newFactResponse = page.waitForResponse(response => response.url().endsWith('/api/v1/facts') && response.request().method() === 'POST');
  await ordinaryCorrection.getByRole('button', { name: 'Propose correction', exact: true }).click();
  const ordinary = await (await newFactResponse).json();
  expect(ordinary.data.value).toBe(true);
  expect(ordinary.data.review_status).toBe('proposed');
  const editableFact = page.locator('#facts article.panel').filter({ has: page.getByRole('heading', { name: ordinary.data.label, exact: true }) })
    .filter({ has: page.getByText('Edit this proposal', { exact: true }) });
  await editableFact.getByText('Edit this proposal', { exact: true }).click();
  const ordinaryDraft = editableFact.locator('form');
  await expect(ordinaryDraft.getByLabel('Value', { exact: true })).toHaveValue('yes');
  await ordinaryDraft.getByLabel('Where did you check this?', { exact: true }).fill('Unsaved authored Boolean draft, compared only after the concurrent saved version is displayed.');
  await expect(ordinaryDraft.getByText('Saving draft on this device…', { exact: true })).toHaveCount(0);
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  const secondClient = await page.request.patch(`/api/v1/facts/${ordinary.id}`, { headers: { 'X-CSRF-Token': session.csrf_token },
    data: { expected_revision: ordinary.revision, data: { value: false, notes: 'Concurrent independent HTTP client saved a different Boolean.' } } });
  expect(secondClient.ok(), await secondClient.text()).toBe(true);
  const concurrent = await secondClient.json();
  expect(concurrent.revision).toBe(ordinary.revision + 1);
  await page.reload();
  await expect(page.locator('#facts').getByRole('heading', { name: 'Check answers saved about this farm', exact: true })).toBeVisible();
  await editableFact.getByText('Edit this proposal', { exact: true }).click();
  await expect(ordinaryDraft.getByLabel('Value', { exact: true })).toHaveValue('yes');
  await expect(ordinaryDraft).toContainText('Latest saved answer: No');
  await expect(ordinaryDraft.getByRole('button', { name: 'Save proposed answer', exact: true })).toBeDisabled();
  await expect(ordinaryDraft.getByRole('button', { name: 'Keep my changes after comparing', exact: true })).toBeDisabled();
  await ordinaryDraft.getByRole('checkbox', { name: 'I compared my draft with the latest saved answer.', exact: true }).check();
  await ordinaryDraft.getByRole('button', { name: 'Keep my changes after comparing', exact: true }).click();
  const savedDraftResponse = page.waitForResponse(response => response.url().endsWith(`/api/v1/facts/${ordinary.id}`) && response.request().method() === 'PATCH');
  await ordinaryDraft.getByRole('button', { name: 'Save proposed answer', exact: true }).click();
  const savedResponse = await savedDraftResponse;
  expect(savedResponse.request().postDataJSON().expected_revision).toBe(concurrent.revision);
  expect((await savedResponse.json()).data.value).toBe(true);
  const ordinaryHistory = await (await page.request.get(`/api/v1/facts/${ordinary.id}/history`)).json();
  expect(ordinaryHistory.items.some(item => item.revision === concurrent.revision && item.data.value === false)).toBe(true);
  expect((await (await page.request.get(`/api/v1/facts/${organicSource.id}`)).json()).data.review_status).toBe('confirmed');
});

test('Czech mixed farmer keeps animal records, source alerts and human help under explicit controls', async ({ page, browser }) => {
  await signIn(page, 'peer');
  const farmId = fixture.peer_farm.id;
  await page.goto(`/app/record-work?farm_id=${farmId}`);
  await page.getByLabel('What would you like to record?', { exact: true }).selectOption('animal_birth');
  await page.getByLabel('When did it happen?', { exact: true }).fill('2026-05-19');
  await page.getByLabel('Where were the animals?', { exact: true }).fill('Fictional calving shed');
  await page.getByLabel('Animal group or identification', { exact: true }).fill('Authored calf group A');
  await page.getByLabel('How many animals?', { exact: true }).fill('1.5');
  await page.getByRole('button', { name: 'Check this entry', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save entry for checking', exact: true })).toBeDisabled();
  await expect(page.getByLabel('How many animals?', { exact: true })).toHaveValue('1.5');
  expect((await collection(page, 'operations'))).toHaveLength(0);
  await page.getByLabel('How many animals?', { exact: true }).fill('2');
  await saveAndReview(page);
  const animal = (await collection(page, 'operations'))[0];
  expect(animal.data.type).toBe('animal_birth');
  expect(Number(animal.data.quantity)).toBe(2);
  expect(animal.data.unit).toBe('head');
  expect((await collection(page, 'sales'))).toHaveLength(0);

  await page.goto(`/app/updates?farm_id=${farmId}`);
  await expect(page.getByRole('heading', { name: 'Updates from official websites', exact: true })).toBeVisible();
  await expect(page.getByText(/A changed web page does not by itself establish a changed legal duty/)).toBeVisible();
  const enabled = page.getByRole('checkbox', { name: 'Show relevant source changes inside my farm workspace', exact: true });
  await expect(enabled).toBeChecked();
  await enabled.click();
  await expect(page.getByText('Your in-app update preference is saved.', { exact: true })).toBeVisible();
  await expect(enabled).not.toBeChecked();
  await page.reload();
  await expect(enabled).not.toBeChecked();
  const preferences = (await (await page.request.get(`/api/v1/regulatory/updates?farm_id=${farmId}`)).json()).preferences;
  expect(preferences.enabled).toBe(false);
  await enabled.click();
  await expect(page.getByText('Your in-app update preference is saved.', { exact: true })).toBeVisible();
  await expect(enabled).toBeChecked();

  await page.goto('/app/help');
  await page.getByLabel('Which farm is the question about?', { exact: true }).selectOption(farmId);
  const consent = page.getByRole('checkbox', { name: 'Include permitted farm records in this question. Leave this off for general guidance.', exact: true });
  await expect(consent).not.toBeChecked();
  await page.getByLabel('What would you like help with?', { exact: true }).fill('How should I check an entry copied from my farm notebook?');
  let question = page.waitForResponse(response => response.url().endsWith('/api/v1/assistant/chat') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Ask for help', exact: true }).click();
  let answer = await question;
  expect(answer.request().postDataJSON().include_farm_context).toBe(false);
  expect(answer.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Sources to check', exact: true })).toBeVisible();
  await expect(page.getByText(/No farm data or prior chat history/)).toBeVisible();
  const workBefore = await collection(page, 'operations');
  await consent.check();
  await page.getByLabel('What would you like help with?', { exact: true }).fill('What should I review before using my saved notebook entries?');
  question = page.waitForResponse(response => response.url().endsWith('/api/v1/assistant/chat') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Ask for help', exact: true }).click();
  answer = await question;
  expect(answer.request().postDataJSON().include_farm_context).toBe(true);
  expect((await answer.json()).history_stored).toBe(false);
  await expect(page.getByRole('heading', { name: 'Help from the hosted model', exact: true })).toHaveCount(2);
  expect(await collection(page, 'operations')).toEqual(workBefore);
  await page.getByRole('button', { name: 'Clear this conversation', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Help from the hosted model', exact: true })).toHaveCount(0);

  await page.goto('/app/community');
  await page.getByLabel('Which farm?', { exact: true }).selectOption(farmId);
  await page.getByLabel('Who should receive it?', { exact: true }).selectOption(fixture.adviser_id);
  const privateTitle = 'Authored private question about the calf notebook';
  const privateText = 'PRIVATE-CALF-DETAIL: please compare the actual birth date with my notebook before I use this in an inspection.';
  await page.getByLabel('What do you need a hand with?', { exact: true }).fill(privateTitle);
  await page.getByLabel('Your question', { exact: true }).fill(privateText);
  await page.getByRole('button', { name: 'Send privately to my adviser', exact: true }).click();
  await expect(page.getByText('Your question was sent privately to the adviser you selected.', { exact: true })).toBeVisible();
  const privateQuestion = (await collection(page, 'adviser/questions'))[0];
  const adviserContext = await browser.newContext({ baseURL: process.env.FUNKYFARM_BROWSER_URL, reducedMotion: 'reduce' });
  try {
    const adviserPage = await adviserContext.newPage();
    await signIn(adviserPage, 'adviser');
    await chooseWorkspace(adviserPage, fixture.accounts.peer.workspace_id);
    await adviserPage.goto('/app/community');
    await expect(adviserPage.getByLabel('Switch workspace', { exact: true })).toHaveValue(fixture.accounts.peer.workspace_id);
    await adviserPage.reload();
    await expect(adviserPage.getByLabel('Switch workspace', { exact: true })).toHaveValue(fixture.accounts.peer.workspace_id);
    await adviserPage.getByLabel('Which farm?', { exact: true }).selectOption(farmId);
    await adviserPage.getByRole('button', { name: privateTitle, exact: true }).click();
    await expect(adviserPage.getByText(privateText, { exact: true })).toBeVisible();
    await adviserPage.getByLabel('Private reply', { exact: true }).fill('I checked the notebook date. Keep the supporting original, and confirm the authority deadline separately.');
    await adviserPage.getByRole('button', { name: 'Send private reply', exact: true }).click();
    await expect(adviserPage.getByText('I checked the notebook date. Keep the supporting original, and confirm the authority deadline separately.', { exact: true })).toBeVisible();
  } finally {
    await adviserContext.close();
  }
  await page.reload();
  await page.getByLabel('Which farm?', { exact: true }).selectOption(farmId);
  await page.getByRole('button', { name: privateTitle, exact: true }).click();
  await expect(page.getByText('I checked the notebook date. Keep the supporting original, and confirm the authority deadline separately.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Mark question as resolved', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mark question as resolved', exact: true })).toHaveCount(0);
  expect((await (await page.request.get(`/api/v1/adviser/questions/${privateQuestion.id}`)).json()).data.status).toBe('closed');
  await page.getByRole('button', { name: /Ask the community/ }).click();
  const publicTitle = 'Authored practical notebook storage question';
  await page.getByLabel('Your question in a few words', { exact: true }).fill(publicTitle);
  await page.getByLabel('What would you like to ask?', { exact: true }).fill('What practical filing system helps you find last year’s receipts? This is fictional and contains no private farm details.');
  await expect(page.getByRole('button', { name: 'Publish my question', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'I have checked the text and want this question published publicly.', exact: true }).check();
  await page.getByRole('button', { name: 'Publish my question', exact: true }).click();
  await expect(page.getByRole('heading', { name: publicTitle, exact: true })).toBeVisible();
  await expect(page.getByText(privateText, { exact: true })).toHaveCount(0);
  const postId = new URL(page.url()).searchParams.get('question');
  await page.getByRole('button', { name: 'Withdraw my question', exact: true }).click();
  await expect(page.getByText('Your public text has been withdrawn.', { exact: true })).toBeVisible();
  expect((await page.request.get(`/api/v1/community/${postId}`)).status()).toBe(404);
});

test('Dutch arable farmer compares historical LPIS evidence, exports a draft and reviews a private split', async ({ page }) => {
  const tiles = await authoredMapTiles(page);
  async function checkKmlDownload(download, proposal) {
    expect(download.suggestedFilename()).toBe('field-correction-draft.kml');
    const stream = await download.createReadStream();
    expect(stream).toBeTruthy();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const xml = Buffer.concat(chunks).toString('utf8');
    const parsed = await page.evaluate(source => {
      const document = new DOMParser().parseFromString(source, 'application/xml');
      const ns = 'http://www.opengis.net/kml/2.2';
      return {
        error: document.getElementsByTagName('parsererror').length,
        root: document.documentElement.localName,
        namespace: document.documentElement.namespaceURI,
        external: ['NetworkLink', 'Icon', 'href'].flatMap(tag => [...document.getElementsByTagNameNS(ns, tag)]).length,
        descriptions: [...document.getElementsByTagNameNS(ns, 'description')].map(node => node.textContent),
        placemarks: [...document.getElementsByTagNameNS(ns, 'Placemark')].map(node => ({
          name: node.getElementsByTagNameNS(ns, 'name')[0]?.textContent,
          values: Object.fromEntries([...node.getElementsByTagNameNS(ns, 'Data')].map(item => [item.getAttribute('name'), item.getElementsByTagNameNS(ns, 'value')[0]?.textContent || ''])),
          polygons: node.getElementsByTagNameNS(ns, 'Polygon').length,
          rings: [...node.getElementsByTagNameNS(ns, 'coordinates')].map(ring => ring.textContent.trim().split(/\s+/)),
        })),
      };
    }, xml);
    expect(parsed.error).toBe(0);
    expect(parsed.root).toBe('kml');
    expect(parsed.namespace).toBe('http://www.opengis.net/kml/2.2');
    expect(parsed.external).toBe(0);
    expect(parsed.descriptions.length).toBeGreaterThan(0);
    expect(parsed.descriptions.every(text => text.includes('No submission has been made.'))).toBe(true);
    const parcels = proposal.data.parcels || [proposal.data.parcel];
    expect(parsed.placemarks).toHaveLength(parcels.length);
    expect(parsed.placemarks.map(item => item.values.parcel_id).sort()).toEqual(parcels.map(parcel => parcel.id).sort());
    for (const item of parsed.placemarks) {
      const parcel = parcels.find(candidate => candidate.id === item.values.parcel_id);
      expect(item.name).toBe(parcel.name);
      expect(item.values.proposal_id).toBe(proposal.id);
      expect(item.values.proposal_revision).toBe(String(proposal.revision));
      expect(item.values.status).toBe(proposal.data.status);
      expect(item.polygons).toBe(parcel.geometry.type === 'Polygon' ? 1 : parcel.geometry.coordinates.length);
      expect(item.rings.every(ring => ring.length >= 4 && ring[0] === ring.at(-1))).toBe(true);
    }
  }
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await signIn(page, 'land');
  const farm = fixture.land_farm;
  const originalField = farm.data.parcels[0];
  await page.goto(`/app/fields/${farm.id}`);
  await page.getByRole('link', { name: 'Check my fields', exact: true }).click();
  await page.getByRole('link', { name: 'Open this field in the map tools', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#boundaries-${farm.id}$`));
  const workspace = page.getByRole('region', { name: 'Change boundaries', exact: true });
  await workspace.getByRole('button', { name: 'Open boundary tools', exact: true }).click();
  await workspace.getByRole('button', { name: 'Adjust a field', exact: true }).click();
  await expect(workspace.getByLabel('Which field?', { exact: true })).toHaveValue(originalField.id);
  await expect(workspace.getByRole('button', { name: /^Corner \d+; longitude / })).toHaveCount(4);
  const beforeMapNavigation = await cornerLabels(workspace);
  expect(originalField.point).toEqual({ latitude: 52.0005, longitude: 5.001 });
  const boundaryMap = workspace.getByRole('group', { name: 'Field boundary map', exact: true });
  await boundaryMap.scrollIntoViewIfNeeded();
  const corner = workspace.getByRole('button', { name: 'Corner 2; longitude 5.002, latitude 52', exact: true });
  const heldCorner = await corner.elementHandle();
  const markerBox = await corner.boundingBox();
  const mapBox = await boundaryMap.boundingBox();
  expect(markerBox && mapBox).toBeTruthy();
  await page.mouse.move(markerBox.x + markerBox.width / 2, markerBox.y + markerBox.height / 2);
  await page.mouse.down();
  try {
    await page.mouse.move(markerBox.x + markerBox.width / 2 - 12, markerBox.y + markerBox.height / 2 - 12, { steps: 5 });
    // An ordinary controlled parent edit must not tear down an active Leaflet
    // marker simply because the parcel also has a freshly constructed point.
    const dragNote = workspace.getByLabel('What changed, or where did this outline come from?', { exact: true });
    // Keep the map at the same screen coordinates while typing into the
    // ordinary textarea; scrolling it into view would move our pointer target.
    await dragNote.evaluate(element => element.focus({ preventScroll: true }));
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.insertText('Authored note changed while a boundary corner is being dragged.');
    await expect(dragNote).toHaveValue('Authored note changed while a boundary corner is being dragged.');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await heldCorner.evaluate(element => element.isConnected), 'A parent note edit must retain the marker under the held pointer.').toBe(true);
    const pane = boundaryMap.locator('.leaflet-map-pane');
    const beforePan = await pane.evaluate(element => element.style.transform);
    await page.mouse.move(mapBox.x + mapBox.width - 8, mapBox.y + mapBox.height / 2, { steps: 12 });
    await expect.poll(() => pane.evaluate(element => element.style.transform)).not.toBe(beforePan);
    expect(await heldCorner.evaluate(element => element.isConnected), 'Automatic map panning must not destroy the active drag.').toBe(true);
  } finally {
    await page.mouse.up();
  }
  await expect.poll(() => cornerLabels(workspace)).not.toEqual(beforeMapNavigation);
  expect(pageErrors).toEqual([]);
  expect((await (await page.request.get(`/api/v1/farms/${farm.id}`)).json()).data.parcels).toEqual(farm.data.parcels);
  await workspace.getByRole('button', { name: 'Undo last boundary adjustment', exact: true }).click();
  await workspace.getByRole('button', { name: 'Fit supplied outlines', exact: true }).click();
  expect(await cornerLabels(workspace)).toEqual(beforeMapNavigation);
  const publicReads = [];
  page.on('request', request => { if (/\/api\/v1\/connections\/[^/]+\/read$/.test(request.url()) && request.method() === 'POST') publicReads.push(request.postDataJSON()); });
  await workspace.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await workspace.getByRole('button', { name: 'Move east', exact: true }).click();
  await workspace.getByRole('button', { name: 'Fit supplied outlines', exact: true }).click();
  expect(await cornerLabels(workspace)).toEqual(beforeMapNavigation);
  await workspace.getByLabel('Background map', { exact: true }).selectOption('nl-pdok-aerial');
  expect(tiles.calls).toHaveLength(0);
  await workspace.getByRole('checkbox', { name: 'Show background map', exact: true }).check();
  await expect.poll(() => tiles.calls.filter(call => new URL(call.url).hostname === 'service.pdok.nl').length).toBeGreaterThan(0);
  await expect(workspace.getByText('The chosen background is enabled. Its imagery date may be unknown.', { exact: true })).toBeVisible();
  await workspace.getByLabel('Background map', { exact: true }).selectOption('osm');
  await expect.poll(() => tiles.calls.filter(call => new URL(call.url).hostname === 'tile.openstreetmap.org').length).toBeGreaterThan(0);
  await workspace.getByLabel('Background map', { exact: true }).selectOption('');
  expect(await cornerLabels(workspace)).toEqual(beforeMapNavigation);
  expect(publicReads).toHaveLength(0);
  await expect(workspace.getByRole('button', { name: 'Find reference parcels in this view', exact: true })).toBeDisabled();
  await workspace.getByRole('checkbox', { name: 'I want to read public parcel references for this map view.', exact: true }).check();
  const publicResponse = page.waitForResponse(response => /\/api\/v1\/connections\/[^/]+\/read$/.test(response.url()) && response.request().method() === 'POST');
  await workspace.getByRole('button', { name: 'Find reference parcels in this view', exact: true }).click();
  const publicRecord = await (await publicResponse).json();
  expect(publicRecord.data.status).toBe('unreviewed_candidates');
  expect(publicRecord.data.result.features.map(item => item.properties.jaar)).toEqual([2025, 2025]);
  expect(publicRecord.data.result.features[1].properties.category).toBe('Sloot');
  expect(publicReads).toHaveLength(1);
  expect(publicReads[0].bbox[0]).toBeLessThan(5.001);
  expect(publicReads[0].bbox[2]).toBeGreaterThan(5.001);
  const publicCandidate = workspace.getByRole('region', { name: 'Public Dutch parcel references', exact: true }).locator('article').filter({ hasText: 'Wintertarwe' });
  await publicCandidate.getByRole('button', { name: 'Compare with this reference', exact: true }).click();
  await expect(workspace.getByLabel('Reference on that document', { exact: true })).toHaveValue('authored-crop-007');
  await expect(workspace.getByLabel('Year on the comparison source, if known', { exact: true })).toHaveValue('2025');
  await expect(workspace.getByLabel('Crop after this change, if known', { exact: true })).toHaveValue('Current wheat');
  expect(await cornerLabels(workspace)).toEqual(beforeMapNavigation);
  expect((await (await page.request.get(`/api/v1/farms/${farm.id}`)).json()).data.parcels).toEqual(farm.data.parcels);
  await workspace.getByText('Compare with another supplied outline or reference', { exact: true }).click();
  await workspace.getByText('Advanced: compare a small historical IACS export', { exact: true }).click();
  const source = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: originalField.geometry, properties: {
    field_id: 'source-007', crop_code: '0012', crop_name: 'Historical rye', EC_trans_n: 'Rye', EC_hcat_n: 'rye', EC_hcat_c: '0012345678', field_size: '3.750', crop_area: '2.500', farm_id: 'PUBLIC-NOT-OWNER', organic: '2',
  } }] };
  await workspace.getByLabel('Small subset file', { exact: true }).setInputFiles({ name: 'authored-NL-subset.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(source)) });
  await workspace.getByLabel('Country of the original subset', { exact: true }).selectOption('NL');
  await workspace.getByLabel('Year of the original subset', { exact: true }).fill('2025');
  await workspace.getByLabel('Original upstream file name', { exact: true }).fill('NL_2025.parquet');
  await workspace.getByLabel('Licence and attribution basis for this exact subset', { exact: true }).fill('Authored fictional subset, preserving the documented original source attribution and private comparison purpose.');
  await workspace.getByRole('checkbox', { name: 'I checked that this exported subset uses WGS84 longitude/latitude (EPSG:4326), not the original EPSG:3035 metres.', exact: true }).check();
  await workspace.getByRole('checkbox', { name: 'I checked that source field_size and any crop_area values remain in hectares.', exact: true }).check();
  await workspace.getByRole('checkbox', { name: 'I checked the original country, region, year, source terms and attribution for this exact subset.', exact: true }).check();
  const previewResponse = page.waitForResponse(response => response.url().endsWith('/api/v1/reference-data/iacs/preview') && response.request().method() === 'POST');
  await workspace.getByRole('button', { name: 'Preview historical candidates', exact: true }).click();
  const referencePreview = await (await previewResponse).json();
  await expect(workspace.getByRole('heading', { name: 'Review the historical candidates', exact: true })).toBeVisible();
  await expect(workspace.getByText('0012345678', { exact: true })).toBeVisible();
  expect(referencePreview.data.candidates[0].crop_code).toBe('0012');
  expect(referencePreview.data.candidates[0].source_crop_area_ha).toBe(2.5);
  expect(referencePreview.data.candidates[0].organic_verified).toBe(false);
  await workspace.getByRole('button', { name: 'Use only as comparison reference', exact: true }).click();
  await expect(workspace.getByLabel('Crop after this change, if known', { exact: true })).toHaveValue('Current wheat');
  await workspace.getByRole('button', { name: 'Corner 2; longitude 5.002, latitude 52', exact: true }).press('ArrowRight');
  expect((await (await page.request.get(`/api/v1/farms/${farm.id}`)).json()).data.parcels).toEqual(farm.data.parcels);
  const note = 'Authored historical comparison only; current wheat and the farmer-owned outline remain independent.';
  await workspace.getByLabel('What changed, or where did this outline come from?', { exact: true }).fill(note);
  const editedResponse = page.waitForResponse(response => response.url().endsWith(`/farms/${farm.id}/field-proposals`) && response.request().method() === 'POST');
  await workspace.getByRole('button', { name: 'Save for comparison', exact: true }).click();
  const edited = await (await editedResponse).json();
  expect(edited.data.parcel.geometry).not.toEqual(originalField.geometry);
  expect(edited.data.reference.external_id).toBe('source-007');
  const savedDraft = workspace.locator('article.boundary-proposal').filter({ hasText: note });
  await expect(savedDraft.getByRole('heading', { name: 'Supplied comparison', exact: true })).toBeVisible();
  await expect(savedDraft).toContainText('Historical rye');
  const guide = workspace.locator('details').filter({ has: page.getByText('How do I update the official field register?', { exact: true }) });
  await expect(guide).not.toHaveAttribute('open', '');
  const guideResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/farms/${farm.id}/lpis-guide` && response.request().method() === 'GET');
  await guide.getByText('How do I update the official field register?', { exact: true }).click();
  const guideHTTP = await guideResponse;
  expect(guideHTTP.ok(), await guideHTTP.text()).toBeTruthy();
  const retainedGuide = await guideHTTP.json();
  expect(retainedGuide.farm_id).toBe(farm.id);
  expect(retainedGuide.profiles.find(profile => profile.id === 'nl-mijn-percelen-gps').import_acceptance_verified).toBe(false);
  await guide.getByLabel('What do you need to do?', { exact: true }).selectOption('nl-mijn-percelen-gps');
  await expect(guide.getByRole('link', { name: 'RVO Mijn percelen instructions (opens a new tab)', exact: true })).toHaveAttribute('href', 'https://www.rvo.nl/onderwerpen/percelen-registreren/aan-de-slag');
  await expect(guide).toContainText('Uploaden GPS-bestand');
  await expect(guide).toContainText('KML, through the documented GPS-upload route');
  await expect(guide).toContainText('Live upload and acceptance are unverified.');
  await expect(guide).toContainText('This app has not verified a live import or acceptance.');
  for (const [label, filename] of [['Download boundary file', 'field-correction-draft.geojson'], ['Download correction draft', 'field-correction-handoff.json'], ['Download KML boundary', 'field-correction-draft.kml']]) {
    const download = page.waitForEvent('download');
    await savedDraft.getByRole('button', { name: label, exact: true }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe(filename);
    if (filename.endsWith('.kml')) await checkKmlDownload(file, edited);
  }
  expect((await (await page.request.get(`/api/v1/farms/${farm.id}`)).json()).data.parcels).toEqual(farm.data.parcels);
  await savedDraft.getByRole('button', { name: 'Set this draft aside', exact: true }).click();
  await expect(workspace.getByText('This draft was set aside. The draft remains in history and your fields were not changed.', { exact: true })).toBeVisible();
  await page.reload();
  await workspace.getByRole('button', { name: 'Open boundary tools', exact: true }).click();
  await workspace.getByRole('button', { name: 'Divide a field', exact: true }).click();
  await workspace.getByText('Enter dividing line coordinates', { exact: true }).click();
  for (const latitude of ['51.999', '52.002']) {
    await workspace.getByLabel('Corner longitude', { exact: true }).fill('5.001');
    await workspace.getByLabel('Corner latitude', { exact: true }).fill(latitude);
    await workspace.getByRole('button', { name: 'Add dividing line point', exact: true }).click();
  }
  const splitNote = 'Authored two-part private split, not an official LPIS submission.';
  await workspace.getByLabel('What changed, or where did this outline come from?', { exact: true }).fill(splitNote);
  const splitResponse = page.waitForResponse(response => response.url().endsWith(`/farms/${farm.id}/field-proposals/transform`) && response.request().method() === 'POST');
  await workspace.getByRole('button', { name: 'Save for comparison', exact: true }).click();
  const split = await (await splitResponse).json();
  expect(split.data.parcels).toHaveLength(2);
  expect(split.data.previous_parcels[0].id).toBe(originalField.id);
  expect((await (await page.request.get(`/api/v1/farms/${farm.id}/fields`)).json()).items).toHaveLength(1);
  await page.reload();
  const splitCard = workspace.locator('article.boundary-proposal').filter({ hasText: splitNote });
  await expect(splitCard).toBeVisible();
  await splitCard.getByRole('checkbox', { name: 'I compared the field names, crops, outlines and reference details.', exact: true }).check();
  const splitApprovalResponse = page.waitForResponse(response => response.url().endsWith(`/field-proposals/${split.id}/approve`) && response.request().method() === 'POST');
  await splitCard.getByRole('button', { name: 'Confirm private field change', exact: true }).click();
  const approvedSplit = await (await splitApprovalResponse).json();
  await expect(workspace.getByText('Your farm fields were updated and their earlier outlines retained in history. No official register was changed.', { exact: true })).toBeVisible();
  let fields = (await (await page.request.get(`/api/v1/farms/${farm.id}/fields`)).json()).items;
  expect(fields.map(item => item.id).sort()).toEqual(split.data.parcels.map(item => item.id).sort());
  const retained = (await (await page.request.get(`/api/v1/farms/${farm.id}/fields?include_retired=true`)).json()).items;
  expect(retained.find(item => item.id === originalField.id).active).toBe(false);
  const boundaryHistory = workspace.locator('details.boundary-history').filter({ has: page.getByText('Earlier boundary changes', { exact: true }) });
  if (await boundaryHistory.getAttribute('open') === null) await boundaryHistory.getByText('Earlier boundary changes', { exact: true }).click();
  const retainedSplit = boundaryHistory.locator('li').filter({ hasText: split.data.parcels[0].name });
  const retainedDownload = page.waitForEvent('download');
  await retainedSplit.getByRole('button', { name: 'Download retained KML boundary', exact: true }).click();
  await checkKmlDownload(await retainedDownload, approvedSplit.proposal);
  await workspace.getByRole('button', { name: 'Open boundary tools', exact: true }).click();
  await workspace.getByRole('button', { name: 'Join fields', exact: true }).click();
  const neighbours = workspace.getByRole('group', { name: 'Choose neighbouring fields to join', exact: true }).getByRole('checkbox');
  await expect(neighbours).toHaveCount(2);
  for (const neighbour of await neighbours.all()) await neighbour.check();
  await workspace.getByLabel('Joined field name', { exact: true }).fill('Authored rejoined wheat field');
  await workspace.getByLabel('Crop after this change, if known', { exact: true }).fill('Current wheat');
  const joinNote = 'Authored rejoin of the two private children, retaining their earlier outlines.';
  await workspace.getByLabel('What changed, or where did this outline come from?', { exact: true }).fill(joinNote);
  const joinResponse = page.waitForResponse(response => response.url().endsWith(`/farms/${farm.id}/field-proposals/transform`) && response.request().method() === 'POST');
  await workspace.getByRole('button', { name: 'Save for comparison', exact: true }).click();
  const joined = await (await joinResponse).json();
  expect(joined.data.previous_parcels.map(item => item.id).sort()).toEqual(fields.map(item => item.id).sort());
  expect(joined.data.parcels).toHaveLength(1);
  const joinCard = workspace.locator('article.boundary-proposal').filter({ hasText: joinNote });
  await joinCard.getByRole('checkbox', { name: 'I compared the field names, crops, outlines and reference details.', exact: true }).check();
  await joinCard.getByRole('button', { name: 'Confirm private field change', exact: true }).click();
  await expect(workspace.getByText('Your farm fields were updated and their earlier outlines retained in history. No official register was changed.', { exact: true })).toBeVisible();
  fields = (await (await page.request.get(`/api/v1/farms/${farm.id}/fields`)).json()).items;
  expect(fields).toHaveLength(1);
  expect(fields[0].name).toBe('Authored rejoined wheat field');
  expect(fields[0].crop).toBe('Current wheat');
  const history = (await (await page.request.get(`/api/v1/farms/${farm.id}/fields?include_retired=true`)).json()).items;
  expect(history.filter(item => item.active === false)).toHaveLength(3);

  await page.goto('/app/satellite');
  await page.getByLabel('Farm', { exact: true }).selectOption(farm.id);
  await page.getByLabel('Field', { exact: true }).selectOption(fields[0].id);
  await page.getByLabel('From', { exact: true }).fill('2025-05-01');
  await page.getByLabel('To', { exact: true }).fill('2025-05-20');
  await page.getByLabel('Public data provider', { exact: true }).selectOption('copernicus');
  await page.getByRole('button', { name: 'Find satellite scenes', exact: true }).click();
  await expect(page.getByText('Scene cloud cover unknown', { exact: false })).toBeVisible();
  const unknownScene = page.locator('article.sat-scene').filter({ has: page.locator('a[href$="/AUTHORED-UNKNOWN"]') });
  await unknownScene.getByRole('button', { name: 'Describe work I know happened', exact: true }).click();
  await expect(page.getByLabel('Actual work date, if known', { exact: true })).toHaveValue('');
  await page.getByLabel('Work description', { exact: true }).fill('Authored undated observation to check with farmer');
  await page.getByLabel('What supports your description?', { exact: true }).fill('Scene metadata alone does not prove mowing, actual work date, ownership or crop health.');
  await page.getByRole('button', { name: 'Save proposed work', exact: true }).click();
  await expect(page.getByText('Your description was saved as proposed work. Review it in Record work before confirming.', { exact: true })).toBeVisible();
  const observation = (await collection(page, 'operations'))[0];
  expect(observation.data.review_status).toBe('proposed');
  expect(observation.data.date ?? null).toBeNull();
  expect(observation.data.type).toBe('observation');
  expect((await collection(page, 'facts'))).toHaveLength(0);
  expect(tiles.calls.every(call => !call.url.includes(farm.id) && !call.url.includes(fixture.accounts.land.email)
    && !String(call.headers.referer || '').includes(farm.id) && !call.headers.authorization && !call.headers.cookie)).toBe(true);
  expect(pageErrors).toEqual([]);
});

test('Hungarian farmer reads a consented diary page and selected work without importing it', async ({ page }) => {
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
    await route.abort('blockedbyclient');
    throw new Error(`The authored Hungarian journey must not contact a public host: ${url.origin}`);
  });
  await signIn(page, 'onboarding');
  const farm = await api(page, '/farms', { data: { name: 'Fictional Hungarian diary review holding', country: 'HU', region: null,
    reporting_year: 2026, farm_type: 'arable', area_ha: 4.25 } });
  const original = await (await page.request.get(`/api/v1/farms/${farm.id}`)).json();
  const recordCounts = Object.fromEntries(await Promise.all(['facts', 'operations', 'reports'].map(async kind => [kind, (await collection(page, kind)).length])));
  const pages = [];
  page.on('request', request => { if (/\/api\/v1\/connections\/[^/]+\/read-diary$/.test(request.url()) && request.method() === 'POST') pages.push(request.postDataJSON()); });
  async function chooseDiary() {
    await page.getByLabel('Work to prepare', { exact: true }).selectOption('inputs');
    await page.getByLabel('Available route', { exact: true }).selectOption('hu-nebih-egn-read');
  }
  await page.goto(`/app/connections?farm_id=${farm.id}`);
  await chooseDiary();
  await page.getByRole('button', { name: 'Save this route for my farm', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Read records you already keep at Nébih', exact: true })).toBeVisible();
  const token = 'AUTHORED-BROWSER-DIARY-TOKEN';
  await page.getByLabel('Token for this farm’s eGN diary', { exact: true }).fill(token);
  const credentialResponse = page.waitForResponse(response => /\/connections\/[^/]+\/credentials$/.test(response.url()) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save diary token', exact: true }).click();
  const credential = await (await credentialResponse).json();
  expect(credential.data.credentials_present).toBe(true);
  expect(credential.data.credential_ciphertext).toBeUndefined();
  expect(JSON.stringify(credential)).not.toContain(token);
  await expect(page.getByLabel('Token for this farm’s eGN diary', { exact: true })).toHaveValue('');
  expect(pages).toHaveLength(0);
  await page.getByRole('button', { name: 'Enable read access', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Read my diary fields', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'This token is for this farm’s diary, and I have permission to read it here.', exact: true }).check();
  const firstResponse = page.waitForResponse(response => /\/connections\/[^/]+\/read-diary$/.test(response.url()) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Read my diary fields', exact: true }).click();
  const first = await (await firstResponse).json();
  expect(first.data.status).toBe('unreviewed_candidates');
  expect(first.data.result.page).toBe(1);
  expect(first.data.result.page_size).toBe(50);
  await expect(page.getByRole('heading', { name: 'Field reference 00071', exact: true })).toBeVisible();
  await expect(page.getByText('These are test-service records, not production farm records.', { exact: true })).toBeVisible();
  expect(pages).toHaveLength(1);
  const nextResponse = page.waitForResponse(response => /\/connections\/[^/]+\/read-diary$/.test(response.url()) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Read next page', exact: true }).click();
  const second = await (await nextResponse).json();
  expect(second.data.result.page).toBe(2);
  await expect(page.getByRole('heading', { name: 'Field reference 00072', exact: true })).toBeVisible();
  expect(pages.map(body => body.page)).toEqual([1, 2]);
  const workResponse = page.waitForResponse(response => /\/connections\/[^/]+\/read-diary-operations$/.test(response.url()) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Read work for crop-use reference 00092', exact: true }).click();
  const work = await (await workResponse).json();
  expect(work.data.field_read_id).toBe(second.id);
  expect(work.data.result.selection_verified).toBe(true);
  const workSection = page.getByRole('heading', { name: 'Saved work records', exact: true }).locator('..');
  await expect(workSection).toContainText('Nothing in this read has changed your field boundaries, confirmed farm records or official diary.');
  const download = page.waitForEvent('download');
  await workSection.getByRole('button', { name: 'Download this saved read', exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('nebih-diary-read.json');
  const chunks = [];
  for await (const chunk of await file.createReadStream()) chunks.push(chunk);
  const snapshot = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  expect(snapshot.read_kind).toBe('operations');
  expect(snapshot.result.requested_site_id).toBe('00072');
  expect(JSON.stringify(snapshot.result.payload)).toContain('0.500');
  expect(JSON.stringify(snapshot)).not.toContain(token);
  const disconnectedResponse = page.waitForResponse(response => /\/connections\/[^/]+\/disconnect$/.test(response.url()) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Disconnect this route', exact: true }).click();
  expect((await (await disconnectedResponse).json()).data.credentials_present).toBe(false);
  await page.reload();
  await chooseDiary();
  await expect(page.getByLabel('Token for this farm’s eGN diary', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Read my diary fields', exact: true })).toHaveCount(0);
  await page.getByText('Earlier saved reads', { exact: true }).click();
  await page.getByRole('button', { name: 'Show saved reads', exact: true }).click();
  await page.getByRole('button', { name: /^Open saved work read from / }).first().click();
  await expect(page.getByRole('heading', { name: 'Saved work records', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Read work for crop-use reference / })).toHaveCount(0);
  expect(pages.map(body => body.page)).toEqual([1, 2]);
  expect((await (await page.request.get(`/api/v1/farms/${farm.id}`)).json())).toEqual(original);
  for (const kind of Object.keys(recordCounts)) expect((await collection(page, kind))).toHaveLength(recordCounts[kind]);
});

test('Luxembourg farmer reviews an original 2026 parcel export before issuing a private country report', async ({ page }) => {
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
    await route.abort('blockedbyclient');
    throw new Error(`No authority or other external request belongs in this authored source journey: ${url.origin}${url.pathname}`);
  });
  await signIn(page, 'luxembourg');
  const farm = fixture.luxembourg_farm;
  const originalFarm = await (await page.request.get(`/api/v1/farms/${farm.id}`)).json();
  const source = 'id_parcel;field_name;expl_code;pa_status;crop_code;prev_crop;a_parcel;a_deposit;a_eligible;bio;assur_harv;activ_FLIK;extra_blank;extra_null;extra_zero\r\n000007;Authored Luxembourg north field;000123;N;0012;0001;125,00;0;125,00;BIO;TRUE;FALSE;;NULL;0\r\n';
  const request = await api(page, '/requests', { data: { farm_id: farm.id, title: 'Authored Luxembourg source-table request', recipient: 'Fictional source reviewer', country: 'LU', region: null, reporting_year: 2026, deadline: null, pack_id: 'LU-cap-2026', requirements: [], status: 'draft' } });
  await page.goto(`/app/paperwork/${request.id}`);
  const tables = page.getByRole('region', { name: 'Original source tables', exact: true });
  await expect(tables.getByRole('heading', { name: 'Agricultural parcel export row', exact: true })).toBeVisible();
  await expect(tables.getByRole('heading', { name: 'Vineyard parcel export row', exact: true })).toBeVisible();
  await expect(tables.getByText('0 confirmed rows · 0 rows waiting for review', { exact: true })).toHaveCount(2);
  await expect(page.getByText('Add or correct an answer', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Review all saved answers', exact: true }).click();
  await expect(page.getByText('Add or correct an answer', { exact: true })).toHaveCount(0);
  const agricultureTable = tables.locator('article').filter({ has: page.getByRole('heading', { name: 'Agricultural parcel export row', exact: true }) });
  await agricultureTable.getByRole('link', { name: 'Bring in this table', exact: true }).click();
  await expect(page.getByLabel('CSV source', { exact: true })).toHaveValue('lu-agriculture-2026');
  await expect(page.getByLabel('Luxembourg farm', { exact: true })).toHaveValue(farm.id);
  await expect(page.getByLabel('Source year', { exact: true })).toHaveValue('2026');
  await page.getByLabel('CSV file', { exact: true }).setInputFiles({ name: 'authored-lu-parcels-2026.csv', mimeType: 'text/csv', buffer: Buffer.from(source) });
  await page.getByRole('button', { name: 'Open Luxembourg CSV for review', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Check the source before reusing rows', exact: true })).toBeVisible();
  await expect(page.getByLabel('Holding number in file', { exact: true })).toHaveValue('000123');
  expect(await collection(page, 'facts')).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Confirm source and show rows', exact: true })).toBeDisabled();
  await page.getByLabel('Decimal mark in this file', { exact: true }).selectOption(',');
  await page.getByRole('checkbox', { name: 'I checked the holding number, 2026 source year and selected Luxembourg farm against this file.', exact: true }).check();
  await page.getByRole('button', { name: 'Confirm source and show rows', exact: true }).click();
  await expect(page.getByRole('heading', { name: '3. Review and save your rows', exact: true })).toBeVisible();
  await expect(page.getByText('Measured parcel area (a_parcel) · a', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Correct this row', exact: true })).toHaveCount(0);
  await expect(page.getByText('Empty source cell', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Select reviewable rows on this page', exact: true }).click();
  await page.getByLabel('What did you check in the selected rows?', { exact: true }).fill('Compared original 2026 holding and parcel codes, decimal comma, Ar areas and all source-only warnings.');
  await expect(page.getByRole('button', { name: 'Save 1 selected proposal', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'I checked the warnings on each selected row and want to keep these proposed records.', exact: true }).check();
  await page.getByRole('button', { name: 'Save 1 selected proposal', exact: true }).click();
  await expect(page.getByText('1 proposal saved. The original source rows are retained.', { exact: true })).toBeVisible();
  const proposed = (await collection(page, 'facts'))[0];
  expect(proposed.data.review_status).toBe('proposed');
  expect(proposed.data.key).toMatch(/^lu\.fa\.agriculture_row\.[a-f0-9]{64}$/);
  expect(proposed.data.value).toMatchObject({ id_parcel: '000007', expl_code: '000123', a_parcel: '125,00', prev_crop: '0001', extra_blank: '', extra_null: 'NULL', extra_zero: '0', assur_harv: 'TRUE' });
  expect(proposed.data.parcel_id).toBeUndefined();
  expect(await (await page.request.get(`/api/v1/farms/${farm.id}`)).json()).toEqual(originalFarm);
  await page.getByRole('link', { name: 'Review row 1 in My fields', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/app/fields/${farm.id}#facts$`));
  await page.reload();
  const answers = page.locator('#facts');
  await expect(answers.getByRole('heading', { name: 'Check answers saved about this farm', exact: true })).toBeVisible();
  const answer = answers.locator('article.panel').filter({ has: page.getByRole('heading', { name: proposed.data.label, exact: true }) });
  await expect(answer.getByText('Needs review', { exact: true })).toBeVisible();
  await answer.getByLabel('Review note', { exact: true }).fill('Reviewed original source values and units. BIO is the source code, not independent certification or eligibility.');
  await answer.getByRole('button', { name: 'I checked this — confirm answer', exact: true }).click();
  await expect(answer.getByText('Checked', { exact: true })).toBeVisible();
  await page.goto(`/app/paperwork/${request.id}`);
  await expect(page.getByRole('region', { name: 'Original source tables', exact: true }).getByText('1 confirmed rows · 0 rows waiting for review', { exact: true })).toBeVisible();
  await expect(page.getByText('Add or correct an answer', { exact: true })).toHaveCount(0);
  await openMoreTool(page, '/app/reports');
  await page.getByLabel('Farm', { exact: true }).selectOption(farm.id);
  await page.getByLabel('Reporting year', { exact: true }).fill('2026');
  await page.getByLabel('Response format', { exact: true }).selectOption('LU-cap-2026');
  await page.getByRole('checkbox', { name: new RegExp('^' + proposed.data.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).check();
  await page.getByRole('button', { name: 'Prepare preview', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review your answer', exact: true })).toBeVisible();
  const reportId = page.url().split('/').pop();
  await page.getByRole('checkbox', { name: 'I reviewed this report and its sources and approve this version.', exact: true }).check();
  await page.getByRole('button', { name: 'Approve this version', exact: true }).click();
  await expect(page.getByText('Approval recorded. This report keeps the reviewed snapshot.', { exact: true })).toBeVisible();
  const issued = await (await page.request.get(`/api/v1/reports/${reportId}/download?format=json`)).json();
  const field = issued.snapshot.fields.find(item => item.fact_id === proposed.id);
  expect(field.row_schema.id).toBe('lu-agriculture-2026');
  expect(field.value).toEqual(proposed.data.value);
  expect(issued.filing_status).toBe('not_filed');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.csv$/);
  let content = '';
  for await (const chunk of await download.createReadStream()) content += chunk.toString('utf8');
  expect(content).toContain(`${proposed.data.key}.a_parcel`);
  expect(content).toContain('Measured parcel area (a_parcel)');
  expect(content).toContain('125,00');
  expect(await collection(page, 'operations')).toHaveLength(0);
  expect(await (await page.request.get(`/api/v1/farms/${farm.id}`)).json()).toEqual(originalFarm);
});
