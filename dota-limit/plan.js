// Today's plan: a checklist that keeps the web locked until its first tasks are ticked.
// Pure functions; the daemon keeps the plan in plan.json and serves it at /plan.

// "1. GYM", "2) Gym", "- Gym", "* Gym" -> "GYM".
const MARKER = /^\s*(?:\d+[.)]|[-*•])\s+/;

// One task per line; an indented line is a sub-task. When some lines are numbered or
// bulleted, the others are headings like "Today's Plan" and are left out.
// Ticks carry over from `old` for tasks whose text didn't change.
function parse(text, old) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim());
  const marked = lines.filter((l) => MARKER.test(l));
  return (marked.length ? marked : lines)
    .map((l) => ({ text: l.replace(MARKER, "").trim().slice(0, 300), depth: /^\s/.test(l) ? 1 : 0 }))
    .filter((t) => t.text)
    .slice(0, 100)
    .map((t) => Object.assign(t, { done: (old || []).some((o) => o.done && o.text === t.text) }));
}

// Locked until the first `gate` top-level tasks are done. No plan yet counts as locked.
function locked(plan) {
  const top = plan.tasks.filter((t) => !t.depth);
  return !top.length || top.slice(0, plan.gate || top.length).some((t) => !t.done);
}

module.exports = { parse, locked };
