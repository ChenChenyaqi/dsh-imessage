// Playwright 配置：真机 e2e（设置页卡片）。
//
// 关键决定：用系统 Chrome（channel: 'chrome'），**不下载** Playwright 自带
// 浏览器——`pnpm install` 不会下载浏览器（该包没有安装脚本），只有显式
// `npx playwright install` 才会；我们连那一步都不需要。
//
// 串行执行：spec 共享一个隔离宿主（见 tests/e2e/support/host.ts）。

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    channel: 'chrome',
    headless: true,
    // 桌面布局：窄视口会切成移动端抽屉，设置入口完全不同
    viewport: { width: 1512, height: 945 },
    trace: 'retain-on-failure',
  },
});
