import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    server: {
      deps: {
        // primitives 是浏览器包（import 了 CSS/katex）：内联交给 vite 处理，
        // 否则 node 直载会因 ".css" 扩展名报错。客户端组件测试需要真组件。
        inline: [/@deepseek-ai\/dsh-client-ui-primitives/],
      },
    },
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text-summary'],
    },
  },
});
