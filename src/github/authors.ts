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
 * **The returned string is final.** It is fully escaped here and the bullet
 * renderer emits it verbatim. That split is the whole point: this module escapes
 * names, the renderer escapes subjects, and neither re-escapes the other's
 * output, so a name can never pick up a second backslash.
 */

import type { MentionStyle } from '../types'

import type { CommitPayload } from './client'

/** Rendered when no usable name exists at all, so the field is never blank. */
export const UNKNOWN_AUTHOR = 'unknown'

/** GitHub appends this to every App identity; such a login is not mentionable. */
const BOT_LOGIN_SUFFIX = '[bot]'

/** The account GitHub attributes web-editor commits to. Not a person. */
const WEB_EDITOR_LOGIN = 'web-flow'

/**
 * Every character that could turn a name into markup inside a bullet: emphasis,
 * code, link and image syntax, raw HTML, an issue reference, a mention, and the
 * table cell separator. The backslash is first in the class for the human
 * reader; the regex is applied in one pass, so an inserted backslash is never
 * itself re-escaped.
 */
const MARKDOWN_SPECIAL = /[\\`*_[\]<>#@|]/g

/** Any run of whitespace, including the CR and LF that would break the bullet. */
const WHITESPACE_RUN = /\s+/g

/**
 * Collapses a git author name or login to a single line and escapes it.
 *
 * Whitespace collapsing comes first and is not cosmetic: a newline inside
 * `user.name` would end the bullet and let the rest of the name render as a new
 * list item. Escaping second means a literal `<!-- pr-decorator:end -->` in a
 * name survives as visible text but no longer matches the marker the block
 * parser looks for, because both angle brackets carry a backslash.
 */
function neutralize(text: string): string {
  return text.replace(WHITESPACE_RUN, ' ').trim().replace(MARKDOWN_SPECIAL, '\\$&')
}

/** The git author trailer's name, escaped, or {@link UNKNOWN_AUTHOR} if unusable. */
function gitAuthorName(apiCommit: CommitPayload): string {
  const name = neutralize(apiCommit.commit.author?.name ?? '')
  return name === '' ? UNKNOWN_AUTHOR : name
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

  // Classified on the raw login, emitted through `neutralize`. Doing it the
  // other way round would compare against an escaped `\[bot\]`.
  const login = apiCommit.author?.login.trim() ?? ''

  if (login === '') {
    return gitAuthorName(apiCommit)
  }
  if (login.endsWith(BOT_LOGIN_SUFFIX)) {
    // Escaped like any other plain text, which is what stops the `[bot]` suffix
    // from binding to a reference link definition someone left in the body.
    return neutralize(login)
  }
  if (login === WEB_EDITOR_LOGIN) {
    return gitAuthorName(apiCommit)
  }
  // Documented logins are alphanumeric plus `-`, so `neutralize` is a no-op on
  // every real one. It runs anyway: this module's contract is that no API string
  // reaches the body unescaped, and the `@` sigil below is ours, not theirs.
  return `@${neutralize(login)}`
}
