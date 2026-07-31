---
description: Run the full requirements → GitHub issues pipeline (analyst → dialogue → architecture → planner → author → reviewer → publish)
argument-hint: [feature or requirement description]
---

Run the issue-creation pipeline for this requirement:

$ARGUMENTS

If no requirement was passed above, ask me for it first.

Execute the phases strictly in order. Do not skip the review gates. All user
dialogue happens here in the main conversation — subagents cannot ask the
user anything, so relay their questions to me using the AskUserQuestion tool
with concrete tappable options wherever possible.

## Phase 1 — Requirements analysis (requirements-analyst)

Delegate to the requirements-analyst subagent: analyze the requirement
against the codebase and return the specification with open questions.

## Phase 2 — Interactive refinement (main conversation)

Present each OPEN QUESTION to me via AskUserQuestion, using the analyst's
suggested options. Send my answers back to the requirements-analyst (resume
it) and repeat until it returns an empty OPEN QUESTIONS section. Then show me
the final REQUIREMENT SUMMARY in one short paragraph before continuing.

## Phase 3 — Architecture review (architecture-reviewer)

Delegate to the architecture-reviewer with the final specification and
proposed task candidates. On VERDICT: CONCERNS with blockers, feed the
required changes back into the specification (re-invoking the
requirements-analyst and me where user decisions are needed via
AskUserQuestion), then re-review. Do not proceed to drafting until the
verdict is SOUND. Maximum two revision cycles; after that, stop and show me
the unresolved blockers.

## Phase 4 — Draft issues (issue-author, Mode DRAFT)

Delegate to the issue-author in Mode DRAFT with the final specification and
the architecture reviewer's advisories. Drafts follow
`.github/ISSUE_TEMPLATE/technical-task.md` and go to `.claude/issue-drafts/`.

## Phase 5 — Plan dependencies, epics & milestones (dependency-planner)

Delegate to the dependency-planner. If it reports a MISSING milestone, show
me its proposed title and scope and confirm it with me via AskUserQuestion;
then delegate to the milestone-creator with that deliverable (if the agent
reports missing acceptance criteria, relay its question to me and re-delegate
with my answer), and re-run the planner's milestone assignment. Pass the planner's
PROPOSED DRAFT EDITS to the issue-author to apply. The plan must give every
draft a milestone, a parent epic, and its blocked-by edges before you
continue.

## Phase 6 — Labels (triage-labeler)

Delegate to the triage-labeler with the drafts. It reuses existing labels and
creates missing ones (full-word names, unique color, one-line description).
Include any newly created labels in your final report.

## Phase 7 — QA gate (issue-reviewer)

Delegate to the issue-reviewer. If CHANGES REQUESTED: send the blockers to
the issue-author (Mode DRAFT, fix pass), then re-review. Maximum two
fix/review cycles; if blockers remain after that, stop and show me the
unresolved blockers instead of publishing.

## Phase 8 — Publish (issue-author, Mode PUBLISH)

Only after VERDICT: APPROVED, delegate to the issue-author in Mode PUBLISH
with the planner's publish order, label mapping, and milestone/epic
assignment. It creates the epic issues first, then the tasks directly via
the gh CLI in dependency order, wiring native sub-issue (--parent) and
blocked-by relationships, and verifies every link afterwards.

## Final report

Summarize for me in a few sentences: created issue URLs in publish order,
milestone(s) and epic(s) used, labels created (if any), architecture
advisories carried into the issues, and anything deferred or flagged.
Then clean up `.claude/issue-drafts/`.
