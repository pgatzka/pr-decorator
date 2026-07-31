---
description: Create a GitHub milestone from a described goal (1 deliverable = 1 milestone)
argument-hint: [goal, description and acceptance criteria]
---

Delegate to the milestone-creator subagent to create a GitHub milestone for
this deliverable:

$ARGUMENTS

If nothing was passed above, ask me for the milestone content (summary,
description, acceptance criteria, and a target date if there is one) and then
delegate.

Afterwards, report back the milestone number, title, due date, and URL — or,
if a milestone for that deliverable already existed, report the existing one
and the differences the agent found.
