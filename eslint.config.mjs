// @ts-check
import eslint from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettierConfig from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['lib/', 'node_modules/', 'scripts/']),
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  // 关掉与 prettier 冲突的格式规则（必须排在推荐配置之后）
  prettierConfig,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
