import { test, expect } from '@playwright/test';

const fixture = JSON.parse(process.env.FUNKYFARM_BROWSER_FIXTURES || '{}');
const account = fixture.accounts?.owner;

// Complement farmer journeys with navigation and isolated account preferences.
// This is not an assertion that every button/state has been exercised.
async function readOnlyBrowser(page, { accountControls = false } = {}) {
  const errors = [], external = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (['localhost', '127.0.0.1'].includes(url.hostname)) {
      if (url.pathname.startsWith('/api/v1/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())
          && !(url.pathname === '/api/v1/auth/login' && request.method() === 'POST')
          && !(accountControls && (
            url.pathname === '/api/v1/account' && request.method() === 'PATCH'
            || url.pathname === '/api/v1/auth/logout' && request.method() === 'POST'))) {
        writes.push(`${request.method()} ${url.pathname}`);
        return route.abort('blockedbyclient');
      }
      return route.continue();
    }
    const tile = url.protocol === 'https:' && (
      url.hostname === 'tile.openstreetmap.org' && /^\/\d+\/\d+\/\d+\.png$/.test(url.pathname)
      || url.hostname === 'service.pdok.nl' && url.pathname.startsWith('/hwh/luchtfotorgb/wmts/')
      || url.hostname === 'www.wms.nrw.de' && url.pathname === '/geobasis/wms_nw_dop');
    if (tile) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#dfe8d1"/><text x="8" y="22">Authored local navigation fixture</text></svg>' });
    external.push(`${url.origin}${url.pathname}`);
    return route.abort('blockedbyclient');
  });
  return { errors, external, writes };
}

async function read(page, path) {
  const response = await page.request.get(`/api/v1${path}`);
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

async function signIn(page) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/home/);
}

async function fillPreferences(page, values) {
  await page.getByLabel('Preferred language', { exact: true }).selectOption(values.language);
  await page.getByLabel('Default country', { exact: true }).selectOption(values.country || '');
  await page.getByLabel('Default region', { exact: true }).fill(values.region || '');
  await page.getByLabel('Default reporting year', { exact: true }).fill(String(values.reporting_year));
  await page.getByRole('checkbox', { name: 'Show workspace notifications', exact: true }).setChecked(values.notifications);
}

async function savePreferences(page, values, previousRevision) {
  await fillPreferences(page, values);
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/account' && response.request().method() === 'PATCH');
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  const response = await saved;
  expect(response.ok(), await response.text()).toBeTruthy();
  const result = await response.json();
  expect(result.revision).toBe(previousRevision + 1);
  expect(result.data).toMatchObject(values);
  await expect(page.getByText('Your preferences are saved.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save preferences', exact: true })).toBeEnabled();
  return result;
}

test('page controls: account defaults, source handbook and legacy navigation do not change records', async ({ page }) => {
  test.skip(!account || !fixture.farm || !fixture.request, 'Requires the shared fictional owner/farm/request browser fixture.');
  test.setTimeout(180_000);
  const safety = await readOnlyBrowser(page, { accountControls: true });
  await page.goto('/login');
  await page.getByRole('link', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/\/register$/);
  await page.getByLabel('Your name', { exact: true }).fill('FICTIONAL unsubmitted form');
  await expect(page.getByRole('form', { name: 'Create account', exact: true }).locator('input[name="password"]')).toHaveAttribute('minlength', '12');
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await signIn(page);
  const beforeAccount = await read(page, '/account');
  const beforeFarm = await read(page, `/farms/${fixture.farm.id}`);
  const beforeRequest = await read(page, `/requests/${fixture.request.id}`);

  await page.locator('.language-picker select').selectOption('cs');
  await expect(page.locator('html')).toHaveAttribute('lang', 'cs');
  await page.locator('.language-picker select').selectOption('en');
  await page.locator('.account-menu > summary').click();
  await page.getByRole('link', { name: 'Account and settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Make yourself at home', exact: true })).toBeVisible();
  const initialPreferences = {
    language: await page.getByLabel('Preferred language', { exact: true }).inputValue(),
    country: await page.getByLabel('Default country', { exact: true }).inputValue() || null,
    region: await page.getByLabel('Default region', { exact: true }).inputValue() || null,
    reporting_year: Number(await page.getByLabel('Default reporting year', { exact: true }).inputValue()),
    notifications: await page.getByRole('checkbox', { name: 'Show workspace notifications', exact: true }).isChecked(),
  };
  const savedPreferences = { language: 'fr', country: 'NL', region: 'FICTIONAL saved region', reporting_year: 2199, notifications: true };
  const savedAccount = await savePreferences(page, savedPreferences, beforeAccount.revision);
  expect(await read(page, '/account')).toEqual({ ...beforeAccount, ...savedAccount });
  await fillPreferences(page, { language: 'de', country: 'BE', region: 'FICTIONAL unsaved region', reporting_year: 2200, notifications: false });
  expect(await read(page, '/account')).toEqual({ ...beforeAccount, ...savedAccount });
  await page.reload();
  await expect(page.getByLabel('Default region', { exact: true })).toHaveValue(savedPreferences.region);
  await expect(page.getByLabel('Preferred language', { exact: true })).toHaveValue(savedPreferences.language);
  await expect(page.getByLabel('Default country', { exact: true })).toHaveValue(savedPreferences.country);
  await expect(page.getByLabel('Default reporting year', { exact: true })).toHaveValue(String(savedPreferences.reporting_year));
  await expect(page.getByRole('checkbox', { name: 'Show workspace notifications', exact: true })).toBeChecked();
  // Restore all original visible preferences, retaining the real revision history.
  const restoredPreferences = await savePreferences(page, initialPreferences, savedAccount.revision);
  const restoredAccount = { ...beforeAccount, ...restoredPreferences };
  expect(await read(page, '/account')).toEqual(restoredAccount);

  await page.getByText('More farm tools', { exact: true }).click();
  await page.getByRole('navigation', { name: 'More farm tasks', exact: true }).getByRole('link', { name: 'Guidance', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Find the right guidance', exact: true })).toBeVisible();
  await page.getByLabel('Country', { exact: true }).selectOption('DE');
  await page.getByLabel('Reporting year', { exact: true }).fill('2026');
  await page.getByRole('button', { name: /^Düngeportal NRW — Schlagbezogene Pflanzenschutzanwendungen/ }).click();
  await expect(page.getByRole('heading', { name: 'What this pack can and cannot do', exact: true })).toBeVisible();
  await expect(page.getByText('Available preparation: sourced draft mapping', { exact: true })).toBeVisible();
  await page.getByText('Required answers and checks', { exact: true }).click();
  await expect(page.getByText('Applicator full name · required', { exact: true })).toBeVisible();
  const officialSources = page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Official sources', exact: true }) }).getByRole('link');
  expect(await officialSources.count()).toBeGreaterThan(0);
  for (const link of await officialSources.all()) expect(await link.getAttribute('href')).toMatch(/^https:\/\//);
  const unavailableYear = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/v1/packs' && url.searchParams.get('country') === 'DE' && url.searchParams.get('year') === '2199' && response.request().method() === 'GET';
  });
  await page.getByLabel('Reporting year', { exact: true }).fill('2199');
  const unavailableResponse = await unavailableYear;
  expect(unavailableResponse.ok()).toBeTruthy();
  expect((await unavailableResponse.json()).items).toEqual([]);
  await expect(page.getByRole('button', { name: /^Düngeportal NRW — Schlagbezogene Pflanzenschutzanwendungen/ })).toHaveCount(0);
  // Common dossiers also declare the 2026 edition; none may masquerade as 2199 guidance.
  await expect(page.getByText("No packs found for these choices. A missing format is not replaced with a different country's form.", { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /General farm records$/ })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'What this pack can and cannot do', exact: true })).toHaveCount(0);
  await page.getByLabel('Reporting year', { exact: true }).fill('2026');
  for (const title of ['Farm records', 'Inspection evidence', 'Aid application evidence', 'Inputs and treatment evidence', 'Environmental and scheme evidence']) {
    await expect(page.getByRole('button', { name: `${title} · General farm records`, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('heading', { name: 'What this pack can and cannot do', exact: true })).toHaveCount(0);

  for (const [from, target] of [
    [`/app/farm/${fixture.farm.id}?from=legacy#facts`, `/app/fields/${fixture.farm.id}?from=legacy#facts`],
    [`/app/requests/${fixture.request.id}?from=legacy#questions`, `/app/paperwork/${fixture.request.id}?from=legacy#questions`],
    ['/app/farm?from=legacy', '/app/fields?from=legacy'],
    ['/app/requests?from=legacy', '/app/paperwork?from=legacy'],
    ['/app/advisers?from=legacy', '/app/adviser?from=legacy'],
    ['/app/compliance?from=legacy', '/app/checks?from=legacy'],
  ]) {
    await page.goto(from);
    await expect(page).toHaveURL(url => url.pathname + url.search + url.hash === target);
    await expect(page.getByRole('heading', { name: 'This page could not open.', exact: true })).toHaveCount(0);
  }
  await page.goto('/app/fictional-unknown-page');
  await expect(page.getByRole('heading', { name: 'We could not find that page.', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to home', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/home$/);
  await page.goto('/app/settings');
  const signedOut = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/auth/logout' && response.request().method() === 'POST');
  await page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Your account', exact: true }) }).getByRole('button', { name: 'Sign out', exact: true }).click();
  expect((await signedOut).ok()).toBeTruthy();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  const privateSession = await page.request.get('/api/v1/auth/session');
  expect(privateSession.status()).toBe(401);
  await signIn(page);
  expect(await read(page, '/account')).toEqual(restoredAccount);
  expect(await read(page, `/farms/${fixture.farm.id}`)).toEqual(beforeFarm);
  expect(await read(page, `/requests/${fixture.request.id}`)).toEqual(beforeRequest);
  expect(safety).toEqual({ errors: [], external: [], writes: [] });
});

test('page controls: assistant connection guidance and invalid consent stay read-only', async ({ page }) => {
  test.skip(!account, 'Requires the shared fictional owner browser fixture.');
  test.setTimeout(120_000);
  const safety = await readOnlyBrowser(page);
  await signIn(page);
  await page.goto('/app/help');
  await page.getByRole('link', { name: 'Choose an assistant and its farm access', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Use your own assistant', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reload granted access', exact: true })).toBeEnabled();
  const config = await read(page, '/assistant/oauth/config');
  if (config.available) {
    await expect(page.getByLabel('MCP server address', { exact: true })).toHaveValue(config.resource);
    await page.getByLabel('Your assistant', { exact: true }).selectOption('claude');
    await expect(page.getByRole('link', { name: 'Open Claude', exact: true })).toHaveAttribute('href', 'https://claude.ai/');
    await page.getByLabel('Your assistant', { exact: true }).selectOption('chatgpt');
    await expect(page.getByRole('link', { name: 'Open ChatGPT', exact: true })).toHaveAttribute('href', 'https://chatgpt.com/');
    await page.getByRole('button', { name: 'Copy server address', exact: true }).click();
    await expect(page.getByText(/MCP server address copied\.|Select and copy the server address shown below\./)).toBeVisible();
  } else {
    await expect(page.getByText(/No public connector is configured\./)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy server address', exact: true })).toHaveCount(0);
  }
  const reloaded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/assistant/oauth/connections' && response.request().method() === 'GET');
  await page.getByRole('button', { name: 'Reload granted access', exact: true }).click();
  expect((await reloaded).ok()).toBeTruthy();
  await expect(page.getByRole('button', { name: 'Previous connections', exact: true })).toBeDisabled();
  await page.goto('/app/assistant/connect?request=not-a-valid-request');
  await expect(page.getByRole('alert')).toContainText('This connection request is not valid. Start again from your assistant.');
  await expect(page.getByRole('button', { name: 'Allow selected farm access', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Reload this page', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('This connection request is not valid. Start again from your assistant.');
  expect(safety).toEqual({ errors: [], external: [], writes: [] });
});
