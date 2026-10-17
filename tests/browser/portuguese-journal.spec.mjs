import { test, expect } from '@playwright/test';

const fixture = JSON.parse(process.env.FUNKYFARM_BROWSER_FIXTURES || '{}');
const title = 'Portuguese farmer preserves literal journal drafts and explicitly prepares a reviewed report';
const factKey = 'pt.ppp.surface_journal';
const packId = 'pt-ppp-surface-journal';
// Independently retained literal order from the inspected DGAV workbook contract.
const columns = [
  ['application_date_time_text', 'A', 'Data (e hora de início, se aplicável)'],
  ['location_text', 'B', 'Localização '],
  ['use_crop_oepp_text', 'C', 'Tipo de utilização/cultura (código OEPP)'],
  ['bbch_text', 'D', 'Estado fenológico (BBCH)'],
  ['target_text', 'E', 'Inimigo '],
  ['treated_area_text', 'F', 'Área tratada\n(ha ou m2)'],
  ['applicator_number_text', 'G', 'N.º de aplicador'],
  ['product_name_text', 'H', 'Nome'],
  ['product_authorisation_text', 'I', 'Número de autorização'],
  ['seller_establishment_text', 'J', ' Estabelecimento de venda '],
  ['seller_activity_authorisation_text', 'K', 'N.º de autorização de exercício de atividade'],
  ['quantity_or_dose_text', 'L', 'Quant. de produto aplicado (kg ou L) ou dose (kg ou L/ha ou m²)'],
  ['mixture_volume_text', 'M', 'Volume de calda  (L)'],
];
const producer = '  Produtora fictícia Amélia — exploração 0007  ';
const observations = 'Observação global: registos fictícios para ensaio.\nSem decisão de elegibilidade.';
const firstCells = {
  application_date_time_text: '15/06/26 — hora por confirmar', location_text: 'Talhão 0007 / Horta do Vale',
  use_crop_oepp_text: 'TRZAX 001 — cultura registada', bbch_text: null, target_text: '', treated_area_text: '1,2500 ha',
  applicator_number_text: '00001234', product_name_text: 'Produto fictício A', product_authorisation_text: '00077',
  seller_establishment_text: 'Loja fictícia, Sul', seller_activity_authorisation_text: '000009',
  quantity_or_dose_text: '=1+1', mixture_volume_text: '0',
};
const secondCells = { ...firstCells, product_name_text: 'Produto fictício B', quantity_or_dose_text: '0,250 L/ha', mixture_volume_text: '12,50' };

const responseFor = (page, path, method = 'POST') => page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1${path}` && response.request().method() === method);
async function checkedJSON(response) {
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
const read = async (page, path) => checkedJSON(await page.request.get(`/api/v1${path}`));
async function downloadBytes(page, format) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: `Download ${format}`, exact: true }).click();
  const download = await pending;
  expect(await download.failure()).toBeNull();
  expect(download.suggestedFilename()).toMatch(new RegExp(`\\.${format.toLowerCase()}$`));
  const stream = await download.createReadStream(); expect(stream).toBeTruthy();
  const chunks = []; let size = 0;
  for await (const chunk of stream) { size += chunk.length; expect(size).toBeLessThan(16 * 1024 * 1024); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

// Quoted newlines and escaped quotes must survive the derivative CSV as well.
function csvRows(bytes) {
  const rows = []; let row = []; let value = ''; let quoted = false;
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') { if (quoted && text[index + 1] === '"') { value += '"'; index += 1; } else quoted = !quoted; }
    else if (!quoted && char === ',') { row.push(value); value = ''; }
    else if (!quoted && (char === '\r' || char === '\n')) { if (char === '\r' && text[index + 1] === '\n') index += 1; row.push(value); rows.push(row); row = []; value = ''; }
    else value += char;
  }
  expect(quoted).toBe(false);
  if (value || row.length) { row.push(value); rows.push(row); }
  return rows;
}

async function literal(scope, label, value) {
  if (value === null) { await expect(scope.getByLabel(`${label} — supplied value`, { exact: true })).toHaveValue('unknown'); return; }
  await scope.getByLabel(`${label} — supplied value`, { exact: true }).selectOption('text');
  await scope.getByLabel(label, { exact: true }).fill(value);
}
async function fillRow(page, editor, number, cells, date) {
  const row = editor.locator('section.paper-section').filter({ has: page.getByRole('heading', { name: `Edit row ${number}`, exact: true }) });
  for (const [key, letter, label] of columns) await literal(row, `${letter} · ${label}`, cells[key]);
  const actual = row.getByLabel('Actual application date, supplied separately', { exact: true });
  const confirmed = row.getByRole('checkbox', { name: 'I checked the actual application date separately from column A.', exact: true });
  if (date) { await actual.fill(date); await expect(confirmed).not.toBeChecked(); await confirmed.check(); }
  else { await expect(actual).toHaveValue(''); await expect(confirmed).toBeDisabled(); }
  await row.getByRole('button', { name: 'Close row editor', exact: true }).click();
}

test(title, async ({ page }) => {
  test.skip(!fixture.accounts?.owner, 'Supply the existing normal owner account in the browser fixture.');
  test.setTimeout(240_000);
  const errors = []; const external = []; const authorityEvents = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST' && /\/api\/v1\/(?:reports\/[^/]+\/receipts|cases\/[^/]+\/events)$/.test(new URL(request.url()).pathname)) authorityEvents.push(request.url()); });
  await page.route('**/*', route => { const url = new URL(route.request().url()); if (['localhost', '127.0.0.1'].includes(url.hostname)) return route.continue(); external.push(`${url.origin}${url.pathname}`); return route.abort('blockedbyclient'); });
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(fixture.accounts.owner.email);
  await page.getByLabel('Password', { exact: true }).fill(fixture.accounts.owner.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/home/);
  const nav = page.getByRole('navigation', { name: 'Main navigation', exact: true });
  await nav.getByRole('link', { name: /^My fields\b/ }).click();
  await page.getByText('Add another farm', { exact: true }).click();
  const setup = page.locator('section.farm-setup');
  await setup.getByLabel('Farm name', { exact: true }).fill('Fictional Portuguese browser holding');
  await setup.getByLabel('Country', { exact: true }).selectOption('PT');
  await setup.getByLabel('Region or state', { exact: true }).fill('Authored training region');
  await setup.getByLabel('What kind of farm?', { exact: true }).selectOption('horticulture');
  await setup.getByLabel('Year you are preparing for', { exact: true }).fill('2026');
  await setup.getByRole('button', { name: 'Continue', exact: true }).click();
  await setup.getByRole('radio', { name: /A notebook, receipt or letter/ }).check();
  const onboard = responseFor(page, '/workflow/onboard');
  await setup.getByRole('button', { name: 'Set up farm and add document', exact: true }).click();
  const { farm } = await checkedJSON(await onboard);
  expect(farm.data.country).toBe('PT'); expect(farm.data.reporting_year).toBe(2026);
  await expect(page).toHaveURL(/\/app\/documents/);
  await nav.getByRole('link', { name: /^Notebook\b/ }).click();
  await page.getByLabel('Farm', { exact: true }).selectOption(farm.id);
  const journal = page.locator('#portuguese-journal');
  await expect(journal.getByRole('heading', { name: 'Portuguese surface-treatment journal', exact: true })).toBeVisible();
  await journal.getByRole('button', { name: 'Start or reopen a private journal draft', exact: true }).click();
  let editor = journal.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Start a Portuguese surface-treatment journal', exact: true }) });
  await literal(editor, 'Nome do produtor/empresa ou entidade autorizada:', producer);
  await literal(editor, 'Obs. — whole journal', observations);
  await editor.getByRole('button', { name: 'Add a journal row', exact: true }).click();
  await fillRow(page, editor, 1, firstCells);
  const proposed = responseFor(page, '/facts');
  await editor.getByRole('button', { name: 'Save proposed Portuguese journal', exact: true }).click();
  const partial = await checkedJSON(await proposed);
  expect(partial.data.key).toBe(factKey); expect(partial.data.review_status).toBe('proposed');
  expect(partial.data.value.identity_text).toBe(producer); expect(partial.data.value.observations_text).toBe(observations);
  expect(partial.data.value.entries).toHaveLength(1);
  const firstId = partial.data.value.entries[0].entry_id;
  expect(partial.data.value.entries[0]).toEqual({ entry_id: firstId, cells: firstCells, actual_date: null, date_confirmed: false });
  for (const kind of ['operations', 'purchases']) expect((await read(page, `/${kind}?farm_id=${farm.id}`)).total).toBe(0);

  // Reopen a server-saved partial draft through the actual notebook screen.
  await page.reload();
  await expect(page.getByLabel('Farm', { exact: true })).toHaveValue(farm.id);
  await journal.getByRole('button', { name: 'Open this saved journal', exact: true }).click();
  await expect(journal.getByRole('heading', { name: 'Read back the saved Portuguese journal', exact: true })).toBeVisible();
  await expect(journal.getByRole('region', { name: 'Portuguese journal literal rows', exact: true })).toContainText('No actual date supplied');
  expect((await read(page, `/facts/${partial.id}`)).data.value.entries[0]).toEqual(partial.data.value.entries[0]);
  await journal.getByRole('button', { name: 'Edit this proposed journal', exact: true }).click();
  editor = journal.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Edit the proposed journal', exact: true }) });
  await expect(editor.getByLabel('Nome do produtor/empresa ou entidade autorizada:', { exact: true })).toHaveValue(producer);
  await editor.getByRole('button', { name: 'Edit row 1', exact: true }).click();
  const editedRow = editor.locator('section.paper-section').filter({ has: page.getByRole('heading', { name: 'Edit row 1', exact: true }) });
  await expect(editedRow.getByLabel('A · Data (e hora de início, se aplicável)', { exact: true })).toHaveValue(firstCells.application_date_time_text);
  await editedRow.getByLabel('Actual application date, supplied separately', { exact: true }).fill('2026-06-15');
  await expect(editedRow.getByRole('checkbox', { name: 'I checked the actual application date separately from column A.', exact: true })).not.toBeChecked();
  await editedRow.getByRole('checkbox', { name: 'I checked the actual application date separately from column A.', exact: true }).check();
  await editedRow.getByRole('button', { name: 'Close row editor', exact: true }).click();
  await editor.getByRole('button', { name: 'Add a journal row', exact: true }).click();
  await fillRow(page, editor, 2, secondCells, '2026-06-15');
  await editor.getByRole('button', { name: 'Add a journal row', exact: true }).click();
  const undatedCells = Object.fromEntries(columns.map(([key]) => [key, null]));
  undatedCells.application_date_time_text = 'Data por confirmar'; undatedCells.location_text = firstCells.location_text; undatedCells.product_name_text = 'Rascunho fictício sem data';
  await fillRow(page, editor, 3, undatedCells);
  const edited = responseFor(page, `/facts/${partial.id}`, 'PATCH');
  await editor.getByRole('button', { name: 'Save proposed Portuguese journal', exact: true }).click();
  const saved = await checkedJSON(await edited);
  expect(saved.id).toBe(partial.id); expect(saved.revision).toBeGreaterThan(partial.revision); expect(saved.data.review_status).toBe('proposed');
  expect(saved.data.value.entries).toHaveLength(3);
  const [first, second, undated] = saved.data.value.entries;
  expect(first).toEqual({ entry_id: firstId, cells: firstCells, actual_date: '2026-06-15', date_confirmed: true });
  expect(second.cells).toEqual(secondCells); expect(second.entry_id).not.toBe(firstId);
  expect(second.actual_date).toBe('2026-06-15'); expect(second.date_confirmed).toBe(true);
  expect(undated.cells).toEqual(undatedCells); expect(undated.actual_date).toBeNull(); expect(undated.date_confirmed).toBe(false);

  const confirm = journal.getByRole('button', { name: 'Confirm this Portuguese journal', exact: true });
  await expect(confirm).toBeDisabled();
  await journal.getByLabel('What did you compare before checking this journal?', { exact: true }).fill('Compared the fictional source text, producer, global observations, leading-zero identifiers and all three independent rows; row 3 has no checked actual date.');
  await expect(confirm).toBeDisabled();
  await journal.getByRole('checkbox', { name: 'I compared every saved page and the original records. This confirms only my review of these literal entries.', exact: true }).check();
  const confirmedResponse = responseFor(page, `/facts/${saved.id}/review`); await confirm.click();
  const confirmed = await checkedJSON(await confirmedResponse);
  expect(confirmed.data.review_status).toBe('confirmed'); expect(confirmed.data.value).toEqual(saved.data.value);

  const selection = journal.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Choose rows for a journal preview', exact: true }) });
  const prepare = selection.getByRole('button', { name: 'Prepare selected Portuguese rows', exact: true });
  await expect(prepare).toBeDisabled();
  await selection.getByLabel('Year for this app journal preview', { exact: true }).fill('2025');
  for (const number of [1, 2, 3]) await expect(selection.getByRole('checkbox', { name: `Include row ${number} in the journal preview`, exact: true })).toBeDisabled();
  await selection.getByLabel('Year for this app journal preview', { exact: true }).fill('2026');
  for (const number of [1, 2]) await expect(selection.getByRole('checkbox', { name: `Include row ${number} in the journal preview`, exact: true })).not.toBeChecked();
  await expect(selection.getByRole('checkbox', { name: 'Include row 3 in the journal preview', exact: true })).toBeDisabled();
  // Deliberately choose the second row first: selection order must not be sorted.
  await selection.getByRole('checkbox', { name: 'Include row 2 in the journal preview', exact: true }).check();
  await selection.getByRole('checkbox', { name: 'Include row 1 in the journal preview', exact: true }).check();
  await expect(prepare).toBeDisabled();
  await selection.getByRole('checkbox', { name: 'I checked the selected rows, their order and actual dates. I understand that unknown or empty cells still need checking and this preview does not send anything.', exact: true }).check();
  const preparedResponse = responseFor(page, '/reports'); await prepare.click();
  const preparedHTTP = await preparedResponse;
  expect(preparedHTTP.request().postDataJSON()).toMatchObject({ farm_id: farm.id, pack_id: packId, reporting_year: 2026, request_id: null, fact_ids: [confirmed.id], operation_ids: [], selected_document_ids: [], manual_journal_selection: { source_fact_id: confirmed.id, source_fact_revision: confirmed.revision, entry_ids: [second.entry_id, first.entry_id], acknowledged_unresolved: true } });
  const report = await checkedJSON(preparedHTTP);
  expect(report.data.status).toBe('draft');
  await expect(page).toHaveURL(new RegExp(`/app/reports/${report.id}$`));
  await expect(page.getByRole('heading', { name: 'Review your answer', exact: true })).toBeVisible();
  const preview = page.getByRole('region', { name: 'Saved Portuguese crop-protection record', exact: true });
  await expect(preview).toContainText('Produtora fictícia Amélia');
  await expect(preview).toContainText(observations);
  await expect(preview.getByRole('heading', { name: '2 selected rows', exact: true })).toBeVisible();
  for (const [position, cells] of [[1, secondCells], [2, firstCells]]) {
    const row = preview.locator('details.card').filter({ has: page.getByText(`Row ${position}, 2026-06-15`, { exact: true }) });
    await row.locator('summary').click();
    expect(await row.locator('dt').allTextContents()).toEqual(columns.map(([, , label]) => label));
    await expect(row).toContainText(cells.product_name_text);
    await expect(row).toContainText(cells.quantity_or_dose_text);
    await expect(row).toContainText('00001234');
    await expect(row).toContainText('Not recorded');
    await expect(row).toContainText('Left blank');
  }
  await preview.getByText('1 source row was not included', { exact: true }).click();
  await expect(preview).toContainText('Actual date not recorded');
  await expect(preview).toContainText('These rows remain in the source journal.');
  const approve = page.getByRole('button', { name: 'Approve this version', exact: true });
  await expect(approve).toBeDisabled();
  await page.getByRole('checkbox', { name: 'I reviewed this report and its sources and approve this version.', exact: true }).check();
  const issuedResponse = responseFor(page, `/reports/${report.id}/approve`); await approve.click();
  const issued = await checkedJSON(await issuedResponse); expect(issued.data.status).toBe('issued');

  const exported = JSON.parse((await downloadBytes(page, 'JSON')).toString('utf8'));
  expect(exported.snapshot.request).toBeNull(); expect(exported.snapshot.operations).toEqual([]);
  const retained = exported.snapshot.journals.find(item => item.schema_id === 'pt-ppp-surface-v1');
  expect(retained).toBeTruthy(); expect(retained.holder).toEqual({ fact_id: confirmed.id, fact_revision: confirmed.revision, value: producer });
  expect(retained.observations_text).toBe(observations); expect(retained.reporting_year).toBe(2026);
  expect(retained.source.sha256).toBe('34ebb9d9d933cab566cf2084a6592ade06aa80821e363b7a428969c9f19dd2f3');
  expect(retained.columns.map(column => [column.key, column.label])).toEqual(columns.map(([key, , label]) => [key, label]));
  expect(retained.selection.entry_ids).toEqual([second.entry_id, first.entry_id]);
  expect(retained.entries.map(entry => entry.entry_id)).toEqual([second.entry_id, first.entry_id]);
  expect(retained.entries.map(entry => entry.values)).toEqual([secondCells, firstCells]);
  for (const entry of retained.entries) { expect(entry.source_fact_id).toBe(confirmed.id); expect(entry.source_fact_revision).toBe(confirmed.revision); expect(entry.actual_date).toBe('2026-06-15'); expect(entry).not.toHaveProperty('operation_id'); }
  expect(retained.excluded_entries).toEqual([{ entry_id: undated.entry_id, reason: 'date_missing', actual_date: null }]);
  expect(retained.capability_notice).toMatch(/Not an authority submission/);
  const csv = csvRows(await downloadBytes(page, 'CSV'));
  const header = csv.findIndex(row => JSON.stringify(row) === JSON.stringify(columns.map(([, , label]) => label)));
  expect(header).toBeGreaterThanOrEqual(0);
  expect(csv[header + 1]).toEqual(columns.map(([key]) => secondCells[key] ?? ''));
  expect(csv[header + 2]).toEqual(columns.map(([key]) => key === 'quantity_or_dose_text' ? "'=1+1" : firstCells[key] ?? ''));
  expect(csv.find(row => row[0] === 'Nome do produtor/empresa ou entidade autorizada:')?.[1]).toBe(producer);
  expect(csv.filter(row => row[0] === 'Obs. — whole document')).toEqual([['Obs. — whole document', observations]]);
  const state = JSON.parse(csv.find(row => row[0] === 'Row cell-state map' && row[1] === first.entry_id)[2]);
  expect(state.null_columns).toContain('bbch_text'); expect(state.empty_columns).toContain('target_text'); expect(state.protected_columns).toContain('quantity_or_dose_text');
  expect((await downloadBytes(page, 'PDF')).subarray(0, 5).toString('ascii')).toBe('%PDF-');
  const final = await read(page, `/reports/${issued.id}`);
  expect(final.data.status).toBe('issued'); expect(final.data.receipts || []).toEqual([]);
  expect((await read(page, `/facts/${confirmed.id}`)).data.value).toEqual(saved.data.value);
  for (const kind of ['operations', 'purchases', 'requests']) expect((await read(page, `/${kind}?farm_id=${farm.id}`)).total).toBe(0);
  expect(authorityEvents).toEqual([]); expect(external).toEqual([]); expect(errors).toEqual([]);
});
