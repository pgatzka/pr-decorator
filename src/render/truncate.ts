/**
 * Fitting the commit list into whatever room the body has left.
 *
 * A pull request body is capped at 65,536 characters and this action can be
 * handed 250 commits, so the list does not always fit. What happens then is the
 * single most dangerous operation in the action, and the rule this module exists
 * to enforce is that the choice is made over WHOLE COMMITS, never over the
 * assembled string: a blunt cut of the rendered markdown can sever the
 * `<!-- pr-decorator:end -->` line, and a block that has lost its end marker can
 * never be located again — the pull request body is orphaned for good, with no
 * subsequent run able to repair it. There is therefore no string-level cut
 * anywhere below, and a test greps this file to keep it that way.
 *
 * Three things this module deliberately does NOT do:
 *
 * - **Compute the budget.** It arrives as a plain `number`, already net of the
 *   markers, the closing reference, the footer, the section frame and the
 *   overflow line. That keeps this module free of any import from the assembler
 *   even though the assembler is what calls it — the runtime order is assemble →
 *   truncate → render → assemble, while the dependency only ever points one way.
 * - **Render.** Sizing goes through the injected {@link CommitMeasure}, which the
 *   caller closes over the real bullet renderer, already bound to the timezone
 *   and the commit URL base. Estimating from subject length would measure a
 *   string nobody ever writes; the kept subset is re-rendered by the caller, so
 *   the bytes that land in the body are always bytes the renderer produced.
 * - **Order.** The kept commits are a PREFIX of the input in API list order (D6).
 *   Nothing is sorted, nothing is dropped from the middle, and no attempt is made
 *   to pack more small commits in by skipping a large one — the list has to agree
 *   with the pull request's own Commits tab, which reads from the top.
 */

import type { RenderableCommit } from '../types'

/**
 * Measures what one bullet costs, in the same UTF-16 code units the budget is
 * expressed in (D10). Injected rather than imported so this module never needs
 * to know how a bullet is spelled or what options spell it.
 */
export type CommitMeasure = (commit: RenderableCommit) => number

/** Which commits survived the budget, and how many did not. */
export interface TruncationResult {
  /**
   * The kept commits, a prefix of the input. The elements are the SAME OBJECT
   * REFERENCES as the inputs — never copies — so a caller can prove by identity
   * that nothing was rewritten on the way through.
   */
  commits: RenderableCommit[]
  /**
   * How many commits the budget dropped. `commits.length + overflowCount` always
   * equals the input length. Greater than zero is what makes the renderer emit
   * its `… and N more commits` line; this module owns the count and not the line.
   */
  overflowCount: number
}

/**
 * What a bullet costs on top of its own characters: the newline that puts it on
 * its own line. The section joins heading, blank line and bullets with LF, so
 * every bullet — including the first, which follows the section's blank line —
 * is preceded by exactly one separator.
 *
 * Charged here rather than reserved by the caller because the caller does not
 * know how many bullets there will be; that is the answer this function returns.
 * 250 uncharged newlines is a quarter-kilobyte overrun of a hard limit, and the
 * failure it causes is the permanent one described at the top of this file.
 */
const LINE_SEPARATOR_COST = 1

/**
 * Selects the longest prefix of `commits` whose bullets fit inside `budget`.
 *
 * Commits are taken in order and the first one that does not fit ends the
 * selection, along with everything after it. A budget too small for even one
 * bullet keeps nothing and reports the whole list as overflow, which still
 * renders a well-formed section — the renderer emits its no-commits line and the
 * overflow note, so the reader is told what happened rather than shown a bare
 * heading.
 *
 * @param commits - The commits to choose from, in the order they are to appear.
 *   Neither reordered nor mutated.
 * @param budget - Characters available for the bullets alone, already net of
 *   everything else in the block. Zero, negative and non-finite values are all
 *   treated as no room at all.
 * @param measure - Sizes one rendered bullet, without its line separator.
 * @returns The kept prefix and the number of commits dropped.
 */
export function truncateCommits(
  commits: RenderableCommit[],
  budget: number,
  measure: CommitMeasure,
): TruncationResult {
  // `NaN` would make every comparison below false and silently keep everything,
  // which is the one outcome the limit exists to prevent.
  const available = Number.isFinite(budget) ? budget : 0

  let spent = 0
  let kept = 0
  for (const commit of commits) {
    const cost = measure(commit) + LINE_SEPARATOR_COST
    if (spent + cost > available) {
      break
    }
    spent += cost
    kept += 1
  }

  // `slice` on the ARRAY, which copies references and no characters. The one
  // thing that must never be sliced is a rendered string.
  return { commits: commits.slice(0, kept), overflowCount: commits.length - kept }
}
