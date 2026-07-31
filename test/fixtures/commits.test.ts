import {
  buildCommit,
  buildCommits,
  buildRawCommit,
  nonMonotonicCommits,
  nonMonotonicRawCommits,
} from './commits'

describe('buildCommit', () => {
  it('returns a well-formed commit from defaults alone', () => {
    const commit = buildCommit()
    expect(commit.fullSha).toMatch(/^[0-9a-f]{40}$/)
    expect(commit.shortSha).toBe(commit.fullSha.slice(0, 7))
    expect(commit.authoredAt).toBeInstanceOf(Date)
    expect(Number.isNaN(commit.authoredAt.getTime())).toBe(false)
    expect(commit.mention).toBeTruthy()
    expect(commit.subject).toBeTruthy()
  })

  it('re-derives shortSha when only fullSha is overridden', () => {
    const fullSha = 'feedface0000000000000000000000000000beef'
    expect(buildCommit({ fullSha }).shortSha).toBe('feedfac')
  })

  it('keeps an explicit shortSha override', () => {
    expect(buildCommit({ shortSha: 'abcdefg' }).shortSha).toBe('abcdefg')
  })

  it('overrides fields independently', () => {
    const authoredAt = new Date('2020-01-02T03:04:05.000Z')
    const commit = buildCommit({ authoredAt, subject: 'Something else' })
    expect(commit.authoredAt).toBe(authoredAt)
    expect(commit.subject).toBe('Something else')
    expect(commit.mention).toBe(buildCommit().mention)
  })

  it('builds a list in the order given', () => {
    const commits = buildCommits([{ subject: 'first' }, { subject: 'second' }])
    expect(commits.map((commit) => commit.subject)).toEqual(['first', 'second'])
  })
})

describe('buildRawCommit', () => {
  it('matches the commit it was built from', () => {
    const commit = buildCommit({ subject: 'Add the thing' })
    const raw = buildRawCommit({ subject: 'Add the thing' })
    expect(raw.sha).toBe(commit.fullSha)
    expect(raw.commit.author?.date).toBe(commit.authoredAt.toISOString())
    expect(raw.commit.message).toBe(commit.subject)
  })

  it('renders an unattributed commit with a null author', () => {
    const raw = buildRawCommit({}, { name: 'Ada Lovelace', login: null })
    expect(raw.author).toBeNull()
    expect(raw.commit.author?.name).toBe('Ada Lovelace')
  })
})

describe('nonMonotonicCommits', () => {
  it('has author dates that do not increase along the list', () => {
    const times = nonMonotonicCommits.map((commit) => commit.authoredAt.getTime())
    const sorted = [...times].sort((a, b) => a - b)
    expect(times).not.toEqual(sorted)
  })

  it('is a plausible rebase: exactly one commit is older than its predecessor', () => {
    const times = nonMonotonicCommits.map((commit) => commit.authoredAt.getTime())
    const regressions = times.filter(
      (time, index) => index > 0 && time < (times[index - 1] as number),
    )
    expect(regressions).toHaveLength(1)
  })

  it('pairs each commit with its raw payload, in the same order', () => {
    expect(nonMonotonicRawCommits).toHaveLength(nonMonotonicCommits.length)
    for (const [index, commit] of nonMonotonicCommits.entries()) {
      expect(nonMonotonicRawCommits[index]?.sha).toBe(commit.fullSha)
      expect(nonMonotonicRawCommits[index]?.commit.author?.date).toBe(
        commit.authoredAt.toISOString(),
      )
    }
  })

  it('covers both the linked-account and the git-name-only author', () => {
    expect(nonMonotonicRawCommits.some((raw) => raw.author !== null)).toBe(true)
    expect(nonMonotonicRawCommits.some((raw) => raw.author === null)).toBe(true)
  })
})
