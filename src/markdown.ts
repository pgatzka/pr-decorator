/**
 * The two primitives every field carrying untrusted text goes through.
 *
 * A commit subject and a git author name arrive from different places and are
 * assembled by different modules, but they are the same kind of string: whoever
 * opened the pull request chose the bytes. Both were once made safe by escaping
 * markdown's special characters, and that turned out not to be safe at all (D7) —
 * an escaped `\#12` stops RENDERING as an issue link while GitHub's
 * closing-keyword pass reads straight through the backslash, so a commit that said
 * it fixed an issue still closed that issue on merge.
 *
 * They live here rather than in either caller because one copy of this rule is the
 * only defensible number. The second copy is the one that does not get fixed.
 */

import { START_MARKER } from './body/markers'

/**
 * `<!-- pr-decorator:` — the opening every marker shares, sliced off the real
 * marker rather than retyped. A typo in a retyped marker is the failure mode that
 * lets a crafted string smuggle a genuine marker into the body, so the literal has
 * exactly one home and this is not it.
 */
const MARKER_OPENING = START_MARKER.slice(0, START_MARKER.indexOf(':') + 1)

/**
 * Any HTML comment of the marker shape, whether or not the name is one this action
 * knows — an unknown `<!-- pr-decorator:whatever -->` is still ours to strip.
 *
 * Non-greedy, so two markers in one string do not swallow the text between them.
 * None of the opening's characters are regex metacharacters, which is why it is
 * used as pattern source verbatim.
 */
const MARKER_SHAPED = new RegExp(`${MARKER_OPENING}.*?-->`, 'g')

/**
 * Every run of backticks in a string. The fence has to be longer than the longest
 * of them, otherwise the first run inside the content closes the span early and the
 * rest of the line renders as markup again.
 *
 * Safe to reuse despite the `g` flag: `String.prototype.match` resets `lastIndex`
 * before it scans, so a previous call cannot make the next one start mid-string.
 */
const BACKTICK_RUNS = /`+/g

/**
 * Removes every marker-shaped comment, repeatedly, until the text stops changing.
 *
 * Still required even for text that ends up inside a code span. A code span hides a
 * marker from the RENDERER, and the module that finds the managed block scans lines
 * instead of rendering markdown — so an unremoved marker would still cut the block
 * in half wherever it appeared.
 *
 * One pass is not enough. `<!-- pr-<!-- pr-decorator:x -->decorator:skip -->`
 * strips its inner comment and what closes over the gap is a real skip marker —
 * removal that creates the thing being removed is the classic sanitizer bug. Each
 * pass strictly shortens the string, so the loop terminates.
 *
 * @param text - Untrusted text, before any wrapping.
 * @returns The same text with every marker-shaped comment removed. Surrounding
 *   whitespace is deliberately left behind, as visible evidence of the removal.
 */
export function stripMarkerShapedComments(text: string): string {
  let current = text
  for (;;) {
    const stripped = current.replace(MARKER_SHAPED, '')
    if (stripped === current) {
      return current
    }
    current = stripped
  }
}

/**
 * Wraps text in a code span that its own content cannot escape from.
 *
 * Two rules from the GFM spec, both load-bearing rather than defensive:
 *
 * - The fence is one backtick longer than the longest run inside the content, so
 *   nothing in the content can close the span early.
 * - When the content starts or ends with a backtick, a space goes on each side. The
 *   renderer strips one space from each end only when BOTH ends carry one, so
 *   padding both sides is what makes an edge backtick survive as visible text
 *   instead of merging into the fence.
 *
 * Content that is entirely whitespace would be destroyed by that stripping rule,
 * which is why every caller resolves the empty case before reaching here.
 *
 * @param content - The text to render inertly, already stripped and trimmed.
 * @returns The fenced code span, ready to be concatenated into a line.
 */
export function codeSpan(content: string): string {
  let longestRun = 0
  for (const run of content.match(BACKTICK_RUNS) ?? []) {
    longestRun = Math.max(longestRun, run.length)
  }

  const fence = '`'.repeat(longestRun + 1)
  const padding = content.startsWith('`') || content.endsWith('`') ? ' ' : ''
  return `${fence}${padding}${content}${padding}${fence}`
}
