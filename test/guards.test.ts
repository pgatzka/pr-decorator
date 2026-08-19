import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { classifyWriteFailure, guardedWrite } from '../src/guards'
import { DecoratorError, GitHubApiError, PermissionDeniedError } from '../src/errors'

/**
 * The guard's whole job is a judgement call about which failures the run may
 * survive, so what is proven here is the shape of that call: a denied permission —
 * on the write or on the re-read that precedes it — becomes data the entrypoint can
 * turn into a warning and a green run, and everything else leaves as the identical
 * error instance it arrived as.
 *
 * The last two cases guard the module's boundaries rather than its behaviour: that
 * permission is inferred from the 403 alone and never from event or repository
 * metadata, and that no body or block logic drifted in here. Both are what the
 * design buys, and neither is visible in a return value.
 */

const GUARDS_SOURCE = readFileSync(
  fileURLToPath(new URL('../src/guards.ts', import.meta.url)),
  'utf8',
)

/** A denial as the client raises it, for whichever call was refused. */
function denied(
  operation: 'updatePullRequest' | 'getWritableFields' = 'updatePullRequest',
): PermissionDeniedError {
  return new PermissionDeniedError(
    operation,
    'Permission denied: the token may not update the body of pull request pgatzka/pr-decorator#42.' +
      ' GitHub replied 403: Resource not accessible by integration',
  )
}

describe('classifyWriteFailure', () => {
  it('turns a denied write into a warning-severity skip', () => {
    const error = denied()

    const outcome = classifyWriteFailure(error)

    expect(outcome.status).toBe('skipped')
    expect(outcome.reason).toBe('permission-denied')
    expect(outcome.operation).toBe('updatePullRequest')
    // Read off the error rather than hard-coded here, but the value the entrypoint
    // branches on is still pinned: anything but `warning` fails the run.
    expect(outcome.severity).toBe('warning')
    expect(outcome.error).toBe(error)
  })

  it('treats a denied re-read exactly like a denied write', () => {
    // The body re-read immediately before the PATCH is refused by the same token
    // for the same reason. Classifying it as fatal would fail the very runs this
    // module exists to keep green.
    const outcome = classifyWriteFailure(denied('getWritableFields'))

    expect(outcome.status).toBe('skipped')
    expect(outcome.reason).toBe('permission-denied')
    expect(outcome.operation).toBe('getWritableFields')
    expect(outcome.severity).toBe('warning')
  })

  it('names the read-only fork token and points at the pull_request_target recipe', () => {
    const { message } = classifyWriteFailure(denied())

    // The contributor reading this log can do nothing about it; the maintainer can.
    // The message has to say which of them is which.
    expect(message).toContain('read-only GITHUB_TOKEN')
    expect(message).toContain('fork')
    expect(message).toContain('pull_request_target')
    expect(message).toContain('README')
    // The recipe is only safe with its checkout safeguard, so the pointer carries
    // the caveat rather than leaving it to be discovered.
    expect(message).toContain('safeguard')
    // GitHub's own reply survives; the remedy is appended to it, not substituted.
    expect(message).toContain('GitHub replied 403')
  })

  it('rethrows a fatal DecoratorError as the same instance', () => {
    const error = new GitHubApiError(
      'updatePullRequest',
      500,
      'Could not update the body of pull request pgatzka/pr-decorator#42. GitHub replied 500: oops',
    )

    // Identity, not just type: the entrypoint maps severity off this object and a
    // wrapped copy would lose the original stack.
    expect(() => classifyWriteFailure(error)).toThrow(error)
    expect(error).toBeInstanceOf(DecoratorError)
  })

  it('rethrows a plain Error as the same instance', () => {
    const error = new Error('socket hang up')

    expect(() => classifyWriteFailure(error)).toThrow(error)
  })
})

describe('guardedWrite', () => {
  it('reports a successful write and nothing else', async () => {
    let calls = 0

    const outcome = await guardedWrite(async () => {
      calls += 1
    })

    expect(outcome).toEqual({ status: 'written' })
    expect(calls).toBe(1)
  })

  it('converts a denial into a skip instead of rejecting', async () => {
    const error = denied()

    const outcome = await guardedWrite(() => Promise.reject(error))

    expect(outcome.status).toBe('skipped')
    if (outcome.status !== 'skipped') return
    expect(outcome.error).toBe(error)
    expect(outcome.message).toContain('pull_request_target')
  })

  it('lets every other failure reject with the original error', async () => {
    const error = new GitHubApiError('updatePullRequest', 422, 'Could not update: unprocessable')

    await expect(guardedWrite(() => Promise.reject(error))).rejects.toBe(error)
  })
})

describe('module boundaries', () => {
  it('infers permission from the 403 alone, never from event or repository metadata', () => {
    // The word "fork" is expected in the remedy text, so the check targets the
    // actual signals: reading any of these instead of the API's answer is wrong in
    // both directions.
    expect(GUARDS_SOURCE).not.toMatch(/head\.repo\.fork|context\.eventName|context\.actor/)
  })

  it('owns no body or block logic', () => {
    // Per D9 the byte-identical comparison is the entrypoint's concern. It cannot
    // move here as long as neither layer is reachable from here.
    expect(GUARDS_SOURCE).not.toMatch(/from ['"].*(body|render)\//)
  })
})
