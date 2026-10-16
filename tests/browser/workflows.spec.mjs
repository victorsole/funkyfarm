import { test, expect } from '@playwright/test';

const fixture = JSON.parse(process.env.FUNKYFARMERS_BROWSER_FIXTURES || '{}');

async function signIn(page, who) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(fixture.accounts[who].email);
  await page.getByLabel('Password', { exact: true }).fill(fixture.accounts[who].password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/home/);
}

async function api(page, path, body) {
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  const response = await page.request.post('/api/v1' + path, { data: body, headers: { 'X-CSRF-Token': session.csrf_token } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

async function saveAndReview(page) {
  await page.getByRole('button', { name: 'Check this entry', exact: true }).click();
  await page.getByRole('button', { name: 'Save proposed entry', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Entry saved — now check it' })).toBeVisible();
  await page.getByLabel('What did you check?', { exact: true }).fill('Checked the authored notebook against the actual work and date.');
  await page.getByRole('button', { name: 'I checked this — confirm entry', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Saved entry', exact: true })).toBeVisible();
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
  await page.goto('/app/reports');
  await page.getByLabel('Request to answer', { exact: true }).selectOption(fixture.request.id);
  await page.getByLabel('Reporting pack', { exact: true }).selectOption('farm-evidence');
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
  await page.goto('/app/adviser');
  await page.getByLabel('Private invitation code', { exact: true }).fill(fixture.invitation.token);
  const acceptance = page.waitForResponse(response => response.url().endsWith('/api/v1/invitations/accept') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Accept invitation', exact: true }).click();
  expect((await acceptance).status()).toBe(200);
  await expect(page.getByText(/Invitation accepted\. The farm workspace/)).toBeVisible();
  await expect(page.getByRole('heading', { name: fixture.farm.data.name, exact: true })).toBeVisible();
  await expect(page.getByText(fixture.private.data.name, { exact: true })).toHaveCount(0);
  await page.getByLabel('Switch workspace', { exact: true }).selectOption(fixture.accounts.owner.workspace_id);
  await page.getByLabel('Farm', { exact: true }).selectOption(fixture.farm.id);
  await page.getByLabel('Question', { exact: true }).fill('Please check the actual date in the notebook');
  await page.getByLabel('What the farmer needs to provide', { exact: true }).fill('A receipt date alone does not establish when a field treatment happened.');
  await page.getByRole('button', { name: 'Save question for farmer', exact: true }).click();
  await expect(page.getByText('Question saved for the farmer in this workspace.', { exact: true })).toBeVisible();
  const ownerContext = await browser.newContext({ baseURL: process.env.FUNKYFARMERS_BROWSER_URL, reducedMotion: 'reduce' });
  try {
    const ownerPage = await ownerContext.newPage();
    await signIn(ownerPage, 'owner');
    await ownerPage.goto('/app/adviser');
    const invitationRow = ownerPage.locator('li').filter({ hasText: fixture.accounts.adviser.email });
    await invitationRow.getByRole('button', { name: /Revoke/ }).click();
    await expect(invitationRow.getByText('Revoked', { exact: true })).toBeVisible();
    await page.reload();
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
  await expect(page.getByRole('button', { name: 'Save proposed entry', exact: true })).toBeDisabled();
  const acknowledgements = readback.getByRole('checkbox', { name: 'I checked this and want to keep these details.', exact: true });
  expect(await acknowledgements.count()).toBeGreaterThan(0);
  for (const acknowledgement of await acknowledgements.all()) await acknowledgement.check();
  await page.getByRole('button', { name: 'Save proposed entry', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Entry saved — now check it', exact: true })).toBeVisible();
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
  await page.getByRole('button', { name: 'Save proposed entry', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Entry saved — now check it', exact: true })).toBeVisible();
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
  await signIn(page, 'seller');
  await page.goto(`/app/fields/${fixture.sales_farm.id}`);
  const workspace = page.getByRole('region', { name: 'Change boundaries', exact: true });
  await workspace.getByRole('button', { name: 'Open boundary tools', exact: true }).click();
  await workspace.getByRole('button', { name: 'Draw a field', exact: true }).click();
  await workspace.getByLabel('Field name', { exact: true }).fill('Authored recoverable field draft');
  const note = 'Authored outline, retained after an error and page reload; not an official LPIS update.';
  await workspace.getByLabel('What changed, or where did this outline come from?', { exact: true }).fill(note);
  const crossed = { type: 'Polygon', coordinates: [[[11, 48], [11.002, 48.001], [11.002, 48], [11, 48.001], [11, 48]]] };
  await workspace.getByLabel('Existing boundary file', { exact: true }).setInputFiles({ name: 'authored-crossed.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(crossed)) });
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
  const repaired = { type: 'Polygon', coordinates: [[[11, 48], [11.002, 48], [11.002, 48.001], [11, 48.001], [11, 48]]] };
  await workspace.getByLabel('Existing boundary file', { exact: true }).setInputFiles({ name: 'authored-repaired.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(repaired)) });
  await expect(workspace.getByRole('button', { name: 'Corner 2; longitude 11.002, latitude 48', exact: true })).toBeVisible();
  await workspace.getByRole('button', { name: 'Save for comparison', exact: true }).click();
  await expect(workspace.getByText('Your boundary change is saved in the workspace. Compare the old and proposed fields below before confirming.', { exact: true })).toBeVisible();
  expect((await (await page.request.get(`/api/v1/farms/${fixture.sales_farm.id}/fields`)).json()).items).toHaveLength(0);
  await page.reload();
  await expect(workspace.getByRole('heading', { name: 'Authored recoverable field draft', exact: true })).toBeVisible();
  await workspace.getByRole('checkbox', { name: 'I compared the field names, crops, outlines and reference details.', exact: true }).check();
  await workspace.getByRole('button', { name: 'Confirm private field change', exact: true }).click();
  await expect(workspace.getByText('Your farm fields were updated and their earlier outlines retained in history. No official register was changed.', { exact: true })).toBeVisible();
  const current = (await (await page.request.get(`/api/v1/farms/${fixture.sales_farm.id}/fields`)).json()).items;
  expect(current).toHaveLength(1);
  expect(current[0].name).toBe('Authored recoverable field draft');
});
