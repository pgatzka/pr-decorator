/**
 * Timestamp formatting for the managed block. Two pure functions with no
 * dependency on the Actions toolkit — the render layer formats through here and
 * nowhere else, and a test asserts the toolkit stays out of this file.
 *
 * The runner's host timezone is not guaranteed and is deliberately never read.
 * Output depends only on the instant and the `timeZone` argument, which is what
 * keeps the golden-file tests stable across runners.
 */

/**
 * A fixed locale so no host locale can leak into the output. The block format is
 * assembled from `formatToParts`, so the locale only has to be one ICU accepts —
 * its own date layout is never used.
 */
const FORMAT_LOCALE = 'en-CA'

/**
 * One formatter per zone. A 250-commit pull request formats 250 instants against
 * the same zone, and `Intl.DateTimeFormat` construction is the expensive half.
 * Keyed on the zone name alone — nothing here depends on host state, so the
 * cache cannot make two runs disagree.
 */
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone)
  if (cached !== undefined) {
    return cached
  }
  const formatter = new Intl.DateTimeFormat(FORMAT_LOCALE, {
    timeZone,
    // h23 and not h24: midnight must render as `00:00`, never `24:00`. `hour12`
    // is left unset on purpose — setting it would override `hourCycle`.
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
  formatters.set(timeZone, formatter)
  return formatter
}

function part(
  parts: readonly Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
  width: number,
): string {
  const found = parts.find((candidate) => candidate.type === type)
  if (found === undefined) {
    throw new Error(`Intl.DateTimeFormat produced no ${type} part`)
  }
  return found.value.padStart(width, '0')
}

/**
 * Formats an instant as `YYYY-MM-DD HH:mm` in `timeZone`.
 *
 * Takes a `Date` and never an ISO string, so a caller cannot smuggle in a
 * differently formatted timestamp — the timezone is applied exactly once, here.
 *
 * @param instant - The commit author date as an instant.
 * @param timeZone - An IANA zone name; validate it with {@link isValidTimeZone}
 *   first, because ICU throws a `RangeError` on anything it does not accept.
 * @returns The zero-padded local date and time, e.g. `2026-07-28 09:14`.
 */
export function formatInstant(instant: Date, timeZone: string): string {
  const parts = formatterFor(timeZone).formatToParts(instant)
  const year = part(parts, 'year', 4)
  const month = part(parts, 'month', 2)
  const day = part(parts, 'day', 2)
  const hour = part(parts, 'hour', 2)
  const minute = part(parts, 'minute', 2)
  return `${year}-${month}-${day} ${hour}:${minute}`
}

/**
 * Reports whether the runtime's ICU accepts `timeZone` as an IANA zone name.
 *
 * ICU is the single authority: no zone table is bundled, and the check is the
 * same construction {@link formatInstant} performs, so anything accepted here
 * formats without throwing.
 *
 * Note that ICU matches zone names case-insensitively, so `europe/berlin` is
 * accepted. Callers wanting canonical casing must enforce it themselves.
 *
 * @param timeZone - The candidate name, e.g. from the `timezone` input.
 * @returns `true` if ICU accepts it; `false` for `''`, `UTC+2`, `Mars/Phobos`
 *   and every other non-IANA string.
 */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat(FORMAT_LOCALE, { timeZone })
    return true
  } catch (error) {
    if (error instanceof RangeError) {
      return false
    }
    throw error
  }
}
