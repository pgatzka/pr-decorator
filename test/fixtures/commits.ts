import type { CommitPayload } from '../../src/github/client'
import type { RenderableCommit } from '../../src/types'

/**
 * The subset of a `GET /repos/{owner}/{repo}/pulls/{number}/commits` list item
 * that the action reads. Aliased to the client's own type rather than restated,
 * so a fixture can never drift from the shape the client actually returns; it
 * lives alongside the {@link RenderableCommit} builder because the render layer
 * maps the former onto the latter.
 */
export type RawCommit = CommitPayload

const DEFAULT_FULL_SHA = '0f1e2d3c4b5a69788796a5b4c3d2e1f009e8d7c6'

const DEFAULT_COMMIT: RenderableCommit = {
  shortSha: DEFAULT_FULL_SHA.slice(0, 7),
  fullSha: DEFAULT_FULL_SHA,
  authoredAt: new Date('2026-03-04T09:15:00.000Z'),
  mention: '@octocat',
  subject: 'Add the thing',
}

/**
 * Builds one {@link RenderableCommit}. Every field can be overridden; overriding
 * `fullSha` alone re-derives `shortSha` from it, so callers never have to keep
 * the two consistent by hand.
 */
export function buildCommit(overrides: Partial<RenderableCommit> = {}): RenderableCommit {
  const fullSha = overrides.fullSha ?? DEFAULT_COMMIT.fullSha
  return {
    ...DEFAULT_COMMIT,
    fullSha,
    shortSha: overrides.shortSha ?? fullSha.slice(0, 7),
    ...overrides,
  }
}

/** Builds a list of commits, one per override object, in the order given. */
export function buildCommits(
  overrides: readonly Partial<RenderableCommit>[],
): RenderableCommit[] {
  return overrides.map((override) => buildCommit(override))
}

/**
 * Builds the raw API payload matching a {@link RenderableCommit}. `login` maps to
 * the payload's `author` field; pass `null` for the unattributed case that makes
 * the client fall back to the git author name.
 */
export function buildRawCommit(
  overrides: Partial<RenderableCommit> = {},
  identity: { name?: string; email?: string; login?: string | null } = {},
): RawCommit {
  const commit = buildCommit(overrides)
  const name = identity.name ?? commit.mention.replace(/^@/, '')
  const login = identity.login === undefined ? name : identity.login
  return {
    sha: commit.fullSha,
    commit: {
      author: {
        name,
        email: identity.email ?? `${name}@users.noreply.github.com`,
        date: commit.authoredAt.toISOString(),
      },
      message: commit.subject,
    },
    author: login === null ? null : { login },
  }
}

/**
 * Author dates that deliberately do NOT increase along the list: index 2 is
 * older than index 1, as happens after a rebase. Commits render in API list
 * order and are never sorted, so this fixture is the regression guard for that
 * decision — any renderer or orchestrator that sorts by date reorders it.
 */
const NON_MONOTONIC_SPEC: readonly {
  commit: Partial<RenderableCommit>
  identity: { name?: string; email?: string; login?: string | null }
}[] = [
  {
    commit: {
      fullSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      authoredAt: new Date('2026-03-04T09:15:00.000Z'),
      mention: '@octocat',
      subject: 'Add the parser',
    },
    identity: { name: 'The Octocat', login: 'octocat' },
  },
  {
    commit: {
      fullSha: 'b2c3d4e5f60718293a4b5c6d7e8f90123456789a',
      authoredAt: new Date('2026-03-04T11:42:00.000Z'),
      mention: '@hubot',
      subject: 'Handle the empty input',
    },
    identity: { name: 'Hubot', login: 'hubot' },
  },
  {
    commit: {
      fullSha: 'c3d4e5f60718293a4b5c6d7e8f90123456789ab2',
      // Older than the commit before it: rebased in from an earlier branch.
      authoredAt: new Date('2026-03-02T08:05:00.000Z'),
      mention: '@octocat',
      subject: 'Fix the off-by-one',
    },
    identity: { name: 'The Octocat', login: 'octocat' },
  },
  {
    commit: {
      fullSha: 'd4e5f60718293a4b5c6d7e8f90123456789ab2c3',
      authoredAt: new Date('2026-03-05T16:20:00.000Z'),
      // No linked GitHub account: the plain git name is the mention.
      mention: 'Ada Lovelace',
      subject: 'Document the parser',
    },
    identity: { name: 'Ada Lovelace', login: null },
  },
]

/** Commits in API list order with non-monotonic author dates. */
export const nonMonotonicCommits: RenderableCommit[] = buildCommits(
  NON_MONOTONIC_SPEC.map((spec) => spec.commit),
)

/** The raw API payloads matching {@link nonMonotonicCommits}, same order. */
export const nonMonotonicRawCommits: RawCommit[] = NON_MONOTONIC_SPEC.map((spec) =>
  buildRawCommit(spec.commit, spec.identity),
)
