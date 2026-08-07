import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Flat ESLint configuration for the whole monorepo.
 *
 * Formatting is prettier's job (`eslint-config-prettier` turns the overlapping
 * rules off), and type errors are `tsc --noEmit`'s job, so this configuration
 * concentrates on the things neither of them catches.
 */
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '.devcontext/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      'no-console': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': ['error', { destructuring: 'all' }],
      'no-var': 'error',
      'object-shorthand': ['error', 'properties'],
      'no-implicit-coercion': ['error', { boolean: false }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },

  // The CLI: Node, and the only place that may write to stdout/stderr directly.
  {
    files: ['cli/**/*.ts', 'cli/bin/*.js'],
    languageOptions: {
      globals: globals.node,
    },
  },

  // Tests may reach for shortcuts that production code should not.
  {
    files: ['cli/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },

  // The web viewer: browser globals plus the rules of hooks.
  {
    files: ['web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },

  // Build tooling runs in Node.
  {
    files: ['**/*.config.{js,ts}', 'web/vite.config.ts', 'cli/vitest.config.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },

  prettier,
);
