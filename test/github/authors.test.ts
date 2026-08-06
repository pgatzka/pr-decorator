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
    expected: '`Alice Liddell`',
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
    expected: '`dependabot[bot]`',
  },
  {
    rule: 'rule 3: web-flow falls back to the git author name',
    commit: commitBy({ name: 'Grace Hopper', login: 'web-flow' }),
    mentions: 'login',
    expected: '`Grace Hopper`',
  },
  {
    rule: 'rule 4: an unmatched commit falls back to the git author name',
    commit: commitBy({ name: 'Ada Lovelace', login: null }),
    mentions: 'login',
    expected: '`Ada Lovelace`',
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
      '`Ada Lovelace`',
    )
  })

  it('leaves a real login untouched, because logins need no escaping', () => {
    expect(resolveMention(commitBy({ name: 'x', login: 'octo-cat-99' }), 'login')).toBe(
      '@octo-cat-99',
    )
  })
})

describe('git name neutralization', () => {
  /** Renders `name` as the git author of an unmatched commit. */
  function render(name: string): string {
    return resolveMention(commitBy({ name, login: null }), 'login')
  }

  it('wraps the full attack name rather than escaping it', () => {
    // The escape this replaced was measured against live GitHub during #16 and
    // did not stop the closing-keyword pass. A code span does, and it is the
    // whole field that is wrapped, because that is the form the probe proved.
    expect(render('@everyone *pwned* | x')).toBe('`@everyone *pwned* | x`')
  })

  it.each([
    ['backslash', 'a\\b'],
    ['asterisk', 'a*b'],
    ['underscore', 'a_b'],
    ['open bracket', 'a[b'],
    ['close bracket', 'a]b'],
    ['less than', 'a<b'],
    ['greater than', 'a>b'],
    ['hash', 'a#b'],
    ['at sign', 'a@b'],
    ['pipe', 'a|b'],
  ])('carries a %s through untouched, inert inside the span', (_label, name) => {
    expect(render(name)).toBe('`' + name + '`')
  })

  it('adds no backslash of its own, for any input', () => {
    // The regression this guards: an escape creeping back in alongside the
    // wrapper would render a visible backslash, because inside a code span a
    // backslash is a literal backslash.
    expect(render('##')).toBe('`##`')
    expect(render('\\@')).toBe('`\\@`')
    expect(render('plain')).not.toContain('\\')
  })

  it('fences longer than any backtick run the name carries', () => {
    expect(render('a`b')).toBe('``a`b``')
    expect(render('`edge`')).toBe('`` `edge` ``')
  })

  it('defuses link and image syntax', () => {
    expect(render('[link](x)')).toBe('`[link](x)`')
    expect(render('![img](x)')).toBe('`![img](x)`')
  })

  it('defuses a mention that would notify an entire team', () => {
    const rendered = render('@org/team')
    expect(rendered).toBe('`@org/team`')
    // The `@` survives as text, so the reader still sees what was written.
    expect(rendered).toContain('@org/team')
  })

  it('defuses an issue reference that would close an unrelated issue', () => {
    expect(render('closes #12')).toBe('`closes #12`')
  })

  it('removes a literal managed-block marker outright', () => {
    // Wrapping is not enough here and never was: the block parser scans lines
    // rather than rendering markdown, so a marker inside a code span would still
    // terminate the block. It has to be gone, not merely inert.
    expect(render('Ada <!-- pr-decorator:end --> Lovelace')).toBe('`Ada  Lovelace`')

    const onlyMarker = render('<!-- pr-decorator:end -->')
    expect(onlyMarker).toBe(UNKNOWN_AUTHOR)
    expect(onlyMarker).not.toContain('pr-decorator')
  })

  it('collapses newlines so a name cannot inject a second bullet', () => {
    expect(render('Alice\n- pwned')).toBe('`Alice - pwned`')
    expect(render('Alice\r\nBob')).toBe('`Alice Bob`')
    expect(render('  Alice   B  ')).toBe('`Alice B`')
  })

  it('leaves the unknown literal unwrapped, so a real "unknown" is distinguishable', () => {
    expect(render('')).toBe(UNKNOWN_AUTHOR)
    expect(render('unknown')).toBe('`unknown`')
  })

  it('leaves ordinary names readable', () => {
    expect(render('Ada Lovelace')).toBe('`Ada Lovelace`')
    expect(render("Sinead O'Brien-Ng")).toBe("`Sinead O'Brien-Ng`")
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
