import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

/**
 * The CI workflow itself has no unit tests — the workflow IS the artifact and is
 * verified by observing real runs. What is tested here is the one invariant a
 * green run cannot prove: that the Node major the bundle is BUILT with in CI is
 * the same major the action is RUN with by consumers (`runs.using` in
 * action.yml) and the same major the repository declares in `engines`. Those
 * three live in three files and drift silently, so the check is executable
 * rather than a review note.
 *
 * The permissions and secrets assertions are here for the same reason: a
 * workflow that quietly gains `contents: write` or a secret reference is a
 * supply-chain change, and nothing else in the build would notice.
 */

interface WorkflowStep {
  name?: string
  uses?: string
  run?: string
  with?: Record<string, string | number | boolean>
}

interface CiWorkflow {
  on?: Record<string, unknown>
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean }
  permissions?: Record<string, string>
  jobs?: Record<string, { steps?: WorkflowStep[] }>
}

interface ActionYml {
  runs?: { using?: string }
}

interface PackageJson {
  engines?: { node?: string }
}

const readRepoFile = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8')

const workflowSource = readRepoFile('.github/workflows/ci.yml')
const workflow = parse(workflowSource) as CiWorkflow
const action = parse(readRepoFile('action.yml')) as ActionYml
const pkg = JSON.parse(readRepoFile('package.json')) as PackageJson

const steps = Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? [])

const majorOf = (value: string | undefined, label: string): number => {
  const match = /(\d+)/.exec(value ?? '')
  if (!match) throw new Error(`no Node major found in ${label}: ${String(value)}`)
  return Number(match[1])
}

describe('.github/workflows/ci.yml', () => {
  it('builds the bundle on the same Node major the action runs on', () => {
    const setupNode = steps.filter((step) => step.uses?.startsWith('actions/setup-node@'))
    expect(setupNode).toHaveLength(1)

    const nodeVersion = setupNode[0]?.with?.['node-version']
    expect(nodeVersion, 'setup-node needs an explicit node-version').toBeDefined()

    expect(majorOf(String(nodeVersion), 'ci.yml node-version')).toBe(
      majorOf(action.runs?.using, 'action.yml runs.using'),
    )
  })

  it('declares the same Node major in package.json engines', () => {
    const setupNode = steps.find((step) => step.uses?.startsWith('actions/setup-node@'))
    expect(majorOf(String(setupNode?.with?.['node-version']), 'ci.yml node-version')).toBe(
      majorOf(pkg.engines?.node, 'package.json engines.node'),
    )
  })

  it('runs on pull requests and on pushes to main, with a concurrency group', () => {
    // `on:` is the YAML 1.1 boolean `true` once parsed, hence the lookup on both.
    const triggers = (workflow.on ?? (workflow as Record<string, unknown>)['true']) as
      | Record<string, { branches?: string[] }>
      | undefined
    expect(Object.keys(triggers ?? {})).toEqual(['pull_request', 'push'])
    expect(triggers?.push?.branches).toEqual(['main'])
    expect(workflow.concurrency?.group).toBeTruthy()
  })

  it('installs, lints, tests, packages and then gates dist/, in that order', () => {
    const commands = steps.map((step) => step.run ?? '').filter(Boolean)
    const indexOf = (needle: string): number => {
      const index = commands.findIndex((command) => command.includes(needle))
      expect(index, `no CI step runs ${needle}`).toBeGreaterThanOrEqual(0)
      return index
    }

    const order = ['npm ci', 'npm run lint', 'npm test', 'npm run package'].map(indexOf)
    expect(order).toEqual([...order].sort((a, b) => a - b))

    const lastBuildStep = Math.max(...order)
    expect(indexOf('git diff --exit-code dist/')).toBeGreaterThan(lastBuildStep)
    // A rebuilt chunk that is not tracked yet is invisible to `git diff`.
    expect(indexOf('git status --porcelain dist/')).toBeGreaterThan(lastBuildStep)
  })

  it('asks for read-only contents and nothing else', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' })
  })

  it('references no secrets', () => {
    expect(workflowSource).not.toMatch(/secrets\./)
  })

  it('pins every action it uses to a version', () => {
    for (const step of steps.filter((candidate) => candidate.uses)) {
      expect(step.uses, 'unpinned action reference').toMatch(/@(v\d+(\.\d+)*|[0-9a-f]{40})$/)
    }
  })
})
