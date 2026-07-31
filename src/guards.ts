/**
 * The one failure this action is allowed to survive: the token was not permitted
 * to touch the pull request.
 *
 * A pull request opened from a fork runs with a read-only `GITHUB_TOKEN` no matter
 * what the workflow's `permissions:` block asks for. The `PATCH` comes back 403,
 * and nobody involved can fix it: not the contributor, who cannot grant themselves
 * write access to a repository they do not own, and not the maintainer, who cannot
 * grant it from inside a `pull_request` workflow either. Failing the check would
 * put a red X on a first-time contributor's pull request over a cosmetic block, so
 * the run warns and exits 0 instead.
 *
 * **The signal is the 403 itself, never repository or event metadata.** Reading the
 * head repository's fork flag, the event name or the actor to predict the token's
 * permission is wrong in both directions: a same-repository pull request under a workflow with
 * a restricted token fails too, and a fork pull request run under
 * `pull_request_target` succeeds. The API's answer is the only authority, so this
 * module asks it by making the call and classifying what comes back.
 *
 * **Everything else is someone else's problem, deliberately.** A 500, a 422, a
 * socket reset — anything that is not a denied permission — leaves here as the same
 * error instance it arrived as, so the entrypoint maps it by severity and fails the
 * run. Swallowing a non-403 here would turn a broken action into a silently
 * decorated-nothing action.
 *
 * The result is data, not a side effect. This module logs nothing and sets no exit
 * code; it returns an outcome and the entrypoint decides how loudly to say it and
 * with which status to leave. That is also what makes every branch below assertable
 * without a live API or a mocked toolkit.
 *
 * Per D9 the byte-identical write skip is NOT here. That is an orchestration
 * decision about whether a write is worth making; this module is only about whether
 * an attempted write was allowed.
 */

import { PermissionDeniedError, type GitHubOperation, type Severity } from './errors'

/**
 * Why a write did not happen. One member today; spelled as a union member rather
 * than a boolean so a future survivable cause is an added literal instead of a
 * changed shape.
 */
export type SkipReason = 'permission-denied'

/** The write went through. */
export interface WriteSucceeded {
  status: 'written'
}

/**
 * The write was denied and the run should say so and carry on. Carries everything
 * the entrypoint needs to report it, so the entrypoint never has to re-inspect the
 * original error.
 */
export interface WriteSkipped {
  status: 'skipped'
  /** Why the write was abandoned. */
  reason: SkipReason
  /** Which call was denied — a write, or the re-read that precedes it. */
  operation: GitHubOperation
  /**
   * How the entrypoint should report it, taken from the error rather than assumed
   * here: `warning` is the whole point of this module, but the severity lives on
   * {@link PermissionDeniedError} and is read from there so the two cannot drift.
   */
  severity: Severity
  /** The full message to report, cause and remedy included. */
  message: string
  /** The denial itself, for a caller that wants the stack or the HTTP cause. */
  error: PermissionDeniedError
}

/** What a guarded write did: it happened, or it was denied and skipped. */
export type GuardOutcome = WriteSucceeded | WriteSkipped

/**
 * The remedy, appended to every skip message.
 *
 * It names the read-only fork token as the likely cause and points at the
 * `pull_request_target` recipe in the README — the only supported way to decorate a
 * fork pull request — including the reminder that the recipe comes with a checkout
 * safeguard, because `pull_request_target` runs with the base repository's write
 * token and checking out the head ref under it would execute a contributor's code
 * with that token.
 */
const REMEDY = [
  'The block was not written and the run is being left green on purpose.',
  'The usual cause is a pull request from a fork: GitHub issues a read-only GITHUB_TOKEN' +
    " for fork pull requests regardless of the workflow's permissions: block, so the write" +
    ' cannot succeed and no contributor can fix it from their side.',
  'The same 403 also appears when the workflow itself runs with a restricted token, so check' +
    ' that pull-requests: write is granted before assuming a fork.',
  'To decorate pull requests from forks, use the pull_request_target recipe in the README —' +
    ' and keep its head-ref checkout safeguard, which is what stops that workflow from running' +
    " contributor code with the base repository's write token.",
].join(' ')

/**
 * Builds the skip outcome for a denial.
 *
 * The error's own message already names the operation and quotes GitHub's reply, so
 * the remedy is appended to it rather than replacing it: the reader gets what failed
 * and what to do about it in one line of log.
 */
export function classifyWriteFailure(error: unknown): WriteSkipped {
  if (!(error instanceof PermissionDeniedError)) {
    // Not a permission problem, so not survivable. Rethrown as the very same
    // instance — the entrypoint's severity mapping and the original stack both
    // depend on it arriving unwrapped.
    throw error
  }

  return {
    status: 'skipped',
    reason: 'permission-denied',
    operation: error.operation,
    severity: error.severity,
    message: `${error.message} ${REMEDY}`,
    error,
  }
}

/**
 * Runs a write under the guard.
 *
 * @param write - The write to attempt. Any read it needs to do first — the re-read
 *   of the body, for instance — belongs inside it, because that read is denied by
 *   the same token and for the same reason as the write.
 * @returns `{ status: 'written' }` when the call went through, or the skip outcome
 *   when it was denied.
 * @throws The original error, untouched, for every failure that is not a denial.
 */
export async function guardedWrite(write: () => Promise<void>): Promise<GuardOutcome> {
  try {
    await write()
    return { status: 'written' }
  } catch (error) {
    return classifyWriteFailure(error)
  }
}
