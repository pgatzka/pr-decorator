/**
 * The action's fail-fast surface: the one place where raw `INPUT_*` strings
 * become typed, validated configuration.
 *
 * Everything arrives as a string, so every type, enum and regex is parsed here
 * and nowhere else — a test asserts `getInput` and `getBooleanInput` appear in
 * this file alone. Downstream modules receive a {@link DecoratorInputs} whose
 * values are already known-good and never re-check them.
 *
 * **`required: true` is documentation.** The Actions runner does not enforce it
 * for JavaScript actions: an omitted `timezone` simply leaves `INPUT_TIMEZONE`
 * unset and the action would happily format every timestamp in whatever zone it
 * guessed. So the mandatory input is checked at runtime, first, before any
 * network call — a run that cannot be correct must fail rather than write a
 * wrong block.
 *
 * **Severity is not decided here.** Every failure is a fatal
 * {@link DecoratorError}; the entrypoint owns the single mapping onto
 * `core.setFailed` / `core.warning` / `core.notice`.
 */

import * as core from '@actions/core'

import { DecoratorError } from './errors'
import { isValidTimeZone } from './time'
import type { DecoratorInputs, MentionStyle, Position } from './types'

/**
 * The longest head branch name the action will match `branch-pattern` against.
 *
 * This is a ReDoS bound, not a judgement about what a valid branch name is. The
 * pattern is user-supplied and can be catastrophically backtracking; the branch
 * name is attacker-influenceable on a fork pull request. Capping the subject
 * bounds the damage to a constant, which is the only mitigation available
 * without a regex engine that takes a timeout.
 *
 * 255 is the per-component limit Git inherits from the filesystem, so a
 * single-segment branch name cannot legitimately exceed it and a real one is an
 * order of magnitude shorter. A `a/b/c/…` name could in principle be longer;
 * refusing to match it costs the `Closes #N` line and nothing else.
 */
export const MAX_BRANCH_NAME_LENGTH = 255

/** The `branch-pattern` default, kept identical to `action.yml`. */
const DEFAULT_BRANCH_PATTERN = String.raw`^(\d+)-`

/** The literals `core.getBooleanInput` accepts, quoted for its error message. */
const BOOLEAN_LITERALS = 'true, True, TRUE, false, False or FALSE'

const POSITIONS: readonly Position[] = ['top', 'bottom']
const MENTION_STYLES: readonly MentionStyle[] = ['login', 'name']

/** Every failure from this module is fatal; only the message differs. */
function fatal(message: string, cause?: unknown): DecoratorError {
  return cause === undefined
    ? new DecoratorError(message, 'fatal')
    : new DecoratorError(message, 'fatal', { cause })
}

function quoteList(values: readonly string[]): string {
  return values.map((value) => `\`${value}\``).join(' or ')
}

/**
 * Reads an input, trimmed. `''` means "absent" throughout this module: the
 * runner supplies `action.yml`'s defaults in a real run, but the defaults are
 * repeated here so `parseInputs()` is correct when called with nothing but
 * `INPUT_TIMEZONE` set — which is how the unit tests and any future direct
 * invocation exercise it.
 */
function read(name: string): string {
  return core.getInput(name)
}

/**
 * The mandatory input, checked before anything else so its error always wins.
 *
 * Both messages carry the literal token `timezone`. That is a contract, not a
 * coincidence: the pre-tag bundle smoke test asserts an `::error::` line
 * containing exactly that token, so rewording these means updating that
 * workflow step too.
 */
function parseTimezone(): string {
  const timezone = read('timezone')
  if (timezone === '') {
    throw fatal(
      'Input `timezone` is required and was empty. Set it to an IANA zone name, ' +
        'for example `Europe/Berlin`. Note that `required: true` in action.yml is ' +
        'documentation only — the Actions runner does not enforce it for JavaScript actions.',
    )
  }
  if (!isValidTimeZone(timezone)) {
    throw fatal(
      `Input \`timezone\` is not an IANA zone name this runtime accepts: \`${timezone}\`. ` +
        'Use a name like `Europe/Berlin` or `UTC`; offsets such as `UTC+2` are not zones.',
    )
  }
  return timezone
}

function parseToken(): string {
  const token = read('token')
  if (token === '') {
    throw fatal(
      'Input `token` is required and was empty. It defaults to `${{ github.token }}`; ' +
        'pass a token with `pull-requests: write` if you override it.',
    )
  }
  return token
}

/**
 * YAML boolean semantics, borrowed from the toolkit rather than reimplemented so
 * the accepted spellings cannot drift from what consumers read in the Actions
 * documentation. An absent input takes the default instead of reaching
 * `getBooleanInput`, which rejects `''` along with every other non-boolean.
 */
function parseBoolean(name: string, fallback: boolean): boolean {
  const raw = read(name)
  if (raw === '') {
    return fallback
  }
  try {
    return core.getBooleanInput(name)
  } catch (error) {
    throw fatal(
      `Input \`${name}\` must be a boolean — one of ${BOOLEAN_LITERALS}. Got \`${raw}\`.`,
      error,
    )
  }
}

function parseEnum<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = read(name)
  if (raw === '') {
    return fallback
  }
  const match = allowed.find((candidate) => candidate === raw)
  if (match === undefined) {
    throw fatal(`Input \`${name}\` must be ${quoteList(allowed)}. Got \`${raw}\`.`)
  }
  return match
}

/**
 * How many capturing groups `pattern` declares, asked of the regex engine rather
 * than of a hand-written scanner.
 *
 * Appending an empty alternative makes the copy match the empty string
 * unconditionally, and the resulting match array has one entry per capturing
 * group plus the whole match. Alternation binds loosest, so `X|` parses whenever
 * `X` does. This is structural — it reads the compiled pattern's shape and never
 * touches a branch name — which matters because trial-matching a sample branch
 * cannot tell "no group declared" from "group declared but did not participate",
 * and only the first of those is the misconfiguration worth failing on.
 *
 * Scanning the source for `(` by hand would have to get `\(`, `[(]`, `(?:`,
 * `(?=`, `(?<!` and `(?<name>` right; the engine already does.
 */
function countCapturingGroups(pattern: RegExp): number {
  const probe = new RegExp(`${pattern.source}|`)
  const match = probe.exec('')
  return match === null ? 0 : match.length - 1
}

/**
 * Compiles `branch-pattern`.
 *
 * Flags are not part of the contract and cannot be supplied: the input is a
 * pattern *source*, handed to `new RegExp(value)` with no second argument, so
 * the compiled pattern is never `g` or `y` and its `lastIndex` can never go
 * stale between calls. Nothing is stripped because nothing can get in — a value
 * written as `/^(\d+)-/g` is read as a source that matches literal slashes, not
 * as flags. The renderer defends the same hazard from its side by matching
 * through a flag-identical copy, so a pattern reaching it from anywhere else is
 * safe too.
 *
 * The capturing-group check is the point of this function. A pattern with no
 * group still matches happily and the renderer, seeing group 1 as `undefined`,
 * returns nothing — the `Closes #N` line would just quietly never appear. That
 * is exactly the silent misconfiguration worth turning into a loud failure at
 * parse time.
 */
function parseBranchPattern(): RegExp {
  const raw = read('branch-pattern')
  const source = raw === '' ? DEFAULT_BRANCH_PATTERN : raw

  let pattern: RegExp
  try {
    pattern = new RegExp(source)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw fatal(
      `Input \`branch-pattern\` is not a valid regular expression: \`${source}\`. ${detail}`,
      error,
    )
  }

  if (countCapturingGroups(pattern) === 0) {
    throw fatal(
      `Input \`branch-pattern\` must declare at least one capturing group; capture ` +
        `group 1 is read as the issue number. Got \`${source}\`, which captures nothing — ` +
        'wrap the number in parentheses, for example `^(\\d+)-`.',
    )
  }

  return pattern
}

/**
 * Bounds a head branch name before it is matched against `branch-pattern`.
 *
 * Kept here, next to {@link MAX_BRANCH_NAME_LENGTH}, rather than inside the
 * renderer: the renderer takes `(branchName, pattern)` and holds no opinion
 * about length, so the entrypoint applies this first and treats `null` as "no
 * closing reference" — the same outcome as a pattern that does not match.
 *
 * @param name - The head branch name, exactly as GitHub reports it.
 * @returns `name` unchanged, or `null` when it is longer than
 *   {@link MAX_BRANCH_NAME_LENGTH} UTF-16 code units.
 */
export function capBranchName(name: string): string | null {
  return name.length > MAX_BRANCH_NAME_LENGTH ? null : name
}

/**
 * Parses and validates all eight inputs.
 *
 * @returns The validated configuration. Every field is known-good; no caller
 *   re-validates.
 * @throws {DecoratorError} Fatal, on the first input that is missing, malformed
 *   or outside its allowed set. `timezone` is checked first, so a run with more
 *   than one problem reports the one that would have corrupted every timestamp.
 */
export function parseInputs(): DecoratorInputs {
  return {
    timezone: parseTimezone(),
    token: parseToken(),
    position: parseEnum('position', POSITIONS, 'top'),
    issueLink: parseBoolean('issue-link', true),
    branchPattern: parseBranchPattern(),
    footer: parseBoolean('footer', true),
    mentions: parseEnum('mentions', MENTION_STYLES, 'login'),
    dryRun: parseBoolean('dry-run', false),
  }
}
