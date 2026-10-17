import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const fixture = JSON.parse(process.env.FUNKYFARM_BROWSER_FIXTURES || '{}');
const account = fixture.accounts?.land;
const responseFor = (page, path, method) => page.waitForResponse(response =>
  new URL(response.url()).pathname === `/api/v1${path}` && response.request().method() === method);

async function checked(response) {
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

test('tools follow-up: farmer saves a funding task and attaches a document without filing or duplicate records', async ({ page }) => {
  test.skip(!account, 'Requires the isolated land account browser fixture.');
  test.setTimeout(150_000);
  const errors = [], external = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/v1/') && ['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method()))
      writes.push(`${request.method()} ${path}`);
  });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['localhost', '127.0.0.1'].includes(url.hostname)) return route.continue();
    external.push(`${url.origin}${url.pathname}`);
    return route.abort('blockedbyclient');
  });
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/home/);
  const session = await checked(await page.request.get('/api/v1/auth/session'));
  expect(session.workspace.id).toBe(account.workspace_id);
  const headers = { 'X-CSRF-Token': session.csrf_token, 'X-Workspace-ID': account.workspace_id };
  const read = path => page.request.get(`/api/v1${path}`, { headers }).then(checked);
  // The generated holding has no coordinates or map/provider dependencies.
  const farm = await checked(await page.request.post('/api/v1/farms', { headers, data: { data: {
    name: `Funding follow-up holding ${randomUUID()}`, country: 'DE', region: 'Bavaria',
    reporting_year: 2026, farm_type: 'arable', area_ha: 3.75,
  } } }));
  const taskList = () => read(`/tasks?farm_id=${farm.id}&task_state=all`);
  expect((await taskList()).total).toBe(0);

  await page.goto('/app/funding');
  await page.getByLabel('Which farm?', { exact: true }).selectOption(farm.id);
  await expect(page.getByRole('heading', { name: 'Funding and grants', exact: true })).toBeVisible();
  await expect(page.getByText('Your eligibility has not been assessed. The official call decides what can be funded.', { exact: true })).toBeVisible();
  const followUpDate = '2026-11-20';
  const originalNote = 'Ask our producer group whether it can apply. This is our own reminder.';
  await page.getByLabel('Follow-up date (optional)', { exact: true }).fill(followUpDate);
  await page.getByLabel('What should we check? (optional)', { exact: true }).fill(originalNote);
  const createdResponse = responseFor(page, '/tasks', 'POST');
  await page.getByRole('button', { name: 'Save funding follow-up', exact: true }).click();
  const task = await checked(await createdResponse);
  expect(task.data).toMatchObject({ farm_id: farm.id, due_date: followUpDate, notes: originalNote, status: 'open' });
  await expect(page.getByRole('link', { name: 'Open the task', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('link', { name: 'Open the task', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save funding follow-up', exact: true })).toHaveCount(0);
  expect((await taskList()).total).toBe(1);

  await page.getByRole('link', { name: 'Open the task', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/app/tasks/${task.id}$`));
  await expect(page.getByRole('heading', { name: 'Check agricultural promotion funding', exact: true })).toBeVisible();
  await expect(page.getByLabel('What has been done, or what is still needed?', { exact: true })).toHaveValue(originalNote);
  const originalPointer = task.data.document_id;
  if (originalPointer) {
    await expect(page.getByRole('link', { name: 'Read the original document', exact: true })).toHaveAttribute('href', `/app/documents/${originalPointer}`);
  }
  const filename = 'task-follow-up-notebook.txt';
  const original = Buffer.from('Authored acceptance note. Producer group meeting planned for 20 November 2026. No grant application has been submitted.\n');
  await page.getByLabel('Add a PDF, photo or text file', { exact: true }).setInputFiles({ name: filename, mimeType: 'text/plain', buffer: original });
  const uploadedResponse = responseFor(page, '/documents', 'POST');
  await page.getByRole('button', { name: 'Upload and select document', exact: true }).click();
  const document = await checked(await uploadedResponse);
  expect(document.data.farm_id).toBe(farm.id);
  await expect(page.getByText('The document is saved. Save your answer below to attach it to this task.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Selected for this answer (1 of 20)', exact: true })).toBeVisible();
  const checkbox = page.getByRole('checkbox', { name: filename, exact: true });
  await expect(checkbox).toBeChecked();
  await checkbox.uncheck();
  await expect(page.getByRole('heading', { name: /^Selected for this answer/ })).toHaveCount(0);
  await checkbox.check();
  const beforeSave = await read(`/tasks/${task.id}`);
  expect(beforeSave.revision).toBe(task.revision);
  expect(beforeSave.data.evidence_documents || []).toEqual([]);
  expect(beforeSave.data.status).toBe('open');
  const answer = 'I spoke with the producer group. The meeting note is attached; we still need to check the official call.';
  await page.getByLabel('What has been done, or what is still needed?', { exact: true }).fill(answer);
  await page.getByLabel('Task progress', { exact: true }).selectOption('in_progress');
  const save = page.getByRole('button', { name: 'Save answer and progress', exact: true });
  await expect(save).toBeEnabled();
  const savedResponse = responseFor(page, `/tasks/${task.id}`, 'PATCH');
  await save.click();
  const saved = await checked(await savedResponse);
  expect(saved.data).toMatchObject({ notes: answer, status: 'in_progress',
    evidence_documents: [{ document_id: document.id, document_revision: document.revision }] });
  expect(saved.data.document_id).toBe(originalPointer);
  await expect(page.getByRole('heading', { name: 'Documents attached to the saved answer', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('What has been done, or what is still needed?', { exact: true })).toHaveValue(answer);
  await expect(page.getByRole('checkbox', { name: filename, exact: true })).toBeChecked();
  const attached = page.locator('.panel.inset').filter({ has: page.getByRole('heading', { name: 'Documents attached to the saved answer', exact: true }) });
  await expect(attached.getByRole('link', { name: filename, exact: true })).toHaveAttribute('href', `/app/documents/${document.id}`);
  const readback = await read(`/tasks/${task.id}`);
  expect(readback).toEqual(saved);
  expect((await taskList()).total).toBe(1);
  expect((await read(`/documents?farm_id=${farm.id}`)).total).toBe(1);
  const download = await page.request.get(`/api/v1/documents/${document.id}/file`, { headers });
  expect(download.ok()).toBeTruthy();
  expect(await download.body()).toEqual(original);
  for (const kind of ['facts', 'operations', 'purchases', 'sales', 'requests', 'reports'])
    expect((await read(`/${kind}?farm_id=${farm.id}`)).total, `No implicit ${kind}`).toBe(0);
  const unexpectedWrites = writes.filter(write => ![
    'POST /api/v1/auth/login', 'POST /api/v1/tasks', 'POST /api/v1/documents', `PATCH /api/v1/tasks/${task.id}`,
  ].includes(write));
  expect(unexpectedWrites).toEqual([]);
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});
