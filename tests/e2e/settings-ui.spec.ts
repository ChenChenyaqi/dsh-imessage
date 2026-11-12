// Real-machine e2e: the iMessage settings card, end to end.
//
// One test with steps instead of five tests: each page.goto() reloads the whole
// DSH client (~5s), so a single navigation keeps the suite fast while
// test.step() still reports exactly which stage failed.
//
// Environment isolation and cleanup live in support/host.ts.

import { expect, test } from '@playwright/test';

import { startHost, type HostRun } from './support/host';

/** The boot manifest the web shell exposes (only the field we assert on). */
declare global {
  interface Window {
    __DSH_BOOT__?: { entries?: ReadonlyArray<{ id: string }> };
  }
}

const PHONE = '+8613800000000';
const PHONE_2 = '+8613900000000';

let host: HostRun;

test.beforeAll(async () => {
  host = await startHost({ allowlist: [PHONE] });
});

test.afterAll(async () => {
  // Runs whether assertions passed or not: kill the process group, delete DSH_HOME.
  await host?.stop();
});

/** Dismiss first-run gates (Preview Notice / Get started) without pinning
 *  DSH's internal notice version: click whatever dismiss control exists. */
async function dismissGates(page: import('@playwright/test').Page): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await page.locator('[role="dialog"]').count() === 0) return;
    const dismiss = page
      .getByRole('button', { name: 'Continue' })
      .or(page.getByRole('button', { name: 'Close' }));
    if (await dismiss.first().isVisible().catch(() => false)) {
      await dismiss.first().click({ timeout: 2000 }).catch(() => undefined);
      continue;
    }
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(200);
  }
}

const t0 = Date.now();
/** Step-level timing so a slow stage is visible in CI logs. */
const mark = (label: string): void => {
  console.log(`[e2e +${((Date.now() - t0) / 1000).toFixed(1)}s] ${label}`);
};

test('settings card edits the allowlist and the reply language', async ({ page }) => {
  await test.step('client half boots without activation failures', async () => {
    await page.goto(host.url);
    const booted = await page.evaluate(() =>
      window.__DSH_BOOT__?.entries?.some((row) => row.id === '@chenyaqi/dsh-imessage') ?? false);
    expect(booted, 'client row missing from the boot manifest').toBe(true);
    await expect(page.getByText('did not activate')).toHaveCount(0);
    mark('boot ok');
  });

  const card = page.locator('[data-dsh-imessage-card]');
  const save = card.getByRole('button', { name: 'Save' });
  const textarea = card.getByRole('textbox');

  await test.step('settings dialog exposes the iMessage section with host values', async () => {
    // An isolated DSH_HOME is signed out, so first-run gates appear.
    // They are dismissed by their own controls; none may survive.
    await dismissGates(page);
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Account menu' }).click({ timeout: 10_000 });
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'iMessage', exact: true }).click();

    await expect(card).toBeVisible();
    await expect(card.getByRole('combobox')).toHaveValue('zh');
    await expect(textarea).toHaveValue(PHONE);
    await expect(save).toBeDisabled();
    mark('settings opened, values prefilled');
  });

  await test.step('saving the allowlist persists it and hot-updates the channel', async () => {
    await textarea.fill(`${PHONE}\n${PHONE_2}`);
    await expect(save).toBeEnabled();
    await save.click();

    await expect.poll(() => host.readPatch(), { timeout: 15_000 }).toContain(PHONE_2);
    await expect.poll(
      () => host.readLog().some((row) => row.event === 'channel.config-updated'),
      { timeout: 15_000 },
    ).toBe(true);
    await expect(save).toBeDisabled();
    mark('allowlist saved');
  });

  await test.step('saving the reply language persists locale=en', async () => {
    await card.getByRole('combobox').selectOption('en');
    await expect(save).toBeEnabled();
    await save.click();

    await expect.poll(() => host.readPatch(), { timeout: 15_000 }).toMatch(/locale:\s*en/u);
    mark('locale saved');
  });

  await test.step('an unparseable number blocks the save', async () => {
    await textarea.fill('not-a-number');

    await expect(textarea).toHaveAttribute('aria-invalid', 'true');
    await expect(save).toBeDisabled();
    await expect(card.getByText('Some numbers cannot be parsed')).toBeVisible();
    mark('invalid input rejected');
  });
});
