---
name: crew
description: Use when the user wants a small team of AI roles (a "crew") to tackle one goal together, not just a single agent turn.
triggers: [crew, "ai employees", "ai organization", "team of agents", "hire a team", "organization of agents"]
---
A "crew" is a small, named group of AI employee roles working one
shared goal together inside this same session — not a new subsystem,
just a structured way to run several role-scoped passes back to back,
each still gated by the normal permission engine and diff approval a
role carries no special authority of its own.

Before writing any code:

1. State the goal in one sentence, confirmed against what the user
   actually asked.
2. Propose a short roster (2-4 roles) that actually fits the goal —
   e.g. "Backend", "Frontend", "Reviewer" for a full-stack feature;
   "Writer", "Editor" for a content task. Don't pad the roster with
   roles the goal doesn't need.
3. Break the goal into one concrete sub-task per role, ordered by
   dependency (e.g. Backend before Frontend if the frontend calls an
   API the backend defines).

Then work through the roster one role at a time:

- Announce the switch plainly: "Acting as <Role> now:" before starting
  that role's sub-task.
- Do that sub-task's real work through the normal tool flow — reads,
  edits, and commands all still go through the existing permission
  engine and per-hunk diff approval.
- Before moving to the next role, give a short handoff: what this role
  finished, and what the next role needs to know (a function
  signature, a file path, a decision made).

After the last role finishes, give one short rollup: what the crew
produced, role by role, and anything left undone.

See references/pitfalls.md for sizing the roster and keeping roles honest.
