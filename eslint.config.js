import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/', 'data/', 'node_modules/', 'playwright-report/', 'test-results/', '.venv/', 'ingest/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    // The data layer is pure: no three.js, no DOM-bound scene code.
    files: ['src/data/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['three', 'three/*', '../scene/*', 'postprocessing'],
              message: 'src/data must stay pure (no three.js).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['*.config.{js,ts}', 'scripts/**/*.mjs', 'tests/e2e/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  prettier,
);
