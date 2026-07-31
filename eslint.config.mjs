import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['dist/', 'coverage/', 'node_modules/'],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
  },
  {
    // Hard layering rule: src/render/** is a pure markdown layer. It renders from
    // plain data structures only, which is what keeps the golden-file tests free of
    // HTTP fixtures. Any import of the GitHub API — the client wrapper in
    // src/github/ or @actions/github itself — breaks that and fails CI here rather
    // than in review.
    files: ['src/render/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@actions/github', '@actions/github/*'],
              message:
                'src/render/** is a pure render layer and must not import @actions/github.',
            },
            {
              // Relative specifiers climbing into src/github/, plus any absolute
              // one naming it. Deliberately does not match the bare package
              // '@actions/github' — the group above owns that message.
              regex: String.raw`^(\.{1,2}\/)+github(\/|$)|(^|\/)src\/github(\/|$)`,
              message:
                'src/render/** is a pure render layer and must not import from src/github/.',
            },
          ],
        },
      ],
    },
  },
)
