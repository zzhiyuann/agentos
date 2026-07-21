import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='require']",
          message: "This project is ESM — use 'import' or 'await import()' instead of 'require()'. See ~/.aos/shared-memory/esm-require-forbidden.md.",
        },
      ],
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
);
