import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import nextPlugin from '@next/eslint-plugin-next';

const noTypeScript = {
  'no-restricted-imports': ['error', {
    patterns: [{ group: ['*.ts', '*.tsx', 'typescript'], message: 'This project is JavaScript-only.' }],
  }],
};

export default [
  { ignores: ['**/node_modules/**', '**/.next/**', '**/.next-e2e/**', '**/dist/**', '**/coverage/**', '**/playwright-report/**', '**/test-results/**', '.local/**'] },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      ...noTypeScript,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['apps/web/**/*.{js,jsx}'],
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { 'react-hooks': reactHooks, '@next/next': nextPlugin },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
    },
    settings: { next: { rootDir: 'apps/web' } },
  },
  {
    // Desktop agent: the status window runs in a sandboxed browser context; the preload is CommonJS.
    files: ['apps/desktop-agent/src/renderer/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
  },
  {
    // Seeds and operational scripts print to the console by design.
    files: ['**/prisma/seed.js', 'scripts/**', 'infrastructure/**'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/tests/**', '**/*.test.{js,jsx}'],
    languageOptions: { globals: { ...globals.vitest } },
  },
];
