/**
 * The bundle's entrypoint, and deliberately nothing else.
 *
 * A JavaScript action is executed by the runner loading `dist/index.js`, so the run
 * has to start as a side effect of the module being imported. Keeping that one line
 * out of `src/main.ts` is what lets the test suite import the orchestration and
 * drive `run()` itself: importing a module that starts the run on load would fire an
 * unmockable second pass on every test file that touches it.
 *
 * Nothing is awaited here because there is nothing to await it: `run()` reports every
 * failure through the Actions toolkit and never rejects.
 */

import { run } from './main'

void run()
