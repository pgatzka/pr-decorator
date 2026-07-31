---
name: project-pr-decorator-milestone
description: Status of the pr-decorator v1 milestone and the explicit user waiver of the issues-per-milestone rule
metadata:
  type: project
---

As of 2026-07-31 the repository is greenfield — only `README.md`, `.github/ISSUE_TEMPLATE/`
and `.claude/` are tracked. All of pr-decorator v1 is planned as a single milestone of
roughly 15 technical tasks.

**Why:** the user EXPLICITLY WAIVED the usual 3-8 issues-per-milestone guidance for this
milestone, because v1 is one indivisible deliverable (a publishable action) and splitting
it across milestones would produce a half-shippable tag.

**How to apply:** do not raise task count as a finding for this milestone. Do judge whether
individual tasks are too large or too thin, and whether the file-ownership seams are
genuinely disjoint — those still matter. The waiver is milestone-scoped; re-confirm before
assuming it applies to later milestones.

The issue pipeline conventions (epic/technical-task body structure, label families,
dependency planning) are documented in the repo itself under `.github/ISSUE_TEMPLATE/`
and `.claude/agents/` — read those rather than relying on memory.

See [[adr-pr-decorator-v1]].
