import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { renderIssueReference } from '../../src/render/issue-ref'

/**
 * `renderIssueReference` is a pure string-in/string-out function with a small,
 * fully enumerable branch set, so the suite is a table over those branches plus
 * the two things that are easy to get wrong: the exact output bytes, which
 * GitHub's closing-keyword parser reads, and regex state, which the caller owns.
 */

/** The `branch-pattern` default from `action.yml`, verbatim. */
const DEFAULT_PATTERN = /^(\d+)-/

interface Case {
  rule: string
  branch: string
  pattern: RegExp
  expected: string | null
}

const CASES: readonly Case[] = [
  {
    rule: 'the documented convention renders the issue number',
    branch: '142-fix-auth',
    pattern: DEFAULT_PATTERN,
    expected: 'Closes #142',
  },
  {
    rule: 'leading zeros are stripped, because GitHub does not carry them',
    branch: '042-fix-auth',
    pattern: DEFAULT_PATTERN,
    expected: 'Closes #42',
  },
  {
    rule: 'a single-digit number needs no normalization',
    branch: '7-thing',
    pattern: DEFAULT_PATTERN,
    expected: 'Closes #7',
  },
  {
    rule: 'the default branch does not match',
    branch: 'main',
    pattern: DEFAULT_PATTERN,
    expected: null,
  },
  {
    rule: 'a conventional branch without a number does not match',
    branch: 'feature/foo',
    pattern: DEFAULT_PATTERN,
    expected: null,
  },
  {
    rule: 'there is no issue #0',
    branch: '0-nope',
    pattern: DEFAULT_PATTERN,
    expected: null,
  },
  {
    rule: 'an all-zeros capture is zero however it is spelled',
    branch: '000-nope',
    pattern: DEFAULT_PATTERN,
    expected: null,
  },
  {
    rule: 'a custom pattern with the number in group 1 renders the same form',
    branch: 'feature/77-thing',
    pattern: /^(?:feature|fix)\/(\d+)-/,
    expected: 'Closes #77',
  },
  {
    rule: 'the same custom pattern still refuses a branch it does not match',
    branch: 'chore/77-thing',
    pattern: /^(?:feature|fix)\/(\d+)-/,
    expected: null,
  },
  {
    rule: 'a group that matched the empty string is not a number',
    branch: 'x-foo',
    pattern: /^(\d*)x/,
    expected: null,
  },
  {
    rule: 'a pattern with no capturing group at all yields nothing',
    branch: '142-fix-auth',
    pattern: /^\d+-/,
    expected: null,
  },
  {
    rule: 'a group capturing non-digits is refused rather than coerced',
    branch: 'abc-foo',
    pattern: /^(\w+)-/,
    expected: null,
  },
  {
    rule: 'a capture carrying whitespace is refused, not trimmed',
    branch: ' 42-foo',
    pattern: /^(\s*\d+)-/,
    expected: null,
  },
  {
    rule: 'non-ASCII digits are not issue numbers',
    // `\p{Nd}` matches Arabic-Indic digits; `#١٢` closes nothing on GitHub.
    branch: '١٢-foo',
    pattern: /^(\p{Nd}+)-/u,
    expected: null,
  },
  {
    rule: 'only the first capturing group is read',
    branch: 'fix-91-auth',
    pattern: /^(\d+|[a-z]+)-(\d+)-/,
    expected: null,
  },
  {
    rule: 'a number past 2^53 survives, because normalization is textual',
    branch: '9007199254740993-huge',
    pattern: DEFAULT_PATTERN,
    expected: 'Closes #9007199254740993',
  },
]

describe('renderIssueReference', () => {
  it.each(CASES)('$rule', ({ branch, pattern, expected }) => {
    expect(renderIssueReference(branch, pattern)).toBe(expected)
  })

  it('renders a bare line with no decoration and no surrounding whitespace', () => {
    // Pinned byte-for-byte: GitHub's closing-keyword parser has to see this
    // verbatim, so a list marker, bold, or a trailing period would break it.
    const line = renderIssueReference('142-fix-auth', DEFAULT_PATTERN)
    expect(line).toBe('Closes #142')
    expect(line).toBe(line?.trim())
    expect(line).not.toMatch(/[*_`\n.]/)
  })
})

describe('the branch name is data, never pattern', () => {
  it('does not interpret regex metacharacters in the branch name', () => {
    expect(renderIssueReference('(.*)+-foo', DEFAULT_PATTERN)).toBeNull()
    expect(renderIssueReference('.*', /^(\d+)-/)).toBeNull()
  })

  it('still renders when the metacharacters follow a valid number', () => {
    expect(renderIssueReference('7-fix-(.*)+[a-z]$', DEFAULT_PATTERN)).toBe('Closes #7')
  })
})

describe('regex state belongs to the caller', () => {
  it('answers identically on repeated calls with a global pattern', () => {
    // `exec` advances `lastIndex` on a /g pattern, so a naive implementation
    // returns the answer once and null forever after.
    const pattern = /(\d+)-/g
    expect(renderIssueReference('x142-fix', pattern)).toBe('Closes #142')
    expect(renderIssueReference('x142-fix', pattern)).toBe('Closes #142')
  })

  it('leaves the caller pattern untouched', () => {
    const pattern = /(\d+)-/g
    renderIssueReference('x142-fix', pattern)
    expect(pattern.lastIndex).toBe(0)
  })

  it('preserves a sticky pattern as anchored rather than searching', () => {
    // Dropping `y` to sidestep `lastIndex` would quietly match at index 1 here.
    expect(renderIssueReference('x7-fix', /(\d+)-/y)).toBeNull()
    expect(renderIssueReference('7-fix', /(\d+)-/y)).toBe('Closes #7')
  })
})

describe('configuration knowledge stays out of this module', () => {
  it('renders the line regardless of issue-link, which only the assembler reads', () => {
    // `issue-link: false` is honoured one level up: the block assembler omits
    // the line. There is no flag to pass here and none is accepted — the
    // `issue-link: false` + `footer: false` golden covers that path.
    expect(renderIssueReference.length).toBe(2)
    expect(renderIssueReference('142-fix-auth', DEFAULT_PATTERN)).toBe('Closes #142')
  })
})

describe('module boundaries', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../src/render/issue-ref.ts', import.meta.url)),
    'utf8',
  )

  it('reads the source it is asserting over', () => {
    // Guards the assertions below against an empty read passing vacuously.
    expect(source).toContain('export function renderIssueReference')
  })

  it.each(['@actions', 'src/github', "from '../github", 'octokit'])(
    'never mentions %s, as the pure render layer',
    (forbidden) => {
      expect(source).not.toContain(forbidden)
    },
  )

  it('imports nothing at all', () => {
    expect(source).not.toMatch(/^\s*import\b/m)
  })
})
