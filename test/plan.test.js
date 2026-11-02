// Offline test for today's plan: parsing, the lock rule, and the Plan page in a fake DOM.
// Run: node test/plan.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const plan = require("../dota-limit/plan");

// ---- parsing: the plan as it gets pasted, with a title and numbered sub-tasks
const pasted = `Today’s Plan
1. GYM
2. Clean Work Room
3. Clean Self Room
4. Apply Jobs
5. Improve RESUME
6. Sprint 6 Aurora
    1. Improve each AI plugins
    2. Improve Claude.MD for each services and apps
7. PRD for QAll
8. PRD for Firma
`;
const tasks = plan.parse(pasted);
assert.strictEqual(tasks.length, 10, "the title is left out");
assert.deepStrictEqual(tasks[0], { text: "GYM", depth: 0, done: false });
assert.deepStrictEqual(tasks[6], { text: "Improve each AI plugins", depth: 1, done: false });
assert.strictEqual(tasks.filter((t) => !t.depth).length, 8);
assert.deepStrictEqual(plan.parse("Gym\n\n  \nRead").map((t) => t.text), ["Gym", "Read"], "no markers: every line is a task");
assert.deepStrictEqual(plan.parse("- a\n* b\n2) c\n1. ").map((t) => t.text), ["a", "b", "c"], "bullets, and empty items dropped");
assert.strictEqual(plan.parse("x\n".repeat(500)).length, 100, "capped");

// Editing keeps the ticks on tasks that didn't change.
const ticked = plan.parse("1. Gym\n2. Read", [{ text: "Gym", depth: 0, done: true }, { text: "Old", depth: 0, done: true }]);
assert.deepStrictEqual(ticked.map((t) => t.done), [true, false]);
console.log("ok: parsing");

// ---- the lock rule
const day = (gate, done) => ({ gate, tasks: tasks.map((t, i) => Object.assign({}, t, { done: done.includes(i) })) });
assert.strictEqual(plan.locked({ gate: 3, tasks: [] }), true, "no plan yet: locked");
assert.strictEqual(plan.locked(day(3, [0, 1])), true);
assert.strictEqual(plan.locked(day(3, [0, 1, 2])), false, "tasks 1 to 3 done: open");
assert.strictEqual(plan.locked(day(3, [0, 2, 3, 4])), true, "order doesn't matter, all of 1 to 3 do");
assert.strictEqual(plan.locked(day(7, [0, 1, 2, 3, 4, 5, 8])), false, "sub-tasks don't count toward the gate");
assert.strictEqual(plan.locked(day(50, [0, 1, 2, 3, 4, 5, 8, 9])), false, "a gate past the end means every task");
assert.strictEqual(plan.locked(day(50, [0, 1, 2, 3, 4, 5, 8])), true);
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
  const today = { day: "2026-11-03", gate: 3, tasks: tasks.map((t, i) => Object.assign({}, t, { done: i === 0 })), on: true, locked: true, allow: ["spotify.com"] };
  today.tasks[1].text = "<b>Clean</b> Work Room";
  let p = await page(today);
  let out = p.body();
  assert.ok(out.includes("locked until tasks 1 to 3 are done"), out);
  assert.ok(out.includes("Still open: spotify.com"));
  assert.ok(out.includes("&lt;b&gt;Clean&lt;/b&gt;") && !out.includes("<b>Clean"), "task text is escaped");
  assert.ok(/Clean Self Room<\/span><\/label><div class="gate">/.test(out), "the line sits after task 3");
  assert.strictEqual((out.match(/checked/g) || []).length, 1);
  assert.ok(/<span class="n">1\.<\/span><span class="t">Improve each AI plugins/.test(out), "sub-tasks are numbered inside their task");

  // Ticking a box posts its index.
  await p.listeners.change({ target: { dataset: { i: "2" }, checked: true } });
  assert.deepStrictEqual(p.posts, [{ check: 2, done: true }]);

  // No plan yet: the form, with the last gate filled in.
  p = await page(Object.assign({}, today, { tasks: [], gate: 4 }));
  out = p.body();
  assert.ok(out.includes("Write today's plan to start"));
  assert.ok(out.includes('<textarea') && out.includes('value="4"'));
  assert.ok(!out.includes("Cancel"), "nothing to go back to");

  // Saving sends the text and the gate.
  p.els.text = { value: "1. Gym" };
  p.els.gate = { value: "2" };
  await p.listeners.click({ target: { id: "save" } });
  assert.deepStrictEqual(p.posts, [{ text: "1. Gym", gate: 2 }]);

  // Lock off: just a checklist, no line.
  p = await page(Object.assign({}, today, { on: false, locked: false }));
  out = p.body();
  assert.ok(out.includes("web lock is off") && !out.includes('class="gate"'));

  p = await page(Object.assign({}, today, { locked: false }));
  assert.ok(p.body().includes("The web is open"));
  console.log("ok: plan page");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
