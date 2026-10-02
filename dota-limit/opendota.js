// Fills in the other nine players after a match, using OpenDota (https://www.opendota.com),
// a free public Dota 2 stats API. Matches show up there a few minutes after they end.
// Players who hide their match data appear with their hero and stats but no profile.
const https = require("https");
const fs = require("fs");
const path = require("path");

const BASE = "https://api.opendota.com/api";
const STEAM64_BASE = BigInt("76561197960265728");
// Minutes after the match ends to look it up. OpenDota usually has it within 10.
const RETRY_MINUTES = [2, 5, 10, 15, 30, 60, 120, 240];
const PROFILE_TTL = 6 * 3600 * 1000;
const CONSTANTS_TTL = 7 * 24 * 3600 * 1000;

function accountIdFromSteamId(steamid) {
  try {
    const id = BigInt(String(steamid)) - STEAM64_BASE;
    return id > BigInt(0) ? Number(id) : null;
  } catch (e) {
    return null;
  }
}

function httpJson(url, method) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: method || "GET", headers: { "user-agent": "focus-guard (github.com/ReidoBoss/focus-guard)" }, timeout: 20000 }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode === 404) return resolve(null);
        if (res.statusCode !== 200) return reject(new Error(`OpenDota answered ${res.statusCode}`));
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error("OpenDota sent something that isn't JSON"));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("OpenDota timed out")));
    req.on("error", reject);
    req.end();
  });
}

// fetchJson(url, method) can be swapped out in tests.
function createOpenDota({ dir, apiKey, fetchJson = httpJson, spacingMs = 1100 }) {
  let chain = Promise.resolve();

  // One request at a time, about one a second: the free tier allows 60 a minute.
  function get(p, method) {
    const url = BASE + p + (apiKey ? (p.indexOf("?") >= 0 ? "&" : "?") + "api_key=" + encodeURIComponent(apiKey) : "");
    const result = chain.then(() => fetchJson(url, method));
    chain = result.catch(() => {}).then(() => new Promise((r) => setTimeout(r, spacingMs)));
    return result;
  }

  const constantsFile = path.join(dir, "opendota-constants.json");
  let constantsCache = null;

  async function constants() {
    if (!constantsCache) {
      try {
        constantsCache = JSON.parse(fs.readFileSync(constantsFile, "utf8"));
      } catch (e) {}
    }
    if (constantsCache && constantsCache.labels && Date.now() - constantsCache.fetchedAt < CONSTANTS_TTL) return constantsCache;
    try {
      const heroes = await get("/constants/heroes");
      const items = await get("/constants/item_ids");
      if (heroes && items) {
        const heroNames = {};
        const labels = {};
        for (const h of Object.values(heroes)) {
          heroNames[h.id] = h.name;
          labels[h.name] = h.localized_name;
        }
        constantsCache = { fetchedAt: Date.now(), heroes: heroNames, labels, items };
        fs.writeFileSync(constantsFile, JSON.stringify(constantsCache));
      }
    } catch (e) {
      // A stale copy is still better than nothing.
      if (!constantsCache) throw e;
    }
    return constantsCache;
  }

  // Display names ("Zeus", not "zuus") for the stats page, from the cached constants.
  function heroLabels() {
    if (!constantsCache) {
      try {
        constantsCache = JSON.parse(fs.readFileSync(constantsFile, "utf8"));
      } catch (e) {}
    }
    return (constantsCache && constantsCache.labels) || {};
  }

  const profiles = new Map();
  const refreshed = new Set();

  async function profile(accountId, consts) {
    const hit = profiles.get(accountId);
    if (hit && Date.now() - hit.at < PROFILE_TTL) return hit.data;
    const p = await get(`/players/${accountId}`);
    const wl = await get(`/players/${accountId}/wl`);
    const heroes = await get(`/players/${accountId}/heroes`);
    const recent = await get(`/players/${accountId}/recentMatches`);
    const heroName = (id) => consts.heroes[id] || null;
    // OpenDota doesn't keep everyone's full history. Without it, game counts read as 0
    // even for Immortal players, so the page must not treat them as new accounts.
    const games = wl ? wl.win + wl.lose : 0;
    const fhUnavailable = !!(p && p.profile && p.profile.fh_unavailable) || games === 0;
    if (fhUnavailable && !refreshed.has(accountId)) {
      // Asks OpenDota to fetch their history, so it's there next time you meet them.
      refreshed.add(accountId);
      get(`/players/${accountId}/refresh`, "POST").catch(() => {});
    }
    const data = {
      fhUnavailable,
      name: p && p.profile ? p.profile.personaname : null,
      avatar: p && p.profile ? p.profile.avatarmedium : null,
      rankTier: p ? p.rank_tier : null,
      leaderboardRank: p ? p.leaderboard_rank : null,
      estimatedMmr: p && p.computed_mmr ? Math.round(p.computed_mmr) : null,
      games: fhUnavailable ? null : games,
      wins: fhUnavailable ? null : wl.win,
      heroes: (heroes || []).filter((h) => h.games > 0).map((h) => ({ hero: heroName(h.hero_id), games: h.games, win: h.win })),
      recent: (recent || []).slice(0, 10).map((r) => ({
        matchId: r.match_id,
        hero: heroName(r.hero_id),
        win: r.player_slot < 128 === r.radiant_win,
        kills: r.kills,
        deaths: r.deaths,
        assists: r.assists,
        laneRole: r.lane_role,
        roaming: r.is_roaming,
      })),
    };
    profiles.set(accountId, { at: Date.now(), data });
    return data;
  }

  async function me(accountId, consts) {
    const heroes = await get(`/players/${accountId}/heroes`);
    const peers = await get(`/players/${accountId}/peers`);
    const byHero = {};
    for (const h of heroes || []) {
      byHero[consts.heroes[h.hero_id]] = { withGames: h.with_games, withWin: h.with_win, againstGames: h.against_games, againstWin: h.against_win };
    }
    const byPeer = {};
    for (const p of peers || []) {
      byPeer[p.account_id] = { withGames: p.with_games, withWin: p.with_win, againstGames: p.against_games, againstWin: p.against_win };
    }
    return { byHero, byPeer };
  }

  // Your record with and against each hero, for the counter-pick lookup.
  const mineCache = new Map();
  async function myHeroes(accountId) {
    const hit = mineCache.get(accountId);
    if (hit && Date.now() - hit.at < 3600 * 1000) return hit.data;
    const data = (await me(accountId, await constants())).byHero;
    mineCache.set(accountId, { at: Date.now(), data });
    return data;
  }

  // Your last 90 days, for the hero report. One request.
  async function recentMatches(accountId) {
    const consts = await constants();
    const fields = ["hero_id", "kills", "deaths", "assists", "start_time", "player_slot", "radiant_win", "gold_per_min", "last_hits", "duration"];
    const rows = await get(`/players/${accountId}/matches?date=90&${fields.map((f) => "project=" + f).join("&")}`);
    return (rows || []).map((r) => Object.assign({}, r, { hero: consts.heroes[r.hero_id] || null }));
  }

  // How a hero does against every other hero, from OpenDota's high-level parsed games.
  // Changes slowly, so it's cached on disk for a week.
  const matchupFile = path.join(dir, "opendota-matchups.json");
  let matchupCache = null;
  async function matchups(hero) {
    const consts = await constants();
    if (!matchupCache) {
      try {
        matchupCache = JSON.parse(fs.readFileSync(matchupFile, "utf8"));
      } catch (e) {
        matchupCache = {};
      }
    }
    const hit = matchupCache[hero];
    if (hit && Date.now() - hit.at < CONSTANTS_TTL) return hit.rows;
    const id = Object.keys(consts.heroes).find((key) => consts.heroes[key] === hero);
    if (!id) return [];
    const rows = await get(`/heroes/${id}/matchups`);
    const named = (rows || []).map((r) => ({ hero: consts.heroes[r.hero_id] || null, games_played: r.games_played, wins: r.wins }));
    matchupCache[hero] = { at: Date.now(), rows: named };
    fs.writeFileSync(matchupFile, JSON.stringify(matchupCache));
    return named;
  }

  // Asks OpenDota to parse the replay, which adds lanes and per-minute gold. Takes a minute or so.
  async function requestParse(matchId) {
    const r = await get(`/request/${matchId}`, "POST");
    return r && r.job ? r.job.jobId : null;
  }

  // The parsed parts of a match, or null if the replay isn't parsed yet.
  async function fetchParsed(matchId) {
    const consts = await constants();
    const m = await get(`/matches/${matchId}`);
    if (!m || !m.od_data || !m.od_data.has_parsed || !Array.isArray(m.players)) return null;
    const at10 = (arr) => (Array.isArray(arr) && arr.length > 10 ? arr[10] : null);
    return {
      goldAdv: m.radiant_gold_adv || [],
      xpAdv: m.radiant_xp_adv || [],
      players: m.players.map((p) => ({
        slot: p.player_slot,
        team: p.player_slot < 128 ? "radiant" : "dire",
        hero: consts.heroes[p.hero_id] || null,
        lane: p.lane,
        laneRole: p.lane_role,
        laneEfficiency: p.lane_efficiency_pct,
        gold10: at10(p.gold_t),
        xp10: at10(p.xp_t),
        lh10: at10(p.lh_t),
        dn10: at10(p.dn_t),
      })),
    };
  }

  // Returns the full scoreboard with profiles, or null if OpenDota doesn't have the match yet.
  // `local` is what Dota reported to us during the match, used to find you if your profile is private.
  async function fetchMatch(matchId, local) {
    const consts = await constants();
    const m = await get(`/matches/${matchId}`);
    if (!m || !Array.isArray(m.players) || m.players.length < 10) return null;

    const myAccountId = (local && (Number(local.accountid) || accountIdFromSteamId(local.steamid))) || null;
    const heroName = (id) => consts.heroes[id] || null;
    const itemName = (id) => (id && consts.items[id] ? `item_${consts.items[id]}` : null);

    let mine = null;
    if (myAccountId) {
      try {
        mine = await me(myAccountId, consts);
      } catch (e) {}
    }

    const players = [];
    for (const p of m.players) {
      const team = p.player_slot < 128 ? "radiant" : "dire";
      const hero = heroName(p.hero_id);
      const isMe = myAccountId ? p.account_id === myAccountId : !!(local && local.hero === hero && local.team === team);
      const player = {
        slot: p.player_slot,
        team,
        isMe,
        accountId: p.account_id || null,
        name: p.personaname || null,
        rankTier: p.rank_tier || null,
        hero,
        level: p.level,
        kills: p.kills,
        deaths: p.deaths,
        assists: p.assists,
        lastHits: p.last_hits,
        denies: p.denies,
        gpm: p.gold_per_min,
        xpm: p.xp_per_min,
        netWorth: p.net_worth,
        heroDamage: p.hero_damage,
        towerDamage: p.tower_damage,
        heroHealing: p.hero_healing,
        items: [0, 1, 2, 3, 4, 5].map((i) => itemName(p[`item_${i}`])),
        neutral: itemName(p.item_neutral),
        partyId: p.party_id == null ? null : p.party_id,
        partySize: p.party_size || null,
        profile: null,
        onHero: null,
        together: null,
        youWithHero: null,
      };
      if (player.accountId && !isMe) {
        try {
          player.profile = await profile(player.accountId, consts);
          if (!player.name) player.name = player.profile.name;
          if (!player.rankTier) player.rankTier = player.profile.rankTier;
          const h = player.profile.heroes.find((x) => x.hero === hero);
          if (!player.profile.fhUnavailable) player.onHero = h ? { games: h.games, win: h.win } : { games: 0, win: 0 };
        } catch (e) {}
      }
      if (mine && !isMe) {
        if (player.accountId && mine.byPeer[player.accountId]) player.together = mine.byPeer[player.accountId];
        if (mine.byHero[hero]) player.youWithHero = mine.byHero[hero];
      }
      players.push(player);
    }

    return {
      fetchedAt: new Date().toISOString(),
      myAccountId,
      duration: m.duration,
      startTime: m.start_time,
      radiantWin: m.radiant_win,
      radiantScore: m.radiant_score,
      direScore: m.dire_score,
      gameMode: m.game_mode,
      lobbyType: m.lobby_type,
      region: m.region,
      players,
    };
  }

  return { fetchMatch, heroLabels, recentMatches, matchups, myHeroes, requestParse, fetchParsed };
}

module.exports = { createOpenDota, accountIdFromSteamId, RETRY_MINUTES };
