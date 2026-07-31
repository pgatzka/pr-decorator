---
name: reference-repo-writing-rules
description: Where this repo's HOUSE style for issues/PRs is defined (issue templates + .claude agents) — distinct from the official GitHub docs the product implements
metadata:
  type: reference
---

2026-07: The repository has no `CLAUDE.md` and no style guide document. Its
**house** writing rules — how issues, milestones and reviews in THIS repo must
look — are defined implicitly across:

- `.github/ISSUE_TEMPLATE/technical-task.md` and `epic.md` — canonical body
  section order and heading names.
- `.claude/agents/issue-author.md` — issue anatomy, imperative-title rule,
  3–8 issues per feature, "never speculate about code you have not seen".
- `.claude/agents/issue-reviewer.md` — binary acceptance criteria, no placeholders.
- `.claude/agents/pr-reviewer.md` — the PR-side format precedent, including the
  mandatory machine-readable trailer (`reviewed: approved` /
  `reviewed: requesting changes`) that automation depends on.
- `.claude/agents/triage-labeler.md` — label taxonomy (`family/value`, lowercase
  kebab-case, FULL WORDS ONLY, unique colors, description required).
- `.claude/agents/milestone-creator.md` — one milestone = one coherent deliverable,
  description must contain Description + Acceptance criteria.
- `.claude/settings.json` — the gh permission model (`gh pr merge` is denied).

**Why it matters:** these govern the *delivery process* for building pr-decorator.
They are explicitly NOT the specification for what the Action writes into PR
bodies — that comes from docs.github.com (see [[project-pr-decorator-scope]]).

**How to apply:** read these files rather than recalling their content — they are
authoritative and may change. Cite them when a spec claims "follows the
repository's house conventions".
