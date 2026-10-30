import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'sentiment-engine/**', 'test-results/**', 'playwright-report/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'no-restricted-properties': [
        'error',
        { property: 'innerHTML', message: 'Use the h() helper / textContent to avoid XSS.' },
        { property: 'outerHTML', message: 'Use the h() helper / textContent to avoid XSS.' },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "CallExpression[callee.property.name='insertAdjacentHTML']", message: 'Avoid raw HTML insertion.' },
      ],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: [
      'server/**/*.ts',
      'shared/**/*.ts',
      'scripts/**/*.mjs',
      'server/test/fixtures/*.mjs',
      '*.config.*',
      'e2e/**/*.{ts,mjs}',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    // Playwright fixtures must destructure their (unused) dependencies.
    files: ['e2e/**/*.ts'],
    rules: { 'no-empty-pattern': 'off' },
  },
  {
    files: ['web/src/**/*.ts'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['chrome-extension/**/*.js'],
    languageOptions: { globals: { ...globals.browser, ...globals.webextensions } },
  },
);
