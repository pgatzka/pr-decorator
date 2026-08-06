/**
 * Author rendering for the commit bullet.
 *
 * The only trustworthy attribution source is the commits endpoint itself:
 * `author.login` when GitHub matched the commit email to an account, and the git
 * author trailer when it did not. There is deliberately no second lookup: no
 * user-search request, no commit-email resolution, nothing (D3). A test greps
 * the whole of `src/` for the search route to keep it that way. Such a lookup
 * would turn a bounded action into one request per unmatched author, and it
 * would guess at an identity GitHub itself declined to assert.
 *
 * Two logins must never become mentions. `@dependabot[bot]` does not resolve as
 * a mention on GitHub, and `web-flow` is the web editor's identity rather than
 * the person who pressed the button.
 *
 * **The returned string is final.** It is fully neutralized here and the bullet
 * renderer emits it verbatim. That split is the whole point: this module owns the
 * author field, the renderer owns the subject, and neither re-processes the
 * other's output.
 *
 * The two are neutralized differently because they are different kinds of string.
 * A git author name is untrusted — whoever pushed the commit chose it with
 * `git config user.name` — so it goes into a code span, exactly like a subject and
 * for the same measured reason (D7): a backslash escape leaves GitHub's
 * closing-keyword pass free to act, so a contributor named after a closing keyword
 * and an issue number would close that issue on merge. A LOGIN is not untrusted in
 * that way. It comes from GitHub's own namespace, cannot contain a `#` or an `@`,
 * and in the `@login` case it MUST stay unwrapped — a code span would render a
 * mention inert, and notifying is the point of rendering one at all.
 */

import { codeSpan, stripMarkerShapedComments } from '../markdown'
import type { MentionStyle } from '../types'

import type { CommitPayload } from './client'

/** Rendered when no usable name exists at all, so the field is never blank. */
export const UNKNOWN_AUTHOR = 'unknown'

/** GitHub appends this to every App identity; such a login is not mentionable. */
const BOT_LOGIN_SUFFIX = '[bot]'

/** The account GitHub attributes web-editor commits to. Not a person. */
const WEB_EDITOR_LOGIN = 'web-flow'

/**
 * The characters that could turn a LOGIN into markup: link and image syntax, and
 * raw HTML. A documented login is alphanumeric plus `-`, so this is a no-op on
 * every real one and exists because no API string should reach the body unchecked
 * — with one exception that matters, the `[bot]` suffix, whose raw brackets would
 * otherwise bind to a `[bot]: …` reference definition left elsewhere in the body.
 *
 * The backslash is first in the class for the human reader; the regex is applied in
 * one pass, so an inserted backslash is never itself re-escaped.
 */
const LOGIN_SPECIAL = /[\\`*_[\]<>|]/g

/** Any run of whitespace, including the CR and LF that would break the bullet. */
const WHITESPACE_RUN = /\s+/g

/**
 * Collapses a login to a single line and escapes what markdown would act on.
 *
 * Escaping rather than wrapping, because the caller may prefix an `@` to the
 * result and that mention has to stay live. See the note at the top of the file for
 * why a login can be treated this way and a git name cannot.
 */
function neutralizeLogin(text: string): string {
  return text.replace(WHITESPACE_RUN, ' ').trim().replace(LOGIN_SPECIAL, '\\$&')
}

/**
 * The git author trailer's name, made inert, or {@link UNKNOWN_AUTHOR} if unusable.
 *
 * Whitespace collapsing comes first and is not cosmetic: a newline inside
 * `user.name` would end the bullet and let the rest of the name render as a new
 * list item. Marker text is then removed outright rather than wrapped — a code span
 * hides a marker from the renderer, but the block parser scans lines, so a marker
 * left inside one would still cut the managed block in half.
 *
 * {@link UNKNOWN_AUTHOR} is deliberately NOT wrapped: inside a code span means the
 * commit supplied it, outside means this action did, so a contributor who really is
 * called `unknown` is still distinguishable from a missing trailer.
 */
function gitAuthorName(apiCommit: CommitPayload): string {
  const raw = apiCommit.commit.author?.name ?? ''
  const name = stripMarkerShapedComments(raw.replace(WHITESPACE_RUN, ' ')).trim()
  return name === '' ? UNKNOWN_AUTHOR : codeSpan(name)
}

/**
 * Resolves the rendered author for one commit.
 *
 * The rules are applied in this order and the first match wins:
 *
 * 1. `mentions: 'name'` — always the plain git name, never an `@`.
 * 2. A `[bot]` login — the login as plain text, without a leading `@`.
 * 3. `web-flow` — the git author name, because the login is the web editor.
 * 4. No matched account — the git author name.
 * 5. Otherwise — `@<login>`.
 *
 * @param apiCommit - One raw commit as the commits endpoint serves it.
 * @param mentions - The `mentions` input: `'login'` for `@mentions`, `'name'`
 *   for plain git names.
 * @returns The final, already-escaped text for the author field. Emit it
 *   verbatim; escaping it again renders a visible backslash.
 */
export function resolveMention(apiCommit: CommitPayload, mentions: MentionStyle): string {
  if (mentions === 'name') {
    return gitAuthorName(apiCommit)
  }

  // Classified on the raw login, emitted through `neutralizeLogin`. Doing it the
  // other way round would compare against an escaped `\[bot\]`.
  const login = apiCommit.author?.login.trim() ?? ''

  if (login === '') {
    return gitAuthorName(apiCommit)
  }
  if (login.endsWith(BOT_LOGIN_SUFFIX)) {
    // Escaped rather than wrapped, so it still reads as a name beside the plain
    // `@mentions` around it. Safe to leave unwrapped: the dangerous sigils cannot
    // occur in a login, and the brackets that CAN are escaped here.
    return neutralizeLogin(login)
  }
  if (login === WEB_EDITOR_LOGIN) {
    return gitAuthorName(apiCommit)
  }
  // The `@` sigil is ours, not theirs, and it has to stay live — this is the one
  // field in the block that is meant to notify somebody.
  return `@${neutralizeLogin(login)}`
}
