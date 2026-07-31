/**
 * The managed block: finding it, inserting it, replacing it — and nothing else.
 *
 * This is the only module that manipulates the pull request body string, and the
 * rules it enforces are absolute: text outside the markers is never modified, the
 * body is never wholesale replaced, and nothing here deletes a byte the author
 * wrote. Every function is pure — plain strings in, plain strings out, no I/O and
 * no dependency on the API layer or the Actions toolkit — so those guarantees are
 * proven by test rather than by inspection.
 *
 * Nothing here decides WHETHER to write. The caller compares the returned body to
 * the current one, honours `dry-run`, and handles the `unclosed` outcome. That
 * split is what lets a body that is already correct come back byte-identical:
 * replacement happens in place, so a re-render of the same block produces the same
 * bytes and the write is skipped upstream.
 *
 * **Known limitation.** Marker detection is a literal line scan; it does not parse
 * markdown. A marker line pasted inside a fenced code block is indistinguishable
 * from a real one and will be treated as the block. The behaviour is deterministic
 * and still non-destructive — the fence lines and every other character outside the
 * matched span survive untouched — but the rendered result will look wrong to the
 * author. Locked by test rather than fixed: a real fence parser is a markdown
 * parser, and guessing which of two identical marker pairs is "the real one" is a
 * worse failure mode than being predictable.
 */

import type { Position } from '../types'

/** Opening line of the managed block. */
export const START_MARKER = '<!-- pr-decorator:start -->'

/** Closing line of the managed block. */
export const END_MARKER = '<!-- pr-decorator:end -->'

/** Opt-out marker. A body carrying it anywhere is left completely untouched. */
export const SKIP_MARKER = '<!-- pr-decorator:skip -->'

/**
 * What {@link upsertBlock} did. The three literals are pinned exactly as written:
 * the entrypoint branches on them, and `unclosed` in particular is the signal to
 * warn and exit without writing.
 */
export type UpsertAction = 'inserted' | 'replaced' | 'unclosed'

/** Half-open character range of the managed block: `body.slice(start, end)`. */
export interface BlockRange {
  /** Index of the first character of the start-marker line. */
  start: number
  /**
   * Index one past the last character of the end-marker line. The newline that
   * terminates that line belongs to the author's text, not to the block.
   */
  end: number
}

/** The new body plus what happened to it. */
export interface UpsertResult {
  /** The body to write. Identical to the input when nothing could be done. */
  body: string
  /** Which of the three outcomes applied. */
  action: UpsertAction
}

/**
 * Builds the line-anchored pattern for one marker.
 *
 * A marker counts only as a whole line, so a marker quoted mid-sentence in the
 * author's prose is text like any other. The literals contain no regex
 * metacharacters, which is why they are used as pattern source verbatim.
 *
 * Trailing horizontal whitespace and a lone CR are tolerated: a body edited
 * through the web form comes back with CRLF line endings, and failing to
 * recognize our own block there would append a second one on every run. Leading
 * whitespace is NOT tolerated — an indented line is a different construct in
 * markdown, and matching it would let an indented quotation move the block.
 */
function lineAnchored(marker: string): RegExp {
  return new RegExp(String.raw`^${marker}[ \t]*\r?$`, 'm')
}

const START_LINE = lineAnchored(START_MARKER)
const END_LINE = lineAnchored(END_MARKER)

/**
 * Separator placed BEFORE the block when inserting at the bottom.
 *
 * Only ever additive: it tops up the newlines the body already ends with so that
 * exactly one blank line sits between the author's text and the block. Trimming
 * the body instead would be shorter and would also be a deletion of the author's
 * bytes, which is the one thing this module must never do.
 */
function gapBefore(text: string): string {
  if (text.endsWith('\n\n')) {
    return ''
  }
  return text.endsWith('\n') ? '\n' : '\n\n'
}

/** Mirror of {@link gapBefore} for insertion at the top. Equally additive. */
function gapAfter(text: string): string {
  if (text.startsWith('\n\n')) {
    return ''
  }
  return text.startsWith('\n') ? '\n' : '\n\n'
}

/**
 * Whether the body opts out of decoration entirely.
 *
 * Matched anywhere, not line-anchored: the marker is a deliberate act by the
 * author, and someone who writes it at the end of a sentence means it. Nothing
 * this action renders can re-introduce it — the commit renderer strips literal
 * marker text out of subjects, and the author renderer escapes both angle
 * brackets — so a `true` here always comes from a human.
 *
 * @param body - The pull request body; `null` for a body GitHub reports as unset.
 * @returns `true` when the opt-out marker appears anywhere in the body.
 */
export function hasSkipMarker(body: string | null): boolean {
  return (body ?? '').includes(SKIP_MARKER)
}

/**
 * Locates the managed block.
 *
 * Only a start followed by a matching end counts. A stray end marker with no
 * start before it is prose, and a start with no end after it is an unclosed block
 * — reported as `null` here, and refused rather than repaired by
 * {@link upsertBlock}.
 *
 * @param body - The pull request body; `null` is treated as empty.
 * @returns The block's half-open range, or `null` when there is no complete block.
 */
export function findBlock(body: string | null): BlockRange | null {
  const text = body ?? ''

  const startMatch = START_LINE.exec(text)
  if (startMatch === null) {
    return null
  }
  const start = startMatch.index
  const afterStart = start + startMatch[0].length

  // Searched in a slice rather than from an offset, which keeps `^` meaningful.
  // The slice can never begin mid-line: the start pattern matched through its own
  // line end, so what follows is a newline or nothing at all.
  const endMatch = END_LINE.exec(text.slice(afterStart))
  if (endMatch === null) {
    return null
  }

  return { start, end: afterStart + endMatch.index + endMatch[0].length }
}

/**
 * Writes the block into the body, replacing an existing one or inserting a first.
 *
 * An existing block is replaced WHERE IT SITS, whatever `position` says — moving a
 * block the author has already scrolled past is a surprise, and `position` is a
 * first-write choice. Everything before the start marker and after the end marker
 * comes back byte-for-byte.
 *
 * @param body - The current pull request body; `null` and `''` both mean empty.
 * @param block - The complete rendered block, markers included. Emitted verbatim.
 * @param position - Where a FIRST block goes. Ignored when one already exists.
 * @returns The new body and which of the three outcomes applied. On `unclosed` the
 *   body is returned unchanged — a start marker whose end is missing is a body in
 *   an unknown state, and no edit is safe.
 */
export function upsertBlock(
  body: string | null,
  block: string,
  position: Position,
): UpsertResult {
  const text = body ?? ''

  const existing = findBlock(text)
  if (existing !== null) {
    return {
      body: text.slice(0, existing.start) + block + text.slice(existing.end),
      action: 'replaced',
    }
  }

  // No complete block, but a start marker: the end was edited away or truncated.
  // Inserting now would leave two starts and one end, so nothing is touched.
  if (START_LINE.test(text)) {
    return { body: text, action: 'unclosed' }
  }

  if (text === '') {
    return { body: block, action: 'inserted' }
  }

  return {
    body: position === 'top' ? block + gapAfter(text) + text : text + gapBefore(text) + block,
    action: 'inserted',
  }
}

/**
 * How many characters of the body belong to the author rather than to the block.
 *
 * This is the figure the truncation budget starts from: whatever is left of
 * GitHub's body limit once the author's own prose is accounted for. Measured in
 * UTF-16 code units, the same unit the rest of the budget arithmetic uses.
 *
 * A body with an unclosed marker has no locatable block, so its full length counts
 * as the author's — conservative in the right direction, and moot in practice
 * because that body is never written to.
 *
 * @param body - The pull request body; `null` is treated as empty.
 * @returns The length of everything outside the managed block, or the whole length
 *   when there is no block.
 */
export function outsideLength(body: string | null): number {
  const text = body ?? ''
  const block = findBlock(text)
  return block === null ? text.length : text.length - (block.end - block.start)
}
