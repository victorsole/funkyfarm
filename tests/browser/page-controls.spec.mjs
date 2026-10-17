import { test, expect } from '@playwright/test';
import { isEOXTile, backgroundTile } from './map-fixtures.mjs';
import { createHash } from 'node:crypto';

const fixture = JSON.parse(process.env.FUNKYFARM_BROWSER_FIXTURES || '{}');
const account = fixture.accounts?.owner;

// Complement farmer journeys with navigation and isolated account preferences.
// This is not an assertion that every button/state has been exercised.
async function readOnlyBrowser(page, { accountControls = false, assistantControls = false } = {}) {
  const errors = [], external = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (['localhost', '127.0.0.1'].includes(url.hostname)) {
      if (url.pathname.startsWith('/api/v1/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())
          && !(url.pathname === '/api/v1/auth/login' && request.method() === 'POST')
          && !(accountControls && (
            url.pathname === '/api/v1/account' && request.method() === 'PATCH'
            || url.pathname === '/api/v1/auth/logout' && request.method() === 'POST'))
          && !(assistantControls && request.method() === 'POST' && /^\/api\/v1\/assistant\/oauth\/(?:requests\/[a-f0-9-]+\/consent|connections\/[a-f0-9-]+\/revoke)$/.test(url.pathname))) {
        writes.push(`${request.method()} ${url.pathname}`);
        return route.abort('blockedbyclient');
      }
      return route.continue();
    }
    if (assistantControls && url.origin + url.pathname === fixture.oauth_registration?.callback)
      return route.fulfill({ contentType: 'text/html', body: '<h1>Local connector callback</h1><p>No provider was contacted.</p>' });
    const tile = url.protocol === 'https:' && (
      url.hostname === 'tile.openstreetmap.org' && /^\/\d+\/\d+\/\d+\.png$/.test(url.pathname)
      || url.hostname === 'service.pdok.nl' && url.pathname.startsWith('/hwh/luchtfotorgb/wmts/')
      || url.hostname === 'www.wms.nrw.de' && url.pathname === '/geobasis/wms_nw_dop'
      || url.hostname === 'www.ign.es' && url.pathname === '/wms-inspire/pnoa-ma'
      || isEOXTile(url));
    if (tile) return backgroundTile(route);
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
  await expect(page.getByRole('combobox', { name: /language/i })).toHaveCount(0);
  await page.getByRole('link', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/\/register$/);
  await expect(page.getByRole('combobox', { name: /language/i })).toHaveCount(0);
  await page.getByLabel('Your name', { exact: true }).fill('FICTIONAL unsubmitted form');
  await expect(page.getByRole('form', { name: 'Create account', exact: true }).locator('input[name="password"]')).toHaveAttribute('minlength', '12');
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await signIn(page);
  const beforeAccount = await read(page, '/account');
  const beforeFarm = await read(page, `/farms/${fixture.farm.id}`);
  const beforeRequest = await read(page, `/requests/${fixture.request.id}`);

  await expect(page.getByRole('combobox', { name: /language/i })).toHaveCount(0);
  await page.locator('.account-menu > summary').click();
  await page.getByRole('link', { name: 'Account and settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: /language/i })).toHaveCount(0);
  await expect(page.getByText('Some translated interface labels are still drafts.', { exact: true })).toHaveCount(0);
  const initialPreferences = {
    language: beforeAccount.data.language,
    country: await page.getByLabel('Default country', { exact: true }).inputValue() || null,
    region: await page.getByLabel('Default region', { exact: true }).inputValue() || null,
    reporting_year: Number(await page.getByLabel('Default reporting year', { exact: true }).inputValue()),
    notifications: await page.getByRole('checkbox', { name: 'Show workspace notifications', exact: true }).isChecked(),
  };
  const savedPreferences = { language: beforeAccount.data.language, country: 'NL', region: 'FICTIONAL saved region', reporting_year: 2199, notifications: true };
  const savedAccount = await savePreferences(page, savedPreferences, beforeAccount.revision);
  expect(await read(page, '/account')).toEqual({ ...beforeAccount, ...savedAccount });
  await fillPreferences(page, { country: 'BE', region: 'FICTIONAL unsaved region', reporting_year: 2200, notifications: false });
  expect(await read(page, '/account')).toEqual({ ...beforeAccount, ...savedAccount });
  await page.reload();
  await expect(page.getByLabel('Default region', { exact: true })).toHaveValue(savedPreferences.region);
  await expect(page.getByRole('combobox', { name: /language/i })).toHaveCount(0);
  expect((await read(page, '/account')).data.language).toBe(beforeAccount.data.language);
  await expect(page.getByLabel('Default country', { exact: true })).toHaveValue(savedPreferences.country);
  await expect(page.getByLabel('Default reporting year', { exact: true })).toHaveValue(String(savedPreferences.reporting_year));
  await expect(page.getByRole('checkbox', { name: 'Show workspace notifications', exact: true })).toBeChecked();
  // Restore all original visible preferences, retaining the real revision history.
  const restoredPreferences = await savePreferences(page, initialPreferences, savedAccount.revision);
  const restoredAccount = { ...beforeAccount, ...restoredPreferences };
  expect(await read(page, '/account')).toEqual(restoredAccount);

  await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('link', { name: /^Tools\b/ }).click();
  await expect(page.getByRole('heading', { name: 'Farm tools', exact: true })).toBeVisible();
  const toolPaths = ['fields', 'record-work', 'documents', 'imports', 'satellite', 'easy-form', 'paperwork', 'cases', 'tasks', 'checks', 'reports', 'connections', 'guidance', 'updates', 'funding', 'adviser', 'community', 'help', 'assistant/connect', 'demo', 'examples', 'settings'];
  const tools = page.locator('main .tools-index a');
  await expect(tools).toHaveCount(toolPaths.length);
  expect(await tools.evaluateAll(links => links.map(link => link.getAttribute('href')))).toEqual(toolPaths.map(path => `/app/${path}`));
  for (const path of toolPaths) {
    await page.locator('main').locator(`a[href="/app/${path}"]`).click();
    await expect(page).toHaveURL(url => url.pathname === `/app/${path}`);
    await expect(page.getByRole('heading', { name: 'This page could not open.', exact: true })).toHaveCount(0);
    await expect(page.locator('main pre')).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText(/\bFICTIONAL\b/);
    await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('link', { name: /^Tools\b/ }).click();
    await expect(page.getByRole('heading', { name: 'Farm tools', exact: true })).toBeVisible();
  }
  await page.locator('main').getByRole('link', { name: /^Forms and guidance\b/ }).click();
  await expect(page.getByRole('heading', { name: 'Guidance for your farm', exact: true })).toBeVisible();
  await page.getByLabel('Country', { exact: true }).selectOption('DE');
  await page.getByLabel('Reporting year', { exact: true }).fill('2026');
  const countryChoice = page.getByLabel('Country', { exact: true });
  await countryChoice.focus(); await countryChoice.press('ArrowDown'); await countryChoice.press('ArrowUp');
  await expect(countryChoice).toHaveValue('DE');
  const guide = page.getByRole('link', { name: /^Read guidance: Düngeportal NRW — Schlagbezogene Pflanzenschutzanwendungen/ });
  const guideHref = await guide.getAttribute('href');
  await guide.click();
  await expect(page).toHaveURL(url => url.pathname.startsWith('/app/guidance/') && url.searchParams.get('country') === 'DE' && url.searchParams.get('year') === '2026');
  await expect(page.getByRole('heading', { name: 'Information to gather', exact: true })).toBeVisible();
  await expect(page.getByText('Checklist and draft', { exact: true })).toBeVisible();
  await expect(page.getByText('Applicator full name', { exact: true })).toBeVisible();
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); });
  await expect(page).toHaveURL(url => url.pathname + url.search === guideHref);
  const officialSources = page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Source documents', exact: true }) }).getByRole('link');
  expect(await officialSources.count()).toBeGreaterThan(0);
  for (const link of await officialSources.all()) expect(await link.getAttribute('href')).toMatch(/^https:\/\//);
  await expect(page.locator('main pre')).toHaveCount(0);
  await page.getByRole('link', { name: 'All guidance', exact: true }).click();
  await expect(countryChoice).toHaveValue('DE');
  const unavailableYear = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/v1/packs' && url.searchParams.get('country') === 'DE' && url.searchParams.get('year') === '2199' && response.request().method() === 'GET';
  });
  await page.getByLabel('Reporting year', { exact: true }).fill('2199');
  const unavailableResponse = await unavailableYear;
  expect(unavailableResponse.ok()).toBeTruthy();
  expect((await unavailableResponse.json()).items).toEqual([]);
  await expect(page.getByRole('link', { name: /^Read guidance: Düngeportal NRW — Schlagbezogene Pflanzenschutzanwendungen/ })).toHaveCount(0);
  // Common dossiers also declare the 2026 edition; none may masquerade as 2199 guidance.
  await expect(page.getByText('No guidance is available for these choices. Try another topic or year.', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Read guidance:/ })).toHaveCount(0);
  await page.getByLabel('Reporting year', { exact: true }).fill('3000');
  await expect(page.getByText('Enter a reporting year from 1900 to 2200.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Reporting year', { exact: true })).toBeEditable();
  await page.getByLabel('Reporting year', { exact: true }).fill('2026');
  for (const title of ['Farm records', 'Inspection evidence', 'Aid application evidence', 'Inputs and treatment evidence', 'Environmental and scheme evidence']) {
    await expect(page.getByRole('link', { name: `Read guidance: ${title}`, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('heading', { name: 'Information to gather', exact: true })).toHaveCount(0);

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

test('page controls: assistant instructions never bypass farm consent or human review', async ({ page }) => {
  test.skip(!account, 'Requires the shared fictional owner browser fixture.');
  test.setTimeout(120_000);
  const safety = await readOnlyBrowser(page, { assistantControls: true });
  await signIn(page);
  await page.goto('/app/help');
  await expect(page.getByRole('link', { name: 'Get the instruction for my assistant', exact: true })).toHaveAttribute('href', '/app/assistant/connect');
  const footerConnection = page.locator('footer.workspace-footer').getByRole('link', { name: 'Connect an AI assistant', exact: true });
  await expect(footerConnection).toHaveAttribute('href', '/app/assistant/connect');
  await footerConnection.click();
  await expect(page).toHaveURL(/\/app\/assistant\/connect$/);
  await expect(page.getByRole('dialog', { name: 'Connect an AI assistant', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Use your own assistant', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reload granted access', exact: true })).toBeEnabled();
  const initialConnections = await read(page, '/assistant/oauth/connections');
  await page.getByRole('button', { name: 'Copy instruction', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: /Instruction copied\.|Your browser could not copy the instruction\./ })).toBeVisible();
  await page.getByText('Read or copy the instruction yourself', { exact: true }).click();
  const instruction = await page.getByLabel('Instruction for your assistant', { exact: true }).inputValue();
  expect(instruction).toContain(`${new URL(page.url()).origin}/app`);
  expect(instruction).toContain('one question at a time'); expect(instruction).toContain('only after I choose the farms and permissions');
  expect(instruction).toContain('Do not confirm records, approve reports, send or file anything for me.');
  expect(instruction).not.toMatch(/password=|access_token=|request=|code=/);
  expect(await read(page, '/assistant/oauth/connections')).toEqual(initialConnections);
  await page.getByText('Connection setup and compatibility', { exact: true }).click();
  const config = await read(page, '/assistant/oauth/config');
  if (config.available) {
    await expect(page.getByLabel('MCP server address', { exact: true })).toHaveValue(config.resource);
    await page.getByLabel('Your assistant', { exact: true }).selectOption('claude');
    await expect(page.getByRole('link', { name: 'Open Claude', exact: true })).toHaveAttribute('href', 'https://claude.ai/');
    await page.getByLabel('Your assistant', { exact: true }).selectOption('chatgpt');
    await expect(page.getByRole('link', { name: 'Open ChatGPT', exact: true })).toHaveAttribute('href', 'https://chatgpt.com/');
    await page.getByRole('button', { name: 'Copy server address', exact: true }).click();
    await expect(page.getByText(/Connection address copied\.|Select and copy the server address shown below\./)).toBeVisible();
  } else {
    await expect(page.getByText(/The remote connection is not available on this installation\./)).toBeVisible();
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
  if (config.available && fixture.oauth_registration) {
    const { client_id: clientId, callback } = fixture.oauth_registration;
    const beforeFarm = await read(page, `/farms/${fixture.farm.id}`);
    const beforeRequest = await read(page, `/requests/${fixture.request.id}`);
    async function beginConsent(state) {
      const challenge = createHash('sha256').update('browser-acceptance-verifier-for-local-consent-only-0123456789').digest('base64url');
      const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: callback, code_challenge: challenge, code_challenge_method: 'S256', scope: 'farm:read farm:propose offline_access', resource: config.resource, state });
      await page.goto(`/api/v1/assistant/oauth/authorize?${query}`);
      await expect(page.getByRole('heading', { name: 'Choose what your assistant can access', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Allow selected farm access', exact: true })).toBeDisabled();
      await expect(page.getByRole('checkbox', { name: /Also stage facts/ })).not.toBeChecked();
      await expect(page.getByRole('checkbox', { name: /Keep this connection available/ })).not.toBeChecked();
    }
    await beginConsent('browser-declined-local-only');
    await page.getByRole('button', { name: 'Decline connection', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Local connector callback', exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('error')).toBe('access_denied');
    expect(new URL(page.url()).searchParams.has('code')).toBe(false);
    expect((await read(page, '/assistant/oauth/connections')).total).toBe(initialConnections.total);
    await beginConsent('browser-selected-local-only');
    const farmChoice = page.getByRole('checkbox', { name: fixture.farm.data.name, exact: true });
    await farmChoice.check();
    const allow = page.getByRole('button', { name: 'Allow selected farm access', exact: true });
    await expect(allow).toBeDisabled();
    await page.getByRole('checkbox', { name: 'I want the selected farm information returned to this assistant when it uses these tools. I have checked the callback domain and permissions.', exact: true }).check();
    await expect(allow).toBeEnabled();
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); });
    await page.waitForLoadState('networkidle'); await expect(farmChoice).toBeChecked();
    await allow.click();
    await expect(page.getByRole('heading', { name: 'Local connector callback', exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('state')).toBe('browser-selected-local-only');
    expect(new URL(page.url()).searchParams.has('code')).toBe(true);
    const connections = await read(page, '/assistant/oauth/connections');
    const granted = connections.items.find(item => item.data.client_id === clientId && !item.data.revoked_at);
    expect(granted).toBeTruthy(); expect(granted.data.farm_ids).toEqual([fixture.farm.id]);
    expect(granted.data.permissions).toEqual(['read']); expect(granted.data.last_issued_at ?? null).toBeNull();
    await page.goto('/app/assistant/connect');
    const connection = page.locator('article.panel').filter({ has: page.getByRole('heading', { name: granted.data.client_name, exact: true }) });
    await connection.getByRole('button', { name: 'Revoke this connection', exact: true }).click();
    await expect(connection.getByText('Revoked', { exact: true })).toBeVisible();
    expect((await read(page, '/assistant/oauth/connections')).items.find(item => item.id === granted.id).data.revoked_at).toBeTruthy();
    expect(await read(page, `/farms/${fixture.farm.id}`)).toEqual(beforeFarm);
    expect(await read(page, `/requests/${fixture.request.id}`)).toEqual(beforeRequest);
  }
  expect(safety).toEqual({ errors: [], external: [], writes: [] });
});
