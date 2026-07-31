import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  createGitHubClientForRequest,
  MAX_COMMITS,
  type CommitPayload,
  type OctokitRequest,
} from '../../src/github/client'
import { DecoratorError, GitHubApiError, PermissionDeniedError } from '../../src/errors'
import { buildRawCommit, nonMonotonicRawCommits } from '../fixtures/commits'

/**
 * The client is the action's only door to the network, so what has to be proven
 * here is that the door is bounded and honest: paging stops at the endpoint's own
 * ceiling, the commit count comes from the pull request rather than from whatever
 * the list happened to return, list order survives untouched, and every HTTP
 * failure arrives at the caller as a classified error.
 *
 * Everything runs against a recording stub rather than a live API or a recorded
 * cassette — the request COUNT is an assertion here, and only a stub makes it one.
 */

const OWNER = 'pgatzka'
const REPO = 'pr-decorator'
const NUMBER = 42
const TARGET = `${OWNER}/${REPO}#${NUMBER}`

const PULL_ROUTE = 'GET /repos/{owner}/{repo}/pulls/{pull_number}'
const COMMITS_ROUTE = 'GET /repos/{owner}/{repo}/pulls/{pull_number}/commits'
const PATCH_ROUTE = 'PATCH /repos/{owner}/{repo}/pulls/{pull_number}'

interface RecordedCall {
  route: string
  params: Record<string, unknown>
}

/** The shape Octokit throws on a non-2xx response: an `Error` with a `status`. */
class HttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

/**
 * Wraps a handler as an {@link OctokitRequest} and records every call. The handler
 * returns the response body; throwing from it is how a failing status is
 * simulated.
 */
function recordingRequest(handler: (call: RecordedCall) => unknown): {
  request: OctokitRequest
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const request: OctokitRequest = (route, params) => {
    const call: RecordedCall = { route, params }
    calls.push(call)
    // Resolved through a promise so a throwing handler surfaces as a rejection,
    // exactly as a real transport would.
    return Promise.resolve().then(() => ({ data: handler(call) }))
  }
  return { request, calls }
}

/** A pull request payload; every field is overridable. */
function pullRequestPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    body: 'Author text.',
    head: { ref: '5-add-a-bounded-github-client', sha: 'f'.repeat(40) },
    base: { repo: { owner: { login: OWNER }, name: REPO } },
    commits: 3,
    ...overrides,
  }
}

/** `count` distinct commits, numbered so order is verifiable at a glance. */
function commitPage(startIndex: number, count: number): CommitPayload[] {
  return Array.from({ length: count }, (_unused, offset) => {
    const index = startIndex + offset
    return buildRawCommit({
      fullSha: index.toString(16).padStart(40, '0'),
      subject: `Commit ${index}`,
    })
  })
}

describe('getPullRequest', () => {
  it('reads the fields the rest of the action needs', async () => {
    const { request, calls } = recordingRequest(() => pullRequestPayload())
    const client = createGitHubClientForRequest(request)

    const pull = await client.getPullRequest(OWNER, REPO, NUMBER)

    expect(pull).toEqual({
      body: 'Author text.',
      bodyWasAbsent: false,
      headRef: '5-add-a-bounded-github-client',
      headSha: 'f'.repeat(40),
      baseOwner: OWNER,
      baseRepo: REPO,
      totalCommits: 3,
    })
    expect(calls).toEqual([
      { route: PULL_ROUTE, params: { owner: OWNER, repo: REPO, pull_number: NUMBER } },
    ])
  })

  it('normalizes a null body to an empty string and reports it was absent', async () => {
    const { request } = recordingRequest(() => pullRequestPayload({ body: null }))
    const client = createGitHubClientForRequest(request)

    const pull = await client.getPullRequest(OWNER, REPO, NUMBER)

    expect(pull.body).toBe('')
    expect(pull.bodyWasAbsent).toBe(true)
  })

  it('distinguishes an absent body from one the author emptied', async () => {
    const { request } = recordingRequest(() => pullRequestPayload({ body: '' }))
    const client = createGitHubClientForRequest(request)

    const pull = await client.getPullRequest(OWNER, REPO, NUMBER)

    expect(pull.body).toBe('')
    expect(pull.bodyWasAbsent).toBe(false)
  })

  it('reports the BASE repository for a fork pull request, never the head one', async () => {
    // Links into a fork die when the fork is deleted, which happens routinely
    // once a contribution is merged.
    const { request } = recordingRequest(() =>
      pullRequestPayload({
        head: {
          ref: 'patch-1',
          sha: 'a'.repeat(40),
          repo: { owner: { login: 'contributor' }, name: 'pr-decorator' },
        },
        base: { repo: { owner: { login: 'pgatzka' }, name: 'pr-decorator' } },
      }),
    )
    const client = createGitHubClientForRequest(request)

    const pull = await client.getPullRequest(OWNER, REPO, NUMBER)

    expect(pull.baseOwner).toBe('pgatzka')
    expect(pull.baseRepo).toBe('pr-decorator')
    // The head repo coordinates are not on the returned shape at all.
    expect(Object.keys(pull).sort()).toEqual([
      'baseOwner',
      'baseRepo',
      'body',
      'bodyWasAbsent',
      'headRef',
      'headSha',
      'totalCommits',
    ])
  })

  it('takes the commit count from the pull request, not from any list', async () => {
    const { request } = recordingRequest(() => pullRequestPayload({ commits: 1312 }))
    const client = createGitHubClientForRequest(request)

    expect((await client.getPullRequest(OWNER, REPO, NUMBER)).totalCommits).toBe(1312)
  })
})

describe('listCommits', () => {
  it('stops at the 250-commit ceiling after three requests', async () => {
    // Four full pages are on offer. The endpoint itself caps at 250, so a fourth
    // request could not return anything usable even if the mock serves it.
    const { request, calls } = recordingRequest(({ params }) =>
      commitPage(((params.page as number) - 1) * 100, 100),
    )
    const client = createGitHubClientForRequest(request)

    const result = await client.listCommits(OWNER, REPO, NUMBER, 412)

    expect(calls).toHaveLength(3)
    expect(result.commits).toHaveLength(MAX_COMMITS)
    expect(result.returnedCount).toBe(250)
    expect(result.totalCount).toBe(412)
    expect(result.truncated).toBe(true)
  })

  it('pages at 100 per request, in ascending page order', async () => {
    const { request, calls } = recordingRequest(({ params }) =>
      commitPage(((params.page as number) - 1) * 100, 100),
    )
    const client = createGitHubClientForRequest(request)

    await client.listCommits(OWNER, REPO, NUMBER, 412)

    expect(calls.map((call) => call.route)).toEqual([
      COMMITS_ROUTE,
      COMMITS_ROUTE,
      COMMITS_ROUTE,
    ])
    expect(calls.map((call) => call.params)).toEqual([
      { owner: OWNER, repo: REPO, pull_number: NUMBER, per_page: 100, page: 1 },
      { owner: OWNER, repo: REPO, pull_number: NUMBER, per_page: 100, page: 2 },
      { owner: OWNER, repo: REPO, pull_number: NUMBER, per_page: 100, page: 3 },
    ])
  })

  it('keeps the first 250 in API order when the third page overshoots', async () => {
    const { request } = recordingRequest(({ params }) =>
      commitPage(((params.page as number) - 1) * 100, 100),
    )
    const client = createGitHubClientForRequest(request)

    const { commits } = await client.listCommits(OWNER, REPO, NUMBER, 412)

    // Trimmed from the END: the kept commits are the first 250 the API served.
    expect(commits[0]?.commit.message).toBe('Commit 0')
    expect(commits[249]?.commit.message).toBe('Commit 249')
  })

  it('stops on the first short page instead of asking for another', async () => {
    const { request, calls } = recordingRequest(() => commitPage(0, 3))
    const client = createGitHubClientForRequest(request)

    const result = await client.listCommits(OWNER, REPO, NUMBER, 3)

    expect(calls).toHaveLength(1)
    expect(result.returnedCount).toBe(3)
    expect(result.truncated).toBe(false)
  })

  it('reports not truncated when the ceiling is hit but nothing is hidden', async () => {
    // Exactly 250 commits: the ceiling is reached, yet the total matches.
    const { request, calls } = recordingRequest(({ params }) => {
      const page = params.page as number
      return commitPage((page - 1) * 100, page === 3 ? 50 : 100)
    })
    const client = createGitHubClientForRequest(request)

    const result = await client.listCommits(OWNER, REPO, NUMBER, 250)

    expect(calls).toHaveLength(3)
    expect(result.returnedCount).toBe(250)
    expect(result.truncated).toBe(false)
  })

  it('handles a pull request with no commits at all', async () => {
    const { request, calls } = recordingRequest(() => [])
    const client = createGitHubClientForRequest(request)

    const result = await client.listCommits(OWNER, REPO, NUMBER, 0)

    expect(calls).toHaveLength(1)
    expect(result).toEqual({ commits: [], returnedCount: 0, totalCount: 0, truncated: false })
  })

  it('preserves API list order for commits whose author dates go backwards', async () => {
    // The regression guard for the ordering decision: index 2 is authored before
    // index 1, as after a rebase. Any sort by date reorders this fixture.
    const { request } = recordingRequest(() => nonMonotonicRawCommits)
    const client = createGitHubClientForRequest(request)

    const { commits } = await client.listCommits(OWNER, REPO, NUMBER, 4)

    expect(commits).toEqual(nonMonotonicRawCommits)
    commits.forEach((commit, index) => {
      expect(commit).toBe(nonMonotonicRawCommits[index])
    })
    const dates = commits.map((commit) => commit.commit.author?.date)
    expect(dates).toEqual([
      '2026-03-04T09:15:00.000Z',
      '2026-03-04T11:42:00.000Z',
      '2026-03-02T08:05:00.000Z',
      '2026-03-05T16:20:00.000Z',
    ])
    // Stated explicitly so the fixture cannot be "fixed" into sorted order.
    expect(dates[2]! < dates[1]!).toBe(true)
  })

  it('exposes the author date and not the committer date', async () => {
    // A rebase rewrites every committer date to the rebase time, which is why the
    // block shows the author date.
    const authored = '2026-03-02T08:05:00.000Z'
    const committed = '2026-07-30T18:00:00.000Z'
    const { request } = recordingRequest(() => [
      {
        ...buildRawCommit({ authoredAt: new Date(authored) }),
        commit: {
          author: { name: 'The Octocat', email: 'octocat@example.com', date: authored },
          committer: { name: 'GitHub', email: 'noreply@github.com', date: committed },
          message: 'Fix the off-by-one',
        },
      },
    ])
    const client = createGitHubClientForRequest(request)

    const { commits } = await client.listCommits(OWNER, REPO, NUMBER, 1)

    expect(commits[0]?.commit.author?.date).toBe(authored)
  })

  it('passes a commit with no matched GitHub account through unchanged', async () => {
    const unmatched = buildRawCommit({ mention: 'Ada Lovelace' }, { login: null })
    const { request } = recordingRequest(() => [unmatched])
    const client = createGitHubClientForRequest(request)

    const { commits } = await client.listCommits(OWNER, REPO, NUMBER, 1)

    expect(commits[0]?.author).toBeNull()
    expect(commits[0]?.commit.author?.name).toBe('Ada Lovelace')
  })
})

describe('getBody', () => {
  it('re-reads the current body', async () => {
    const { request, calls } = recordingRequest(() =>
      pullRequestPayload({ body: 'Edited while the action was running.' }),
    )
    const client = createGitHubClientForRequest(request)

    expect(await client.getBody(OWNER, REPO, NUMBER)).toBe(
      'Edited while the action was running.',
    )
    expect(calls).toEqual([
      { route: PULL_ROUTE, params: { owner: OWNER, repo: REPO, pull_number: NUMBER } },
    ])
  })

  it('normalizes a null body to an empty string', async () => {
    const { request } = recordingRequest(() => pullRequestPayload({ body: null }))
    const client = createGitHubClientForRequest(request)

    expect(await client.getBody(OWNER, REPO, NUMBER)).toBe('')
  })
})

describe('updateBody', () => {
  it('issues exactly one PATCH carrying the body verbatim', async () => {
    const body = '<!-- pr-decorator:start -->\nBlock\n<!-- pr-decorator:end -->\n\nAuthor text.'
    const { request, calls } = recordingRequest(() => pullRequestPayload({ body }))
    const client = createGitHubClientForRequest(request)

    await client.updateBody(OWNER, REPO, NUMBER, body)

    expect(calls).toEqual([
      {
        route: PATCH_ROUTE,
        params: { owner: OWNER, repo: REPO, pull_number: NUMBER, body },
      },
    ])
    expect(calls[0]?.params.body).toBe(body)
  })

  it('sends an empty body as an empty string rather than dropping the field', async () => {
    const { request, calls } = recordingRequest(() => pullRequestPayload())
    const client = createGitHubClientForRequest(request)

    await client.updateBody(OWNER, REPO, NUMBER, '')

    expect(calls[0]?.params).toHaveProperty('body', '')
  })
})

describe('error classification', () => {
  /** A client whose every request fails with `error`. */
  function failingClient(error: unknown) {
    const { request, calls } = recordingRequest(() => {
      throw error
    })
    return { client: createGitHubClientForRequest(request), calls }
  }

  it('maps a 403 on a read to a warning-severity PermissionDeniedError', async () => {
    const { client } = failingClient(new HttpError(403, 'Resource not accessible by integration'))

    const error = await client.getPullRequest(OWNER, REPO, NUMBER).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(PermissionDeniedError)
    expect(error).toBeInstanceOf(DecoratorError)
    const denied = error as PermissionDeniedError
    expect(denied.severity).toBe('warning')
    expect(denied.operation).toBe('getPullRequest')
    expect(denied.status).toBe(403)
    expect(denied.message).toContain(TARGET)
    expect(denied.message).toContain('Resource not accessible by integration')
    expect(denied.cause).toBeInstanceOf(HttpError)
  })

  it('maps a 403 on the write to a warning-severity PermissionDeniedError', async () => {
    // The fork case: a read-only GITHUB_TOKEN reads fine and only fails on PATCH.
    const { client } = failingClient(new HttpError(403, 'Resource not accessible by integration'))

    const error = await client
      .updateBody(OWNER, REPO, NUMBER, 'anything')
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(PermissionDeniedError)
    const denied = error as PermissionDeniedError
    expect(denied.severity).toBe('warning')
    expect(denied.operation).toBe('updateBody')
  })

  it.each([
    ['listCommits', (client: ReturnType<typeof createGitHubClientForRequest>) =>
      client.listCommits(OWNER, REPO, NUMBER, 1)],
    ['getBody', (client: ReturnType<typeof createGitHubClientForRequest>) =>
      client.getBody(OWNER, REPO, NUMBER)],
  ] as const)('tags the 403 it raises from %s with that operation', async (operation, call) => {
    const { client } = failingClient(new HttpError(403, 'Forbidden'))

    const error = await call(client).catch((cause: unknown) => cause)

    expect((error as PermissionDeniedError).operation).toBe(operation)
  })

  it('maps a 500 to a fatal GitHubApiError carrying the status', async () => {
    const { client } = failingClient(new HttpError(500, 'Internal Server Error'))

    const error = await client.getPullRequest(OWNER, REPO, NUMBER).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(GitHubApiError)
    expect(error).toBeInstanceOf(DecoratorError)
    const failed = error as GitHubApiError
    expect(failed.severity).toBe('fatal')
    expect(failed.status).toBe(500)
    expect(failed.operation).toBe('getPullRequest')
    expect(failed.message).toContain('500')
    expect(failed.message).toContain(TARGET)
  })

  it('maps a 404 to a fatal GitHubApiError', async () => {
    const { client } = failingClient(new HttpError(404, 'Not Found'))

    const error = await client.getPullRequest(OWNER, REPO, NUMBER).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(GitHubApiError)
    expect((error as GitHubApiError).status).toBe(404)
    expect((error as GitHubApiError).severity).toBe('fatal')
  })

  it('maps a transport failure with no status to a fatal error', async () => {
    const { client } = failingClient(new Error('getaddrinfo ENOTFOUND api.github.com'))

    const error = await client.getPullRequest(OWNER, REPO, NUMBER).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(GitHubApiError)
    expect((error as GitHubApiError).severity).toBe('fatal')
    expect((error as GitHubApiError).message).toContain('ENOTFOUND')
  })

  it('stops paging as soon as a page fails', async () => {
    let seen = 0
    const { request, calls } = recordingRequest(({ params }) => {
      seen += 1
      if (params.page === 2) {
        throw new HttpError(502, 'Bad Gateway')
      }
      return commitPage(0, 100)
    })
    const client = createGitHubClientForRequest(request)

    await expect(client.listCommits(OWNER, REPO, NUMBER, 400)).rejects.toBeInstanceOf(
      GitHubApiError,
    )
    expect(calls).toHaveLength(2)
    expect(seen).toBe(2)
  })
})

describe('module boundaries', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../src/github/client.ts', import.meta.url)),
    'utf8',
  )

  /**
   * The source with comments removed. The checks below are about what the module
   * DOES, and a doc comment explaining why it does not do something would
   * otherwise trip them.
   */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  it('never sorts or reverses the commit list', () => {
    // The one guarantee a unit test cannot give on its own: no code path reorders,
    // not just the ones exercised above.
    expect(code).not.toMatch(/\.sort\(|\.reverse\(\)/)
  })

  it('never reads a committer date', () => {
    expect(code).not.toContain('committer')
  })

  it('never lets head repository coordinates out', () => {
    // `head.repo` is the fork; only `head.ref` and `head.sha` may be read.
    expect(code).not.toMatch(/head\.repo|head:\s*\{\s*repo/)
  })
})
