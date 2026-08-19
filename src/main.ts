/**
 * The action's single execution path: the one module that reads the event, calls
 * the API, drives the render layer and decides whether anything is written at all.
 *
 * Everything it composes is pure or single-purpose, so what lives here is only the
 * things that cannot live anywhere else:
 *
 * - **The three mapping contracts.** Abbreviating a SHA, building the commit URL
 *   base and turning the API's author date into an instant all need to see both the
 *   API payload and the render layer, and this is the only place that does. They are
 *   defined once here so the goldens have exactly one thing to agree with.
 * - **The byte-identical write skip (D5).** A pull request whose body and title
 *   already say what this run would say is not written to. That is what stops the
 *   action from retriggering itself, and it is deliberately the ONLY loop guard —
 *   no actor check, no bot-name check, nothing that a self-hosted or renamed bot
 *   identity could defeat. Placed here rather than in the guard module per D9:
 *   whether a write is worth making is orchestration, not permission.
 * - **The severity mapping.** `fatal` fails the run, `warning` and `notice` do not,
 *   and no other module in the action calls `core.setFailed`. A test greps `src/`
 *   to keep it that way.
 *
 * Four outcomes leave this run green without a write: the opt-out marker, a block
 * whose end marker was edited away, a body too long for the block to fit in, and a
 * token that was not allowed to write. Only the last of those is an error at all,
 * and none of them is the consumer's mistake to fix under a red X.
 *
 * The title (#47) rides along with the body rather than beside it: one pull
 * request read resolves the issue number both features share, one guarded
 * callback re-reads both current fields immediately before writing, and one
 * `PATCH` carries whichever of the two actually changed. A title that cannot be
 * resolved — the branch does not match, the issue read is denied, the issue title
 * is empty — never blocks the body; it only ever narrows what gets written.
 */

import * as core from '@actions/core'
import * as github from '@actions/github'

import { hasSkipMarker, outsideLength, upsertBlock } from './body/markers'
import { DecoratorError, type Severity } from './errors'
import { guardedWrite } from './guards'
import { resolveMention } from './github/authors'
import {
  createGitHubClient,
  type CommitPayload,
  type GitHubClient,
  type PullRequestSummary,
} from './github/client'
import { MAX_BRANCH_NAME_LENGTH, capBranchName, parseInputs } from './inputs'
import {
  assembleBlock,
  blockFits,
  computeCommitsBudget,
  measureSectionReservations,
} from './render/block'
import { renderCommitBullet, renderCommits, type CommitBulletOptions } from './render/commits'
import { renderFooter } from './render/footer'
import { renderIssueReference, resolveIssueNumber } from './render/issue-ref'
import { renderTitle } from './render/title'
import { truncateCommits } from './render/truncate'
import type { DecoratorInputs, MentionStyle, RenderableCommit } from './types'

/**
 * How many hex characters of a SHA are displayed. Seven is what GitHub's own UI
 * abbreviates to, and the goldens assert it. Applied identically to the commit
 * SHAs on the bullets and to the head SHA in the footer — one rule, one place, so
 * the two can never disagree by a character.
 */
const SHORT_SHA_LENGTH = 7

/**
 * The instant used when a commit carries no usable author date.
 *
 * `commit.author` is `null` on the rare commit with no author trailer, and there is
 * no second date to fall back on — the committer date is deliberately not fetched,
 * because a rebase rewrites it. So the choice is between failing the run, hiding the
 * commit, and rendering a timestamp that is obviously not real. The third is the
 * least destructive: the commit still appears in the list, in its API order, and the
 * epoch is unmistakable to anyone reading it. What must not happen is reaching
 * `formatInstant` with an invalid `Date`, which throws a `RangeError` out of ICU and
 * would fail the whole run over one malformed commit.
 */
const UNDATED = new Date(0)

/** What the run is decorating, resolved from the event payload. */
interface Target {
  owner: string
  repo: string
  number: number
}

/** What the guarded write actually did, reported once the guard has returned. */
type WriteDecision = 'updated' | 'unchanged' | 'unclosed'

/**
 * {@link SHORT_SHA_LENGTH} applied. The full SHA still builds every URL.
 *
 * Exported, like the two mappings below, so the contract test can assert it
 * directly rather than inferring it from a rendered line. Nothing else imports it:
 * the render layer is handed the already-abbreviated value.
 */
export function abbreviate(fullSha: string): string {
  return fullSha.slice(0, SHORT_SHA_LENGTH)
}

/**
 * Everything before the SHA in a commit URL.
 *
 * Built from the BASE repository (D1) and from `context.serverUrl`, which is
 * `https://github.com` on github.com and the instance's own host on GitHub
 * Enterprise Server. The head repository is never consulted: a fork can be deleted
 * and every link into it dies with it.
 */
export function commitUrlBase(pullRequest: PullRequestSummary): string {
  return `${github.context.serverUrl}/${pullRequest.baseOwner}/${pullRequest.baseRepo}/commit`
}

/**
 * The commit AUTHOR date as an instant (D2).
 *
 * Converted to a `Date` here rather than passed on as a string, so
 * {@link RenderableCommit.authoredAt} is never a preformatted timestamp (D8) and the
 * render layer cannot apply a timezone twice.
 */
function authoredAt(payload: CommitPayload): Date {
  const raw = payload.commit.author?.date
  if (raw === undefined) {
    return UNDATED
  }
  const instant = new Date(raw)
  return Number.isNaN(instant.getTime()) ? UNDATED : instant
}

/**
 * Reduces one raw commit to what the render layer is allowed to see.
 *
 * The subject is passed through RAW on purpose: the bullet renderer takes its first
 * line and neutralizes it, and pre-trimming here would put a second, weaker
 * sanitizer in front of the real one. The mention is the opposite — already escaped
 * by the resolver, and emitted verbatim downstream.
 */
export function toRenderableCommit(
  payload: CommitPayload,
  mentions: MentionStyle,
): RenderableCommit {
  return {
    shortSha: abbreviate(payload.sha),
    fullSha: payload.sha,
    authoredAt: authoredAt(payload),
    mention: resolveMention(payload, mentions),
    subject: payload.commit.message,
  }
}

/**
 * The single mapping from a severity onto an Actions log call. `fatal` is the only
 * one that sets an exit code, which is what makes every other outcome a green run.
 */
function report(severity: Severity, message: string): void {
  switch (severity) {
    case 'fatal':
      core.setFailed(message)
      return
    case 'warning':
      core.warning(message)
      return
    case 'notice':
      core.notice(message)
      return
  }
}

/**
 * Reports whatever escaped {@link decorate}.
 *
 * A {@link DecoratorError} already knows how loudly it wants to be said, so it is
 * reported at its own severity. Anything else is a bug or an unexpected runtime
 * failure: fatal, with the stack in the log, because the alternative is an action
 * that silently decorates nothing.
 */
function reportFailure(error: unknown): void {
  if (error instanceof DecoratorError) {
    report(error.severity, error.message)
    if (error.stack !== undefined) {
      core.debug(error.stack)
    }
    return
  }

  if (error instanceof Error) {
    core.setFailed(error.message)
    core.info(error.stack ?? `${error.name}: ${error.message}`)
    return
  }

  core.setFailed(`pr-decorator failed with a non-error value: ${String(error)}`)
}

/**
 * Which pull request this run is for, or `null` when the event has none.
 *
 * The action holds no opinion about `on:` — the consuming workflow owns that — so an
 * event without a pull request is a misconfiguration to point out, not a failure.
 */
function resolveTarget(): Target | null {
  const pullRequest = github.context.payload.pull_request
  if (pullRequest === undefined) {
    return null
  }
  const { owner, repo } = github.context.repo
  return { owner, repo, number: pullRequest.number }
}

/**
 * The head branch name, capped and ready to match against `branch-pattern`, or
 * `null` for "there is nothing to match" — shared by the closing reference and
 * the title (#47) so a run where both are on caps the branch name once and logs
 * the over-long notice once, not twice.
 *
 * Skipped entirely when neither feature that reads it is on, so a run with
 * `issue-link: false` and `title: false` never even caps the branch name.
 */
function resolveIssueBranchName(headRef: string, inputs: DecoratorInputs): string | null {
  if (!inputs.issueLink && !inputs.title) {
    return null
  }

  const branchName = capBranchName(headRef)
  if (branchName === null) {
    core.notice(
      `The head branch name is longer than ${MAX_BRANCH_NAME_LENGTH} characters, so it was not ` +
        'matched against `branch-pattern`; neither a closing reference nor a title was resolved. ' +
        'The cap bounds the cost of a catastrophically backtracking pattern; the rest of the block ' +
        'is unaffected.',
    )
    return null
  }

  return branchName
}

/**
 * The `Closes #<n>` line for this pull request, or `null` for no line at all.
 *
 * Three different causes collapse into that one `null`, and the assembler treats
 * them identically: the line is turned off, the branch name is too long to match
 * safely, or the pattern simply does not match. Only the over-long branch is
 * worth a log line — logged once by {@link resolveIssueBranchName} — because it
 * is the one a reader would otherwise be unable to explain. A branch that simply
 * does not match `branch-pattern` is the ordinary case for any pull request not
 * opened from an issue-numbered branch, so it stays silent.
 */
function renderClosingReference(branchName: string | null, inputs: DecoratorInputs): string | null {
  if (!inputs.issueLink || branchName === null) {
    return null
  }

  return renderIssueReference(branchName, inputs.branchPattern)
}

/**
 * The pull request title for this run, or `null` for "leave it alone".
 *
 * Every cause that yields `null` past the `title: false` check is logged once,
 * right here, because each is a different explanation a reader could not
 * otherwise reconstruct: the branch did not match `branch-pattern`, the issue
 * title could not be read, or the issue title normalized to nothing. None of
 * them is fatal — the body decoration proceeds exactly the same either way,
 * which is what makes the title strictly additive rather than a second thing
 * that can fail the run.
 *
 * Deliberately louder than {@link renderClosingReference} about a branch that
 * simply does not match: the closing reference is one line among several and a
 * missing one is easy to miss, but a title left exactly as the author typed it
 * is something they see every time they look at the pull request, so the run
 * says why.
 */
async function resolveTitle(
  client: GitHubClient,
  inputs: DecoratorInputs,
  target: Target,
  branchName: string | null,
): Promise<string | null> {
  if (!inputs.title) {
    return null
  }

  const { owner, repo, number } = target

  if (branchName === null) {
    // Either the branch name was too long — resolveIssueBranchName() already
    // logged that — or issue-link and title are both off, which is
    // unreachable here since title is on.
    return null
  }

  const issueNumber = resolveIssueNumber(branchName, inputs.branchPattern)
  if (issueNumber === null) {
    core.notice(
      `The head branch name of ${owner}/${repo}#${number} did not match \`branch-pattern\`, so no ` +
        'issue number was resolved and the pull request title was left untouched.',
    )
    return null
  }

  const issueTitle = await client.getIssueTitle(owner, repo, issueNumber)
  if (issueTitle === null) {
    core.warning(
      `Could not read the title of issue #${issueNumber} to set the title of ${owner}/${repo}#${number}. ` +
        'The usual cause is that the token was not granted `issues: read` — add it to the ' +
        "workflow's `permissions:` block, next to `pull-requests: write`. The pull request title " +
        'was left untouched; the body was still decorated.',
    )
    return null
  }

  const rendered = renderTitle(issueNumber, issueTitle)
  if (rendered === null) {
    core.notice(
      `Issue #${issueNumber} linked from ${owner}/${repo}#${number} has an empty title once ` +
        'normalized, so the pull request title was left untouched rather than set to a bare `#<n>`.',
    )
  }
  return rendered
}

/**
 * Renders the block and decides whether it is written.
 *
 * Everything before the write is pure once the two reads have happened, which is why
 * the sequence reads top to bottom with no branching other than the four early
 * returns that leave the run green.
 */
async function decorate(
  client: GitHubClient,
  inputs: DecoratorInputs,
  target: Target,
): Promise<void> {
  const { owner, repo, number } = target

  const pullRequest = await client.getPullRequest(owner, repo, number)

  // Checked before the commits are even listed: an opted-out pull request should
  // cost one request, not four.
  if (hasSkipMarker(pullRequest.body)) {
    core.notice(
      `${owner}/${repo}#${number} carries the pr-decorator skip marker, so its body was left ` +
        'untouched. Remove the marker to let the action decorate it again.',
    )
    return
  }

  const commitList = await client.listCommits(owner, repo, number, pullRequest.totalCommits)

  const bulletOptions: CommitBulletOptions = {
    timeZone: inputs.timezone,
    commitUrlBase: commitUrlBase(pullRequest),
  }

  const commits = commitList.commits.map((payload) =>
    toRenderableCommit(payload, inputs.mentions),
  )

  const branchName = resolveIssueBranchName(pullRequest.headRef, inputs)
  const closingReference = renderClosingReference(branchName, inputs)
  const desiredTitle = await resolveTitle(client, inputs, target, branchName)
  const footer = inputs.footer
    ? renderFooter({
        headShortSha: abbreviate(pullRequest.headSha),
        // The pull request's TOTAL, not the number of bullets: the list carries its
        // own notes about what it is not showing.
        commitCount: commitList.totalCount,
        timeZone: inputs.timezone,
      })
    : null

  const budgetParts = {
    outsideBodyLength: outsideLength(pullRequest.body),
    closingRefLength: closingReference?.length ?? 0,
    footerLength: footer?.length ?? 0,
    ...measureSectionReservations(commitList),
  }

  // A budget of zero means "no room for bullets", which is survivable. This means
  // "no room for the block at all", which is not: assembling one anyway produces a
  // body the API refuses, and failing over a long description is not this action's
  // call to make.
  if (!blockFits(budgetParts)) {
    core.warning(
      `The body of ${owner}/${repo}#${number} is too long for the pr-decorator block to fit ` +
        'inside the 65,536-character limit, even with no commits listed. Nothing was written; ' +
        'shorten the description to let the block in.',
    )
    return
  }

  const truncation = truncateCommits(
    commits,
    computeCommitsBudget(budgetParts),
    // Measured through the real renderer, so the budget is spent on the bytes that
    // actually land in the body.
    (commit) => renderCommitBullet(commit, bulletOptions).length,
  )

  const block = assembleBlock({
    closingReference,
    commitsSection: renderCommits(truncation.commits, {
      ...bulletOptions,
      totalCount: commitList.totalCount,
      returnedCount: commitList.returnedCount,
      overflowCount: truncation.overflowCount,
    }),
    footer,
    renderedCommits: truncation.commits.length,
    omittedCommits: truncation.overflowCount,
  })

  if (inputs.dryRun) {
    core.info(
      `dry-run: nothing was written to ${owner}/${repo}#${number}. The block below is what ` +
        `this run would have placed (${block.renderedCommits} commits shown, ` +
        `${block.omittedCommits} omitted):`,
    )
    core.info(block.text)
    // Logged whether or not it differs from the current title — dry-run reports
    // what this run WOULD set, and "already correct" is a legitimate answer to
    // that question, not a reason to stay silent.
    if (desiredTitle !== null) {
      core.info(
        `dry-run: the title of ${owner}/${repo}#${number} would be set to \`${desiredTitle}\`.`,
      )
    }
    return
  }

  await write(client, inputs, target, block.text, desiredTitle)
}

/**
 * Performs the write, under the guard and behind the two skips.
 *
 * The title and body are re-read INSIDE the guarded callback rather than before
 * it. There is no `If-Match` on this endpoint and each field named on the `PATCH`
 * is replaced whole, so the only mitigation against clobbering an edit made while
 * the block was being rendered is to read both again at the last possible
 * moment — and that read is refused by exactly the same token, for exactly the
 * same reason, as the write it precedes.
 */
async function write(
  client: GitHubClient,
  inputs: DecoratorInputs,
  target: Target,
  block: string,
  desiredTitle: string | null,
): Promise<void> {
  const { owner, repo, number } = target

  // Written from inside the guarded callback and read once it has returned. A
  // holder rather than a bare `let`, because a value assigned only inside a
  // callback is one the compiler cannot see being assigned.
  const attempt: { decision: WriteDecision } = { decision: 'updated' }

  const outcome = await guardedWrite(async () => {
    const current = await client.getWritableFields(owner, repo, number)
    const upsert = upsertBlock(current.body, block, inputs.position)

    // A start marker with no end after it: the body is in a state nothing can edit
    // safely, so it is not edited — and the title is left alone right along with
    // it, because a pull request half-managed by this run is worse than one this
    // run declined to touch at all. Checked before the comparison below, which
    // would otherwise swallow it — the unchanged body is exactly what `unclosed`
    // returns.
    if (upsert.action === 'unclosed') {
      attempt.decision = 'unclosed'
      return
    }

    // The byte-identical skip (D5), extended to the second field: only a field
    // that actually differs from its current value is sent, and a `PATCH` with
    // neither field is not sent at all. That is what keeps a rerun of this
    // action from retriggering itself over a title it already set correctly.
    const fields: { title?: string; body?: string } = {}
    if (upsert.body !== current.body) {
      fields.body = upsert.body
    }
    if (desiredTitle !== null && desiredTitle !== current.title) {
      fields.title = desiredTitle
    }

    if (Object.keys(fields).length === 0) {
      attempt.decision = 'unchanged'
      return
    }

    await client.updatePullRequest(owner, repo, number, fields)
  })

  if (outcome.status === 'skipped') {
    // Reported at the severity the guard read off the error, not at one assumed
    // here, so the two cannot drift.
    report(outcome.severity, outcome.message)
    return
  }

  switch (attempt.decision) {
    case 'unclosed':
      core.warning(
        `The body of ${owner}/${repo}#${number} contains a pr-decorator start marker with no ` +
          'matching end marker, so nothing was written — inserting a second block would leave ' +
          'the body unrepairable. Restore or remove the stray marker line.',
      )
      return
    case 'unchanged':
      core.notice(
        `${owner}/${repo}#${number} already matches what this run would write, so no request ` +
          'was made.',
      )
      return
    case 'updated':
      core.info(`Updated ${owner}/${repo}#${number}.`)
      return
  }
}

/**
 * The action's entrypoint.
 *
 * Never rejects: every failure is turned into a log line and, for a fatal one, an
 * exit code. That is what makes the severity mapping the single place the run's
 * status is decided.
 */
export async function run(): Promise<void> {
  try {
    const inputs = parseInputs()

    const target = resolveTarget()
    if (target === null) {
      core.notice(
        'This event carries no pull request, so there is nothing to decorate. pr-decorator is ' +
          'event-agnostic by design — trigger it from a workflow whose `on:` includes ' +
          '`pull_request` or `pull_request_target`.',
      )
      return
    }

    await decorate(createGitHubClient(inputs.token), inputs, target)
  } catch (error) {
    reportFailure(error)
  }
}
