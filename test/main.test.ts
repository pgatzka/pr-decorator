import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import * as core from '@actions/core'

import { END_MARKER, SKIP_MARKER, START_MARKER, type UpsertAction } from '../src/body/markers'
import type { PullRequestSummary } from '../src/github/client'
import { abbreviate, commitUrlBase, run, toRenderableCommit } from '../src/main'

import { buildRawCommit, nonMonotonicRawCommits, type RawCommit } from './fixtures/commits'

/**
 * Every module the entrypoint composes is already covered by its own suite, so what
 * is proven here is the SEQUENCE — and above all, how many writes leave the process.
 *
 * The action's real contract is not "renders a block"; it is "edits a pull request
 * body at most once, and only when the body would actually change". A run that
 * writes an identical body retriggers the very workflow that produced it, and a run
 * that fails on a fork puts a red X on a first-time contributor's pull request over
 * a cosmetic block. Both are counted rather than described: nearly every case below
 * asserts on the number of `PATCH` requests the mocked API received.
 *
 * The mock is an Octokit-shaped `request` function rather than a stubbed client, so
 * the real client — its paging, its 403 classification, its base-repository mapping —
 * runs inside every scenario.
 */

const mocked = vi.hoisted(() => ({
  context: {
    serverUrl: 'https://github.com',
    repo: { owner: 'pgatzka', repo: 'pr-decorator' },
    payload: {} as { pull_request?: { number: number } },
  },
  request: vi.fn<(route: string, params: Record<string, unknown>) => Promise<{ data: unknown }>>(),
}))

vi.mock('@actions/github', () => ({
  context: mocked.context,
  getOctokit: () => ({ request: mocked.request }),
}))

/**
 * Only the log surface is replaced. `getInput` and `getBooleanInput` stay real, so
 * the suite configures the action the way the runner does — through `INPUT_*` — and
 * the input parser is exercised rather than bypassed.
 */
vi.mock('@actions/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@actions/core')>()),
  info: vi.fn(),
  notice: vi.fn(),
  warning: vi.fn(),
  debug: vi.fn(),
  setFailed: vi.fn(),
}))

const MAIN_SOURCE = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8')

const PULL_ROUTE = 'GET /repos/{owner}/{repo}/pulls/{pull_number}'
const COMMITS_ROUTE = 'GET /repos/{owner}/{repo}/pulls/{pull_number}/commits'
const PATCH_ROUTE = 'PATCH /repos/{owner}/{repo}/pulls/{pull_number}'

const PULL_NUMBER = 42
const HEAD_SHA = '9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d'
const AUTHOR_TEXT = 'This is the description the author wrote.'

/** The literal the entrypoint branches on, taken from the union #8 exports. */
const UNCLOSED = 'unclosed' satisfies UpsertAction

/** Mutable API state; `install` closes over it, so a scenario can edit it mid-run. */
interface Api {
  body: string | null
  commits: RawCommit[]
  /** `null` means "as many as were served" — the ordinary case. */
  totalCommits: number | null
  headRef: string
  headSha: string
  baseOwner: string
  baseRepo: string
  /** HTTP status to reject a `PATCH` with, or `null` to let it through. */
  patchStatus: number | null
  /** HTTP status to reject the pre-write re-read with. */
  rereadStatus: number | null
}

function api(overrides: Partial<Api> = {}): Api {
  return {
    body: AUTHOR_TEXT,
    commits: nonMonotonicRawCommits,
    totalCommits: null,
    headRef: '42-add-the-parser',
    headSha: HEAD_SHA,
    baseOwner: 'pgatzka',
    baseRepo: 'pr-decorator',
    patchStatus: null,
    rereadStatus: null,
    ...overrides,
  }
}

/** An Octokit `RequestError` as far as the client's classifier is concerned. */
function httpError(status: number): Error {
  const error = new Error('Resource not accessible by integration') as Error & { status: number }
  error.status = status
  return error
}

/**
 * Wires the mocked Octokit to `state`.
 *
 * A successful `PATCH` writes back into `state.body`, which is what lets the
 * idempotency scenario run the action twice against one API instead of hand-feeding
 * the second run the first run's output.
 */
function install(state: Api): void {
  let pullReads = 0

  mocked.request.mockImplementation((route, params) => {
    if (route === PATCH_ROUTE) {
      if (state.patchStatus !== null) {
        return Promise.reject(httpError(state.patchStatus))
      }
      state.body = String(params.body)
      return Promise.resolve({ data: {} })
    }

    if (route === COMMITS_ROUTE) {
      const perPage = Number(params.per_page)
      const offset = (Number(params.page) - 1) * perPage
      return Promise.resolve({ data: state.commits.slice(offset, offset + perPage) })
    }

    if (route === PULL_ROUTE) {
      pullReads += 1
      // The first read is `getPullRequest`; every later one is the pre-write
      // re-read, which is the only one a read-only token can refuse differently.
      if (pullReads > 1 && state.rereadStatus !== null) {
        return Promise.reject(httpError(state.rereadStatus))
      }
      return Promise.resolve({
        data: {
          body: state.body,
          head: { ref: state.headRef, sha: state.headSha },
          base: { repo: { owner: { login: state.baseOwner }, name: state.baseRepo } },
          commits: state.totalCommits ?? state.commits.length,
        },
      })
    }

    return Promise.reject(new Error(`unexpected route: ${route}`))
  })
}

/** The toolkit's own mapping: uppercase, spaces to underscores, hyphens kept. */
function envName(input: string): string {
  return `INPUT_${input.replace(/ /g, '_').toUpperCase()}`
}

const BASE_INPUTS: Record<string, string> = {
  timezone: 'Europe/Berlin',
  token: 'ghs_test',
}

function setInputs(overrides: Record<string, string> = {}): void {
  for (const [name, value] of Object.entries({ ...BASE_INPUTS, ...overrides })) {
    process.env[envName(name)] = value
  }
}

function routeCalls(route: string): Record<string, unknown>[] {
  return mocked.request.mock.calls
    .filter(([called]) => called === route)
    .map(([, params]) => params)
}

function patchCount(): number {
  return routeCalls(PATCH_ROUTE).length
}

/** The body as it stands after the run — unchanged unless a `PATCH` went through. */
function writtenBody(state: Api): string {
  return state.body ?? ''
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('INPUT_')) {
      delete process.env[key]
    }
  }
  setInputs()
  mocked.context.serverUrl = 'https://github.com'
  mocked.context.repo = { owner: 'pgatzka', repo: 'pr-decorator' }
  mocked.context.payload = { pull_request: { number: PULL_NUMBER } }
})

describe('(a) the skip marker', () => {
  it('leaves the body untouched and never writes', async () => {
    const state = api({ body: `${AUTHOR_TEXT}\n\n${SKIP_MARKER}` })
    install(state)

    await run()

    expect(patchCount()).toBe(0)
    expect(writtenBody(state)).toContain(SKIP_MARKER)
    expect(core.notice).toHaveBeenCalledWith(expect.stringContaining('skip marker'))
    expect(core.setFailed).not.toHaveBeenCalled()
    // Opting out costs one request, not four: the commits are never listed.
    expect(routeCalls(COMMITS_ROUTE)).toHaveLength(0)
  })
})

describe('(b) the first write', () => {
  it('issues exactly one PATCH and places the block per position', async () => {
    const state = api()
    install(state)

    await run()

    expect(patchCount()).toBe(1)
    const body = writtenBody(state)
    // `position: top` is the default, so the block leads and the author's text
    // survives underneath it, byte for byte.
    expect(body.startsWith(START_MARKER)).toBe(true)
    expect(body).toContain(END_MARKER)
    expect(body).toContain(AUTHOR_TEXT)
    expect(body).toContain('Closes #42')
    expect(body).toContain('## Commits')
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('honours position: bottom on that first write', async () => {
    setInputs({ position: 'bottom' })
    const state = api()
    install(state)

    await run()

    const body = writtenBody(state)
    expect(body.startsWith(AUTHOR_TEXT)).toBe(true)
    expect(body.endsWith(END_MARKER)).toBe(true)
  })
})

describe('(c) the byte-identical skip', () => {
  it('makes no write on a second run against its own output', async () => {
    const state = api()
    install(state)

    await run()
    expect(patchCount()).toBe(1)
    const afterFirst = writtenBody(state)

    vi.clearAllMocks()
    install(state)
    await run()

    expect(patchCount()).toBe(0)
    expect(writtenBody(state)).toBe(afterFirst)
    expect(core.notice).toHaveBeenCalledWith(expect.stringContaining('already matches'))
    expect(core.setFailed).not.toHaveBeenCalled()
  })
})

describe('(d) dry-run', () => {
  it('logs the block and writes nothing', async () => {
    setInputs({ 'dry-run': 'true' })
    const state = api()
    install(state)

    await run()

    expect(patchCount()).toBe(0)
    expect(writtenBody(state)).toBe(AUTHOR_TEXT)
    const logged = vi.mocked(core.info).mock.calls.map(([message]) => message)
    expect(logged.some((message) => message.includes(START_MARKER))).toBe(true)
    expect(logged.some((message) => message.includes('dry-run'))).toBe(true)
    // Nothing is re-read either: there is no write for the re-read to protect.
    expect(routeCalls(PULL_ROUTE)).toHaveLength(1)
  })
})

describe('(e) a denied write', () => {
  it('warns and leaves the run green when the PATCH comes back 403', async () => {
    const state = api({ patchStatus: 403 })
    install(state)

    await run()

    // The denial is the API's answer, so the attempt has to be made: exactly one,
    // and nothing after it.
    expect(patchCount()).toBe(1)
    expect(mocked.request.mock.calls.at(-1)?.[0]).toBe(PATCH_ROUTE)
    expect(writtenBody(state)).toBe(AUTHOR_TEXT)
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('pull_request_target'))
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('treats a denied pre-write re-read the same way, with no PATCH at all', async () => {
    const state = api({ rereadStatus: 403 })
    install(state)

    await run()

    expect(patchCount()).toBe(0)
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('read-only GITHUB_TOKEN'))
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('still fails the run for a status that is not a denial', async () => {
    const state = api({ patchStatus: 500 })
    install(state)

    await run()

    expect(core.setFailed).toHaveBeenCalledTimes(1)
    expect(vi.mocked(core.setFailed).mock.calls[0]?.[0]).toContain('500')
  })
})

describe('(f) an unclosed block', () => {
  it('warns and writes nothing when the end marker is missing', async () => {
    const state = api({ body: `${START_MARKER}\nleftovers\n\n${AUTHOR_TEXT}` })
    install(state)

    await run()

    expect(patchCount()).toBe(0)
    expect(writtenBody(state)).not.toContain(END_MARKER)
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('no matching end marker'))
    expect(core.setFailed).not.toHaveBeenCalled()
    // The branch above is reached through `upsertBlock`'s own literal, not a
    // second spelling of it.
    expect(UNCLOSED).toBe('unclosed')
  })
})

describe('(g) a fatal DecoratorError', () => {
  it('calls setFailed exactly once for an invalid timezone', async () => {
    setInputs({ timezone: 'Mars/Phobos' })
    install(api())

    await run()

    expect(core.setFailed).toHaveBeenCalledTimes(1)
    expect(vi.mocked(core.setFailed).mock.calls[0]?.[0]).toContain('timezone')
    // Fails before the first request: a run that cannot be correct never asks.
    expect(mocked.request).not.toHaveBeenCalled()
  })
})

describe('(h) commit order', () => {
  it('renders the non-monotonic fixture in API list order end to end', async () => {
    const state = api()
    install(state)

    await run()

    const body = writtenBody(state)
    const positions = nonMonotonicRawCommits.map((commit) => body.indexOf(commit.sha.slice(0, 7)))
    expect(positions.every((position) => position >= 0)).toBe(true)
    // Index 2 is authored BEFORE index 1. Anything that sorts by date reorders it.
    expect([...positions].sort((left, right) => left - right)).toEqual(positions)
  })
})

describe('(i) an over-long branch name', () => {
  it('drops the closing reference, says so, and writes the rest of the block', async () => {
    const state = api({ headRef: `42-${'x'.repeat(300)}` })
    install(state)

    await run()

    expect(patchCount()).toBe(1)
    const body = writtenBody(state)
    expect(body).not.toContain('Closes #')
    expect(body).toContain('## Commits')
    expect(core.notice).toHaveBeenCalledWith(expect.stringContaining('branch-pattern'))
    expect(core.setFailed).not.toHaveBeenCalled()
  })
})

describe('a body with no room for the block', () => {
  it('warns rather than writing one the API would refuse', async () => {
    const state = api({ body: 'x'.repeat(65_450) })
    install(state)

    await run()

    expect(patchCount()).toBe(0)
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('too long'))
    expect(core.setFailed).not.toHaveBeenCalled()
  })
})

describe('an event without a pull request', () => {
  it('says so and exits without touching the API', async () => {
    mocked.context.payload = {}
    install(api())

    await run()

    expect(mocked.request).not.toHaveBeenCalled()
    expect(core.notice).toHaveBeenCalledWith(expect.stringContaining('no pull request'))
    expect(core.setFailed).not.toHaveBeenCalled()
  })
})

describe('the lost-update mitigation', () => {
  it('re-reads the body immediately before the PATCH', async () => {
    const state = api()
    install(state)

    await run()

    const routes = mocked.request.mock.calls.map(([route]) => route)
    const patchIndex = routes.indexOf(PATCH_ROUTE)
    // Two pull reads: the one the block is built from, and the one it is written
    // against. The second is the last thing that happens before the write.
    expect(routes.filter((route) => route === PULL_ROUTE)).toHaveLength(2)
    expect(routes[patchIndex - 1]).toBe(PULL_ROUTE)
  })

  it('writes the block against an edit made while the block was being rendered', async () => {
    const state = api()
    install(state)
    let pullReads = 0
    const inner = mocked.request.getMockImplementation()
    mocked.request.mockImplementation((route, params) => {
      if (route === PULL_ROUTE) {
        pullReads += 1
        if (pullReads === 2) {
          state.body = `${AUTHOR_TEXT}\n\nEdited after the first read.`
        }
      }
      return inner?.(route, params) ?? Promise.reject(new Error('no implementation'))
    })

    await run()

    expect(patchCount()).toBe(1)
    // The late edit survives: the block is written against the fresh copy, not
    // against the stale one it was sized from.
    expect(writtenBody(state)).toContain('Edited after the first read.')
  })
})

describe('the mapping contracts', () => {
  const FULL_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
  const AUTHOR_DATE = '2026-03-04T09:15:00.000Z'
  const COMMITTER_DATE = '2026-06-01T00:00:00.000Z'

  /** A commit whose committer date differs from its author date, as a rebase leaves it. */
  const rebased = (() => {
    const raw = buildRawCommit(
      { fullSha: FULL_SHA, authoredAt: new Date(AUTHOR_DATE), subject: 'Add the parser' },
      { name: 'The Octocat', login: 'octocat' },
    )
    return {
      ...raw,
      commit: {
        ...raw.commit,
        committer: { name: 'GitHub', email: 'noreply@github.com', date: COMMITTER_DATE },
      },
    }
  })()

  /** A fork's head repository. Nothing generated may point at it. */
  const forked: PullRequestSummary = {
    body: AUTHOR_TEXT,
    bodyWasAbsent: false,
    headRef: '42-add-the-parser',
    headSha: HEAD_SHA,
    baseOwner: 'pgatzka',
    baseRepo: 'pr-decorator',
    totalCommits: 1,
  }

  it('abbreviates to seven characters', () => {
    expect(abbreviate(FULL_SHA)).toBe('a1b2c3d')
    // The same rule, applied to the head SHA the footer shows.
    expect(abbreviate(HEAD_SHA)).toBe('9c8d7e6')
  })

  it('builds the commit URL base from the BASE repository', () => {
    expect(commitUrlBase(forked)).toBe('https://github.com/pgatzka/pr-decorator/commit')
  })

  it('takes the AUTHOR date, never the committer date', () => {
    const commit = toRenderableCommit(rebased, 'login')

    expect(commit.shortSha).toBe('a1b2c3d')
    expect(commit.fullSha).toBe(FULL_SHA)
    expect(commit.authoredAt.toISOString()).toBe(AUTHOR_DATE)
    expect(commit.authoredAt.toISOString()).not.toBe(COMMITTER_DATE)
    expect(commit.mention).toBe('@octocat')
    // Raw, so the bullet renderer stays the only place a subject is neutralized.
    expect(commit.subject).toBe('Add the parser')
  })

  it('survives a commit with no author trailer instead of failing the run', async () => {
    const undated: RawCommit = { sha: FULL_SHA, commit: { author: null, message: 'Orphan' }, author: null }
    const state = api({ commits: [undated] })
    install(state)

    await run()

    expect(patchCount()).toBe(1)
    // A visibly unreal timestamp, not a RangeError out of ICU and not a hidden commit.
    expect(writtenBody(state)).toContain('1970-01-01')
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('links the base repository from the rendered bullet too', async () => {
    const state = api({ commits: [rebased], baseOwner: 'pgatzka', baseRepo: 'pr-decorator' })
    install(state)

    await run()

    const body = writtenBody(state)
    expect(body).toContain(`https://github.com/pgatzka/pr-decorator/commit/${FULL_SHA}`)
    // Europe/Berlin is UTC+1 on that date: the author date, shifted, and never the
    // committer date.
    expect(body).toContain('2026-03-04 10:15')
    expect(body).not.toContain('2026-06-01')
  })
})

describe('module boundaries', () => {
  it('is the only place in src/ that fails the run', () => {
    // The severity mapping is a single point by design; a second `setFailed`
    // anywhere else would make a survivable outcome fatal without this file saying
    // so. Calls only — other modules name it in prose to point at this one.
    const root = fileURLToPath(new URL('../src/', import.meta.url))
    const offenders = readdirSync(root, { recursive: true })
      .map(String)
      .filter((entry) => entry.endsWith('.ts') && entry !== 'main.ts')
      .filter((entry) => /core\.setFailed\s*\(/.test(readFileSync(`${root}${entry}`, 'utf8')))

    expect(offenders).toEqual([])
  })

  it('guards the loop with the byte-identical comparison alone (D5)', () => {
    // An actor or bot-name check is the obvious alternative and the wrong one: it
    // is defeated by a renamed bot identity and it suppresses legitimate reruns.
    expect(MAIN_SOURCE).not.toMatch(/context\.actor|github-actions\[bot\]/)
  })
})
