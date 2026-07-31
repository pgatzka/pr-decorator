import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { UNKNOWN_AUTHOR, resolveMention } from '../../src/github/authors'
import type { MentionStyle } from '../../src/types'
import { buildRawCommit, type RawCommit } from '../fixtures/commits'

/**
 * `resolveMention` is a pure lookup table over untrusted input, so the suite is
 * a table too: one case per resolution rule, then the escaping matrix. What is
 * being pinned down is the FINAL rendered string — the bullet renderer emits
 * this verbatim, so every expectation here is byte-for-byte and a change to any
 * of them is a change to the action's public output.
 */

/** A commit authored by a named identity, with or without a linked account. */
function commitBy(identity: { name?: string; login?: string | null }): RawCommit {
  return buildRawCommit({}, identity)
}

/** The rare commit whose object carries no git author trailer at all. */
function withoutGitAuthor(commit: RawCommit): RawCommit {
  return { ...commit, commit: { ...commit.commit, author: null } }
}

const LINKED = commitBy({ name: 'Alice Liddell', login: 'alice' })

interface Case {
  rule: string
  commit: RawCommit
  mentions: MentionStyle
  expected: string
}

const RULES: readonly Case[] = [
  {
    rule: 'rule 5: a matched account renders as @login',
    commit: LINKED,
    mentions: 'login',
    expected: '@alice',
  },
  {
    rule: 'rule 1: mentions=name overrides a perfectly good login',
    commit: LINKED,
    mentions: 'name',
    expected: 'Alice Liddell',
  },
  {
    rule: 'rule 2: a [bot] login renders as plain text with the brackets escaped',
    commit: commitBy({ name: 'dependabot[bot]', login: 'dependabot[bot]' }),
    mentions: 'login',
    expected: 'dependabot\\[bot\\]',
  },
  {
    rule: 'rule 2 defers to rule 1: a bot commit with mentions=name uses the git name',
    commit: commitBy({ name: 'dependabot[bot]', login: 'dependabot[bot]' }),
    mentions: 'name',
    expected: 'dependabot\\[bot\\]',
  },
  {
    rule: 'rule 3: web-flow falls back to the git author name',
    commit: commitBy({ name: 'Grace Hopper', login: 'web-flow' }),
    mentions: 'login',
    expected: 'Grace Hopper',
  },
  {
    rule: 'rule 4: an unmatched commit falls back to the git author name',
    commit: commitBy({ name: 'Ada Lovelace', login: null }),
    mentions: 'login',
    expected: 'Ada Lovelace',
  },
  {
    rule: 'rule 6: an unmatched commit with a blank git name renders the literal',
    commit: commitBy({ name: '', login: null }),
    mentions: 'login',
    expected: UNKNOWN_AUTHOR,
  },
  {
    rule: 'rule 6: a whitespace-only git name is blank once collapsed',
    commit: commitBy({ name: ' \t \n ', login: null }),
    mentions: 'login',
    expected: UNKNOWN_AUTHOR,
  },
  {
    rule: 'rule 6: a commit with no git author trailer at all renders the literal',
    commit: withoutGitAuthor(commitBy({ login: null })),
    mentions: 'login',
    expected: UNKNOWN_AUTHOR,
  },
  {
    rule: 'rule 6: mentions=name on a linked commit with no git trailer renders the literal',
    commit: withoutGitAuthor(LINKED),
    mentions: 'name',
    expected: UNKNOWN_AUTHOR,
  },
]

describe('resolveMention', () => {
  it.each(RULES)('$rule', ({ commit, mentions, expected }) => {
    expect(resolveMention(commit, mentions)).toBe(expected)
  })

  it('never prefixes an @ to a bot login', () => {
    const rendered = resolveMention(
      commitBy({ name: 'dependabot[bot]', login: 'dependabot[bot]' }),
      'login',
    )
    expect(rendered).not.toContain('@')
    // Escaped brackets are what the reader sees as `dependabot[bot]`; the raw
    // form must not be able to bind to a `[bot]: …` reference definition left
    // elsewhere in the body.
    expect(rendered).not.toContain('[bot]')
  })

  it('treats an empty login as no account rather than rendering a bare @', () => {
    expect(resolveMention(commitBy({ name: 'Ada Lovelace', login: '' }), 'login')).toBe(
      'Ada Lovelace',
    )
  })

  it('leaves a real login untouched, because logins need no escaping', () => {
    expect(resolveMention(commitBy({ name: 'x', login: 'octo-cat-99' }), 'login')).toBe(
      '@octo-cat-99',
    )
  })
})

describe('git name escaping', () => {
  /** Renders `name` as the git author of an unmatched commit. */
  function render(name: string): string {
    return resolveMention(commitBy({ name, login: null }), 'login')
  }

  it('escapes the full attack name byte for byte', () => {
    expect(render('@everyone *pwned* | x')).toBe('\\@everyone \\*pwned\\* \\| x')
  })

  it.each([
    ['backslash', 'a\\b', 'a\\\\b'],
    ['backtick', 'a`b', 'a\\`b'],
    ['asterisk', 'a*b', 'a\\*b'],
    ['underscore', 'a_b', 'a\\_b'],
    ['open bracket', 'a[b', 'a\\[b'],
    ['close bracket', 'a]b', 'a\\]b'],
    ['less than', 'a<b', 'a\\<b'],
    ['greater than', 'a>b', 'a\\>b'],
    ['hash', 'a#b', 'a\\#b'],
    ['at sign', 'a@b', 'a\\@b'],
    ['pipe', 'a|b', 'a\\|b'],
  ])('escapes a %s', (_label, name, expected) => {
    expect(render(name)).toBe(expected)
  })

  it('escapes each special character exactly once', () => {
    // The escaper runs in a single pass, so the backslash it inserts is never
    // fed back through the character class.
    expect(render('##')).toBe('\\#\\#')
    expect(render('\\@')).toBe('\\\\\\@')
  })

  it('defuses link and image syntax', () => {
    expect(render('[link](x)')).toBe('\\[link\\](x)')
    expect(render('![img](x)')).toBe('!\\[img\\](x)')
  })

  it('defuses a mention that would notify an entire team', () => {
    const rendered = render('@org/team')
    expect(rendered).toBe('\\@org/team')
    expect(rendered).not.toMatch(/(^|[^\\])@/)
  })

  it('defuses an issue reference that would cross-link', () => {
    expect(render('closes #12')).toBe('closes \\#12')
  })

  it('breaks a literal managed-block marker', () => {
    const rendered = render('<!-- pr-decorator:end -->')
    expect(rendered).toBe('\\<!-- pr-decorator:end --\\>')
    expect(rendered).not.toContain('<!-- pr-decorator:end -->')
  })

  it('collapses newlines so a name cannot inject a second bullet', () => {
    expect(render('Alice\n- pwned')).toBe('Alice - pwned')
    expect(render('Alice\r\nBob')).toBe('Alice Bob')
    expect(render('  Alice   B  ')).toBe('Alice B')
  })

  it('leaves ordinary names alone', () => {
    expect(render('Ada Lovelace')).toBe('Ada Lovelace')
    expect(render("Sinéad O'Brien-Ng")).toBe("Sinéad O'Brien-Ng")
  })
})

describe('module boundaries', () => {
  const sourceDir = new URL('../../src/', import.meta.url)

  /** Every TypeScript file under `src/`, as `[posix-style path, contents]`. */
  const sources = readdirSync(fileURLToPath(sourceDir), { recursive: true, encoding: 'utf8' })
    // Separators are normalized because the walk yields backslashes on Windows.
    .map((entry) => entry.replaceAll('\\', '/'))
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => [entry, readFileSync(new URL(entry, sourceDir), 'utf8')] as const)

  it('reads the src tree it is asserting over', () => {
    // Guards the two assertions below against a walk that quietly matches
    // nothing and passes for the wrong reason.
    expect(sources.map(([entry]) => entry)).toContain('github/authors.ts')
  })

  it.each(['search/users', 'search.users'])(
    'never reaches for %s anywhere in src (D3: no email-to-user lookups)',
    (forbidden) => {
      for (const [entry, source] of sources) {
        expect(source, entry).not.toContain(forbidden)
      }
    },
  )

  it('resolves mentions without the Actions toolkit', () => {
    const source = readFileSync(new URL('github/authors.ts', sourceDir), 'utf8')
    expect(source).not.toContain('@actions')
  })
})
