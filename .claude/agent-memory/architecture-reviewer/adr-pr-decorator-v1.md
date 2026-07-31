---
name: adr-pr-decorator-v1
description: Architecture decisions of record for the pr-decorator GitHub Action v1, including the approaches that were challenged and what replaced them
metadata:
  type: project
---

The product is a public reusable GitHub Action (`uses: <owner>/pr-decorator@v1`) that
regenerates a marker-delimited managed block in a PR body from git/PR metadata only —
no LLM, no network beyond the GitHub API. Writer-only in v1; no check/validate mode,
no `outputs:`.

**Why:** it is consumed by third-party repos, so the `action.yml` input surface and the
rendered markdown are a public contract — breaking them requires a major tag, not a patch.

**How to apply:** treat `action.yml` inputs and the golden markdown files as versioned
API. Renderers stay pure so golden tests need no HTTP fixtures.

## Accepted decisions (settled 2026-07)

- Commit SHAs render as an explicit link wrapping a code span; code spans suppress
  GitHub autolinking, so a bare backticked SHA would not link. URLs use the BASE repo.
- Commit AUTHOR date, not committer date — survives rebases and matches the @mention
  rendered on the same line.
- `author.login` from the PR commits endpoint, falling back to `commit.author.name`;
  no email-to-user search calls. Logins ending in `[bot]` render without `@`, and
  `web-flow` falls back to the git name.
- 250-commit ceiling on `GET /pulls/{n}/commits` is real; the total must come from the
  `commits` field of the PR object, not the returned list length.
- Commits render in **API list order, never sorted** — matches the PR's own Commits tab.
  Accepted consequence: displayed author dates can be non-monotonic after a rebase.
- Untrusted commit subjects are GFM-escaped (`#`, `@`) and stripped of literal
  `<!-- pr-decorator:* -->` text, rather than wrapped in code spans. Escaping keeps
  subjects readable as prose; code spans remain the fallback if escaping ever proves
  not to suppress closing keywords on merge.
- **`dist/` is committed on every PR.** The bundle lives on `main`, CI runs a
  rebuild-and-diff freshness gate on feature branches, and `@main` works alongside `@v1`.
  Accepted consequence: tasks 02-12 all touch `dist/index.js`, so they conflict on rebase
  and serialize in practice; conflicts are resolved by re-running `npm run package` on the
  rebased source, never by hand-merging the bundle.
- Hard layering rule: nothing under `src/render/` may import from `src/github/` or
  `@actions/github`.

## Rejected, with reasons

- **Actor-based loop guard (`actor == github-actions[bot]` → skip).** Removed. Writes
  made with the default `GITHUB_TOKEN` do not trigger new workflow runs, so it guarded
  a case that cannot occur while silently refusing to decorate PRs opened by other bots.
  Only the byte-identical-block comparison remains; the PAT-in-`token` caveat is a
  README note, not code.
- **Building `dist/` on release only** (`main` source-only, bundle gitignored). Proposed to
  keep tasks 02-12 parallel, but reverted by the user: it makes `@main` unusable, leaves the
  released bundle untested until the tag moves, and concentrates packaging risk in a workflow
  that runs rarely. Superseded by commit-on-every-PR above; the serialization cost is accepted
  deliberately.
- **String-level truncation of the assembled block.** A blunt cut can destroy the `end`
  marker and permanently orphan the block. Truncation instead selects whole commits
  against a character budget before assembly.

See [[project-pr-decorator-milestone]].
