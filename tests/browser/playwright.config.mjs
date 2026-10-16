import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.FUNKYFARM_BROWSER_URL;
if (!baseURL || !['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname)) {
  throw new Error('FUNKYFARM_BROWSER_URL must name the isolated local test app.');
}

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.mjs',
  grep: process.env.FUNKYFARM_BROWSER_GREP ? new RegExp(process.env.FUNKYFARM_BROWSER_GREP) : undefined,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: process.env.FUNKYFARM_BROWSER_OUTPUT || '../../runtime/browser-results',
  reporter: [['list'], ['junit', { outputFile: process.env.FUNKYFARM_BROWSER_JUNIT || '../../runtime/browser.xml' }]],
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    actionTimeout: 15_000,
    navigationTimeout: 20_000,
    reducedMotion: 'reduce',
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
  },
});
