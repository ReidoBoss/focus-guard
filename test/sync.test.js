// Offline test for sharing the Dota and Plan tabs: the merge rules, then two machines
// syncing through a real server on 127.0.0.1.
// Run: node test/sync.test.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { mergeDay, mergeDays, mergePlan, createServer, createSync } = require("../dota-limit/sync");

// ---- merge rules
const mac = { day: "2026-11-03", lockedAt: null, matches: { 1: { result: "win" }, 2: { result: null, details: { hero: "x" } } } };
const pc = { day: "2026-11-03", lockedAt: "2026-11-03T20:00:00Z", blockedLaunches: 2, matches: { 2: { result: "loss" }, 3: { result: "loss" } } };
const day = mergeDay(mac, pc);
assert.deepStrictEqual(Object.keys(day.matches), ["1", "2", "3"], "matches from both machines");
assert.strictEqual(day.matches[2].result, "loss", "finished copy wins");
assert.strictEqual(day.lockedAt, pc.lockedAt, "locked on one machine, locked on all");
assert.strictEqual(day.blockedLaunches, 2);
assert.strictEqual(mergeDay(mac, undefined), mac);
const ready = { result: "win", opendota: { status: "ready", players: [1, 2, 3] } };
assert.strictEqual(mergeDay({ day: "d", matches: { 1: { result: "win", opendota: { status: "pending" } } } }, { day: "d", matches: { 1: ready } }).matches[1], ready, "fuller copy wins");

const days = mergeDays([{ day: "2026-11-01", matches: { 9: {} } }], [{ day: "2026-11-02", matches: {} }, { day: "2026-11-01", matches: { 8: {} } }]);
assert.deepStrictEqual(days.map((d) => d.day), ["2026-11-02", "2026-11-01"], "newest first");
assert.deepStrictEqual(Object.keys(days[1].matches), ["8", "9"]);

const old = { day: "2026-11-02", tasks: [], updatedAt: 9e12 };
const edited = { day: "2026-11-03", tasks: [{ text: "a" }], updatedAt: 5 };
const later = { day: "2026-11-03", tasks: [], updatedAt: 6 };
assert.strictEqual(mergePlan(old, edited), edited, "today's plan beats yesterday's");
assert.strictEqual(mergePlan(edited, later), later, "latest edit wins");
assert.strictEqual(mergePlan(later, edited), later);
assert.strictEqual(mergePlan(null, edited), edited);

// ---- two machines through the server
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fg-sync-")), "sync.json");
const token = "test-token-0123456789";
const server = createServer({ file, token }).listen(0, "127.0.0.1", async () => {
  const url = `http://127.0.0.1:${server.address().port}/`;
  const logs = [];
  const log = (m) => logs.push(m);
  const call = (sync, d, p) => new Promise((resolve) => {
    sync(d, p, resolve);
    setTimeout(() => resolve("no reply"), 2000);
  });
  try {
    const a = createSync({ url, token, log });
    const b = createSync({ url, token, log });
    let r = await call(a, [mac], edited);
    assert.strictEqual(r.rev, 1);
    r = await call(b, [pc], null);
    assert.strictEqual(r.rev, 2);
    assert.deepStrictEqual(Object.keys(r.days[0].matches), ["1", "2", "3"], "B gets A's matches");
    assert.deepStrictEqual(r.plan, edited, "B gets A's plan");
    r = await call(a, [mac], edited);
    assert.strictEqual(r.days[0].lockedAt, pc.lockedAt, "A sees B's lock");
    r = await call(a, [mac], edited);
    assert.deepStrictEqual(r, { rev: 2 }, "nothing new, nothing sent back");
    assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).rev, 2, "saved to disk");
    assert.deepStrictEqual(logs, []);

    assert.strictEqual(await call(createSync({ url, token: "wrong-token-0123456789", log }), [], null), "no reply");
    assert.ok(/HTTP 403/.test(logs.pop()), "wrong token refused");
    assert.strictEqual(await call(createSync({ url, token, log }), [{ day: "nope", matches: {} }], null), "no reply");
    assert.ok(/HTTP 400/.test(logs.pop()), "bad data refused");
    console.log("sync tests passed");
  } finally {
    server.close();
  }
});
