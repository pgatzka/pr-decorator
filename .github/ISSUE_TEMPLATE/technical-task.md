---
name: Technical task
about: A single mergeable unit of technical work, linked to a milestone and an epic
title: "<imperative technical title, e.g. Add optimistic locking to OrderRepository>"
labels: type/feature
---

## Context

Why this task exists; link to the requirement. 2–4 sentences.

## Technical scope

- Concrete changes per file/module
- Interfaces/contracts to add or change
- Data/schema migrations if any

## Out of scope

- Explicit non-goals to prevent scope creep

## Dependencies

- Blocked by: #NN <!-- documents the native blocked-by relationship; delete section if none -->

## Test strategy

- Which levels apply (unit / integration / end-to-end) and why
- What to cover: new behavior, edge cases, regression risks
- Where the tests live and how to run them (exact command)

## Acceptance criteria

- [ ] Verifiable, binary check — a command to run or behavior to observe
- [ ] Tests added/updated at `<path>`

## Estimated size

small / medium / large — one-line justification

<!--
Invariants (enforced by the issue pipeline):
milestone assigned · ≥1 label · sub-issue of the milestone's epic ·
blocked-by relationships set natively · this body structure complete
-->
