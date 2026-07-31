import * as core from '@actions/core'

/**
 * Entrypoint stub. The real orchestration — input parsing, the GitHub client,
 * rendering and the body write — is assembled here later; this only proves the
 * toolchain compiles and bundles.
 */
export async function run(): Promise<void> {
  core.info('pr-decorator: nothing to do yet, orchestration is not implemented.')
}

// Not top-level await: the ncc bundle is CommonJS.
void run()

// probe: src changed without rebuilding dist/

const unusedProbe: any = 1

// probe: src changed without rebuilding dist/
