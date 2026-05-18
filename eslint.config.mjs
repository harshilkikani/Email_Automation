// Flat config — minimal, opinionated, focused on real bugs not style.
//
// Why minimal: this repo is small, types catch most issues, and Prettier-style
// debates aren't where we want our review budget to go. Rules below catch
// classes of mistake the type system can't.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.vite/**',
      '**/coverage/**',
      'docs/_design/**',
      'packages/db/migrations/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      /* Types catch most type issues already, but these surface real bugs. */
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'off', // intentional casts at type boundaries
      '@typescript-eslint/no-non-null-assertion': 'off', // ! is fine when the invariant is obvious
      '@typescript-eslint/no-empty-object-type': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-console': 'off', // seed.ts / startup logging uses console intentionally
      'no-debugger': 'error',
      'no-template-curly-in-string': 'warn',
      'prefer-const': 'warn',
      'no-var': 'error',
      'eqeqeq': ['error', 'smart'],
    },
  },
  {
    /* Test files have looser rules. */
    files: ['**/test/**/*.ts', '**/*.test.ts', 'apps/server/integration/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
