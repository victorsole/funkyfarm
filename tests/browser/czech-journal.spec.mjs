import { test, expect } from '@playwright/test';

const fixture = JSON.parse(process.env.FUNKYFARM_BROWSER_FIXTURES || '{}');
const title = 'Czech farmer keeps a requestless journal and separately reviews its correction';

async function responseFor(page, suffix, method = 'POST') {
  return page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/api/v1${suffix}`)
    && response.request().method() === method);
}

async function checkedJSON(response) {
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

async function read(page, path) {
  return checkedJSON(await page.request.get(`/api/v1${path}`));
}

async function retainApplication(page) {
  const checked = responseFor(page, '/workflow/check');
  await page.getByRole('button', { name: 'Check this application', exact: true }).click();
  const check = await checkedJSON(await checked);
  expect(check.can_save).toBe(true);
  const readback = page.locator('.farm-entry-check').filter({ has: page.getByRole('heading', { name: 'Read back this application', exact: true }) });
  await expect(readback).toContainText('Pending — follow up later');
  for (const checkbox of await readback.getByRole('checkbox').all()) await checkbox.check();
  const saved = responseFor(page, '/workflow/capture');
  await readback.getByRole('button', { name: 'Save proposed application', exact: true }).click();
  const record = (await checkedJSON(await saved)).record;
  expect(record.data.review_status).toBe('proposed');
  return record;
}

async function confirmApplication(page, journal, record) {
  const card = journal.locator('article.evidence-card').filter({ hasText: record.id });
  await card.getByLabel('Application review note', { exact: true }).fill('Compared the exact notebook application, identifiers, units and still-pending follow-ups.');
  const confirmed = responseFor(page, `/operations/${record.id}/review`);
  await card.getByRole('button', { name: 'Confirm this application', exact: true }).click();
  const result = await checkedJSON(await confirmed);
  expect(result.data.review_status).toBe('confirmed');
  await expect(card.getByRole('checkbox', { name: 'Include this application in the response', exact: true })).toBeVisible();
  return result;
}

test(title, async ({ page }) => {
  test.skip(!fixture.czech_farm, 'This focused case uses its own isolated Czech farmer fixture.');
  test.setTimeout(180_000);
  // Nothing in this journey may contact a real authority or external provider.
  await page.route('**/*', route => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname)
    ? route.continue() : route.abort('blockedbyclient'));
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(fixture.accounts.czech.email);
  await page.getByLabel('Password', { exact: true }).fill(fixture.accounts.czech.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/home/);
  const farm = fixture.czech_farm;
  await page.goto(`/app/record-work?farm_id=${farm.id}`);
  const journal = page.locator('#czech-journal');
  await expect(journal.getByRole('heading', { name: 'Czech crop-protection journal · 2026', exact: true })).toBeVisible();
  expect((await read(page, '/requests')).items).toHaveLength(0);
  await journal.getByText('Record or correct the journal holder', { exact: true }).click();
  await journal.getByLabel('Holder type', { exact: true }).selectOption('legal_person');
  await journal.getByLabel('Holder name', { exact: true }).fill('Fictional Czech journal grower s.r.o.');
  await journal.getByLabel('Holder address', { exact: true }).fill('Authored holding address 01');
  await journal.getByLabel('Holder identification number', { exact: true }).selectOption('provided');
  await journal.getByLabel('Exact identification number', { exact: true }).fill('00001234');
  await journal.getByLabel('Where did you check this identity?', { exact: true }).fill('Authored business identity record, page 1; not inferred from farm name.');
  await journal.getByRole('button', { name: 'Check holder details', exact: true }).click();
  const holderEditor = journal.getByText('Record or correct the journal holder', { exact: true }).locator('..');
  await expect(holderEditor.getByRole('button', { name: 'Save proposed holder details', exact: true })).toBeVisible();
  for (const checkbox of await holderEditor.getByRole('checkbox').all()) await checkbox.check();
  const holderSaved = responseFor(page, '/workflow/capture');
  await holderEditor.getByRole('button', { name: 'Save proposed holder details', exact: true }).click();
  const holder = (await checkedJSON(await holderSaved)).record;
  expect(holder.data.review_status).toBe('proposed');
  await journal.getByLabel('Holder review note', { exact: true }).fill('Read the supplied holder identity and leading-zero identifier separately.');
  const holderConfirmed = responseFor(page, `/facts/${holder.id}/review`);
  await journal.getByRole('button', { name: 'Confirm these holder details', exact: true }).click();
  expect((await checkedJSON(await holderConfirmed)).data.review_status).toBe('confirmed');

  const form = page.locator('#czech-journal-entry');
  for (const [label, value] of [
    ['Actual application date', '2026-06-15'], ['Field or place name used on the farm', 'Fictional north field'],
    ['Product used', 'Fictional treatment A — not an authorisation claim'], ['Crop, tree or treated use', 'Fictional wheat'],
    ['Person who applied it', 'Fictional farmer'], ['Product authorisation number, if recorded', 'AUTHORED-ONLY'],
  ]) await form.getByLabel(label, { exact: true }).fill(value);
  await form.getByLabel('What did you treat?', { exact: true }).selectOption('surface');
  await form.getByLabel('Dose exactly as recorded', { exact: true }).fill('0,250');
  await form.getByLabel('Dose unit exactly as recorded', { exact: true }).fill('l/ha');
  await form.getByLabel('Actual treated size exactly as recorded', { exact: true }).fill('1,20');
  await form.getByLabel('Unit of the treated size', { exact: true }).fill('ha');
  await form.getByLabel('Recorded location type', { exact: true }).selectOption('lpis_land');
  await form.getByLabel('Cadastral area exactly as supplied', { exact: true }).fill('Authored cadastral area 001');
  await form.getByLabel('LPIS square exactly as supplied', { exact: true }).fill('000012');
  await form.getByLabel('DPB code exactly as supplied', { exact: true }).fill('0007/01');
  await form.getByLabel('What does this entry concern?', { exact: true }).selectOption('crop');
  await form.getByLabel('Sown area, ha — original number', { exact: true }).fill('1,20');
  await form.getByLabel('Actual sowing or planting date', { exact: true }).fill('2025-08-10');
  await form.getByLabel('Target organism or purpose', { exact: true }).fill('Fictional recorded target');
  await form.getByLabel('How was the product used?', { exact: true }).selectOption('S');
  await expect(form.getByLabel('Is the crop end date known?', { exact: true })).toHaveValue('pending');
  await expect(form.getByLabel('Has efficacy been observed?', { exact: true })).toHaveValue('pending');
  await form.getByLabel('Where did you check these details?', { exact: true }).fill('Authored notebook page 14, actual application; efficacy and crop end not yet observed.');
  const proposed = await retainApplication(page);
  expect(proposed.data.cz_ppp.original_numbers).toEqual({ dose: '0,250', treated_size: '1,20', sown_area_ha: '1,20' });
  expect(proposed.data.quantity).toBeNull();
  expect(proposed.data.cz_ppp.efficacy).toEqual({ status: 'pending' });
  expect(proposed.data.cz_ppp.crop_end).toEqual({ status: 'pending' });
  const confirmed = await confirmApplication(page, journal, proposed);
  await journal.getByRole('checkbox', { name: 'Include this application in the response', exact: true }).check();
  await journal.getByRole('link', { name: 'Prepare selected applications', exact: true }).click();
  await expect(page.getByLabel('Request to answer', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Response format', { exact: true })).toHaveValue('cz-ppp-journal-2026');
  await page.getByRole('group', { name: 'Checked farm answers to include', exact: true }).getByRole('checkbox').check();
  const prepared = responseFor(page, '/reports');
  await page.getByRole('button', { name: 'Prepare preview', exact: true }).click();
  const draft = await checkedJSON(await prepared);
  expect(draft.data.request_id).toBeNull();
  await expect(page).toHaveURL(new RegExp(`/app/reports/${draft.id}$`));
  await expect(page.getByText('No letter is linked. Check this journal before approving it. A correction retains this original journal context.', { exact: true })).toBeVisible();
  const retained = page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: 'Application', exact: true }) });
  await expect(retained).toContainText('0,250 l/ha');
  await expect(retained).toContainText('Pending — follow up later');
  await expect(page.getByRole('button', { name: 'Approve this version', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'I reviewed this report and its sources and approve this version.', exact: true }).check();
  const approved = responseFor(page, `/reports/${draft.id}/approve`);
  await page.getByRole('button', { name: 'Approve this version', exact: true }).click();
  const issued = await checkedJSON(await approved);
  expect(issued.data.status).toBe('issued');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download JSON', exact: true }).click();
  const file = await downloaded;
  const chunks = [];
  for await (const chunk of await file.createReadStream()) chunks.push(chunk);
  const originalBytes = Buffer.concat(chunks);
  const exported = JSON.parse(originalBytes.toString('utf8'));
  const entry = exported.snapshot.journals[0].entries[0];
  expect(entry.operation_id).toBe(confirmed.id);
  expect(entry.original_numbers.dose).toBe('0,250');
  expect(entry.values.efficacy).toEqual({ status: 'pending' });
  expect(exported.snapshot.request).toBeNull();

  await page.goto(`/app/record-work?farm_id=${farm.id}`);
  const oldCard = journal.locator('article.evidence-card').filter({ hasText: confirmed.id });
  await oldCard.getByRole('button', { name: 'Prepare a correction', exact: true }).click();
  await expect(form.getByRole('heading', { name: 'Correct a checked application', exact: true })).toBeVisible();
  await form.getByLabel('Dose exactly as recorded', { exact: true }).fill('0,300');
  await form.getByLabel('Where did you check these details?', { exact: true }).fill('Reread authored notebook page 14: actual recorded dose is 0,300 l/ha.');
  const successor = await retainApplication(page);
  expect(successor.id).not.toBe(confirmed.id);
  expect(successor.data.supersedes_id).toBe(confirmed.id);
  expect((await read(page, `/operations/${confirmed.id}`)).active).toBe(true);
  await confirmApplication(page, journal, successor);
  expect((await read(page, `/operations/${confirmed.id}`)).active).toBe(false);
  await page.goto(`/app/reports/${issued.id}`);
  await expect(retained).toContainText('0,250 l/ha');
  await page.getByText('Choose replacement documents or activities', { exact: true }).click();
  const activities = page.getByRole('group', { name: 'Activities in the amendment', exact: true });
  await activities.getByRole('checkbox', { name: /no longer available as a confirmed record/ }).uncheck();
  await activities.getByRole('checkbox', { name: /2026-06-15/ }).check();
  const reissued = responseFor(page, `/reports/${issued.id}/reissue`);
  await page.getByRole('button', { name: 'Prepare a new draft with this selection', exact: true }).click();
  const amendment = await checkedJSON(await reissued);
  expect(amendment.data.request_id).toBeNull();
  expect(amendment.data.status).toBe('draft');
  expect(amendment.data.approval).toBeNull();
  await expect(page).toHaveURL(new RegExp(`/app/reports/${amendment.id}$`));
  await expect(retained).toContainText('0,300 l/ha');
  await expect(page.getByRole('checkbox', { name: 'I reviewed this report and its sources and approve this version.', exact: true })).not.toBeChecked();
  const oldFile = await page.request.get(`/api/v1/reports/${issued.id}/download?format=json`);
  expect(oldFile.ok()).toBe(true);
  expect(await oldFile.body()).toEqual(originalBytes);
  expect((await read(page, '/requests')).items).toHaveLength(0);
});
