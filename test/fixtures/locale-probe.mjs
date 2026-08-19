import process from 'node:process'

// Plain ESM JavaScript, not TypeScript, and imported with an explicit `.ts`
// extension: this file is executed by bare `node` rather than through vitest, so
// it must resolve by exact filename and must not need `allowImportingTsExtensions`
// (ncc overrides `noEmit`, so that option cannot be enabled repo-wide).
import { renderTitle } from '../../src/render/title.ts'

/**
 * The locale-independence probe for {@link renderTitle}, the counterpart to
 * `test/fixtures/tz-probe.mjs` for timezone. `renderTitle` must depend only on
 * its arguments, never on the runtime's default ICU locale, so this file
 * exists to be run twice under different `LANG`/`LC_ALL` values and diffed:
 * `test/render/title.test.ts` spawns it and asserts the two reports are
 * byte-identical. A Turkish default locale is the one that would expose a
 * `toLocaleLowerCase()` mistake, because it maps `I` to the dotless `ı`.
 */

/** Titles chosen to contain the capital `I` the Turkish locale cases specially. */
const PROBE_CASES = [
  ['1', 'Issue about API'],
  ['142', 'Fix OAuth token refresh'],
  ['7', 'IMPORTANT: investigate flaky CI'],
]

/**
 * Builds the report. Deterministic, and identical for every default locale.
 *
 * @returns {string} One tab-separated record per line, no trailing newline.
 */
export function probeReport() {
  return PROBE_CASES.map(
    ([issueNumber, issueTitle]) =>
      `${issueNumber}\t${JSON.stringify(issueTitle)}\t${String(renderTitle(issueNumber, issueTitle))}`,
  ).join('\n')
}

// Printing is opt-in via the flag rather than a main-module check, which would
// have to compare `import.meta.url` against `process.argv[1]` and is brittle
// about drive-letter casing on Windows.
if (process.argv.includes('--print')) {
  process.stdout.write(probeReport())
}
