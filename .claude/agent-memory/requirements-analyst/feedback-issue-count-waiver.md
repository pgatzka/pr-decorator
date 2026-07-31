---
name: feedback-issue-count-waiver
description: For pr-decorator v1 the user waived the 3-8 issues-per-milestone rule and wants one full unphased breakdown (~10-14 tasks)
metadata:
  type: feedback
---

2026-07: For the `Complete pr-decorator v1` milestone the user **explicitly waived**
the "prefer 3–8 issues per feature" decomposition rule in
`.claude/agents/issue-author.md` and asked for the complete breakdown
(~10–14 technical tasks) in a single milestone.

**Why:** the Action is one indivisible deliverable — it is not shippable until the
renderer, the body-surgery, the guards, CI and the release hygiene all exist.
Splitting it into phases would create milestones that ship nothing usable, and
compressing tasks would hide real seams between modules.

**How to apply:** when a deliverable is a single artifact whose parts are not
independently releasable, propose the full task list and say so, rather than
phasing or bundling to satisfy the count heuristic. Do not silently re-apply the
3–8 rule to this milestone. The rule still stands as the default for future,
separable features — ask before waiving it again.
