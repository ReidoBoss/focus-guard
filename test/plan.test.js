// Offline test for today's plan: page changes and focus, the lock rule, and the Plan page in a fake DOM.
// Run: node test/plan.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const plan = require("../dota-limit/plan");

// ---- changes from the page
const fresh = () => ({ gate: 3, tasks: [] });
let p = fresh();
["Gym", "  Read  ", "", "Code"].forEach((add) => plan.apply(p, { add }));
assert.deepStrictEqual(p.tasks.map((t) => t.text), ["Gym", "Read", "Code"], "trimmed, empty dropped");
plan.apply(p, { task: 1, done: true });
assert.strictEqual(p.tasks[1].done, true);
plan.apply(p, { task: 1, remove: true });
assert.deepStrictEqual(p.tasks.map((t) => t.text), ["Gym", "Code"]);
plan.apply(p, { task: 9, done: true, remove: true });
plan.apply(p, { task: "0", remove: true });
assert.strictEqual(p.tasks.length, 2, "bad indexes do nothing");
plan.apply(p, { gate: "0" });
assert.strictEqual(p.gate, 1);
for (let i = 0; i < 120; i++) plan.apply(p, { add: "x" });
assert.strictEqual(p.tasks.length, 100, "capped");

// Focus sites are cleaned up to domains.
assert.strictEqual(plan.site("https://www.GitHub.com/foo?x=1"), "github.com");
assert.strictEqual(plan.site("docs.google.com:443"), "docs.google.com");
["", "localhost", "javascript:alert(1)", "a b.com", "<x>.com"].forEach((s) => assert.strictEqual(plan.site(s), null, s));
p = fresh();
plan.apply(p, { add: "Code" });
plan.apply(p, { add: "Read" });
plan.apply(p, { task: 0, sites: ["github.com", "", "www.github.com", "nope", 5] });
assert.deepStrictEqual(p.tasks[0].sites, ["github.com"]);

// Focus: one task at a time, only with sites, and ticking it off ends it.
plan.apply(p, { task: 1, focus: true });
assert.strictEqual(plan.focused(p), null, "no sites, no focus");
plan.apply(p, { task: 0, focus: true });
assert.strictEqual(plan.focused(p), p.tasks[0]);
plan.apply(p, { task: 1, sites: ["wikipedia.org"] });
plan.apply(p, { task: 1, focus: true });
assert.strictEqual(plan.focused(p), p.tasks[1], "starting another stops the first");
plan.apply(p, { task: 1, focus: false });
assert.strictEqual(plan.focused(p), null);
plan.apply(p, { task: 0, focus: true });
plan.apply(p, { task: 0, done: true });
assert.strictEqual(plan.focused(p), null, "done ends focus");
plan.apply(p, { task: 1, focus: true });
plan.apply(p, { task: 1, sites: [] });
assert.strictEqual(plan.focused(p), null, "clearing the sites ends focus");
console.log("ok: changes");

// ---- the lock rule
const day = (gate, done) => ({ gate, tasks: [0, 1, 2, 3, 4].map((i) => ({ text: "t" + i, done: done.includes(i) })) });
assert.strictEqual(plan.locked({ gate: 3, tasks: [] }), true, "no plan yet: locked");
assert.strictEqual(plan.locked(day(3, [0, 1])), true);
assert.strictEqual(plan.locked(day(3, [0, 1, 2])), false, "tasks 1 to 3 done: open");
assert.strictEqual(plan.locked(day(3, [0, 2, 3, 4])), true, "order doesn't matter, all of 1 to 3 do");
assert.strictEqual(plan.locked(day(50, [0, 1, 2, 3, 4])), false, "a gate past the end means every task");
assert.strictEqual(plan.locked(day(50, [0, 1, 2, 3])), true);
console.log("ok: lock rule");

// ---- the Plan page
const html = fs.readFileSync(path.join(__dirname, "..", "dota-limit", "plan.html"), "utf8");
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];

async function page(answer) {
  const els = {};
  const listeners = {};
  const posts = [];
  const document = {
    getElementById: (id) =>
      (els[id] = els[id] || {
        innerHTML: "",
        textContent: "",
        value: "",
        addEventListener: (type, fn) => (listeners[type] = fn),
      }),
  };
  const fetch = async (url, opts) => {
    assert.strictEqual(url, "/api/plan");
    if (opts && opts.method === "POST") posts.push(JSON.parse(opts.body));
    return { ok: true, json: async () => JSON.parse(JSON.stringify(answer)) };
  };
  vm.runInNewContext(script, { console, JSON, Object, Array, String, Number, Promise, Date, Error, document, fetch });
  await new Promise((r) => setTimeout(r, 10));
  return { body: () => els.body.innerHTML, listeners, posts, els };
}

(async () => {
  const tasks = ["Gym", "<b>Clean</b> Work Room", "Clean Self Room", "Code"].map((text, i) => ({ text, done: i === 0, sites: [], focus: false }));
  tasks[3].sites = ["github.com", "docs.google.com"];
  const today = { day: "2026-11-03", gate: 3, tasks, on: true, gateLocked: true, locked: true, allow: ["spotify.com"] };
  let p = await page(today);
  let out = p.body();
  assert.ok(out.includes("locked until tasks 1 to 3 are done"), out);
  assert.ok(out.includes("Still open: spotify.com"));
  assert.ok(out.includes("&lt;b&gt;Clean&lt;/b&gt;") && !out.includes("<b>Clean"), "task text is escaped");
  assert.ok(/Clean Self Room[\s\S]*?<div class="gate">[\s\S]*Code/.test(out), "the line sits after task 3");
  assert.strictEqual((out.match(/ checked/g) || []).length, 1);
  assert.ok(out.includes("Focus sites: github.com, docs.google.com"));
  assert.strictEqual((out.match(/data-focus=/g) || []).length, 1, "Focus only on tasks with sites");

  // Ticking a box, adding, removing, focusing and saving sites post their changes.
  await p.listeners.change({ target: { dataset: { i: "2" }, checked: true } });
  p.els.new = { value: "Read", focus() {} };
  await p.listeners.submit({ preventDefault() {} });
  await p.listeners.click({ target: { dataset: { remove: "1" } } });
  await p.listeners.click({ target: { dataset: { focus: "3" }, textContent: "Focus" } });
  await p.listeners.click({ target: { dataset: { sites: "0" } } });
  assert.ok(p.body().includes('id="sites"'), "sites editor opens");
  p.els.sites = { value: "github.com, wikipedia.org" };
  await p.listeners.click({ target: { dataset: { saveSites: "0" } } });
  await p.listeners.change({ target: { id: "gate", value: "2", dataset: {} } });
  assert.deepStrictEqual(p.posts, [
    { task: 2, done: true },
    { add: "Read" },
    { task: 1, remove: true },
    { task: 3, focus: true },
    { task: 0, sites: ["github.com", "wikipedia.org"] },
    { gate: 2 },
  ]);

  // A started focus task.
  const focusing = JSON.parse(JSON.stringify(today));
  focusing.tasks[3].focus = true;
  focusing.allow = ["spotify.com", "github.com", "docs.google.com"];
  out = (await page(focusing)).body();
  assert.ok(out.includes("Focus: Code. Only github.com, docs.google.com are open."), out);
  assert.ok(out.includes("Still open: spotify.com.") && out.includes(">Stop<"));

  // No plan yet.
  out = (await page(Object.assign({}, today, { tasks: [] }))).body();
  assert.ok(out.includes("Add today's tasks to start") && out.includes('id="addform"'));

  // Lock off: just a checklist, no line, no gate box.
  out = (await page(Object.assign({}, today, { on: false, gateLocked: false, locked: false }))).body();
  assert.ok(out.includes("daily web lock is off") && !out.includes('class="gate"') && !out.includes('id="gate"'));

  out = (await page(Object.assign({}, today, { gateLocked: false, locked: false }))).body();
  assert.ok(out.includes("The web is open"));
  console.log("ok: plan page");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
