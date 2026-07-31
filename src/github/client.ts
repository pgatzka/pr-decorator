/**
 * The only module in the action that talks to the GitHub API.
 *
 * Two things are owned here and nowhere else:
 *
 * - **Bounding.** `GET /pulls/{n}/commits` serves at most 250 commits no matter
 *   how it is paged, so paging past that is pure rate-limit burn on a
 *   multi-thousand-commit pull request. Paging stops at 250 — three requests at
 *   `per_page: 100` — and the authoritative total comes from the pull request
 *   object's `commits` field, never from the length of the returned list.
 * - **Ordering.** Commits are returned in API list order, exactly as received, so
 *   the rendered list matches the pull request's own Commits tab. Nothing here
 *   sorts or reverses; author dates are not monotonic after a rebase and sorting
 *   by them would silently reorder the block.
 *
 * URLs are always built from the BASE repository. The head repository of a fork
 * pull request can be deleted, and every link into it dies with it, so head repo
 * coordinates deliberately never leave this module.
 */

import { getOctokit } from '@actions/github'

import { GitHubApiError, PermissionDeniedError, type GitHubOperation } from '../errors'

/**
 * The endpoint's own hard ceiling. Lifting it means switching to the compare
 * endpoint, which is a design decision and not a constant change.
 */
export const MAX_COMMITS = 250

/** The largest page size the endpoint accepts. */
const PER_PAGE = 100

/** Three pages of 100 cover the ceiling; a fourth request can never be useful. */
const MAX_PAGES = Math.ceil(MAX_COMMITS / PER_PAGE)

const PULL_REQUEST_ROUTE = '/repos/{owner}/{repo}/pulls/{pull_number}'

/**
 * A single commit as the commits endpoint serves it, reduced to the fields the
 * action reads.
 *
 * `commit.author` is the git author trailer and `author` is the GitHub account
 * the commit was matched to — which is `null` whenever the commit email belongs
 * to no account, so mention resolution always needs the git name as a fallback.
 *
 * There is deliberately no `commit.committer` here: the block shows when the work
 * was authored, and a rebase rewrites every committer date to the rebase time.
 */
export interface CommitPayload {
  /** Full 40-character SHA. */
  sha: string
  commit: {
    /** The git author trailer. `null` on the rare commit with no author line. */
    author: { name: string; email: string; date: string } | null
    /** The full commit message; the first line is the subject. */
    message: string
  }
  /** The matched GitHub account, or `null` when the email matches no account. */
  author: { login: string } | null
}

/** The pull request fields the rest of the action needs. */
export interface PullRequestSummary {
  /** The body with `null` normalized to `''`. */
  body: string
  /**
   * Whether GitHub served `body: null` rather than an empty string. An absent
   * body and a body the author emptied are the same to write, but not the same to
   * log.
   */
  bodyWasAbsent: boolean
  /** The head branch name, matched against `branch-pattern` for the issue number. */
  headRef: string
  /** The head commit SHA. */
  headSha: string
  /** Owner of the BASE repository — the one every generated URL points at. */
  baseOwner: string
  /** Name of the BASE repository. */
  baseRepo: string
  /** The authoritative commit count, which may exceed {@link MAX_COMMITS}. */
  totalCommits: number
}

/** The bounded commit list plus the counts needed to render the truncation note. */
export interface CommitList {
  /** The commits actually fetched, in API list order, at most {@link MAX_COMMITS}. */
  commits: CommitPayload[]
  /** `commits.length`, spelled out so callers never re-derive it. */
  returnedCount: number
  /** The pull request's own commit count, from the pull request object. */
  totalCount: number
  /** Whether the ceiling hid commits: `totalCount > returnedCount`. */
  truncated: boolean
}

/** The bounded GitHub surface the rest of the action is allowed to use. */
export interface GitHubClient {
  /** Reads the pull request fields the action needs. */
  getPullRequest(owner: string, repo: string, number: number): Promise<PullRequestSummary>
  /**
   * Lists the commits, bounded to {@link MAX_COMMITS}, in API list order.
   *
   * `totalCommits` comes from {@link PullRequestSummary.totalCommits} rather than
   * being re-fetched here: the caller has already read the pull request, a second
   * read costs a request and could disagree with the first, and taking it as an
   * argument makes it structurally impossible to fall back to the list length.
   */
  listCommits(
    owner: string,
    repo: string,
    number: number,
    totalCommits: number,
  ): Promise<CommitList>
  /**
   * Re-reads just the current body.
   *
   * `updateBody` replaces the whole body and the endpoint offers no `If-Match`, so
   * the only mitigation against clobbering an edit made since the first read is to
   * read again immediately before writing.
   */
  getBody(owner: string, repo: string, number: number): Promise<string>
  /** Replaces the pull request body with `body`. */
  updateBody(owner: string, repo: string, number: number, body: string): Promise<void>
}

/**
 * The single call shape this module needs from Octokit. Narrowing it to this is
 * what lets the tests drive the client with a recording stub instead of an HTTP
 * interceptor.
 */
export interface OctokitRequest {
  (route: string, params: Record<string, unknown>): Promise<{ data: unknown }>
}

/** What `GET /pulls/{n}` is read for. */
interface PullRequestPayload {
  body: string | null
  head: { ref: string; sha: string }
  base: { repo: { owner: { login: string }; name: string } }
  commits: number
}

/** Verb used in the message of an error raised for each operation. */
const DESCRIPTIONS: Record<GitHubOperation, string> = {
  getPullRequest: 'read pull request',
  listCommits: 'list the commits of pull request',
  getBody: 're-read the body of pull request',
  updateBody: 'update the body of pull request',
}

/** Reads a numeric `status` off an unknown thrown value, Octokit's `RequestError`. */
function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return undefined
  }
  const { status } = error as { status: unknown }
  return typeof status === 'number' ? status : undefined
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Classifies a failed request. This module decides only what KIND of failure it
 * was; whether a 403 is survivable is the caller's call.
 */
function classify(
  error: unknown,
  operation: GitHubOperation,
  target: string,
): PermissionDeniedError | GitHubApiError | Error {
  const status = statusOf(error)
  const detail = detailOf(error)
  const description = `${DESCRIPTIONS[operation]} ${target}`

  if (status === 403) {
    return new PermissionDeniedError(
      operation,
      `Permission denied: the token may not ${description}. GitHub replied 403: ${detail}`,
      { cause: error },
    )
  }
  if (status !== undefined) {
    return new GitHubApiError(
      operation,
      status,
      `Could not ${description}. GitHub replied ${status}: ${detail}`,
      { cause: error },
    )
  }
  // No status at all: a DNS failure, a socket reset, a timeout. Nothing to
  // classify, so it stays fatal and carries the original as its cause.
  return new GitHubApiError(operation, 0, `Could not ${description}: ${detail}`, { cause: error })
}

/**
 * Builds a client over an arbitrary request function.
 *
 * Exported for the tests, which pass a recording stub — that is how the request
 * count itself becomes assertable.
 */
export function createGitHubClientForRequest(request: OctokitRequest): GitHubClient {
  async function send<T>(
    operation: GitHubOperation,
    method: string,
    route: string,
    owner: string,
    repo: string,
    number: number,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    try {
      const response = await request(`${method} ${route}`, {
        owner,
        repo,
        pull_number: number,
        ...params,
      })
      return response.data as T
    } catch (error) {
      throw classify(error, operation, `${owner}/${repo}#${number}`)
    }
  }

  async function readPullRequest(
    operation: GitHubOperation,
    owner: string,
    repo: string,
    number: number,
  ): Promise<PullRequestPayload> {
    return send<PullRequestPayload>(operation, 'GET', PULL_REQUEST_ROUTE, owner, repo, number)
  }

  return {
    async getPullRequest(owner, repo, number) {
      const payload = await readPullRequest('getPullRequest', owner, repo, number)
      return {
        body: payload.body ?? '',
        bodyWasAbsent: payload.body === null,
        headRef: payload.head.ref,
        headSha: payload.head.sha,
        // Base, never head: a link into a deleted fork is a dead link.
        baseOwner: payload.base.repo.owner.login,
        baseRepo: payload.base.repo.name,
        // The pull request's own count, which the 250 ceiling may exceed.
        totalCommits: payload.commits,
      }
    },

    async listCommits(owner, repo, number, totalCommits) {
      const collected: CommitPayload[] = []

      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const batch = await send<CommitPayload[]>(
          'listCommits',
          'GET',
          `${PULL_REQUEST_ROUTE}/commits`,
          owner,
          repo,
          number,
          { per_page: PER_PAGE, page },
        )
        // Appended, never merged or sorted: API list order is the rendered order.
        collected.push(...batch)
        // A short page is the last page; reaching the ceiling makes the next one
        // unusable even if it exists.
        if (batch.length < PER_PAGE || collected.length >= MAX_COMMITS) {
          break
        }
      }

      // A full third page overshoots the ceiling by 50. Trim from the end so the
      // kept commits stay the first N in API order.
      const commits =
        collected.length > MAX_COMMITS ? collected.slice(0, MAX_COMMITS) : collected

      return {
        commits,
        returnedCount: commits.length,
        totalCount: totalCommits,
        truncated: totalCommits > commits.length,
      }
    },

    async getBody(owner, repo, number) {
      const payload = await readPullRequest('getBody', owner, repo, number)
      return payload.body ?? ''
    },

    async updateBody(owner, repo, number, body) {
      await send<unknown>('updateBody', 'PATCH', PULL_REQUEST_ROUTE, owner, repo, number, { body })
    },
  }
}

/** Builds the client the action actually runs with. */
export function createGitHubClient(token: string): GitHubClient {
  const octokit = getOctokit(token)
  return createGitHubClientForRequest((route, params) =>
    // The narrow OctokitRequest signature is not assignable to Octokit's own
    // overloaded parameter type, so the widening happens here, once, at the only
    // point where the toolkit is touched.
    octokit.request(route, params as Parameters<typeof octokit.request>[1]),
  )
}
