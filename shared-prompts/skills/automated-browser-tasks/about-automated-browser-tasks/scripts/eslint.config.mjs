/**
 * ESLint flat config for automation scripts.
 *
 * Scope: mechanical correctness only — unused vars, missing awaits, undeclared
 * globals, obvious foot-guns. The *conventions* (decomposition, doc-blocks,
 * destructuring, no self-validation, logger usage) are enforced by the skill
 * instructions and review, NOT by lint rules; do not try to encode them here.
 *
 * Usage (from a project that has eslint installed):
 *   npx eslint --config <this-file> <scriptsDir> <examplesDir>
 *
 * Requires: eslint >= 9 (flat config). No plugins needed.
 */

export default [
  {
    files: ['**/*.mjs'],
    // Templates are LiquidJS, not valid JS until compiled by sous.
    ignores: ['**/*.tpl.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        // Node globals scripts and the harness rely on.
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        __dirname: 'readonly',
      },
    },
    rules: {
      // Catch real bugs.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-self-assign': 'error',
      'require-await': 'warn',
      'no-return-await': 'warn',

      // Async foot-guns: a forgotten await on a Playwright call is the most
      // common scripting mistake.
      'no-async-promise-executor': 'error',
      'no-await-in-loop': 'off', // sequential page steps legitimately await in loops

      // Style nudges that aid debugging without dictating structure.
      'prefer-const': 'warn',
      'no-var': 'error',
      eqeqeq: ['warn', 'smart'],
    },
  },
];
