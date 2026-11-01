import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.typecheck/**', '**/coverage/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['apps/mcp-server/src/**/*.ts'],
    rules: { 'no-console': 'error' },
  },
);
