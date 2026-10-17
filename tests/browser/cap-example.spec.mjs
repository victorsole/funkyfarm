import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const fixture = JSON.parse(process.env.FUNKYFARM_BROWSER_FIXTURES || '{}');
const account = fixture.accounts?.cap_example || fixture.accounts?.owner;
const title = 'farmer explicitly prepares the fictional CAP example through real field, document and case screens';

const responseFor = (page, path, method = 'GET') => page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1${path}` && response.request().method() === method);
async function checkedJSON(response) {
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
const read = async (page, path) => checkedJSON(await page.request.get(`/api/v1${path}`));
async function bytesOf(download) {
  expect(await download.failure()).toBeNull();
  const stream = await download.createReadStream(); expect(stream).toBeTruthy();
  const chunks = []; let size = 0;
  for await (const chunk of stream) { size += chunk.length; expect(size).toBeLessThan(8 * 1024 * 1024); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

// Read this small authored ZIP independently, without adding an archive package.
function zipFiles(bytes) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThanOrEqual(0); expect(end + 22).toBeLessThanOrEqual(bytes.length);
  const count = bytes.readUInt16LE(end + 10); expect(count).toBeGreaterThan(0); expect(count).toBeLessThanOrEqual(512);
  let offset = bytes.readUInt32LE(end + 16); const files = new Map();
  for (let index = 0; index < count; index += 1) {
    expect(bytes.readUInt32LE(offset)).toBe(0x02014b50);
    const flags = bytes.readUInt16LE(offset + 8); const method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20); const size = bytes.readUInt32LE(offset + 24);
    const nameSize = bytes.readUInt16LE(offset + 28); const extra = bytes.readUInt16LE(offset + 30); const comment = bytes.readUInt16LE(offset + 32);
    const name = bytes.subarray(offset + 46, offset + 46 + nameSize).toString('utf8'); const local = bytes.readUInt32LE(offset + 42);
    expect(flags & 1).toBe(0); expect([0, 8]).toContain(method); expect(size).toBeLessThan(8 * 1024 * 1024);
    expect(name).not.toMatch(/(^\/|\\|(?:^|\/)\.\.(?:\/|$))/); expect(files.has(name)).toBe(false);
    expect(bytes.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    expect(start + compressed).toBeLessThanOrEqual(bytes.length);
    const contents = bytes.subarray(start, start + compressed);
    const decoded = method === 8 ? inflateRawSync(contents, { maxOutputLength: 8 * 1024 * 1024 }) : contents;
    expect(decoded.length).toBe(size); files.set(name, decoded); offset += 46 + nameSize + extra + comment;
  }
  return files;
}

async function openFromHome(page, runId) {
  await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('link', { name: /^Home\b/ }).click();
  const opened = responseFor(page, `/examples/cap/${runId}`);
  await page.goto(`/app/examples/cap?run_id=${runId}`);
  const example = await checkedJSON(await opened);
  expect(example.run_id).toBe(runId);
  await expect(page.getByRole('heading', { name: 'Work through these three things', exact: true })).toBeVisible();
  return example;
}

async function uploadThroughDocuments(page, farmId, file, note = false) {
  if (note) {
    await page.getByRole('button', { name: 'Write a note', exact: true }).click();
    await page.getByLabel('Name this note', { exact: true }).fill(file.name.replace(/\.txt$/, ''));
    await page.getByLabel('Your note', { exact: true }).fill(file.buffer.toString('utf8'));
  } else {
    await page.getByLabel('Choose a PDF, photo or text file', { exact: true }).setInputFiles(file);
    await page.getByLabel('What is it?', { exact: true }).selectOption('unknown');
  }
  await page.getByLabel('Which farm? (you can choose later)', { exact: true }).selectOption(farmId);
  const upload = responseFor(page, '/documents', 'POST');
  await page.getByRole('button', { name: 'Save and read document', exact: true }).click();
  const original = await checkedJSON(await upload);
  await expect(page).toHaveURL(new RegExp(`/app/documents/${original.id}(?:\\?|$)`));
  await expect(page.getByRole('button', { name: 'Download original', exact: true })).toBeVisible();
  const document = await read(page, `/documents/${original.id}`);
  expect(document.data.farm_id).toBe(farmId);
  expect(document.data.sha256).toBe(createHash('sha256').update(file.buffer).digest('hex'));
  return { record: document, file };
}

test(title, async ({ page }) => {
  test.skip(!account, 'Supply an isolated fresh owner in accounts.cap_example (or the existing owner fixture).');
  test.setTimeout(240_000);
  const errors = []; const external = []; const externalEvents = []; const exampleCreates = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (request.method() === 'POST' && /\/api\/v1\/cases\/[^/]+\/events$/.test(url.pathname)) externalEvents.push(url.pathname);
    if (request.method() === 'POST' && url.pathname === '/api/v1/examples/cap') exampleCreates.push(request);
  });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['localhost', '127.0.0.1'].includes(url.hostname)) return route.continue();
    external.push(`${url.origin}${url.pathname}`); return route.abort('blockedbyclient');
  });
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/home/);
  await page.goto('/app/examples/cap');
  await expect(page.getByRole('heading', { name: 'Try a CAP correction', exact: true })).toBeVisible();
  await expect(page.getByText('Fictional training example — not a real holding or application.', { exact: true })).toBeVisible();
  const create = page.getByRole('button', { name: 'Create or reopen my example', exact: true });
  await expect(create).toBeDisabled(); expect(exampleCreates).toHaveLength(0);
  await page.getByRole('checkbox', { name: 'I understand that these are fictional records and want to save this example in my workspace.', exact: true }).check();
  const created = responseFor(page, '/examples/cap', 'POST'); await create.click();
  const createResponse = await created; expect(createResponse.status()).toBe(201);
  expect(createResponse.request().postDataJSON()).toEqual({ acknowledged: true });
  expect(createResponse.request().headers()['idempotency-key']).toMatch(/^[a-f0-9-]{36}$/i);
  const example = await checkedJSON(createResponse); const { farm, scenario } = example;
  const runId = example.run_id; const caseId = example.case.id;
  expect(example.case.data.status).toBe('draft'); expect(example.proposal.data.status).toBe('proposed');
  expect(example.progress.open_items).toBe(3); expect(example.checks.can_review).toBe(false);
  await expect(page).toHaveURL(new RegExp(`/app/examples/cap\\?run_id=${runId}$`));
  await expect(page.getByRole('img', { name: /Fictional claim and supplied reference outlines/ })).toBeVisible();
  await expect(page.getByText(/The claimed area is not the eligible area/)).toBeVisible();
  await expect(page.getByText(/Satellite crop interpretation is unknown/)).toBeVisible();
  expect((await read(page, `/documents?farm_id=${farm.id}`)).total).toBe(0);

  await page.getByRole('link', { name: 'Open the actual saved field proposal', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`proposal_id=${example.proposal.id}&expected_revision=${example.proposal.revision}`));
  const proposal = page.locator('article.boundary-proposal').filter({ has: page.getByRole('heading', { name: 'FICTIONAL meadow A', exact: true }) });
  for (const name of ['Saved before this change', 'Proposed fields', 'Supplied comparison']) await expect(proposal.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(proposal.getByText(/These approximate areas are not official eligible areas/)).toBeVisible();
  await proposal.getByRole('checkbox', { name: 'I compared the field names, crops, outlines and reference details.', exact: true }).check();
  const approval = responseFor(page, `/field-proposals/${example.proposal.id}/approve`, 'POST');
  await proposal.getByRole('button', { name: 'Confirm private field change', exact: true }).click();
  const approved = await checkedJSON(await approval); expect(approved.proposal.data.status).toBe('approved');
  expect(approved.farm.data.parcels[0].geometry).toEqual(scenario.reference_geometry);
  await expect(page.getByText('Your farm fields were updated and their earlier outlines retained in history. No official register was changed.', { exact: true })).toBeVisible();
  const stale = await openFromHome(page, runId);
  expect(stale.proposal.revision).toBe(approved.proposal.revision); expect(stale.progress.open_items).toBe(3);
  expect(stale.checks.references.find(reference => reference.id === example.proposal.id).current).toBe(false);
  expect(stale.checks.can_review).toBe(false); expect(exampleCreates).toHaveLength(1);
  await page.getByRole('link', { name: 'Select evidence and review the case items', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save case details and records', exact: true })).toBeEnabled();
  const blockedCheck = responseFor(page, `/cases/${caseId}/checks`);
  await page.getByRole('button', { name: 'Check the saved case', exact: true }).click();
  expect((await checkedJSON(await blockedCheck)).can_review).toBe(false);
  await expect(page.locator('#case-checks').getByRole('checkbox')).toBeDisabled();
  await expect(page.locator('#case-checks')).toContainText('Missing or changed');

  await openFromHome(page, runId);
  const samples = [];
  for (const sample of scenario.samples) {
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: `Download ${sample.title.toLowerCase()}`, exact: true }).click();
    const file = await downloaded; const buffer = await bytesOf(file);
    expect(file.suggestedFilename()).toMatch(/^FICTIONAL-.*\.txt$/);
    expect(buffer.toString('utf8')).toContain('FICTIONAL TRAINING EXAMPLE'); expect(buffer.toString('utf8')).toContain(sample.contents);
    samples.push({ id: sample.id, name: file.suggestedFilename(), mimeType: 'text/plain', buffer });
  }
  expect((await read(page, `/documents?farm_id=${farm.id}`)).total).toBe(0);
  await page.getByRole('link', { name: 'Open Documents for the example farm', exact: true }).click();
  const documents = new Map();
  for (const sample of samples) {
    const saved = await uploadThroughDocuments(page, farm.id, { name: sample.name, mimeType: sample.mimeType, buffer: sample.buffer });
    documents.set(sample.id === 'land-use' ? 'land_use' : 'commitment', saved);
    await page.getByRole('link', { name: 'Back to documents', exact: true }).click();
  }
  documents.set('boundary', await uploadThroughDocuments(page, farm.id, {
    name: 'FICTIONAL-boundary-review.txt', mimeType: 'text/plain',
    buffer: Buffer.from(`FICTIONAL BOUNDARY REVIEW — NOT AN AUTHORITY RECORD\nI compared the saved before/proposed outlines and chose the private correction.\n${scenario.reference_label}\nThis note does not establish eligible area or official LPIS acceptance.\n`),
  }, true));
  await page.getByRole('link', { name: 'Back to documents', exact: true }).click();
  const unselected = await uploadThroughDocuments(page, farm.id, { name: 'FICTIONAL-private-unselected.txt', mimeType: 'text/plain', buffer: Buffer.from('FICTIONAL PRIVATE NOTE NOT SELECTED FOR THIS CASE\n') });
  await openFromHome(page, runId);
  await page.getByRole('link', { name: 'Select evidence and review the case items', exact: true }).click();
  const editor = page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Case details and selected records', exact: true }) });
  await editor.getByLabel('Find a saved record', { exact: true }).selectOption('field_change_proposals');
  await editor.getByRole('button', { name: 'Use the current saved record after checking it', exact: true }).click();
  const updated = responseFor(page, `/cases/${caseId}`, 'PATCH');
  await editor.getByRole('button', { name: 'Save case details and records', exact: true }).click();
  let currentCase = await checkedJSON(await updated);
  expect(currentCase.data.references.find(reference => reference.id === example.proposal.id).revision).toBe(approved.proposal.revision);
  expect(currentCase.data.status).toBe('draft'); expect(currentCase.data.review).toBeNull();

  for (const definition of scenario.items) {
    const card = page.locator('#case-items article').filter({ has: page.getByRole('heading', { name: definition.title, exact: true }) });
    await card.getByText('Record progress or resolve this item', { exact: true }).click();
    await card.getByLabel('What happened to this item?', { exact: true }).selectOption('resolved');
    await card.getByLabel('What did you check or change?', { exact: true }).fill(`I checked the fictional ${definition.key} record and the private correction. This is a training judgement, not an authority decision.`);
    const saved = documents.get(definition.key);
    await expect(card.getByRole('button', { name: 'Save item progress', exact: true })).toBeDisabled();
    await card.getByRole('checkbox', { name: saved.record.data.title || saved.record.data.filename, exact: true }).check();
    await card.getByRole('checkbox', { name: 'I checked this item and the selected documents. This records my judgement, not an authority decision.', exact: true }).check();
    const reviewed = responseFor(page, `/cases/${caseId}/items/${definition.id}/review`, 'POST');
    await card.getByRole('button', { name: 'Save item progress', exact: true }).click();
    const response = await reviewed;
    expect(response.request().postDataJSON().document_revisions).toEqual({ [saved.record.id]: saved.record.revision });
    currentCase = await checkedJSON(response);
    expect(currentCase.data.items.find(item => item.id === definition.id).document_pins).toEqual([{ id: saved.record.id, revision: saved.record.revision }]);
    expect(currentCase.data.status).toBe('draft'); expect(currentCase.data.review).toBeNull();
    await expect(card.getByText('Resolved by a person', { exact: false })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Save case details and records', exact: true })).toBeEnabled();
  const finalCheck = responseFor(page, `/cases/${caseId}/checks`);
  await page.getByRole('button', { name: 'Check the saved case', exact: true }).click();
  const checks = await checkedJSON(await finalCheck); expect(checks.can_review).toBe(true);
  const review = page.getByRole('button', { name: 'Review this version for sending', exact: true });
  await expect(review).toBeDisabled();
  await page.getByRole('checkbox', { name: 'I checked these saved records and their sources. I understand that this review does not send anything.', exact: true }).check();
  const reviewed = responseFor(page, `/cases/${caseId}/review`, 'POST'); await review.click();
  const reviewResponse = await reviewed; expect(reviewResponse.request().postDataJSON().expected_fingerprint).toBe(checks.fingerprint);
  const ready = await checkedJSON(reviewResponse); expect(ready.data.status).toBe('ready_to_send');
  await expect(page.getByText('This saved version is reviewed and ready for you to send yourself. Nothing has been sent.', { exact: true })).toBeVisible();
  const handoff = responseFor(page, `/cases/${caseId}/handoff`);
  await page.getByRole('button', { name: 'Open handoff and downloads', exact: true }).click();
  const sending = await checkedJSON(await handoff); expect(sending.origin).toBe('current_review');
  await expect(page.getByText('Includes the selected records and their original attachments. Nothing is sent.', { exact: true })).toBeVisible();
  const packetResponse = responseFor(page, `/cases/${caseId}/packet`); const folder = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download complete prepared folder (ZIP)', exact: true }).click();
  const packet = await packetResponse; expect(packet.ok()).toBe(true); expect(packet.headers()['content-type']).toMatch(/^application\/zip/);
  const packetQuery = new URL(packet.url()).searchParams;
  expect(packetQuery.get('expected_revision')).toBe(String(ready.revision)); expect(packetQuery.has('retained_revision')).toBe(false);
  expect(packetQuery.get('reference_fingerprint')).toBe(sending.reference_fingerprint);
  const download = await folder; expect(download.suggestedFilename()).toMatch(/\.zip$/i);
  const bytes = await bytesOf(download); expect(Number(packet.headers()['content-length'])).toBe(bytes.length);
  const files = zipFiles(bytes); expect(files.has('index.html')).toBe(true); expect(files.has('index.txt')).toBe(true);
  const manifest = JSON.parse(files.get('manifest.json').toString('utf8'));
  expect(manifest.case_id).toBe(caseId); expect(manifest.case_revision).toBe(ready.revision); expect(manifest.origin).toBe('current_review');
  for (const { record, file } of documents.values()) {
    const path = `originals/${record.id}-v${record.revision}.txt`;
    expect(files.get(path)).toEqual(file.buffer);
    expect(manifest.files.find(entry => entry.path === path).sha256).toBe(createHash('sha256').update(file.buffer).digest('hex'));
  }
  expect([...files.keys()].some(name => name.includes(unselected.record.id))).toBe(false);
  const correction = JSON.parse(files.get(`fields/${approved.proposal.id}-v${approved.proposal.revision}.json`).toString('utf8'));
  expect(correction.proposed_parcels[0].geometry).toEqual(scenario.reference_geometry);
  expect((await read(page, `/cases/${caseId}`)).data.status).toBe('ready_to_send');
  const history = await read(page, `/cases/${caseId}/events?limit=100`);
  expect(history.items.some(event => ['sent', 'receipt', 'accepted'].includes(event.data.action))).toBe(false);
  expect(externalEvents).toEqual([]); expect(exampleCreates).toHaveLength(1);
  const reopened = await openFromHome(page, runId); expect(reopened.progress.review_current).toBe(true);
  expect(reopened.progress.resolved_items).toBe(3); expect(reopened.progress.case_status).toBe('ready_to_send');
  expect(errors).toEqual([]); expect(external).toEqual([]);
});
