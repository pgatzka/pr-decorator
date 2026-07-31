import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { formatInstant, isValidTimeZone } from '../src/time'

/**
 * `src/time.ts` is the single place a timezone is applied, so what has to be
 * proven here is determinism: the same instant and zone render identically
 * regardless of the runner's own timezone, across DST jumps, and forever.
 */

/** A summer instant: Europe/Berlin is at UTC+2, so 07:14Z is 09:14 local. */
const SUMMER = new Date('2026-07-28T07:14:00.000Z')

describe('formatInstant', () => {
  it('renders the documented example exactly', () => {
    expect(formatInstant(SUMMER, 'Europe/Berlin')).toBe('2026-07-28 09:14')
  })

  it('renders the same instant in UTC without an offset applied', () => {
    expect(formatInstant(SUMMER, 'UTC')).toBe('2026-07-28 07:14')
  })

  it('renders a zone whose offset is behind UTC', () => {
    // Buenos Aires is UTC-3 year round.
    expect(formatInstant(SUMMER, 'America/Argentina/Buenos_Aires')).toBe('2026-07-28 04:14')
  })

  it('crosses the date boundary when the zone is far enough ahead', () => {
    // Kiritimati is UTC+14, the furthest-ahead zone there is.
    expect(formatInstant(SUMMER, 'Pacific/Kiritimati')).toBe('2026-07-28 21:14')
  })

  it('renders midnight as 00:00 and never as 24:00', () => {
    // 22:00Z on the 27th is exactly midnight on the 28th in Berlin.
    expect(formatInstant(new Date('2026-07-27T22:00:00.000Z'), 'Europe/Berlin')).toBe(
      '2026-07-28 00:00',
    )
    expect(formatInstant(new Date('2026-07-28T00:00:00.000Z'), 'UTC')).toBe('2026-07-28 00:00')
  })

  it('zero-pads single-digit month, day and hour', () => {
    expect(formatInstant(new Date('2026-01-05T04:07:00.000Z'), 'UTC')).toBe('2026-01-05 04:07')
  })

  describe('across the 2026 Europe/Berlin DST transitions', () => {
    it('jumps 01:59 to 03:00 when clocks spring forward on 29 March', () => {
      // 01:00Z is the transition: CET (UTC+1) becomes CEST (UTC+2), so 02:00
      // local never happens.
      expect(formatInstant(new Date('2026-03-29T00:59:00.000Z'), 'Europe/Berlin')).toBe(
        '2026-03-29 01:59',
      )
      expect(formatInstant(new Date('2026-03-29T01:00:00.000Z'), 'Europe/Berlin')).toBe(
        '2026-03-29 03:00',
      )
    })

    it('repeats the 02:00 hour when clocks fall back on 25 October', () => {
      // 01:00Z is the transition: CEST (UTC+2) becomes CET (UTC+1), so 02:00
      // local happens twice. Both instants are distinct and both render in the
      // repeated hour — the offset comes from the instant, never from a guess.
      expect(formatInstant(new Date('2026-10-25T00:59:00.000Z'), 'Europe/Berlin')).toBe(
        '2026-10-25 02:59',
      )
      expect(formatInstant(new Date('2026-10-25T01:00:00.000Z'), 'Europe/Berlin')).toBe(
        '2026-10-25 02:00',
      )
    })

    it('applies no transition at all in a zone that does not observe DST', () => {
      expect(formatInstant(new Date('2026-03-29T00:59:00.000Z'), 'UTC')).toBe('2026-03-29 00:59')
      expect(formatInstant(new Date('2026-03-29T01:00:00.000Z'), 'UTC')).toBe('2026-03-29 01:00')
    })
  })

  it('is stable when the same zone is formatted repeatedly', () => {
    // The formatter is memoized per zone; interleaving zones must not let one
    // cached formatter answer for another.
    expect(formatInstant(SUMMER, 'Europe/Berlin')).toBe('2026-07-28 09:14')
    expect(formatInstant(SUMMER, 'UTC')).toBe('2026-07-28 07:14')
    expect(formatInstant(SUMMER, 'Europe/Berlin')).toBe('2026-07-28 09:14')
    expect(formatInstant(SUMMER, 'UTC')).toBe('2026-07-28 07:14')
  })

  it('rejects a zone ICU does not know', () => {
    expect(() => formatInstant(SUMMER, 'Mars/Phobos')).toThrow(RangeError)
  })
})

describe('isValidTimeZone', () => {
  it.each(['Europe/Berlin', 'UTC', 'America/Argentina/Buenos_Aires', 'Etc/GMT+2'])(
    'accepts %s',
    (name) => {
      expect(isValidTimeZone(name)).toBe(true)
    },
  )

  it.each(['', 'Mars/Phobos', 'UTC+2', 'Europe//Berlin', 'Europe Berlin'])(
    'rejects %s',
    (name) => {
      expect(isValidTimeZone(name)).toBe(false)
    },
  )

  // The next two pin down runtime behaviour that is easy to assume wrongly. Both
  // are asserted as observed, not as preferred.
  it('accepts a zone name in non-canonical casing, because ICU matches case-insensitively', () => {
    expect(isValidTimeZone('Europe/berlin')).toBe(true)
    expect(formatInstant(SUMMER, 'Europe/berlin')).toBe(formatInstant(SUMMER, 'Europe/Berlin'))
  })

  it('accepts a bare UTC offset identifier, which ICU treats as a valid zone', () => {
    expect(isValidTimeZone('+02:00')).toBe(true)
  })

  it('accepts every name it reports as valid without formatInstant throwing', () => {
    for (const name of ['Europe/Berlin', 'UTC', 'Etc/GMT+2', '+02:00']) {
      expect(isValidTimeZone(name), name).toBe(true)
      expect(() => formatInstant(SUMMER, name)).not.toThrow()
    }
  })
})

describe('module boundaries', () => {
  it('imports nothing from @actions', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/time.ts', import.meta.url)), 'utf8')
    expect(source).not.toContain('@actions')
  })
})

describe('host timezone independence', () => {
  const probe = fileURLToPath(new URL('./fixtures/tz-probe.mjs', import.meta.url))

  /** Runs the probe in a child process whose host timezone is `TZ`. */
  function reportUnderHostTimezone(TZ: string): string {
    // The probe imports a `.ts` file from a package.json without `"type"`, which
    // makes Node warn before falling back to ES module parsing. Only that one
    // warning is silenced, so anything genuinely new still shows up.
    const args = ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', probe, '--print']
    return execFileSync(process.execPath, args, {
      env: { ...process.env, TZ },
      encoding: 'utf8',
      // stderr is inherited so a crashing probe surfaces its stack; only stdout
      // is compared.
      stdio: ['ignore', 'pipe', 'inherit'],
    })
  }

  it(
    'renders identically whether the host is UTC or UTC+14',
    () => {
      const utc = reportUnderHostTimezone('UTC')
      const kiritimati = reportUnderHostTimezone('Pacific/Kiritimati')

      // Anchor the comparison: an empty or truncated report would otherwise make
      // the equality below pass for the wrong reason.
      expect(utc).toContain('format\tEurope/Berlin\t2026-07-28T07:14:00.000Z\t2026-07-28 09:14')
      expect(utc.split('\n')).toHaveLength(37)

      expect(kiritimati).toBe(utc)
    },
    60_000,
  )
})
