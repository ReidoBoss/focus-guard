// Today's plan: a list of tasks that keeps the web locked until its first tasks are ticked.
// A task can also carry focus sites: while it's started, every other site is closed.
// Pure functions; the daemon keeps the plan in plan.json and serves it at /plan.

// "https://www.GitHub.com/foo" -> "github.com". Anything that isn't a domain -> null.
function site(s) {
  const host = String(s || "").trim().toLowerCase().replace(/^[a-z]+:\/\//, "").split(/[/?#:]/)[0].replace(/^www\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(host) ? host : null;
}

// One change from the plan page, checked here because any website can post to 127.0.0.1.
// Returns the plan, changed in place.
function apply(p, ask) {
  const t = Number.isInteger(ask.task) ? p.tasks[ask.task] : null;
  if (typeof ask.add === "string" && ask.add.trim() && p.tasks.length < 100) p.tasks.push({ text: ask.add.trim().slice(0, 300), done: false, sites: [], focus: false });
  if (ask.gate !== undefined) p.gate = Math.max(1, Math.min(100, Math.floor(Number(ask.gate)) || 1));
  if (!t) return p;
  if (ask.remove === true) p.tasks.splice(ask.task, 1);
  if (typeof ask.done === "boolean") t.done = ask.done;
  if (Array.isArray(ask.sites)) {
    t.sites = ask.sites.map(site).filter((s, i, all) => s && all.indexOf(s) === i).slice(0, 20);
    if (!t.sites.length) t.focus = false;
  }
  if (typeof ask.focus === "boolean") {
    p.tasks.forEach((o) => (o.focus = false));
    t.focus = ask.focus && (t.sites || []).length > 0 && !t.done;
  }
  return p;
}

// The started focus task, or null. Ticking it off ends it.
function focused(p) {
  return p.tasks.filter((t) => t.focus && !t.done && (t.sites || []).length)[0] || null;
}

// Locked until the first `gate` tasks are done. No plan yet counts as locked.
function locked(p) {
  return !p.tasks.length || p.tasks.slice(0, p.gate || p.tasks.length).some((t) => !t.done);
}

module.exports = { site, apply, focused, locked };
