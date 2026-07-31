/**
 * The `## Commits` section: the bullet list, and the two notes that can go with it.
 *
 * This is the part of the block that renders untrusted input. A commit subject on
 * a public fork pull request is written by whoever opened it, so every subject
 * passes through the neutralizer below before it reaches the body: the `#` and `@`
 * sigils GitHub acts on are escaped, and anything shaped like one of this action's
 * own HTML comment markers is removed outright rather than escaped, so a crafted
 * subject can neither close the managed block nor opt the pull request out of
 * decoration.
 *
 * A bullet list and never a table. A table cell has to escape `|` as well, it wraps
 * badly on the pull request page, and a single malformed row breaks the whole grid
 * — a list degrades one line at a time.
 *
 * Two things this module deliberately does NOT do:
 *
 * - **Ordering.** Commits render in the order received, which is the API list order
 *   the client preserves (D6). Author dates are not monotonic after a rebase, so
 *   ordering by them here would silently disagree with the pull request's own
 *   Commits tab. No ordering call appears in this file, and a test greps for one.
 * - **Formatting instants.** The timestamp comes from `formatInstant`, the single
 *   place a timezone is ever applied (D8). A formatter here would be a second
 *   answer to the same question, and the goldens would stop proving anything.
 *
 * Mentions arrive already escaped from the author resolver and are emitted
 * verbatim — escaping them again renders a visible backslash. Subjects are the
 * opposite: they arrive raw, and escaping them is this module's job. Neither side
 * ever touches the other's output.
 */

import { START_MARKER } from '../body/markers'
import { formatInstant } from '../time'
import type { RenderableCommit } from '../types'

/** What the bullet renderer needs, and nothing more. */
export interface CommitBulletOptions {
  /** IANA zone name the author timestamp is rendered in. */
  timeZone: string
  /**
   * Everything before the SHA in a commit URL, e.g.
   * `https://github.com/owner/repo/commit`. Always the BASE repository (D1): the
   * head repository of a fork pull request can be deleted, and every link into it
   * dies with it. Assembled by the caller, which is what keeps this module free of
   * the Actions toolkit.
   */
  commitUrlBase: string
}

/** What the section renderer needs on top of {@link CommitBulletOptions}. */
export interface CommitSectionOptions extends CommitBulletOptions {
  /** The pull request's own commit count, which may exceed what was fetched. */
  totalCount: number
  /** How many commits the client actually fetched, capped by its 250 ceiling. */
  returnedCount: number
  /**
   * How many commits the character budget dropped from `commits`. A separate
   * concern from the ceiling above: that one is the API's limit, this one is the
   * body's. Omitted or `0` renders no overflow line.
   */
  overflowCount?: number
}

/** The section heading. `##`, so it nests under a `#` the author may have written. */
const HEADING = '## Commits'

/**
 * Field separator: space, EM DASH (U+2014), space. Not a hyphen and not an en
 * dash. The goldens are byte contracts, so a test pins the code point rather than
 * trusting that the character survived every editor it passed through.
 */
const FIELD_SEPARATOR = ' — '

/** HORIZONTAL ELLIPSIS (U+2026), one character and not three periods. */
const HORIZONTAL_ELLIPSIS = '…'

/** Emitted instead of the list, so an empty pull request never leaves a bare heading. */
const NO_COMMITS_LINE = 'No commits.'

/**
 * Emitted when a commit message is empty, or when neutralizing left nothing behind
 * — a subject consisting only of marker text does. Without it the bullet would end
 * on a dangling separator.
 */
const EMPTY_SUBJECT = '(no subject)'

/**
 * `<!-- pr-decorator:` — the opening every marker shares, sliced off the real
 * marker rather than retyped. A typo in a retyped marker is the failure mode that
 * lets a crafted subject smuggle a genuine marker into the body, so the literal
 * has exactly one home and this is not it.
 */
const MARKER_OPENING = START_MARKER.slice(0, START_MARKER.indexOf(':') + 1)

/**
 * Any HTML comment of the marker shape, whether or not the name is one this action
 * knows — an unknown `<!-- pr-decorator:whatever -->` is still ours to strip.
 *
 * Non-greedy, so two markers in one subject do not swallow the text between them.
 * None of the opening's characters are regex metacharacters, which is why it is
 * used as pattern source verbatim.
 */
const MARKER_SHAPED = new RegExp(`${MARKER_OPENING}.*?-->`, 'g')

/**
 * The two sigils GitHub acts on inside prose: `#` opens an issue reference, `@` a
 * mention. Escaped, both render as themselves, close nothing and notify nobody.
 */
const GFM_SIGILS = /[#@]/g

/** Line breaks that would end the bullet and let the rest render as new markup. */
const LINE_BREAKS = /[\r\n]+/g

/** Trailing slashes on the URL base, so a base with one does not produce `//`. */
const TRAILING_SLASHES = /\/+$/

/**
 * Removes every marker-shaped comment, repeatedly, until the text stops changing.
 *
 * One pass is not enough. `<!-- pr-<!-- pr-decorator:x -->decorator:skip -->`
 * strips its inner comment and what closes over the gap is a real skip marker —
 * removal that creates the thing being removed is the classic sanitizer bug. Each
 * pass strictly shortens the string, so the loop terminates.
 */
function stripMarkers(text: string): string {
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
 * Reduces a commit message to one safe line of prose (D7).
 *
 * Marker text is stripped BEFORE the sigils are escaped: escaping first would let
 * `<!-- pr-decorator:@ -->` survive as an unrecognized-but-marker-shaped comment.
 * Whitespace is deliberately not collapsed — removing a marker leaves the spaces
 * that surrounded it, which is visible evidence that something was taken out.
 *
 * The result stays prose rather than a code span: a subject is meant to be read,
 * and a code span would make a 70-character message a horizontal scrollbar.
 */
function neutralizeSubject(message: string): string {
  const firstLine = message.split('\n', 1)[0] ?? ''
  const subject = stripMarkers(firstLine).replace(LINE_BREAKS, ' ').trim()
  return subject === '' ? EMPTY_SUBJECT : subject.replace(GFM_SIGILS, '\\$&')
}

/** Joins the URL base and the FULL sha — the short one is for display only. */
function commitUrl(base: string, fullSha: string): string {
  return `${base.replace(TRAILING_SLASHES, '')}/${fullSha}`
}

/** `commit` or `commits`, because `1 more commits` reads like a bug. */
function commitNoun(count: number): string {
  return count === 1 ? 'commit' : 'commits'
}

/**
 * Renders one commit as a single list item.
 *
 * Exported on its own so the truncation pass can measure a bullet without building
 * a section around it: the character budget is spent one whole bullet at a time,
 * and measuring anything other than the final bytes would be measuring the wrong
 * string.
 *
 * The SHA is an explicit link wrapping a code span (D1). A bare backticked SHA is
 * not autolinked by GitHub, and a bare SHA outside a code span is autolinked only
 * within its own repository — the explicit form is the only one that survives on a
 * fork pull request.
 *
 * @param commit - One commit, already reduced to what the render layer needs.
 * @param options - The timezone and the base repository's commit URL prefix.
 * @returns One line, no trailing newline, e.g.
 *   `- 2026-07-28 09:14 — [\`a1b2c3d\`](…/a1b2c3d4…) — @alice — feat: rotate tokens`.
 */
export function renderCommitBullet(
  commit: RenderableCommit,
  options: CommitBulletOptions,
): string {
  const fields = [
    formatInstant(commit.authoredAt, options.timeZone),
    `[\`${commit.shortSha}\`](${commitUrl(options.commitUrlBase, commit.fullSha)})`,
    // Verbatim: already escaped by the author resolver.
    commit.mention,
    neutralizeSubject(commit.subject),
  ]
  return `- ${fields.join(FIELD_SEPARATOR)}`
}

/**
 * Renders the whole `## Commits` section: heading, notes, bullets.
 *
 * The two notes are independent and can both appear. The ceiling note reports what
 * the API refused to serve; the overflow line reports what the body's character
 * budget refused to hold. Both counts are computed elsewhere — this module only
 * decides how they read.
 *
 * @param commits - The commits to render, in the order they are to appear. Never
 *   reordered here; the client owns the order (D6).
 * @param options - Bullet options plus the counts the notes are built from.
 * @returns The section, LF-separated, with no trailing newline. How it is spaced
 *   against the markers, the closing reference and the footer is the assembler's
 *   decision, not this module's.
 */
export function renderCommits(
  commits: readonly RenderableCommit[],
  options: CommitSectionOptions,
): string {
  const lines: string[] = [HEADING, '']

  // Derived rather than passed: `truncated` means exactly this upstream, and two
  // spellings of one fact are one spelling too many.
  if (options.totalCount > options.returnedCount) {
    const { returnedCount, totalCount } = options
    lines.push(`Showing first ${returnedCount} of ${totalCount} ${commitNoun(totalCount)}.`, '')
  }

  if (commits.length === 0) {
    lines.push(NO_COMMITS_LINE)
  } else {
    for (const commit of commits) {
      lines.push(renderCommitBullet(commit, options))
    }
  }

  const overflow = options.overflowCount ?? 0
  if (overflow > 0) {
    // The blank line is load-bearing: without it the note is lazy continuation of
    // the last list item and renders inside that bullet.
    lines.push('', `${HORIZONTAL_ELLIPSIS} and ${overflow} more ${commitNoun(overflow)}`)
  }

  return lines.join('\n')
}
