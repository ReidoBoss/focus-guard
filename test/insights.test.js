// Offline tests for dota-limit/insights.js: hero report, counter-picks, lanes, gold swing,
// tilt check and weekly summary. Run: node test/insights.test.js
const assert = require("assert");
const I = require("../dota-limit/insights");

const NOW = Date.UTC(2026, 9, 2, 12); // Fri 2 Oct 2026
const daysAgo = (n) => Math.floor(NOW / 1000) - n * 86400;
const H = (n) => `npc_dota_hero_${n}`;

function ok(name, fn) {
  fn();
  console.log(`ok: ${name}`);
}

// ---- 1. hero report
ok("hero report: win rate, KDA, GPM, trend, best/worst/improving", () => {
  const m = (hero, win, ago, extra) => Object.assign({ hero: H(hero), player_slot: 0, radiant_win: win, start_time: daysAgo(ago), kills: 10, deaths: 2, assists: 8, gold_per_min: 600 }, extra);
  const rows = [];
  // Juggernaut: 12 games, 8 wins. Earlier 2-4, last 30 days 6-0, so a big upward trend.
  for (let i = 0; i < 6; i++) rows.push(m("juggernaut", true, 5));
  for (let i = 0; i < 2; i++) rows.push(m("juggernaut", true, 60));
  for (let i = 0; i < 4; i++) rows.push(m("juggernaut", false, 60, { deaths: 8 }));
  // Pudge: 10 games, 2 wins.
  for (let i = 0; i < 10; i++) rows.push(m("pudge", i < 2, 10, { gold_per_min: 300 }));
  // A dire-side win, to check the slot logic.
  rows.push({ hero: H("axe"), player_slot: 130, radiant_win: false, start_time: daysAgo(1), kills: 1, deaths: 1, assists: 1 });
  const r = I.heroReport(rows, NOW);
  assert.strictEqual(r.games, 23);
  assert.strictEqual(r.wins, 8 + 2 + 1);
  const jugg = r.heroes.find((h) => h.hero === H("juggernaut"));
  assert.strictEqual(jugg.games, 12);
  assert.strictEqual(jugg.wins, 8);
  assert.strictEqual(jugg.deaths, 4); // (8*2 + 4*8) / 12
  assert.strictEqual(jugg.trend, 100 - 33);
  assert.strictEqual(r.heroes.find((h) => h.hero === H("pudge")).gpm, 300);
  assert.strictEqual(r.heroes.find((h) => h.hero === H("axe")).wins, 1, "dire win counted");
  assert.strictEqual(r.best, H("juggernaut"));
  assert.strictEqual(r.worst, H("pudge"));
  assert.strictEqual(r.improving, H("juggernaut"));
});

ok("hero report: best/worst need 10 games", () => {
  const r = I.heroReport([{ hero: H("axe"), player_slot: 0, radiant_win: true, start_time: daysAgo(1) }], NOW);
  assert.strictEqual(r.best, null);
  assert.strictEqual(r.worst, null);
});

// ---- 3. counter-picks
ok("counters: hardest matchups first, small samples dropped", () => {
  const rows = [
    { hero: H("axe"), games_played: 100, wins: 40 }, // axe wins 60% against it
    { hero: H("lina"), games_played: 50, wins: 15 }, // lina wins 70%
    { hero: H("tiny"), games_played: 5, wins: 0 }, // 100%, but only 5 games
    { hero: H("lion"), games_played: 80, wins: 60 }, // lion wins 25%
  ];
  const c = I.counters(rows);
  assert.deepStrictEqual(c.map((x) => x.hero), [H("lina"), H("axe"), H("lion")]);
  assert.strictEqual(c[0].winRate, 70);
  const mine = I.yourCounters(c, { heroes: [{ hero: H("axe"), games: 20, wins: 12 }, { hero: H("lina"), games: 1, wins: 1 }] });
  assert.deepStrictEqual(mine.map((x) => x.hero), [H("axe")], "only heroes you've played 3+ times");
});

// ---- 4. lanes and gold
const parsed = {
  goldAdv: [0, 200, -500, -1500, -3000, -1000, 2000, 6000, 9000, 4000, -2000, -8000],
  players: [
    { slot: 0, team: "radiant", hero: H("juggernaut"), lane: 1, gold10: 3000, lh10: 40 },
    { slot: 1, team: "radiant", hero: H("lion"), lane: 1, gold10: 1500, lh10: 3 },
    { slot: 2, team: "radiant", hero: H("lina"), lane: 2, gold10: 4000, lh10: 50 },
    { slot: 3, team: "radiant", hero: H("axe"), lane: 3, gold10: 3500, lh10: 30 },
    { slot: 4, team: "radiant", hero: H("rubick"), lane: 3, gold10: 1500, lh10: 2 },
    { slot: 128, team: "dire", hero: H("tidehunter"), lane: 1, gold10: 3200, lh10: 35 },
    { slot: 129, team: "dire", hero: H("dazzle"), lane: 1, gold10: 1400, lh10: 4 },
    { slot: 130, team: "dire", hero: H("invoker"), lane: 2, gold10: 5500, lh10: 70 },
    { slot: 131, team: "dire", hero: H("medusa"), lane: 3, gold10: 5000, lh10: 60 },
    { slot: 132, team: "dire", hero: H("shadow_shaman"), lane: 3, gold10: 1500, lh10: 1 },
  ],
};

ok("lanes: winner per lane, within 10% is even", () => {
  const lanes = I.laneResults(parsed);
  assert.deepStrictEqual(lanes.map((l) => [l.lane, l.winner]), [["top", "dire"], ["middle", "dire"], ["bottom", "even"]]);
  assert.strictEqual(lanes[1].goldDiff, -1500);
});

ok("your lane: opponent is the richest enemy in your lane", () => {
  const y = I.yourLane(parsed, 2);
  assert.strictEqual(y.opponent, H("invoker"));
  assert.strictEqual(y.goldDiff, -1500);
  assert.strictEqual(y.lhDiff, -20);
  assert.strictEqual(I.yourLane({ players: [{ slot: 0, team: "radiant", lane: 4 }] }, 0), null, "jungle has no lane result");
});

ok("gold swing: from your team's side", () => {
  const r = I.goldSwing(parsed.goldAdv, "radiant");
  assert.deepStrictEqual(r.lead, { gold: 9000, minute: 8 });
  assert.deepStrictEqual(r.deficit, { gold: -8000, minute: 11 });
  const d = I.goldSwing(parsed.goldAdv, "dire");
  assert.strictEqual(d.lead.gold, 8000);
});

// ---- 2. tilt check
const label = (n) => ({ [H("invoker")]: "Invoker", [H("lina")]: "Lina" }[n] || n);

ok("tilt check from the live feed only", () => {
  const t = I.tiltCheck({ details: { hero: H("lina"), deaths: 12, gpm: 350, team: "radiant" }, report: { heroes: [{ hero: H("lina"), games: 20, gpm: 520 }] }, label });
  assert.strictEqual(t.detail, "live");
  assert.ok(t.points[0].text.startsWith("You died 12 times"));
  assert.ok(t.points.some((p) => p.text === "350 GPM, well under your usual 520 on Lina."));
  assert.strictEqual(t.headline, t.points[0].text);
});

ok("tilt check with the parsed replay: lost lane and thrown lead", () => {
  const od = {
    status: "ready",
    players: [
      { isMe: true, team: "radiant", hero: H("lina"), deaths: 4, gpm: 500, netWorth: 15000, lastHits: 200 },
      { team: "radiant", deaths: 2, netWorth: 9000 },
      { team: "dire", deaths: 9 },
    ],
    lane: I.yourLane(parsed, 2),
    swing: I.goldSwing(parsed.goldAdv, "radiant"),
  };
  const t = I.tiltCheck({ details: {}, opendota: od, label });
  assert.strictEqual(t.detail, "replay");
  const texts = t.points.map((p) => p.text);
  assert.ok(texts.includes("Lost your lane: 1.5k gold behind Invoker at 10 minutes (-20 last hits)."), texts.join(" | "));
  assert.ok(texts.some((x) => x.startsWith("Your team was 9k gold ahead at 8:00 and still lost")));
  assert.ok(!texts.some((x) => x.includes("Lowest net worth")), "not the poorest on the team");
});

ok("tilt check with nothing wrong says so", () => {
  const t = I.tiltCheck({ details: { hero: H("lina"), deaths: 3, gpm: 600 }, label });
  assert.strictEqual(t.points.length, 0);
  assert.ok(t.headline.startsWith("No obvious mistake"));
});

// ---- 5. weekly summary
ok("week starts on Monday", () => {
  assert.strictEqual(I.weekStartOf("2026-10-02"), "2026-09-28"); // Friday
  assert.strictEqual(I.weekStartOf("2026-09-28"), "2026-09-28"); // Monday
  assert.strictEqual(I.weekStartOf("2026-10-04"), "2026-09-28"); // Sunday
  assert.strictEqual(I.addDays("2026-09-28", -7), "2026-09-21");
});

ok("weekly summary: record, best hero, worst matchup, limit days, reopen attempts", () => {
  const enemy = (heroes) => ({ status: "ready", players: [{ isMe: true, team: "radiant", hero: "x" }].concat(heroes.map((h) => ({ team: "dire", hero: H(h) }))) });
  const days = [
    { day: "2026-09-28", lockedAt: "x", blockedLaunches: 3, matches: {
      a: { result: "win", details: { hero: H("lina"), kills: 10, deaths: 2, assists: 10 } },
      b: { result: "win", details: { hero: H("lina"), kills: 8, deaths: 4, assists: 6 } } } },
    { day: "2026-09-30", lockedAt: "x", matches: {
      c: { result: "loss", details: { hero: H("axe"), kills: 2, deaths: 10, assists: 4 }, opendota: enemy(["pudge", "lion"]) },
      d: { result: "loss", details: { hero: H("axe"), kills: 4, deaths: 8, assists: 8 }, opendota: enemy(["pudge"]) },
      e: { result: "win", details: { hero: H("lina"), kills: 6, deaths: 6, assists: 2 }, opendota: enemy(["pudge"]) } } },
    { day: "2026-10-05", lockedAt: "x", matches: { f: { result: "loss", details: { hero: H("axe") } } } }, // next week
    { day: "2026-09-27", matches: { g: { result: "loss", details: { hero: H("axe") } } } }, // last week
  ];
  const w = I.weekly(days, "2026-09-28");
  assert.strictEqual(w.end, "2026-10-04");
  assert.deepStrictEqual([w.games, w.wins, w.losses, w.daysPlayed, w.limitDays, w.blockedLaunches], [5, 3, 2, 2, 2, 3]);
  assert.strictEqual(w.best.hero, H("lina"));
  assert.deepStrictEqual(w.worst, { hero: H("pudge"), games: 3, losses: 2 });
  assert.deepStrictEqual(w.kda, { kills: 6, deaths: 6, assists: 6 });
  assert.strictEqual(I.weekly(days, "2026-09-14").games, 0);
});

console.log("\nall checks passed");
