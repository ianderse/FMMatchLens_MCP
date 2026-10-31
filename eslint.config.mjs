import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['node_modules/**', 'vendor/**', 'scripts/audit/**', 'audit-output/**', 'schemas/**', 'packages/fmlens-adapter/src/upstream/**', 'tests/fixtures/**', '.fmmi/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.mts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },
)
