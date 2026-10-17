import { test, expect } from '@playwright/test';

const fixture = JSON.parse(process.env.FUNKYFARM_BROWSER_FIXTURES || '{}');
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
async function isolated(page) {
  const errors = []; const external = []; const events = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/v1\/cases\/[^/]+\/events$/.test(new URL(request.url()).pathname)) events.push(request.postDataJSON());
  });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['localhost', '127.0.0.1'].includes(url.hostname)) return route.continue();
    if (url.protocol === 'https:' && url.hostname === 'tile.openstreetmap.org' && /^\/\d+\/\d+\/\d+\.png$/.test(url.pathname)) {
      return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#dfe8d1"/><text x="10" y="25">Fictional local map fixture</text></svg>' });
    }
    external.push(`${url.origin}${url.pathname}`);
    return route.abort('blockedbyclient');
  });
  return { errors, external, events };
}
async function startExample(page) {
  await page.goto('/app/examples');
  const create = page.getByRole('button', { name: 'Create my sample workspace', exact: true });
  await expect(create).toBeDisabled();
  await page.getByRole('checkbox', { name: 'I understand these are made-up records in a separate workspace.', exact: true }).check();
  const saved = responseFor(page, '/examples/workspace', 'POST');
  await create.click();
  const response = await saved; expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).toEqual({ fixture_id: 'lpis-correction-2026-v1', acknowledged: true });
  expect(response.request().headers()['idempotency-key']).toMatch(/^[a-f0-9-]{36}$/i);
  const example = await checked(response);
  await expect(page.getByLabel('Switch workspace', { exact: true })).toHaveValue(example.workspace.id);
  await expect(page.getByRole('heading', { name: 'Your private sample workspace', exact: true })).toBeVisible();
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
  await page.goto('/app/home');
  await page.getByLabel('Farm', { exact: true }).selectOption(farm.id);
  await page.getByRole('link', { name: 'Check my fields', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/app/fields/${farm.id}/check`));
  await expect(page.getByRole('heading', { name: 'Check your fields', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: /FICTIONAL .* meadow/ })).toBeVisible();
  await expect(page.getByText('Unknown. The responsible authority decides.', { exact: true })).toBeVisible();
  const field = page.getByLabel('Field to look at', { exact: true });
  const fields = await read(page, `/farms/${farm.id}/fields`, example.workspace.id);
  await field.selectOption('1'); await field.selectOption('0');
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
  await workspace.getByLabel('Field name', { exact: true }).fill('FICTIONAL browser west meadow');
  await workspace.getByLabel('What changed, or where did this outline come from?', { exact: true }).fill('FICTIONAL browser review of the original outline; no official LPIS update.');
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
  await expect(page.getByRole('heading', { name: 'Your private sample workspace', exact: true })).toBeVisible();
  const cards = page.locator('article.demo-farm-card'); await expect(cards).toHaveCount(7);
  for (let index = 0; index < 7; index += 1) {
    const card = cards.nth(index);
    await card.getByRole('button', { name: 'Show me what to do', exact: true }).click();
    const detail = page.locator('#demo-scenario-detail'); await expect(detail).toBeFocused();
    await expect(detail.getByRole('heading', { level: 2 })).toHaveText(example.scenarios[index].title);
    await expect(detail.locator('ol > li')).toHaveCount(example.scenarios[index].expected_actions.length);
    for (const link of await detail.getByRole('link').all()) expect(await link.getAttribute('href')).toMatch(/^\/app\//);
  }
  await page.getByText('Saved records and sample details', { exact: true }).click();
  await expect(page.getByText(example.notice, { exact: true })).toBeVisible();
  const refreshed = responseFor(page, `/examples/workspace/${example.run_id}`);
  await page.getByRole('button', { name: 'Refresh progress', exact: true }).click();
  expect((await checked(await refreshed)).run_id).toBe(example.run_id);
  const beforeRestart = page.url();
  await page.getByRole('button', { name: 'Start a fresh sample run', exact: true }).click();
  const fresh = page.getByRole('button', { name: 'Create a fresh sample workspace', exact: true }); await expect(fresh).toBeDisabled();
  await page.getByRole('button', { name: 'Keep working here', exact: true }).click();
  await expect(page).toHaveURL(beforeRestart);
  await page.getByRole('button', { name: 'Start a fresh sample run', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Keep this workspace and my changes, and create another fictional sample workspace.', exact: true }).check();
  const restarted = responseFor(page, `/examples/workspace/${example.run_id}/start-again`, 'POST');
  await fresh.click();
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
  await page.goto('/app/home'); await page.getByLabel('Farm', { exact: true }).selectOption(farm.id);
  await page.getByRole('link', { name: 'Fix a mistake in filed paperwork', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Correct something you already sent', exact: true })).toBeVisible();
  await page.getByLabel('Application year', { exact: true }).fill('2026');
  await page.getByLabel('Name this correction', { exact: true }).fill('FICTIONAL browser correction');
  await page.getByLabel('Original submission reference, if known', { exact: true }).fill('FICTIONAL-CAP-CZ-WINDOW-2026');
  await page.getByLabel('What did you actually send?', { exact: true }).fill('FICTIONAL training original: an earlier field outline. This is not a real filing.');
  const create = page.getByRole('button', { name: 'Save original and continue', exact: true }); await expect(create).toBeDisabled();
  await page.getByRole('checkbox', { name: 'I have described an original I actually sent. A saved or approved app report alone does not establish that it was sent.', exact: true }).check();
  const created = responseFor(page, '/cases', 'POST'); await create.click();
  const record = await checked(await created); expect(record.data.focused_review_required).toBe(true);
  await expect(page).toHaveURL(new RegExp(`/app/cases/${record.id}/correction\\?step=2$`));
  await page.getByLabel('What is wrong, and what should change?', { exact: true }).fill('FICTIONAL training: compare the corrected east edge against the retained original; do not treat private preparation as filing.');
  await page.getByText('Choose corrected records and supporting evidence', { exact: true }).click();
  await page.getByLabel('Find a saved record', { exact: true }).selectOption('field_change_proposals');
  await page.getByLabel('Use this record as', { exact: true }).selectOption('change');
  const choices = page.locator('details.correction-sources');
  await choices.getByRole('button', { name: 'Choose this record', exact: true }).click();
  await page.getByLabel('Find a saved record', { exact: true }).selectOption('documents');
  await page.getByLabel('Use this record as', { exact: true }).selectOption('notice');
  await choices.getByRole('button', { name: 'Choose this record', exact: true }).click();
  await page.getByRole('checkbox', { name: 'I checked these entries against my records. Unknown details have not been guessed.', exact: true }).check();
  const details = responseFor(page, `/cases/${record.id}`, 'PATCH');
  await page.getByRole('button', { name: 'Save this step and continue', exact: true }).click();
  const amended = await checked(await details);
  await expect(page).toHaveURL(new RegExp(`step=3$`));
  await page.getByLabel('Which intervention or monitoring route applies?', { exact: true }).selectOption('ams');
  await page.getByLabel('National correction deadline stated in the applicable instructions', { exact: true }).fill('2026-10-30');
  const notice = amended.data.references.find(item => item.kind === 'documents' && item.role === 'notice'); expect(notice).toBeTruthy();
  await page.getByLabel('Saved source for that national deadline', { exact: true }).selectOption(`documents/${notice.id}/notice`);
  await page.getByLabel('First instalment date, if specifically established', { exact: true }).fill('2026-12-01');
  await page.getByRole('checkbox', { name: 'I checked these entries against my records. Unknown details have not been guessed.', exact: true }).check();
  const dates = responseFor(page, `/cases/${record.id}`, 'PATCH');
  await page.getByRole('button', { name: 'Save this step and continue', exact: true }).click(); await checked(await dates);
  await page.getByRole('navigation', { name: 'Correction steps', exact: true }).getByRole('button', { name: /Check the dates$/ }).click();
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
  await page.getByRole('checkbox', { name: 'Allow reviewing and confirming evidence', exact: true }).check();
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
