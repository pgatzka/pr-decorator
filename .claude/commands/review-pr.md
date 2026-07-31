---
description: "Review a pull request against its linked GitHub issue and post the review (reviewed: approved / requesting changes)"
argument-hint: [PR number or URL]
---

Delegate to the pr-reviewer subagent to review this pull request against its
linked GitHub issue:

$ARGUMENTS

If no PR was given above, list open PRs with `gh pr list` and ask me which
one to review.

The agent reads the linked issue, verifies every acceptance criterion,
checks scope and code quality, and posts the review on the PR ending with
`reviewed: approved` or `reviewed: requesting changes` plus bullet points.

Afterwards, report back to me in a few sentences: the verdict, the
acceptance-criteria tally (met / not met / not verifiable), and the link to
the posted review. If the agent could not find a linked issue, relay that
and ask me which issue the PR implements, then re-delegate with it.
