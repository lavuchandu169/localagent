# Crew pitfalls

**Don't invent roles for a simple task.** A one-file bug fix doesn't
need a "crew" — if the goal is genuinely small, say so and just do it
as a normal single-pass task instead of performing a multi-role
structure that adds nothing.

**Don't let a later role silently redo an earlier role's work.** Read
what the previous role actually produced (the real files, not just its
own summary) before starting the next role's sub-task — summaries
drift from the real diff.

**Keep the roster small.** More than 4 roles for a single goal is
almost always the same work artificially split, not genuine
specialization — it costs more turns and more chances for roles to
contradict each other without buying anything.

**A role disagreeing with scope is useful signal, not a bug.** If the
"Reviewer" role would flag real objections (security, correctness, a
contradiction with an earlier role's decision), say so plainly in that
role's own turn rather than smoothing it over in the rollup.
