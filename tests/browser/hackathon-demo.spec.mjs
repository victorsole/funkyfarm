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
  const errors = []; const external = []; const writes = []; const starts = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    const path = new URL(request.url()).pathname;
    if (path === '/api/v1/examples/workspace') starts.push(request);
    if (/\/cases\/[^/]+\/(?:events|review)$/.test(path) || /\/field-proposals(?:\/|$)/.test(path)) writes.push(path);
  });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['localhost', '127.0.0.1'].includes(url.hostname)) return route.continue();
    external.push(`${url.origin}${url.pathname}`); return route.abort('blockedbyclient');
  });
  await page.goto('/demo');
  await expect(page.getByRole('heading', { name: 'Find the parcel mistake before you file.', exact: true })).toBeVisible();
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
  await expect(page.getByRole('heading', { name: 'One parcel. One correction.', exact: true })).toBeVisible();
  const demoURL = page.url(); const before = await read(page, `/farms/${farm.id}`, example.workspace.id);
  const checkPath = `/farms/${farm.id}/parcel-check?expected_farm_revision=${before.revision}&reporting_year=2026`;
  await page.getByRole('link', { name: 'Check the sample parcel', exact: true }).click();
  const firstCheck = await read(page, checkPath, example.workspace.id);
  expect(firstCheck.fields).toHaveLength(1);
  expect(firstCheck.fields[0].outline_area_ha).toBeCloseTo(6.70, 2);
  expect(firstCheck.fields[0].claim_context).toMatchObject({ status: 'unconfirmed', declared: 6.7, max: 3.02, coefficient: 45, excess: 3.68, proposed_claim: 3.02, proposed_claim_is_draft: true });
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
  expect(sourceText).toContain('FICTIONAL TRAINING'); expect(sourceText).toContain('6.70 ha');
  await page.getByRole('link', { name: 'Hackathon demo', exact: true }).click();
  const steps = page.getByRole('navigation', { name: 'Demo steps', exact: true });
  await steps.getByRole('button', { name: /^Check the parcel\b/ }).click();
  await page.getByRole('button', { name: 'Show the next step', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Check the saved figures', exact: true })).toBeVisible();
  await page.getByText('What if the farmer says the scrub was cleared?', { exact: true }).click();
  await page.getByRole('link', { name: 'Check the evidence still needed', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'FICTIONAL Option B — check lease and dated geotagged photos', exact: true })).toBeVisible();
  await expect(page.getByText(/No actual clearance date, geotagged photo, lease/)).toBeVisible();
  await page.goto(demoURL);
  await steps.getByRole('button', { name: /^Check the saved figures\b/ }).click();
  await page.getByRole('link', { name: 'Review the four saved answers', exact: true }).click();
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
  expect(checkedClaim.fields[0].claim_context).toMatchObject({ status: 'confirmed', declared: 6.7, max: 3.02, coefficient: 45, excess: 3.68, proposed_claim: 3.02, proposed_claim_is_draft: true });
  await page.goto(`/app/fields/${farm.id}/check`);
  await comparison(page, 'Values checked by a person — not an authority decision');
  await page.goto(demoURL);
  const refreshed = responseFor(page, `/examples/workspace/${example.run_id}`);
  await page.getByRole('button', { name: 'Refresh saved progress', exact: true }).click();
  const progress = await checked(await refreshed);
  expect(progress.records.filter(item => facts.some(fact => fact.id === item.id)).every(item => item.status === 'confirmed')).toBe(true);
  await steps.getByRole('button', { name: /^Prepare the correction\b/ }).click();
  await page.getByRole('link', { name: 'Work through the correction', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/app/cases/${savedCase.id}/correction$`));
  const correction = page.getByRole('navigation', { name: 'Correction steps', exact: true });
  await correction.getByRole('button', { name: /Check the dates$/ }).click();
  await expect(page.getByLabel('National correction deadline stated in the applicable instructions', { exact: true })).toHaveValue('');
  await expect(page.getByRole('heading', { name: 'Can I still change this?', exact: true })).toBeVisible();
  await correction.getByRole('button', { name: /Check each answer$/ }).click();
  await expect(page.locator('article.correction-answer').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save these answer checks', exact: true })).toBeDisabled();
  // The full folder success path has its own journey. Here the deliberately
  // absent lease/photos and unchecked case items must remain visible blockers.
  await page.goto(demoURL);
  await steps.getByRole('button', { name: /^Review and download\b/ }).click();
  await page.getByRole('link', { name: 'Review the case and prepare the folder', exact: true }).click();
  const checkedCase = responseFor(page, `/cases/${savedCase.id}/checks`);
  await page.getByRole('button', { name: 'Check the saved case', exact: true }).click();
  const result = await checked(await checkedCase); expect(result.can_review).toBe(false);
  expect(result.issues.some(issue => issue.code === 'case_item_open' && /lease|photo|protected/i.test(issue.message))).toBe(true);
  await expect(page.getByRole('button', { name: 'Review this version for sending', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Open handoff and downloads', exact: true })).toBeDisabled();
  await page.goto(demoURL);
  await page.getByText('Adviser access and what this example means', { exact: true }).click();
  await expect(page.getByRole('link', { name: 'Open Adviser view or invite an adviser', exact: true })).toHaveAttribute('href', '/app/adviser');
  await page.getByRole('link', { name: 'Try the other six situations', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your private sample workspace', exact: true })).toBeVisible();
  expect((await read(page, `/cases/${savedCase.id}`, example.workspace.id)).data.status).toBe('draft');
  expect((await read(page, `/cases/${savedCase.id}/events?limit=100`, example.workspace.id)).items.some(item => ['sent', 'receipt', 'accepted'].includes(item.data.action))).toBe(false);
  expect(await read(page, `/farms/${fixture.farm.id}`, fixture.accounts.owner.workspace_id)).toEqual(originalFarm);
  expect(starts).toHaveLength(1); expect(writes).toEqual([]); expect(errors).toEqual([]); expect(external).toEqual([]);
});
