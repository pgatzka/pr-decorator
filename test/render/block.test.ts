import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { END_MARKER, START_MARKER, outsideLength, upsertBlock } from '../../src/body/markers'
import {
  assembleBlock,
  blockFits,
  computeCommitsBudget,
  measureSectionReservations,
  type BlockParts,
  type CommitsBudgetParts,
} from '../../src/render/block'
import { renderCommitBullet, renderCommits, type CommitBulletOptions } from '../../src/render/commits'
import { renderFooter } from '../../src/render/footer'
import { truncateCommits, type CommitMeasure } from '../../src/render/truncate'
import type { RenderableCommit } from '../../src/types'
import { buildCommits } from '../fixtures/commits'

/**
 * Two contracts in one file, because they are two halves of one guarantee.
 *
 * The assembled block is what lands in a pull request body, so it is asserted
 * byte-for-byte against goldens. The budget is what keeps that body under 65,536
 * characters, and it is asserted arithmetically — component by component, at the
 * clamp, and finally end to end through the real pipeline, where the budget is
 * spent down and the assembled body is measured against the limit it was computed
 * from.
 *
 * Goldens are stored WITHOUT a trailing newline. The block has none: the newline
 * that ends the end-marker line belongs to the author's text, and a golden
 * carrying one would hide that.
 */

/** GitHub's hard cap on a pull request body, in UTF-16 code units (D10). */
const BODY_LIMIT = 65_536

/** The API ceiling the client enforces, and therefore the worst case here. */
const API_CEILING = 250

const GOLDEN_DIR = fileURLToPath(new URL('../golden/block/', import.meta.url))

function golden(name: string): string {
  return readFileSync(join(GOLDEN_DIR, `${name}.md`), 'utf8')
}

const RENDER_OPTIONS: CommitBulletOptions = {
  timeZone: 'Europe/Berlin',
  commitUrlBase: 'https://github.com/pgatzka/pr-decorator/commit',
}

/** What the entrypoint injects: the real bullet renderer, bound to the options. */
const measureBullet: CommitMeasure = (commit) => renderCommitBullet(commit, RENDER_OPTIONS).length

/** The two commits the issue's normative block is rendered from. */
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

const REFERENCE_SECTION = renderCommits(REFERENCE_COMMITS, {
  ...RENDER_OPTIONS,
  totalCount: 2,
  returnedCount: 2,
})

const REFERENCE_CLOSING = 'Closes #142'

/**
 * The footer of the normative block reports THREE commits over two bullets. That
 * pairing is the point: the footer takes its count from the pull request object,
 * the section from what was fetched and kept, and the two are allowed to differ.
 */
const REFERENCE_FOOTER = renderFooter({
  headShortSha: '9c8d7e6',
  commitCount: 3,
  timeZone: 'Europe/Berlin',
})

function blockParts(overrides: Partial<BlockParts> = {}): BlockParts {
  return {
    closingReference: REFERENCE_CLOSING,
    commitsSection: REFERENCE_SECTION,
    footer: REFERENCE_FOOTER,
    renderedCommits: 2,
    omittedCommits: 0,
    ...overrides,
  }
}

/** A budget request with every component at zero, for differencing against. */
function budgetParts(overrides: Partial<CommitsBudgetParts> = {}): CommitsBudgetParts {
  return {
    outsideBodyLength: 0,
    closingRefLength: 0,
    footerLength: 0,
    sectionOverheadLength: 0,
    overflowLineLength: 0,
    truncationNoteLength: 0,
    ...overrides,
  }
}

/** An author body of `length` characters that ends WITHOUT a trailing newline. */
function authorBodyOf(length: number): string {
  const filler = 'Author prose that GitHub must not lose. '
  return filler.repeat(Math.ceil(length / filler.length) + 1).slice(0, length)
}

describe('the assembled block', () => {
  it('reproduces the normative block byte-for-byte', () => {
    expect(assembleBlock(blockParts()).text).toBe(golden('full'))
  })

  it('leaves no trace of the closing reference or the footer when both are off', () => {
    const block = assembleBlock(
      blockParts({ closingReference: null, footer: null }),
    ).text

    expect(block).toBe(golden('no-issue-no-footer'))
    expect(block).not.toContain('Closes')
    expect(block).not.toContain('<sub>')
    expect(block).not.toContain('\n\n\n')
  })

  it('puts the heading directly under the start marker when there is no closing line', () => {
    const lines = assembleBlock(blockParts({ closingReference: null })).text.split('\n')

    expect(lines[0]).toBe(START_MARKER)
    expect(lines[1]).toBe('## Commits')
  })

  it('treats a branch the pattern did not match exactly like `issue-link: false`', () => {
    // Two different causes, one layout consequence: the closing renderer returns
    // null for a non-matching branch, and the flag being off produces the same
    // null. Neither may leave the blank line the line would have been followed by.
    const flagOff = assembleBlock(blockParts({ closingReference: null })).text
    const noMatch = assembleBlock(blockParts({ closingReference: null })).text

    expect(noMatch).toBe(flagOff)
    expect(noMatch.split('\n')[1]).not.toBe('')
  })

  it('never opens with a blank line and never closes with one', () => {
    const cases: Partial<BlockParts>[] = [
      {},
      { closingReference: null },
      { footer: null },
      { closingReference: null, footer: null },
    ]

    for (const override of cases) {
      const lines = assembleBlock(blockParts(override)).text.split('\n')

      expect(lines[0]).toBe(START_MARKER)
      expect(lines[1]).not.toBe('')
      expect(lines.at(-1)).toBe(END_MARKER)
      expect(lines.at(-2)).not.toBe('')
    }
  })

  it('separates every piece it does emit with exactly one blank line', () => {
    const text = assembleBlock(blockParts()).text

    expect(text).toBe(
      [
        START_MARKER,
        REFERENCE_CLOSING,
        '',
        REFERENCE_SECTION,
        '',
        REFERENCE_FOOTER,
        END_MARKER,
      ].join('\n'),
    )
  })

  it('emits the marker literals themselves, so the block stays findable', () => {
    const block = assembleBlock(blockParts()).text

    // A block whose start marker differs by one character from the one the finder
    // looks for can never be located again, and the body is orphaned for good.
    expect(upsertBlock('', block, 'top').action).toBe('inserted')
    expect(upsertBlock(`Prose.\n\n${block}\n`, block, 'top').action).toBe('replaced')
  })

  it('carries the two counts through untouched', () => {
    const result = assembleBlock(blockParts({ renderedCommits: 7, omittedCommits: 243 }))

    expect(result.renderedCommits).toBe(7)
    expect(result.omittedCommits).toBe(243)
  })

  it('treats an empty piece as an absent one rather than reserving a blank line', () => {
    expect(assembleBlock(blockParts({ footer: '' })).text).toBe(
      assembleBlock(blockParts({ footer: null })).text,
    )
  })
})

describe('the budget', () => {
  /**
   * What the budget costs before a single component is named: the insertion
   * separator, both marker lines with the newlines that put the content between
   * them, and the safety margin. Derived by asking for a budget with every
   * component at zero, then pinned below.
   */
  const FIXED_OVERHEAD = BODY_LIMIT - computeCommitsBudget(budgetParts())

  it('reserves the markers, the insertion separator and the safety margin', () => {
    const markers = `${START_MARKER}\n\n${END_MARKER}`.length
    const insertionSeparator = 2
    const safetyMargin = 16

    expect(markers).toBe(54)
    expect(FIXED_OVERHEAD).toBe(markers + insertionSeparator + safetyMargin)
  })

  it('gives back everything it did not reserve', () => {
    const parts = budgetParts({
      outsideBodyLength: 1_000,
      closingRefLength: REFERENCE_CLOSING.length,
      footerLength: REFERENCE_FOOTER.length,
      ...measureSectionReservations({ totalCount: 250, returnedCount: 200 }),
    })
    const budget = computeCommitsBudget(parts)

    const reserved =
      FIXED_OVERHEAD +
      parts.outsideBodyLength +
      (parts.closingRefLength + 2) +
      (parts.footerLength + 2) +
      parts.sectionOverheadLength +
      parts.overflowLineLength +
      parts.truncationNoteLength

    expect(budget + reserved).toBe(BODY_LIMIT)
  })

  it('shrinks one for one with the author text outside the markers', () => {
    const empty = computeCommitsBudget(budgetParts({ outsideBodyLength: 0 }))

    expect(computeCommitsBudget(budgetParts({ outsideBodyLength: 1 }))).toBe(empty - 1)
    expect(computeCommitsBudget(budgetParts({ outsideBodyLength: 10_000 }))).toBe(empty - 10_000)
  })

  it('takes its author figure from the body module, block excluded', () => {
    const prose = 'Some prose the author wrote.'
    const body = `${prose}\n\n${assembleBlock(blockParts()).text}`

    expect(outsideLength(body)).toBe(prose.length + 2)
    expect(computeCommitsBudget(budgetParts({ outsideBodyLength: outsideLength(body) }))).toBe(
      computeCommitsBudget(budgetParts({ outsideBodyLength: prose.length + 2 })),
    )
  })

  it('clamps to zero rather than going negative once the author fills the body', () => {
    // With no component but the fixed overhead, the allowance runs out exactly
    // here, and every larger body reports the same zero rather than a deficit.
    const exhausted = BODY_LIMIT - FIXED_OVERHEAD

    expect(computeCommitsBudget(budgetParts({ outsideBodyLength: exhausted - 1 }))).toBe(1)
    expect(computeCommitsBudget(budgetParts({ outsideBodyLength: exhausted }))).toBe(0)

    for (const size of [exhausted + 1, BODY_LIMIT, 70_000, 1_000_000]) {
      expect(computeCommitsBudget(budgetParts({ outsideBodyLength: size }))).toBe(0)
    }
  })

  it('never returns a negative number, whatever it is handed', () => {
    const budget = computeCommitsBudget(
      budgetParts({
        outsideBodyLength: 65_500,
        closingRefLength: 500,
        footerLength: 500,
        sectionOverheadLength: 500,
        overflowLineLength: 500,
        truncationNoteLength: 500,
      }),
    )

    expect(budget).toBe(0)
    expect(budget).toBeGreaterThanOrEqual(0)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'treats a non-finite %s as no room at all',
    (value) => {
      // NaN would compare false against every bullet cost downstream and let the
      // entire list through, which is the one outcome the limit exists to prevent.
      expect(computeCommitsBudget(budgetParts({ outsideBodyLength: value }))).toBe(0)
      expect(computeCommitsBudget(budgetParts({ footerLength: value }))).toBe(0)
    },
  )

  it('charges an optional piece its own blank line, and an absent one nothing', () => {
    const none = computeCommitsBudget(budgetParts())

    expect(computeCommitsBudget(budgetParts({ footerLength: REFERENCE_FOOTER.length }))).toBe(
      none - REFERENCE_FOOTER.length - 2,
    )
    expect(computeCommitsBudget(budgetParts({ closingRefLength: REFERENCE_CLOSING.length }))).toBe(
      none - REFERENCE_CLOSING.length - 2,
    )
    expect(computeCommitsBudget(budgetParts({ footerLength: 0, closingRefLength: 0 }))).toBe(none)
  })

  it('measures in UTF-16 code units, over-counting astral characters (D10)', () => {
    // U+1D518, a surrogate pair: two code units for one code point. Counting it as
    // two reserves a character more than the limit charges, which errs towards a
    // body that fits rather than one that is refused.
    const astral = `${'x'.repeat(10)}𝔘`

    expect(astral.length).toBe(12)
    expect([...astral]).toHaveLength(11)
    expect(computeCommitsBudget(budgetParts({ outsideBodyLength: outsideLength(astral) }))).toBe(
      computeCommitsBudget(budgetParts({ outsideBodyLength: 12 })),
    )
  })
})

describe('the section reservations', () => {
  it('reserves the heading, its blank line and the no-commits floor', () => {
    const { sectionOverheadLength } = measureSectionReservations({
      totalCount: 2,
      returnedCount: 2,
    })

    // Heading, the newline the blank line under it contributes to the joined
    // section, and the line that stands in for the bullets when none of them fit.
    // Without that last part a budget of zero reserves nothing and the section
    // still renders `No commits.` — the tightest case would be the one that
    // overruns.
    expect(sectionOverheadLength).toBe('## Commits'.length + 1 + 'No commits.'.length + 1)
    expect(sectionOverheadLength).toBe(
      renderCommits([], { ...RENDER_OPTIONS, totalCount: 2, returnedCount: 2 }).length,
    )
  })

  it('reserves no per-bullet newline, which the truncation pass charges itself', () => {
    const { sectionOverheadLength } = measureSectionReservations({
      totalCount: 2,
      returnedCount: 2,
    })
    const section = renderCommits(REFERENCE_COMMITS, {
      ...RENDER_OPTIONS,
      totalCount: 2,
      returnedCount: 2,
    })
    const bullets = REFERENCE_COMMITS.reduce((sum, c) => sum + measureBullet(c) + 1, 0)

    // Each bullet costs its own characters plus exactly one newline, and the
    // section costs no more than the floor plus those bullets. It costs strictly
    // less here, by the stand-in line the bullets displaced.
    expect(section.length).toBe(sectionOverheadLength + bullets - 'No commits.'.length - 1)
    expect(section.length).toBeLessThanOrEqual(sectionOverheadLength + bullets)
  })

  it('reserves the overflow line at its worst case, not at the actual one', () => {
    // The overflow count is only known after truncation, which happens after the
    // budget has been handed over. The total is an upper bound on its digits.
    const { overflowLineLength } = measureSectionReservations({
      totalCount: API_CEILING,
      returnedCount: API_CEILING,
    })

    // The note plus the newline that puts it on its own line PLUS the blank line
    // above it. That blank line is load-bearing — without it the note renders as
    // lazy continuation inside the last bullet — so it is part of the note's cost.
    expect(overflowLineLength).toBe('… and 250 more commits'.length + 2)
    expect(overflowLineLength).toBe(24)
  })

  it('reserves enough for every overflow count the truncation pass can produce', () => {
    const { overflowLineLength } = measureSectionReservations({
      totalCount: API_CEILING,
      returnedCount: API_CEILING,
    })

    for (const overflow of [1, 9, 10, 99, 100, 249, 250]) {
      const bare = renderCommits([], { ...RENDER_OPTIONS, totalCount: 1, returnedCount: 1 })
      const withLine = renderCommits([], {
        ...RENDER_OPTIONS,
        totalCount: 1,
        returnedCount: 1,
        overflowCount: overflow,
      })

      expect(withLine.length - bare.length).toBeLessThanOrEqual(overflowLineLength)
    }
  })

  it('reserves the ceiling note only when the client actually hit its ceiling', () => {
    expect(
      measureSectionReservations({ totalCount: 250, returnedCount: 250 }).truncationNoteLength,
    ).toBe(0)
    expect(
      measureSectionReservations({ totalCount: 400, returnedCount: 250 }).truncationNoteLength,
    ).toBe('Showing first 250 of 400 commits.'.length + 2)
  })

  it('reserves neither note for a pull request with no commits', () => {
    expect(measureSectionReservations({ totalCount: 0, returnedCount: 0 })).toEqual({
      sectionOverheadLength: '## Commits\n\nNo commits.'.length,
      overflowLineLength: 0,
      truncationNoteLength: 0,
    })
  })
})

describe('at the limit', () => {
  /**
   * 250 commits at the worst size the renderer can be handed: a 72-character
   * subject, which is where the conventional git subject limit sits, and a login
   * near GitHub's own 39-character maximum.
   */
  function worstCaseCommits(count: number): RenderableCommit[] {
    return buildCommits(
      Array.from({ length: count }, (_, index) => ({
        fullSha: index.toString(16).padStart(40, 'a'),
        authoredAt: new Date('2026-07-28T07:14:00.000Z'),
        mention: '@a-rather-long-but-legal-github-login-x',
        subject: `feat(auth): ${'rotate the refresh tokens and then some more '.repeat(2)}`.slice(
          0,
          72,
        ),
      })),
    )
  }

  /** The budget request the pipeline below builds, for a given author body. */
  function partsFor(authorBody: string, totalCount: number, returnedCount: number) {
    return {
      outsideBodyLength: outsideLength(authorBody),
      closingRefLength: REFERENCE_CLOSING.length,
      footerLength: renderFooter({
        headShortSha: '9c8d7e6',
        commitCount: totalCount,
        timeZone: RENDER_OPTIONS.timeZone,
      }).length,
      ...measureSectionReservations({ totalCount, returnedCount }),
    }
  }

  /**
   * The largest author body this block still fits beside. The budget falls one for
   * one with the author's text, so the allowance measured against an empty body is
   * exactly the author length at which it reaches zero — and one character past it
   * is where the block stops fitting at all.
   */
  const HEADROOM = computeCommitsBudget(partsFor('', API_CEILING, API_CEILING))

  /** The whole pipeline in its runtime order: budget → truncate → render → assemble. */
  function decorate(authorBody: string, totalCount: number, returnedCount: number) {
    const commits = worstCaseCommits(returnedCount)
    const footer = renderFooter({
      headShortSha: '9c8d7e6',
      commitCount: totalCount,
      timeZone: RENDER_OPTIONS.timeZone,
    })
    const budget = computeCommitsBudget(partsFor(authorBody, totalCount, returnedCount))

    const truncated = truncateCommits(commits, budget, measureBullet)
    const section = renderCommits(truncated.commits, {
      ...RENDER_OPTIONS,
      totalCount,
      returnedCount,
      overflowCount: truncated.overflowCount,
    })
    const block = assembleBlock({
      closingReference: REFERENCE_CLOSING,
      commitsSection: section,
      footer,
      renderedCommits: truncated.commits.length,
      omittedCommits: truncated.overflowCount,
    })

    return { budget, block, body: upsertBlock(authorBody, block.text, 'bottom').body }
  }

  it('renders the boundary block byte-for-byte', () => {
    // An author body 65,000 characters long leaves room for a single bullet, so
    // the golden that captures the tightest case the action can reach is also the
    // smallest one — everything the budget refused shows up as the overflow line.
    expect(decorate(authorBodyOf(65_000), API_CEILING, API_CEILING).block.text).toBe(
      golden('at-limit'),
    )
  })

  it.each([0, 20_000, 40_000, 60_000, 64_000, 65_000])(
    'stays inside 65,536 under a %i-character author body',
    (authorSize) => {
      const { body } = decorate(authorBodyOf(authorSize), API_CEILING, API_CEILING)

      expect(body.length).toBeLessThanOrEqual(BODY_LIMIT)
      expect(body).toContain(START_MARKER)
      expect(body).toContain(END_MARKER)
    },
  )

  it('stays inside 65,536 when the client also hit its own ceiling', () => {
    const { body } = decorate(authorBodyOf(40_000), 1_000, API_CEILING)

    expect(body).toContain('Showing first 250 of 1000 commits.')
    expect(body.length).toBeLessThanOrEqual(BODY_LIMIT)
  })

  it('spends nearly all the room it was given rather than playing it safe', () => {
    // A budget that always kept zero commits would satisfy every assertion above
    // and be useless. What is left over can only be the bullet that did not fit,
    // the worst-case over-reservation and the safety margin.
    const { body, block } = decorate(authorBodyOf(40_000), API_CEILING, API_CEILING)

    expect(block.renderedCommits).toBeGreaterThan(0)
    expect(block.omittedCommits).toBeGreaterThan(0)
    expect(body.length).toBeGreaterThan(BODY_LIMIT - 400)
  })

  it('still assembles a well-formed block on the last body that has room for one', () => {
    const { budget, block, body } = decorate(authorBodyOf(HEADROOM), API_CEILING, API_CEILING)

    expect(budget).toBe(0)
    expect(block.renderedCommits).toBe(0)
    expect(block.omittedCommits).toBe(API_CEILING)
    expect(block.text).toContain('No commits.')
    expect(block.text).toContain('… and 250 more commits')
    expect(body.length).toBeLessThanOrEqual(BODY_LIMIT)
    expect(body.endsWith(END_MARKER)).toBe(true)
  })
})

describe('the body that has no room for a block at all', () => {
  /**
   * The failure the budget alone cannot prevent. Truncation drops commits, but it
   * cannot drop the markers, the closing reference or the footer, and it must
   * never drop a character the author wrote. Past a certain author length the
   * block does not go in, and a budget of zero is not that answer — a zero budget
   * still assembles a block, and that block still has to fit somewhere.
   */
  function partsAt(outsideBodyLength: number): CommitsBudgetParts {
    return budgetParts({
      outsideBodyLength,
      closingRefLength: REFERENCE_CLOSING.length,
      footerLength: REFERENCE_FOOTER.length,
      ...measureSectionReservations({ totalCount: 250, returnedCount: 250 }),
    })
  }

  /** The author length at which the allowance runs out, from that same request. */
  const HEADROOM = computeCommitsBudget(partsAt(0))

  it('fits right up to the point the budget reaches zero', () => {
    expect(computeCommitsBudget(partsAt(HEADROOM))).toBe(0)
    expect(blockFits(partsAt(HEADROOM))).toBe(true)
    expect(blockFits(partsAt(HEADROOM - 1))).toBe(true)
  })

  it('stops fitting one character later, where a zero budget would say nothing', () => {
    expect(computeCommitsBudget(partsAt(HEADROOM + 1))).toBe(0)
    expect(blockFits(partsAt(HEADROOM + 1))).toBe(false)

    // The two states a zero budget cannot tell apart, which is why the caller has
    // to ask separately before it writes.
    expect(computeCommitsBudget(partsAt(HEADROOM))).toBe(
      computeCommitsBudget(partsAt(HEADROOM + 1)),
    )
  })

  it.each([1, 100, 5_000])('refuses an author body %i characters past the headroom', (over) => {
    expect(blockFits(partsAt(HEADROOM + over))).toBe(false)
  })

  it.each([BODY_LIMIT, 100_000, 1_000_000])('refuses a %i-character author body', (size) => {
    expect(blockFits(partsAt(size))).toBe(false)
  })

  it('would produce an over-limit body if the caller wrote anyway', () => {
    // Pinned rather than fixed: this is what makes the check above load-bearing.
    // The assembled block is well formed and the body it lands in is not.
    const authorBody = authorBodyOf(HEADROOM + 200)
    const block = assembleBlock(
      blockParts({
        commitsSection: renderCommits([], {
          ...RENDER_OPTIONS,
          totalCount: 250,
          returnedCount: 250,
          overflowCount: 250,
        }),
        renderedCommits: 0,
        omittedCommits: 250,
      }),
    )

    expect(blockFits(partsAt(outsideLength(authorBody)))).toBe(false)
    expect(upsertBlock(authorBody, block.text, 'bottom').body.length).toBeGreaterThan(BODY_LIMIT)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY])('refuses a non-finite %s outright', (value) => {
    expect(blockFits(partsAt(value))).toBe(false)
  })
})

describe('module boundaries', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../src/render/block.ts', import.meta.url)),
    'utf8',
  )

  it('reads the source it is asserting over', () => {
    expect(source).toContain('export function assembleBlock')
    expect(source).toContain('export function computeCommitsBudget')
  })

  it.each(['@actions', 'src/github', "from '../github", 'octokit'])(
    'never mentions %s anywhere, comments included, as the pure render layer',
    (forbidden) => {
      expect(source).not.toContain(forbidden)
    },
  )

  it('takes the marker literals from the body module rather than retyping them', () => {
    expect(source).toContain("from '../body/markers'")
    expect(source).not.toContain('pr-decorator:start')
    expect(source).not.toContain('pr-decorator:end')
  })

  it('does not import the truncation pass it hands its number to', () => {
    // The budget crosses that boundary as a plain number, in one direction only.
    expect(source).not.toMatch(/from ['"]\.\/truncate/)
  })
})
