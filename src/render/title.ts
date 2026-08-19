/**
 * The pull request title: `#<issueId> <issue title, lowercased>`.
 *
 * Pure, like the rest of `src/render/**`: no `@actions/*` import and no import
 * from `src/github/`, enforced by the same eslint layering rule that guards
 * `src/render/issue-ref.ts`. The caller resolves the issue number (via
 * `resolveIssueNumber` in `issue-ref.ts`) and reads the issue title from the
 * API; this module only shapes the string.
 *
 * The title has no delimiter the way the body has markers. When the title
 * feature is on, this string fully replaces whatever the pull request author
 * typed, on every run — there is no non-destructive middle ground for a
 * single-line field, unlike the marker-bounded body.
 */

/**
 * GitHub's own limit on an issue/pull request title, in UTF-16 code units.
 * Measured against `PATCH /repos/{owner}/{repo}/pulls/{pull_number}`: a title
 * longer than this is rejected with a 422 Validation Failed whose error body
 * reads `title is too long (maximum is 256 characters)`.
 */
export const MAX_TITLE_LENGTH = 256

/** Appended in place of the characters a truncated title drops. */
const ELLIPSIS = '…'

/** A run of whitespace or a C0/C1 control character (CR, LF, TAB included). */
const WHITESPACE_OR_CONTROL = /[\s\p{Cc}]+/gu

/**
 * Collapses every run of whitespace and control characters to a single space
 * and trims the result. An issue title can carry a newline or a stray tab in
 * ways the API accepts and are not worth discovering in a pull request title.
 */
function normalize(issueTitle: string): string {
  return issueTitle.replace(WHITESPACE_OR_CONTROL, ' ').trim()
}

/**
 * Renders the pull request title for `issueNumber` and `issueTitle`.
 *
 * Only the issue title is cased: `String.prototype.toLowerCase()`, never
 * `toLocaleLowerCase()`. The latter follows the runtime's default locale, and
 * under a Turkish one `I` maps to the dotless `ı` — the same issue would then
 * render a different title depending on which runner happened to pick up the
 * job. `toLowerCase()` has no such dependency. The `#<n>` prefix is not text
 * to case at all and is emitted verbatim.
 *
 * @param issueNumber - The issue number as a string, exactly as
 *   `resolveIssueNumber` in `issue-ref.ts` returns it — never rounded, so an
 *   issue number past 2^53 renders correctly.
 * @param issueTitle - The issue's own title, exactly as the API served it.
 * @returns `#<issueNumber> <issueTitle, lowercased>`, truncated to
 *   {@link MAX_TITLE_LENGTH} with a trailing `…` when it would otherwise
 *   exceed it — the `#<n>` prefix always survives intact; only the issue
 *   title is ever cut — or `null` when the normalized issue title is empty.
 *   A bare `#142` as a title is worse than leaving the author's title alone.
 */
export function renderTitle(issueNumber: string, issueTitle: string): string | null {
  const normalized = normalize(issueTitle)
  if (normalized === '') {
    return null
  }

  const prefix = `#${issueNumber} `
  const lowered = normalized.toLowerCase()
  const budget = MAX_TITLE_LENGTH - prefix.length

  if (lowered.length <= budget) {
    return `${prefix}${lowered}`
  }

  if (budget <= ELLIPSIS.length) {
    // The prefix alone leaves no room for any issue title text, not even the
    // ellipsis alone. Not reachable with any realistic issue number, but the
    // result stays bounded at MAX_TITLE_LENGTH rather than overrunning it.
    return prefix.slice(0, MAX_TITLE_LENGTH)
  }

  return `${prefix}${lowered.slice(0, budget - ELLIPSIS.length)}${ELLIPSIS}`
}
