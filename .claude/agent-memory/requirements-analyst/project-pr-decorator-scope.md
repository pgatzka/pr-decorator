---
name: project-pr-decorator-scope
description: pr-decorator is greenfield — the product is a GitHub Action decorating PR bodies per GitHub's OFFICIAL writing docs; the settled v1 spec lives in GitHub milestone 1
metadata:
  type: project
---

2026-07: `pr-decorator` is a greenfield PUBLIC repo (github.com/pgatzka/pr-decorator,
default branch `main`). The product is a **reusable GitHub Action that decorates
pull requests** — writing a deterministic, marker-delimited
GitHub-Flavored-Markdown block into the PR body.

**Why:** the user's motivation is that hand-written PR descriptions are "junk".

**Decision (2026-07, user, explicit correction):** the formatting rules the ACTION
applies come from GitHub's *official* documentation — docs.github.com "Writing on
GitHub" (basic writing and formatting syntax) and the Pull Requests reference —
**not** from any convention local to this repository.

**Decision (2026-07, user, after full interview):** the v1 specification is
SETTLED and recorded as the description + acceptance criteria of GitHub milestone
1, "Complete pr-decorator v1"
(https://github.com/pgatzka/pr-decorator/milestone/1). Read that milestone rather
than re-deriving or re-litigating scope. Headline decisions: writer-only (no
check/validate mode), all config via the workflow `with:` block (no config file),
`timezone` is a required input with no default, commits render as a bullet list
(explicitly not a table), TypeScript + `@vercel/ncc` with `dist/` committed.

**How to apply:**
- Never conflate the product's output format (official GFM docs) with this repo's
  house style for issues/PRs (see [[reference-repo-writing-rules]]).
- `.claude/agents/*` + `.github/ISSUE_TEMPLATE/*` are the authoring/review
  pipeline (tooling), not the product and not the product's spec.
- Milestone 1 is intentionally oversized — see [[feedback-issue-count-waiver]].
- The repo dogfoods the Action on its own pull requests.
