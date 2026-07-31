/**
 * Assembling the managed block, and computing the room the commit list has to fit
 * into.
 *
 * Two jobs that look unrelated and are not: the block's layout decides how many
 * characters everything other than the bullets costs, and that number is exactly
 * what the truncation pass has to be told. Splitting them across two modules would
 * mean two descriptions of one layout, and a disagreement between them is not a
 * cosmetic bug — it is a body over GitHub's 65,536-character limit, an API write
 * that fails, and a pull request whose block never lands.
 *
 * The runtime order inverts the dependency order on purpose: budget (here) →
 * truncate → render the section → assemble (here). The budget crosses that
 * boundary as a plain `number`, so the truncation module never imports this one
 * even though this one calls it, and neither ever imports the pull request API
 * client or the toolkit package that wraps it. Everything below is pure.
 *
 * All arithmetic is in UTF-16 code units, the unit JavaScript's `.length` reports
 * and the unit the limit is stated in (D10). A character outside the Basic
 * Multilingual Plane counts as two, which over-counts against a limit measured in
 * code points — conservative in the direction that keeps the body under the cap.
 *
 * One thing the budget cannot do is make room that is not there. Truncation drops
 * commits; it cannot drop the markers, and nothing here may drop a character the
 * author wrote. Past a certain length of the author's own text the block does not
 * go in at all, and a budget of zero does not say so — {@link blockFits} does, and
 * the caller has to ask before it writes.
 */

import { END_MARKER, START_MARKER } from '../body/markers'
import type { RenderedBlock } from '../types'

import { renderCommits, type CommitSectionOptions } from './commits'

/** GitHub's hard cap on a pull request body, in UTF-16 code units. */
const BODY_LIMIT = 65_536

/**
 * The blank line between two pieces of the block. One blank line and never two:
 * the pieces are a paragraph, a section and a caption, and markdown needs exactly
 * one to keep them apart.
 */
const PIECE_SEPARATOR = '\n\n'

/**
 * What the insertion can add between the author's text and the block. The body
 * module's separator is additive only — it tops the body's trailing newlines up to
 * one blank line and never trims — so two characters is the maximum, reached by a
 * body ending in no newline at all. Reserved unconditionally, because whether the
 * block is being inserted or replaced in place is not known here.
 */
const INSERTION_SEPARATOR_LENGTH = PIECE_SEPARATOR.length

/**
 * Slack held back from the budget on top of every reservation below.
 *
 * Nothing known is paid for out of this; it exists because the cost of being a few
 * characters under the limit is nothing at all, and the cost of being one over is
 * a write that fails on a pull request the author cannot fix by hand.
 */
const SAFETY_MARGIN = 16

/** The pieces of the block, each already rendered by the module that owns it. */
export interface BlockParts {
  /**
   * The bare `Closes #<n>` line, or `null` for no line at all — which is both the
   * `issue-link: false` case and the case of a branch name the pattern does not
   * match. One layout consequence, two causes, and neither may leave behind the
   * blank line that would have followed the line.
   */
  closingReference: string | null
  /** The `## Commits` section, exactly as its renderer produced it. */
  commitsSection: string
  /** The footer line, or `null` when `footer: false` turned it off. */
  footer: string | null
  /** How many commits the section actually shows. */
  renderedCommits: number
  /** How many commits the character budget dropped. */
  omittedCommits: number
}

/** The reservations that belong to the commits section itself. */
export interface SectionReservations {
  /**
   * What the section costs before a single bullet: the `## Commits` heading, the
   * blank line under it, AND the no-commits line that stands in for the bullets
   * when none of them fit. Reserved here so the number handed to the truncation
   * pass is a pure bullet allowance and that pass needs no knowledge of the frame.
   *
   * The stand-in line has to be part of the floor rather than left to the bullet
   * allowance. A budget of zero reserves nothing for bullets and the section still
   * renders `No commits.`, so without it the one case where room is tightest is
   * the one case that overruns.
   */
  sectionOverheadLength: number
  /** Room for the `… and N more commits` line, at its worst case. */
  overflowLineLength: number
  /** Room for the `Showing first N of M commits.` note, when one is due. */
  truncationNoteLength: number
}

/** Everything the budget is computed from. All lengths in UTF-16 code units. */
export interface CommitsBudgetParts extends SectionReservations {
  /** How much of the body is the author's own text, from `outsideLength()`. */
  outsideBodyLength: number
  /** Length of the closing reference line, or `0` when there is none. */
  closingRefLength: number
  /** Length of the footer line, or `0` when there is none. */
  footerLength: number
}

/**
 * Joins the block's pieces into the marker-delimited whole.
 *
 * The layout, all LF: start marker on its own line, the pieces separated by one
 * blank line each, end marker on its own line. No blank line directly after the
 * start marker and none directly before the end marker — those would render as
 * empty paragraphs at both ends of the block on every pull request the action
 * touches.
 *
 * A piece that is `null` or empty contributes nothing, separator included. That is
 * what makes turning the closing reference or the footer off leave no trace: the
 * pieces that remain close up rather than leaving the blank line that used to sit
 * beside the missing one.
 *
 * The markers are imported rather than written out here. A block whose start
 * marker differs by one character from the one the finder looks for can never be
 * located again, so the literal has exactly one home and this is not it.
 *
 * @param parts - The rendered pieces and the two commit counts.
 * @returns The complete block, no trailing newline, plus the counts unchanged —
 *   the caller logs them and the dry-run path reports them.
 */
export function assembleBlock(parts: BlockParts): RenderedBlock {
  const pieces = [parts.closingReference, parts.commitsSection, parts.footer].filter(
    (piece): piece is string => piece !== null && piece !== '',
  )

  return {
    text: `${START_MARKER}\n${pieces.join(PIECE_SEPARATOR)}\n${END_MARKER}`,
    renderedCommits: parts.renderedCommits,
    omittedCommits: parts.omittedCommits,
  }
}

/**
 * The block with nothing in it: both markers and the two newlines that put its
 * content between them. Measured through {@link assembleBlock} rather than counted
 * by hand, so the budget cannot drift from the layout it is budgeting for.
 */
const EMPTY_BLOCK_LENGTH = assembleBlock({
  closingReference: null,
  commitsSection: '',
  footer: null,
  renderedCommits: 0,
  omittedCommits: 0,
}).text.length

/**
 * What one optional piece costs: its own characters plus the blank line that
 * separates it from its neighbour. Absent pieces cost nothing, which is the same
 * rule {@link assembleBlock} applies — a length of zero is a piece that is not
 * there. The commits section is never charged a separator: with three pieces there
 * are two separators, and the closing reference and the footer carry one each.
 */
function pieceCost(length: number): number {
  return length === 0 ? 0 : length + PIECE_SEPARATOR.length
}

/**
 * Everything the block costs except the bullets: the separator the insertion may
 * add, the author's own text, the markers, each optional piece with its blank
 * line, the section's floor, both of the section's notes, and the safety margin.
 *
 * One expression, used by both exports below, so the number that decides whether
 * the block fits and the number that decides how much of it is bullets can never
 * disagree.
 */
function reservedLength(parts: CommitsBudgetParts): number {
  return (
    parts.outsideBodyLength +
    INSERTION_SEPARATOR_LENGTH +
    EMPTY_BLOCK_LENGTH +
    SAFETY_MARGIN +
    pieceCost(parts.closingRefLength) +
    pieceCost(parts.footerLength) +
    parts.sectionOverheadLength +
    parts.overflowLineLength +
    parts.truncationNoteLength
  )
}

/**
 * How many characters the commit bullets may spend.
 *
 * What is left once {@link reservedLength} is subtracted is for the bullets alone
 * — the truncation pass adds nothing to it and charges each bullet its own line
 * separator out of it.
 *
 * Both note reservations are WORST CASE, and they have to be: the overflow count
 * is only known after truncation, which happens after this number has been handed
 * over. Reserving the note as it would read with the total count substituted is an
 * upper bound, because no achievable count has more digits than the total.
 *
 * A budget of zero does NOT mean the block fits with nothing in it. It means there
 * is no room for bullets, which is also what a body already over the limit
 * produces. {@link blockFits} is what tells those two apart, and the caller has to
 * ask before it writes.
 *
 * @param parts - The author's text and every component to be reserved.
 * @returns The bullet allowance, never negative. A non-finite input yields `0`
 *   rather than a `NaN` that would compare false against every bullet cost and let
 *   the whole list through.
 */
export function computeCommitsBudget(parts: CommitsBudgetParts): number {
  const reserved = reservedLength(parts)
  if (!Number.isFinite(reserved)) {
    return 0
  }

  return Math.max(0, BODY_LIMIT - reserved)
}

/**
 * Whether the block can be written into this body at all.
 *
 * Truncation can drop every commit, but it cannot drop the markers, the closing
 * reference or the footer, and it can never drop a character of the author's text.
 * So an author who has written 65,000 characters of their own leaves a body that
 * no amount of truncating makes room in, and a budget of zero is not the answer to
 * that — the block simply does not go in.
 *
 * The caller must check this before writing. Writing anyway produces a body the
 * API refuses, which fails the action on a pull request whose only fault is a long
 * description.
 *
 * @param parts - The same components {@link computeCommitsBudget} is given.
 * @returns `true` when the block fits with an empty commit list, margin included.
 */
export function blockFits(parts: CommitsBudgetParts): boolean {
  const reserved = reservedLength(parts)
  return Number.isFinite(reserved) && reserved <= BODY_LIMIT
}

/**
 * Options for the probe renders below. None of these values reaches the output:
 * every probe renders an EMPTY commit list, so neither the timezone nor the URL
 * base is ever consulted. They are here because the section renderer requires
 * them.
 */
const PROBE_OPTIONS: CommitSectionOptions = {
  timeZone: 'UTC',
  commitUrlBase: '',
  totalCount: 0,
  returnedCount: 0,
}

/**
 * Measures the three section-side reservations by asking the renderer instead of
 * restating what it emits.
 *
 * Every number below comes out of a render, and the two notes out of a difference
 * between two renders, so no heading, note or separator literal is written out a
 * second time. The alternative — a hand-counted constant per line — is a number
 * that silently stops matching the day a line is reworded, and the failure that
 * follows is an over-limit body rather than a failing test.
 *
 * @param counts - The pull request's total commit count and how many the client
 *   actually fetched. The notes are reserved at their worst case: the overflow
 *   line as it would read having dropped every commit, and the ceiling note only
 *   when the client did in fact hit its ceiling.
 * @returns The three lengths, ready to spread into {@link computeCommitsBudget}.
 */
export function measureSectionReservations(counts: {
  totalCount: number
  returnedCount: number
}): SectionReservations {
  const { totalCount, returnedCount } = counts

  // The section with no bullets at all: heading, blank line, and the line that
  // stands in for the bullets. That is the floor a section cannot go below, and
  // reserving it is what makes a budget of zero survivable.
  const bare = renderCommits([], { ...PROBE_OPTIONS, totalCount: returnedCount, returnedCount })

  // Both notes are measured against that same bare render, so each difference is
  // the note plus every newline the section spends placing it — the blank line
  // above the overflow line included. That blank line is load-bearing: without it
  // the note renders as lazy continuation inside the last bullet, so its cost
  // belongs to the note and is not an accounting detail.
  const withOverflow = renderCommits([], {
    ...PROBE_OPTIONS,
    totalCount: returnedCount,
    returnedCount,
    overflowCount: totalCount,
  })
  const withNote = renderCommits([], { ...PROBE_OPTIONS, totalCount, returnedCount })

  return {
    sectionOverheadLength: bare.length,
    overflowLineLength: withOverflow.length - bare.length,
    truncationNoteLength: withNote.length - bare.length,
  }
}
