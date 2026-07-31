import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { END_MARKER, SKIP_MARKER, START_MARKER } from '../../src/body/markers'
import {
  renderCommitBullet,
  renderCommits,
  type CommitBulletOptions,
  type CommitSectionOptions,
} from '../../src/render/commits'
import type { RenderableCommit } from '../../src/types'
import { buildCommit, buildCommits, nonMonotonicCommits } from '../fixtures/commits'

/**
 * The rendered markdown is a public contract — it lands in a pull request body and
 * GitHub, not this suite, has the last word on how it reads — so the primary test
 * is a byte-for-byte comparison against golden files. The unit tests below the
 * goldens cover the things a golden cannot show: that a rule holds for inputs other
 * than the one that was captured, and that the separator really is an em dash
 * rather than something that merely looks like one in a diff.
 *
 * Goldens are stored WITHOUT a trailing newline, because the section has none: how
 * it is spaced against the rest of the block is the assembler's decision, and a
 * golden that carried a newline the renderer does not emit would hide that.
 */

const GOLDEN_DIR = fileURLToPath(new URL('../golden/commits/', import.meta.url))

function golden(name: string): string {
  return readFileSync(join(GOLDEN_DIR, `${name}.md`), 'utf8')
}

/** The reference options: base repo `pgatzka/pr-decorator`, Berlin time. */
const RENDER_OPTIONS: CommitBulletOptions = {
  timeZone: 'Europe/Berlin',
  commitUrlBase: 'https://github.com/pgatzka/pr-decorator/commit',
}

function sectionOptions(counts: Partial<CommitSectionOptions>): CommitSectionOptions {
  return { ...RENDER_OPTIONS, totalCount: 1, returnedCount: 1, ...counts }
}

/** The two commits the issue's reference output is rendered from. */
const REFERENCE_COMMITS = buildCommits([
  {
    fullSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    // 07:14Z is 09:14 in Berlin, which is on CEST in July.
    authoredAt: new Date('2026-07-28T07:14:00.000Z'),
    mention: '@alice',
    subject: 'feat(auth): rotate refresh tokens',
  },
  {
    fullSha: 'e4f5a6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d',
    authoredAt: new Date('2026-07-28T09:02:00.000Z'),
    mention: '@bob',
    subject: 'test(auth): cover expiry edge case',
  },
])

/** One commit carrying `subject`, on the fixture's default SHA, author and date. */
function commitWithSubject(subject: string): RenderableCommit[] {
  return buildCommits([{ subject }])
}

/** The line at `index`, or a failure — never an `undefined` that passes quietly. */
function lineAt(text: string, index: number): string {
  const line = text.split('\n')[index]
  if (line === undefined) {
    throw new Error(`no line ${index} in:\n${text}`)
  }
  return line
}

/** The four fields of one bullet, with the leading list marker removed. */
function fieldsOf(bullet: string): (string | undefined)[] {
  return bullet.replace(/^- /, '').split(' — ')
}

interface GoldenCase {
  rule: string
  file: string
  commits: readonly RenderableCommit[]
  options: CommitSectionOptions
}

const GOLDEN_CASES: readonly GoldenCase[] = [
  {
    rule: 'the reference output renders byte-for-byte',
    file: 'two-commits',
    commits: REFERENCE_COMMITS,
    options: sectionOptions({ totalCount: 2, returnedCount: 2 }),
  },
  {
    rule: 'an issue reference in a subject is escaped and closes nothing',
    file: 'subject-issue-reference',
    commits: commitWithSubject('fix: stop the crash, fixes #12 for good'),
    options: sectionOptions({}),
  },
  {
    rule: 'a team mention in a subject is escaped and notifies nobody',
    file: 'subject-team-mention',
    commits: commitWithSubject('chore: hand ownership to @org/team'),
    options: sectionOptions({}),
  },
  {
    rule: 'marker text in a subject is removed outright',
    file: 'subject-marker',
    commits: commitWithSubject(`feat: stop decorating ${END_MARKER} and move on`),
    options: sectionOptions({}),
  },
  {
    rule: 'a multi-line message renders its first line only',
    file: 'multiline-subject',
    commits: commitWithSubject(
      'feat: add the parser\n\nA longer body explaining why, mentioning #99 and @nobody.\n',
    ),
    options: sectionOptions({}),
  },
  {
    rule: 'an already-escaped mention is emitted verbatim',
    file: 'escaped-mention',
    commits: buildCommits([
      { mention: 'dependabot\\[bot\\]', subject: 'chore(deps): bump vitest from 3.0.0 to 3.1.0' },
    ]),
    options: sectionOptions({}),
  },
  {
    rule: 'non-monotonic author dates render in input order',
    file: 'non-monotonic-order',
    commits: nonMonotonicCommits,
    options: sectionOptions({ totalCount: 4, returnedCount: 4 }),
  },
  {
    rule: 'an empty list renders the heading plus an explicit line',
    file: 'empty',
    commits: [],
    options: sectionOptions({ totalCount: 0, returnedCount: 0 }),
  },
  {
    rule: 'a dropped-commit overflow closes the section',
    file: 'overflow',
    commits: REFERENCE_COMMITS,
    options: sectionOptions({ totalCount: 5, returnedCount: 5, overflowCount: 3 }),
  },
  {
    rule: 'commits hidden by the API ceiling are announced above the list',
    file: 'truncated',
    commits: REFERENCE_COMMITS,
    options: sectionOptions({ totalCount: 312, returnedCount: 2 }),
  },
]

describe('golden files', () => {
  it.each(GOLDEN_CASES)('$rule', ({ file, commits, options }) => {
    expect(renderCommits(commits, options)).toBe(golden(file))
  })

  it('covers every golden on disk, so an orphaned file cannot rot unnoticed', () => {
    const onDisk = readdirSync(GOLDEN_DIR).sort()
    const covered = GOLDEN_CASES.map((testCase) => `${testCase.file}.md`).sort()
    expect(onDisk).toEqual(covered)
  })

  it.each(GOLDEN_CASES)('$rule — stored with LF and no trailing newline', ({ file }) => {
    const text = golden(file)
    expect(text).not.toContain('\r')
    expect(text.endsWith('\n')).toBe(false)
  })
})

describe('the reference output, field by field', () => {
  const section = renderCommits(
    REFERENCE_COMMITS,
    sectionOptions({ totalCount: 2, returnedCount: 2 }),
  )
  const line = lineAt(section, 2)

  it('separates the four fields with an em dash, U+2014', () => {
    // A hyphen or an en dash would look almost identical in a diff and would be a
    // silent change to a published format.
    expect(line.match(/\u2014/g)).toHaveLength(3)
    expect(line).not.toMatch(/\u2013|\s-\s/)
  })

  it('renders the timestamp in the configured zone, zero-padded', () => {
    expect(line.startsWith('- 2026-07-28 09:14 ')).toBe(true)
  })

  it('links a 7-character code span at the full 40-character SHA', () => {
    expect(line).toContain(
      '[`a1b2c3d`](https://github.com/pgatzka/pr-decorator/commit/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678)',
    )
  })

  it('leaves exactly one blank line under the heading and none at the end', () => {
    expect(section.split('\n').slice(0, 3).map((each) => each === '')).toEqual([
      false,
      true,
      false,
    ])
    expect(section.endsWith('\n')).toBe(false)
    expect(section.endsWith('edge case')).toBe(true)
  })
})

describe('subject neutralization', () => {
  function subjectOf(subject: string): string | undefined {
    return fieldsOf(renderCommitBullet(buildCommit({ subject }), RENDER_OPTIONS))[3]
  }

  it('escapes the issue-reference sigil wherever it appears', () => {
    expect(subjectOf('fixes #12')).toBe('fixes \\#12')
    expect(subjectOf('#12 fixed')).toBe('\\#12 fixed')
    expect(subjectOf('closes #1 and #2')).toBe('closes \\#1 and \\#2')
  })

  it('escapes the mention sigil wherever it appears', () => {
    expect(subjectOf('thanks @org/team')).toBe('thanks \\@org/team')
    expect(subjectOf('@alice reported it')).toBe('\\@alice reported it')
  })

  it.each([START_MARKER, END_MARKER, SKIP_MARKER])('removes %s outright', (marker) => {
    const rendered = subjectOf(`before ${marker} after`)
    expect(rendered).toBe('before  after')
    expect(rendered).not.toContain('pr-decorator')
  })

  it('removes a marker-shaped comment whose name it has never seen', () => {
    expect(subjectOf('a <!-- pr-decorator:invented -->b')).toBe('a b')
  })

  it('strips repeatedly, so removal cannot assemble a new marker', () => {
    // One pass leaves a genuine skip marker behind: the outer text closes over the
    // gap the inner comment left. This is the bug the fixed-point loop exists for.
    const nested = '<!-- pr-<!-- pr-decorator:x -->decorator:skip -->'
    const rendered = subjectOf(`chore: ${nested}`)
    expect(rendered).toBe('chore:')
    expect(rendered).not.toContain('pr-decorator')
  })

  it('does not let two markers swallow the text between them', () => {
    expect(subjectOf(`a ${START_MARKER} keep ${END_MARKER} b`)).toBe('a  keep  b')
  })

  it('keeps only the first line of a multi-line message', () => {
    expect(subjectOf('subject\n\nbody with #12 and @alice')).toBe('subject')
    expect(subjectOf('subject\r\nbody')).toBe('subject')
  })

  it('collapses a stray carriage return that no line split removed', () => {
    expect(subjectOf('subject\rtail')).toBe('subject tail')
  })

  it('does not escape a backslash the message already carried', () => {
    // Only `#` and `@` are escaped. A message about a Windows path is prose, and
    // doubling its backslashes would be this module inventing content.
    expect(subjectOf('fix: handle C:\\temp paths')).toBe('fix: handle C:\\temp paths')
  })

  it('falls back rather than ending the bullet on a dangling separator', () => {
    expect(subjectOf('')).toBe('(no subject)')
    expect(subjectOf('   ')).toBe('(no subject)')
    expect(subjectOf(SKIP_MARKER)).toBe('(no subject)')
  })
})

describe('the mention is never touched', () => {
  it.each(['dependabot\\[bot\\]', 'Ada Lovelace', '@alice', 'A\\<b\\>', 'name with \\#hash'])(
    'emits %s verbatim',
    (mention) => {
      expect(renderCommitBullet(buildCommit({ mention }), RENDER_OPTIONS)).toContain(
        ` — ${mention} — `,
      )
    },
  )
})

describe('the commit link', () => {
  it('points at the base repository the caller supplied, never at a head repo', () => {
    const commit = buildCommit({ fullSha: 'f'.repeat(40), shortSha: 'fffffff' })
    expect(renderCommitBullet(commit, RENDER_OPTIONS)).toContain(
      `(https://github.com/pgatzka/pr-decorator/commit/${'f'.repeat(40)})`,
    )
  })

  it('does not double the slash when the base carries a trailing one', () => {
    const bullet = renderCommitBullet(buildCommit(), {
      ...RENDER_OPTIONS,
      commitUrlBase: 'https://github.com/pgatzka/pr-decorator/commit/',
    })
    expect(bullet).not.toContain('commit//')
    expect(bullet).toContain('/commit/0f1e2d3c4b5a69788796a5b4c3d2e1f009e8d7c6)')
  })

  it('displays the short SHA it was handed, without re-abbreviating', () => {
    // Abbreviation is the orchestrator's call; a renderer that re-derived it would
    // quietly disagree with whatever length was chosen there.
    const commit = buildCommit({ shortSha: 'a1b2c3d4e5' })
    expect(renderCommitBullet(commit, RENDER_OPTIONS)).toContain('[`a1b2c3d4e5`]')
  })
})

describe('the two notes', () => {
  it('announces the API ceiling with both counts', () => {
    const section = renderCommits(
      REFERENCE_COMMITS,
      sectionOptions({ totalCount: 312, returnedCount: 250 }),
    )
    expect(section).toContain('Showing first 250 of 312 commits.')
  })

  it('stays silent when nothing was hidden', () => {
    const section = renderCommits(
      REFERENCE_COMMITS,
      sectionOptions({ totalCount: 2, returnedCount: 2 }),
    )
    expect(section).not.toContain('Showing first')
    expect(section).not.toContain('more commit')
  })

  it('separates the overflow line from the list, so it is not part of a bullet', () => {
    const section = renderCommits(
      REFERENCE_COMMITS,
      sectionOptions({ totalCount: 5, returnedCount: 5, overflowCount: 3 }),
    )
    expect(section.endsWith('\n\n… and 3 more commits')).toBe(true)
  })

  it('says commit, not commits, for a single dropped commit', () => {
    const section = renderCommits(
      REFERENCE_COMMITS,
      sectionOptions({ totalCount: 3, returnedCount: 3, overflowCount: 1 }),
    )
    expect(section.endsWith('… and 1 more commit')).toBe(true)
  })

  it('treats an absent and a zero overflow the same', () => {
    const counts = { totalCount: 2, returnedCount: 2 }
    expect(renderCommits(REFERENCE_COMMITS, sectionOptions({ ...counts, overflowCount: 0 }))).toBe(
      renderCommits(REFERENCE_COMMITS, sectionOptions(counts)),
    )
  })

  it('renders both notes when the ceiling and the budget both bit', () => {
    const section = renderCommits(
      REFERENCE_COMMITS,
      sectionOptions({ totalCount: 312, returnedCount: 250, overflowCount: 248 }),
    )
    expect(section).toContain('Showing first 250 of 312 commits.')
    expect(section).toContain('… and 248 more commits')
  })

  it('still reports what was hidden when nothing at all survived', () => {
    const section = renderCommits(
      [],
      sectionOptions({ totalCount: 300, returnedCount: 250, overflowCount: 250 }),
    )
    expect(section).toBe(
      '## Commits\n\nShowing first 250 of 300 commits.\n\nNo commits.\n\n… and 250 more commits',
    )
  })
})

describe('order belongs to the client', () => {
  it('renders in input order even when the dates decrease', () => {
    const section = renderCommits(
      nonMonotonicCommits,
      sectionOptions({ totalCount: 4, returnedCount: 4 }),
    )
    const subjects = section
      .split('\n')
      .slice(2)
      .map((bullet) => fieldsOf(bullet)[3])
    expect(subjects).toEqual([
      'Add the parser',
      'Handle the empty input',
      'Fix the off-by-one',
      'Document the parser',
    ])
  })

  it('does not mutate the array it was handed', () => {
    const commits = [...nonMonotonicCommits]
    renderCommits(commits, sectionOptions({ totalCount: 4, returnedCount: 4 }))
    expect(commits).toEqual(nonMonotonicCommits)
  })
})

describe('module boundaries', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../src/render/commits.ts', import.meta.url)),
    'utf8',
  )

  it('reads the source it is asserting over', () => {
    // Guards the assertions below against an empty read passing vacuously.
    expect(source).toContain('export function renderCommits')
  })

  it.each(['@actions', 'src/github', "from '../github", 'octokit'])(
    'never mentions %s, as the pure render layer',
    (forbidden) => {
      expect(source).not.toContain(forbidden)
    },
  )

  it('contains no ordering call at all (D6)', () => {
    expect(source).not.toMatch(/\.sort\(|\.reverse\(\)/)
  })

  it('formats no instant of its own (D8)', () => {
    expect(source).not.toMatch(/Intl\.|toISOString/)
    expect(source).toContain('formatInstant')
  })

  it('takes the marker literal from the module that owns it', () => {
    // Retyping a marker here is the failure mode that orphans a pull request body
    // permanently, so the text must arrive by import.
    expect(source).toContain("from '../body/markers'")
    expect(source).not.toContain('pr-decorator:start')
    expect(source).not.toContain('pr-decorator:end')
    expect(source).not.toContain('pr-decorator:skip')
  })
})
