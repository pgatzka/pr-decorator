import process from 'node:process'

// Plain ESM JavaScript, not TypeScript, and imported with an explicit `.ts`
// extension: this file is executed by bare `node` rather than through vitest, so
// it must resolve by exact filename and must not need `allowImportingTsExtensions`
// (ncc overrides `noEmit`, so that option cannot be enabled repo-wide).
import { formatInstant, isValidTimeZone } from '../../src/time.ts'

/**
 * The host-independence probe. Formatting must depend only on the instant and
 * the `timeZone` argument, never on the runner's own timezone, so this file
 * exists to be run twice under different `TZ` values and diffed:
 * `test/time.test.ts` spawns it and asserts the two reports are byte-identical.
 *
 * The report is built here rather than in the test so both runs are provably
 * driven by the same inputs.
 */

/** Instants covering DST edges, midnight and single-digit date components. */
const PROBE_INSTANTS = [
  '2026-07-28T07:14:00.000Z',
  // Either side of the 2026 Europe/Berlin spring-forward jump.
  '2026-03-29T00:59:00.000Z',
  '2026-03-29T01:00:00.000Z',
  // Either side of the 2026 Europe/Berlin fall-back jump.
  '2026-10-25T00:59:00.000Z',
  '2026-10-25T01:00:00.000Z',
  // Berlin midnight, and a date whose every component needs zero-padding.
  '2026-07-27T22:00:00.000Z',
  '2026-01-05T04:07:00.000Z',
]

/** Zones every instant is formatted in. */
const PROBE_ZONES = [
  'Europe/Berlin',
  'UTC',
  'America/Argentina/Buenos_Aires',
  'Pacific/Kiritimati',
]

/** Names run through `isValidTimeZone`, valid and invalid alike. */
const PROBE_NAMES = [
  'Europe/Berlin',
  'UTC',
  'America/Argentina/Buenos_Aires',
  'Etc/GMT+2',
  'Europe/berlin',
  '',
  'Mars/Phobos',
  'UTC+2',
  '+02:00',
]

/**
 * Builds the report. Deterministic, and identical for every host timezone.
 *
 * @returns {string} One tab-separated record per line, no trailing newline.
 */
export function probeReport() {
  const lines = []
  for (const zone of PROBE_ZONES) {
    for (const iso of PROBE_INSTANTS) {
      lines.push(`format\t${zone}\t${iso}\t${formatInstant(new Date(iso), zone)}`)
    }
  }
  for (const name of PROBE_NAMES) {
    lines.push(`valid\t${JSON.stringify(name)}\t${String(isValidTimeZone(name))}`)
  }
  return lines.join('\n')
}

// Printing is opt-in via the flag rather than a main-module check, which would
// have to compare `import.meta.url` against `process.argv[1]` and is brittle
// about drive-letter casing on Windows.
if (process.argv.includes('--print')) {
  process.stdout.write(probeReport())
}
