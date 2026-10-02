// Offline test for the teammates/enemies feature: runs dota-limit/opendota.js against
// canned OpenDota answers, then renders stats.html in a fake DOM and opens the panel.
// Run: node test/opendota.test.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const { createOpenDota, accountIdFromSteamId } = require("../dota-limit/opendota");

const ME = 1000;
const MATCH = "8123456789";

// Hero ids: 1 antimage, 2 axe, 3 bane, 4 bloodseeker, 5 crystal_maiden, 6 drow_ranger,
// 7 earthshaker, 8 juggernaut, 9 zuus (shown as "Zeus"), 10 morphling.
const HEROES = ["antimage", "axe", "bane", "bloodseeker", "crystal_maiden", "drow_ranger", "earthshaker", "juggernaut", "zuus", "morphling"];
const LABELS = { zuus: "Zeus", crystal_maiden: "Crystal Maiden", drow_ranger: "Drow Ranger", antimage: "Anti-Mage" };
const heroConst = {};
HEROES.forEach((h, i) => (heroConst[i + 1] = { id: i + 1, name: `npc_dota_hero_${h}`, localized_name: LABELS[h] || h[0].toUpperCase() + h.slice(1) }));

const players = HEROES.map((h, i) => ({
  player_slot: i < 5 ? i : 128 + i - 5,
  account_id: i === 2 ? null : ME + i, // slot 2 hides their profile
  personaname: i === 2 ? null : `player${i}`,
  rank_tier: i === 8 ? 80 : 50 + i,
  hero_id: i + 1,
  level: 20 + i,
  kills: i,
  deaths: 10 - i,
  assists: 5,
  last_hits: 100,
  denies: 5,
  gold_per_min: 400 + i,
  xp_per_min: 500,
  net_worth: 10000 + 1000 * i,
  hero_damage: 20000 + 500 * i,
  tower_damage: 1000,
  hero_healing: 0,
  item_0: 1,
  item_1: 0,
  item_neutral: 2,
  party_id: i === 5 || i === 6 ? 77 : i,
  party_size: i === 5 || i === 6 ? 2 : 1,
}));

const routes = {
  "/constants/heroes": heroConst,
  "/constants/item_ids": { 1: "blink", 2: "mysterious_hat" },
  [`/matches/${MATCH}`]: { match_id: Number(MATCH), duration: 2400, radiant_win: true, radiant_score: 40, dire_score: 22, game_mode: 22, lobby_type: 7, players },
  [`/players/${ME}/heroes`]: [{ hero_id: 7, with_games: 0, with_win: 0, against_games: 20, against_win: 6 }, { hero_id: 2, with_games: 12, with_win: 9, against_games: 3, against_win: 1 }],
  [`/players/${ME}/peers`]: [{ account_id: ME + 6, with_games: 0, with_win: 0, against_games: 4, against_win: 3 }],
};
// Enemy in slot 7 (earthshaker) spams it and lost their last 4; slot 8 is a likely smurf;
// slot 9 is a high-rank player whose full history OpenDota doesn't have.
for (let i = 1; i < 10; i++) {
  if (i === 2) continue;
  const id = ME + i;
  const spam = i === 6;
  routes[`/players/${id}`] = { profile: { personaname: `player${i}` }, rank_tier: 50 + i, computed_mmr: 3000 + i };
  routes[`/players/${id}/wl`] = i === 7 ? { win: 90, lose: 30 } : i === 8 ? { win: 0, lose: 0 } : { win: 600, lose: 500 };
  if (i === 8) {
    routes[`/players/${id}`] = { profile: { personaname: "player8", fh_unavailable: true }, rank_tier: 80, leaderboard_rank: 512 };
    routes[`/players/${id}/heroes`] = [];
    routes[`/players/${id}/recentMatches`] = [];
    continue;
  }
  routes[`/players/${id}/heroes`] = spam
    ? [{ hero_id: 7, games: 400, win: 230 }, { hero_id: 1, games: 50, win: 20 }]
    : [{ hero_id: 3, games: 30, win: 15 }, { hero_id: i + 1, games: 1, win: 1 }];
  routes[`/players/${id}/recentMatches`] = [0, 1, 2, 3, 4].map((k) => ({
    match_id: k, hero_id: i + 1, player_slot: 0, radiant_win: !spam || k > 3, lane_role: 2, kills: 1, deaths: 1, assists: 1,
  }));
}

const calls = [];
async function fakeFetch(url, method) {
  const p = url.replace("https://api.opendota.com/api", "");
  calls.push((method === "POST" ? "POST " : "") + p);
  return Object.prototype.hasOwnProperty.call(routes, p) ? routes[p] : null;
}

(async () => {
  assert.strictEqual(accountIdFromSteamId("76561197960266728"), ME);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg-od-"));
  const od = createOpenDota({ dir, fetchJson: fakeFetch, spacingMs: 0 });

  assert.strictEqual(await od.fetchMatch("999", {}), null, "unknown match should be null (not on OpenDota yet)");

  const result = await od.fetchMatch(MATCH, { steamid: "76561197960266728", hero: "npc_dota_hero_antimage", team: "radiant" });
  assert.strictEqual(result.players.length, 10);
  const me = result.players.find((p) => p.isMe);
  assert.ok(me && me.hero === "npc_dota_hero_antimage", "finds you by Steam ID");
  assert.strictEqual(me.profile, null, "doesn't spend API calls on your own profile");
  const hidden = result.players[2];
  assert.ok(!hidden.accountId && !hidden.profile, "private profile has no lookups");
  const shaker = result.players[6];
  assert.strictEqual(shaker.profile.heroes[0].hero, "npc_dota_hero_earthshaker");
  assert.deepStrictEqual(shaker.onHero, { games: 400, win: 230 });
  assert.deepStrictEqual(shaker.together, { withGames: 0, withWin: 0, againstGames: 4, againstWin: 3 });
  assert.strictEqual(shaker.youWithHero.againstGames, 20);
  assert.strictEqual(result.players[0].items[0], "item_blink");
  assert.ok(!calls.includes(`/players/${ME}`), "never looks up your own profile");
  assert.ok(fs.existsSync(path.join(dir, "opendota-constants.json")), "caches hero and item names");
  const partial = result.players[8];
  assert.ok(partial.profile.fhUnavailable && partial.profile.games === null && partial.onHero === null, "partial history isn't read as 0 games");
  assert.ok(calls.includes(`POST /players/${ME + 8}/refresh`), "asks OpenDota to fetch a missing history");
  assert.strictEqual(od.heroLabels().npc_dota_hero_zuus, "Zeus");
  console.log(`ok: OpenDota module (${calls.length} API calls)`);

  // ---- stats page
  const html = fs.readFileSync(path.join(__dirname, "..", "dota-limit", "stats.html"), "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const els = {};
  const handlers = [];
  const el = (id) => (els[id] = els[id] || { id, innerHTML: "", textContent: "", className: "", addEventListener() {} });
  const now = new Date().toISOString();
  const api = {
    today: {
      day: "2026-10-02", matches: { [MATCH]: { startedAt: now, endedAt: now, result: "win", details: { hero: "npc_dota_hero_antimage", team: "radiant", kills: 1 }, opendota: Object.assign({ status: "ready" }, result) },
        "8123456790": { startedAt: now, result: "loss", details: {}, opendota: { status: "pending", tries: 2 } } },
      wins: 1, losses: 1, live: false, limitReached: false, mode: "bo3", resetHour: 4, dotaEnabled: true, heroLabels: od.heroLabels(),
    },
    history: [],
  };
  const context = {
    console, Date, Math, JSON, Object, Array, String, Number, Set, Map, Promise, encodeURIComponent,
    setInterval: () => 0,
    setTimeout,
    fetch: async () => ({ json: async () => JSON.parse(JSON.stringify(api)) }),
    document: { getElementById: el, addEventListener: (type, fn) => handlers.push(fn) },
  };
  vm.runInNewContext(script, context);
  await new Promise((r) => setTimeout(r, 50));

  let page = els.matches.innerHTML;
  assert.ok(page.includes("Show teammates and enemies"), "panel button shown");
  assert.ok(page.includes("Looking up the other players on OpenDota") && page.includes("tried 2x"), "pending match explains itself");

  const click = (sel, data) => ({ target: { closest: (q) => (q === sel ? { dataset: data } : null) } });
  for (const h of handlers) await h(click("[data-players]", { players: MATCH }));
  page = els.matches.innerHTML;
  const expect = [
    "Your team · Radiant",
    "Enemies · Dire",
    "Spams Earthshaker: 36% of games",
    "On their most-played hero (400 games, 58%)",
    "Lost their last 4",
    "You&#39;re 6-14 against Earthshaker",
    "4 games against you, you won 75%",
    "Possible smurf: 120 games, 75% wins",
    "Party A (2)",
    "Private profile",
    "First game on this hero",
    "You win 75% with Axe on your team",
    "Usually mid",
    "~3,006 MMR",
    "Most hero damage",
    "Hide players",
    "Zeus",
    "Immortal #512",
    "Match history not on OpenDota yet",
  ];
  for (const text of expect) assert.ok(page.includes(text.replace("&#39;", "'")), `stats page shows "${text}"`);
  assert.ok(!page.includes("Comfort pick: #2 hero, 1 games"), "a hero played once isn't a comfort pick");
  assert.ok(!page.includes("Zuus"), "uses real hero names");
  const row8 = page.split('class="player ').find((r) => r.includes("player8"));
  assert.ok(!/New account|smurf|First game/.test(row8), "no game-count labels without full history");
  console.log(`ok: stats page renders the panel (${expect.length} details checked)`);
  console.log("\nall checks passed");
})().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
