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

test('settings card edits the allowlist and the system message language', async ({ page }) => {
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
  // 方案 A：平时没有输入框，点「Add number」才展开一行
  const openAdd = () => card.getByRole('button', { name: 'Add number' }).click();
  const addField = () => card.getByRole('textbox');

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
    // 已有号码渲染成 chip（不是输入框）：号码可见 + 恰好一个删除按钮
    await expect(card).toContainText(PHONE);
    await expect(card.getByRole('button', { name: 'Remove' })).toHaveCount(1);
    await expect(card.getByRole('textbox')).toHaveCount(0);
    await expect(save).toBeDisabled();
    mark('settings opened, values prefilled');
  });

  await test.step('saving the allowlist persists it and hot-updates the channel', async () => {
    await openAdd();
    await addField().fill(PHONE_2);
    await card.getByRole('button', { name: 'Add', exact: true }).click();
    // 输入行收起，新号码以 chip 出现（两个条目两个删除按钮）
    await expect(card.getByRole('textbox')).toHaveCount(0);
    await expect(card).toContainText(PHONE_2);
    await expect(card.getByRole('button', { name: 'Remove' })).toHaveCount(2);
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

  await test.step('closing the dialog without saving discards edits', async () => {
    // 真机 bug 回归：删 chip 不保存就关设置页，重开必须看到已保存值
    await card.getByRole('button', { name: 'Remove' }).first().click();
    await expect(card.getByRole('button', { name: 'Remove' })).toHaveCount(1);

    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
    await expect(card).toHaveCount(0);
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'iMessage', exact: true }).click();

    await expect(card.getByRole('button', { name: 'Remove' })).toHaveCount(2);
    await expect(save).toBeDisabled();
    mark('reopen discards unsaved deletion');
  });

  await test.step('saving the reply language persists locale=en', async () => {
    await card.getByRole('combobox').selectOption('en');
    await expect(save).toBeEnabled();
    await save.click();

    await expect.poll(() => host.readPatch(), { timeout: 15_000 }).toMatch(/locale:\s*en/u);
    mark('locale saved');
  });

  await test.step('chunked replies toggle persists the style fields', async () => {
    // 默认关：只有开关，没有数字输入
    const toggle = card.locator('input[type="checkbox"]');
    await expect(toggle).not.toBeChecked();
    await expect(card.getByRole('spinbutton')).toHaveCount(0);

    // 开启后出现两个子输入；改值保存
    await toggle.check();
    await expect(card.getByRole('spinbutton')).toHaveCount(2);
    await card.getByLabel('Max chunks').fill('5');
    await card.getByLabel('Delay factor').fill('0');
    await save.click();

    await expect.poll(() => host.readPatch(), { timeout: 15_000 })
      .toMatch(/chunkedReplies:\s*true/u);
    await expect.poll(() => host.readPatch(), { timeout: 15_000 })
      .toMatch(/maxChunks:\s*5/u);
    await expect.poll(() => host.readPatch(), { timeout: 15_000 })
      .toMatch(/delayFactor:\s*0/u);
  });

  await test.step('an invalid style field blocks the save', async () => {
    // type=number 的输入框拒收非数字文本：走原生 setter + input 事件
    // 把 'abc' 塞进 React 状态（真机里 IME/脚本路径也会产生这种草稿）
    const field = card.getByLabel('Max chunks');
    await field.evaluate((node) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(node, 'abc');
      node.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await expect(card.getByText('Must be an integer between 1 and 50')).toBeVisible();
    await expect(save).toBeDisabled();

    // 修好后恢复
    await field.fill('8');
    await expect(save).toBeEnabled();
  });

  await test.step('an invalid number shows red validation and blocks adding and saving', async () => {
    await openAdd();
    await addField().fill('not-a-number');

    // 红色校验文案出现在输入框下面
    await expect(card.getByText('Not a valid phone number')).toBeVisible();
    await expect(addField()).toHaveAttribute('aria-invalid', 'true');
    await expect(save).toBeDisabled();

    // 确认添加也不入列（列表里不出现非法文本）
    await card.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(card).not.toContainText('not-a-number');
    // 输入行保持打开，修好后即可恢复
    await addField().fill(PHONE);
    await expect(card.getByText('Not a valid phone number')).toHaveCount(0);
    await card.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(card).not.toContainText('Not a valid phone number');
    mark('invalid input rejected');
  });
});
