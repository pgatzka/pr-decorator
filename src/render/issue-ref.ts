/**
 * The closing reference line — the first line of the managed block.
 *
 * The issue number comes from the head branch name alone: no API call is made,
 * and nothing here checks that the issue exists or is open. That is deliberate.
 * The line is a promise about what merging does, and GitHub's own closing-keyword
 * parser is the only thing that has to agree with it.
 *
 * Configuration knowledge stays out of this module. `issue-link: false` is
 * honoured by the assembler, which simply omits the line; the branch name and the
 * already-compiled `branch-pattern` are handed in by the caller. That is what
 * lets the render layer stay pure: nothing here reaches for an input or for the
 * API layer, and both the eslint layering rule and a test in the suite fail the
 * build if that ever changes.
 */

/**
 * The output must be exactly what GitHub's closing-keyword parser accepts: a bare
 * `Closes #<n>`, no bold, no list marker, no trailing punctuation. v1 emits this
 * one keyword and one reference; `Fixes`, `Resolves` and multiple references are
 * deliberately not supported.
 */
const CLOSING_KEYWORD = 'Closes'

/**
 * What the captured group has to look like before it is treated as an issue
 * number. ASCII digits only and nothing else: no sign, no whitespace, no
 * separator, and none of the non-ASCII digits a `\p{Nd}` pattern could capture.
 */
const DIGITS_ONLY = /^[0-9]+$/

/** Leading zeros, which GitHub does not carry: `042-fix` closes issue 42. */
const LEADING_ZEROS = /^0+/

/**
 * Matches `pattern` against `branchName` without leaving state behind.
 *
 * `RegExp.exec` advances `lastIndex` on a `g` or `y` pattern, so calling it twice
 * on the same pattern object would answer differently the second time. The
 * pattern arrives from the `branch-pattern` input and this module cannot dictate
 * its flags, so a matching copy is used instead — flags preserved, because
 * dropping `y` would silently turn an anchored pattern into a searching one.
 * The caller's pattern object is never mutated.
 */
function matchOnce(branchName: string, pattern: RegExp): RegExpExecArray | null {
  if (!pattern.global && !pattern.sticky) {
    return pattern.exec(branchName)
  }
  return new RegExp(pattern.source, pattern.flags).exec(branchName)
}

/**
 * Renders the `Closes #<n>` line for a head branch, or nothing at all.
 *
 * The branch name is only ever the subject of the match, never part of the
 * pattern, so a branch called `fix/(.*)+` is data like any other name.
 *
 * @param branchName - The head branch name, e.g. `142-fix-auth`. The caller has
 *   already applied the length cap from the input parser.
 * @param pattern - The compiled `branch-pattern`; capture group 1 is the issue
 *   number. Only the first group is read, so `^(?:feature|fix)\/(\d+)-` works
 *   unchanged. Not mutated.
 * @returns Exactly `Closes #<n>`, or `null` when the pattern does not match, the
 *   first group is absent or empty, the capture is not a run of ASCII digits, or
 *   the number is zero — there is no issue #0.
 */
export function renderIssueReference(branchName: string, pattern: RegExp): string | null {
  const match = matchOnce(branchName, pattern)
  if (match === null) {
    return null
  }

  // A pattern with no capturing group at all lands here too, as `undefined`.
  const captured = match[1]
  if (captured === undefined || !DIGITS_ONLY.test(captured)) {
    return null
  }

  // Stripped textually rather than parsed: `parseInt` would round a number past
  // 2^53 into a different issue. An all-zeros capture strips to '' and is
  // rejected here, which is also how `0-nope` is refused.
  const number = captured.replace(LEADING_ZEROS, '')
  if (number === '') {
    return null
  }

  return `${CLOSING_KEYWORD} #${number}`
}
