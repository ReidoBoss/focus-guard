// Turns match data into the hero report, tilt check, lane results, counter-picks and
// weekly summary. Pure functions with no network or file access, so they're easy to test.

const DAY = 24 * 3600 * 1000;
const LANES = { 1: "bottom", 2: "middle", 3: "top" };

const pct = (w, g) => (g ? Math.round((100 * w) / g) : 0);
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round1 = (x) => Math.round(x * 10) / 10;
const k = (n) => (Math.abs(n) >= 1000 ? `${round1(n / 1000)}k` : String(Math.round(n)));

// ---------------------------------------------------------------- 1. hero report

// `matches` are OpenDota /players/{id}/matches rows with hero_id mapped to `hero`.
function heroReport(matches, now) {
  now = now || Date.now();
  const recentCut = now / 1000 - 30 * 24 * 3600;
  const byHero = {};
  for (const m of matches) {
    if (!m.hero) continue;
    const win = m.player_slot < 128 === m.radiant_win;
    const h = (byHero[m.hero] = byHero[m.hero] || { hero: m.hero, games: 0, wins: 0, k: [], d: [], a: [], gpm: [], lastPlayed: 0, recent: { games: 0, wins: 0 }, earlier: { games: 0, wins: 0 } });
    h.games++;
    if (win) h.wins++;
    h.k.push(m.kills || 0);
    h.d.push(m.deaths || 0);
    h.a.push(m.assists || 0);
    if (m.gold_per_min) h.gpm.push(m.gold_per_min);
    h.lastPlayed = Math.max(h.lastPlayed, m.start_time || 0);
    const bucket = m.start_time >= recentCut ? h.recent : h.earlier;
    bucket.games++;
    if (win) bucket.wins++;
  }
  const heroes = Object.values(byHero)
    .map((h) => ({
      hero: h.hero,
      games: h.games,
      wins: h.wins,
      kills: round1(avg(h.k)),
      deaths: round1(avg(h.d)),
      assists: round1(avg(h.a)),
      gpm: Math.round(avg(h.gpm)),
      lastPlayed: h.lastPlayed,
      recent: h.recent,
      earlier: h.earlier,
      // Win rate change, last 30 days against the 60 before. Needs a few games in each.
      trend: h.recent.games >= 3 && h.earlier.games >= 3 ? pct(h.recent.wins, h.recent.games) - pct(h.earlier.wins, h.earlier.games) : null,
    }))
    .sort((a, b) => b.games - a.games || b.wins - a.wins);
  const games = matches.length;
  const wins = matches.filter((m) => m.player_slot < 128 === m.radiant_win).length;
  const ranked = heroes.filter((h) => h.games >= 10);
  const byRate = ranked.slice().sort((a, b) => pct(b.wins, b.games) - pct(a.wins, a.games));
  const trending = heroes.filter((h) => h.trend !== null).sort((a, b) => b.trend - a.trend);
  return {
    days: 90,
    games,
    wins,
    heroes,
    best: byRate[0] ? byRate[0].hero : null,
    worst: byRate.length > 1 ? byRate[byRate.length - 1].hero : null,
    improving: trending[0] && trending[0].trend > 0 ? trending[0].hero : null,
  };
}

// ---------------------------------------------------------------- 3. counter-picks

// `rows` are OpenDota /heroes/{id}/matchups rows (wins = the queried hero's wins) with
// hero_id mapped to `hero`. Returns the heroes that beat it most, with enough games to mean something.
function counters(rows, minGames) {
  minGames = minGames || 30;
  return rows
    .filter((r) => r.hero && r.games_played >= minGames)
    .map((r) => ({ hero: r.hero, games: r.games_played, winRate: pct(r.games_played - r.wins, r.games_played) }))
    .sort((a, b) => b.winRate - a.winRate || b.games - a.games)
    .slice(0, 5);
}

// Your own heroes from the counter list, so the advice is something you can actually play.
function yourCounters(counterList, report) {
  if (!report) return [];
  const mine = {};
  for (const h of report.heroes) if (h.games >= 3) mine[h.hero] = h;
  return counterList.filter((c) => mine[c.hero]).map((c) => ({ hero: c.hero, games: mine[c.hero].games, wins: mine[c.hero].wins }));
}

// ---------------------------------------------------------------- 4. lanes and the gold graph

// `parsed.players` come from a parsed OpenDota match: lane (1 bottom, 2 middle, 3 top,
// 4-5 jungle) and gold/xp/last hits at 10 minutes.
function laneResults(parsed) {
  const lanes = [];
  for (const lane of [3, 2, 1]) {
    const inLane = parsed.players.filter((p) => p.lane === lane);
    const side = (team) => {
      const ps = inLane.filter((p) => p.team === team);
      return { heroes: ps.map((p) => p.hero), gold: ps.reduce((a, p) => a + (p.gold10 || 0), 0), xp: ps.reduce((a, p) => a + (p.xp10 || 0), 0) };
    };
    const radiant = side("radiant");
    const dire = side("dire");
    if (!radiant.heroes.length && !dire.heroes.length) continue;
    const diff = radiant.gold - dire.gold;
    // Within 10% counts as even.
    const winner = Math.abs(diff) < 0.1 * Math.max(radiant.gold, dire.gold, 1) ? "even" : diff > 0 ? "radiant" : "dire";
    lanes.push({ lane: LANES[lane], radiant, dire, goldDiff: diff, winner });
  }
  return lanes;
}

// Your lane: the enemy in your lane with the most gold at 10 minutes is your opponent.
function yourLane(parsed, mySlot) {
  const me = parsed.players.find((p) => p.slot === mySlot);
  if (!me || !LANES[me.lane]) return null;
  const rivals = parsed.players.filter((p) => p.team !== me.team && p.lane === me.lane).sort((a, b) => (b.gold10 || 0) - (a.gold10 || 0));
  const opp = rivals[0];
  return {
    lane: LANES[me.lane],
    opponent: opp ? opp.hero : null,
    goldDiff: opp ? (me.gold10 || 0) - (opp.gold10 || 0) : null,
    lhDiff: opp ? (me.lh10 || 0) - (opp.lh10 || 0) : null,
    myGold: me.gold10,
    myLh: me.lh10,
  };
}

// Biggest lead and deficit for your team, from OpenDota's per-minute Radiant gold advantage.
function goldSwing(goldAdv, myTeam) {
  if (!goldAdv || !goldAdv.length) return null;
  const sign = myTeam === "dire" ? -1 : 1;
  let lead = { gold: 0, minute: 0 };
  let deficit = { gold: 0, minute: 0 };
  goldAdv.forEach((g, minute) => {
    const v = g * sign;
    if (v > lead.gold) lead = { gold: v, minute };
    if (v < deficit.gold) deficit = { gold: v, minute };
  });
  return { lead, deficit };
}

// ---------------------------------------------------------------- 2. tilt check

// Points about a loss, worst first. Uses whatever is known so far: the live feed right
// after the match, then OpenDota's scoreboard, then the parsed replay.
// `label` turns "npc_dota_hero_zuus" into "Zeus" for the notification text.
function tiltCheck({ details, opendota, report, label }) {
  const d = details || {};
  const name = label || ((n) => (n ? n.replace("npc_dota_hero_", "").replace(/_/g, " ") : "your opponent"));
  const points = [];
  const bad = (text, weight) => points.push({ tone: "bad", text, weight });
  const good = (text) => points.push({ tone: "good", text, weight: 0 });
  const od = opendota && opendota.status === "ready" ? opendota : null;
  const me = od ? od.players.find((p) => p.isMe) : null;
  const myTeam = (me && me.team) || d.team;

  const deaths = me ? me.deaths : d.deaths;
  if (deaths != null) {
    const team = od ? od.players.filter((p) => p.team === myTeam && !p.isMe) : [];
    const teamAvg = team.length ? avg(team.map((p) => p.deaths)) : null;
    if (deaths >= 10) bad(`You died ${deaths} times${teamAvg !== null ? ` (your teammates averaged ${round1(teamAvg)})` : ""}.`, 3);
    else if (teamAvg !== null && deaths >= 7 && deaths >= 1.5 * teamAvg) bad(`You died ${deaths} times, the most on your team.`, 2);
  }

  const hero = (me && me.hero) || d.hero;
  const usual = report && report.heroes.find((h) => h.hero === hero);
  const gpm = me ? me.gpm : d.gpm;
  if (usual && usual.games >= 5 && usual.gpm && gpm && gpm < 0.85 * usual.gpm) {
    bad(`${gpm} GPM, well under your usual ${usual.gpm} on ${name(hero)}.`, 2);
  }

  const lane = od && od.lane;
  if (lane && lane.opponent && lane.goldDiff !== null) {
    if (lane.goldDiff <= -1000) bad(`Lost your lane: ${k(-lane.goldDiff)} gold behind ${name(lane.opponent)} at 10 minutes (${lane.lhDiff} last hits).`, 3);
    else if (lane.goldDiff >= 1000) good(`You won your lane by ${k(lane.goldDiff)} gold at 10 minutes, so the game was lost later.`);
  }

  const swing = od && od.swing;
  if (swing && swing.lead.gold >= 5000) {
    bad(`Your team was ${k(swing.lead.gold)} gold ahead at ${swing.lead.minute}:00 and still lost. Watch for overextending when ahead.`, 3);
  }

  if (me && od) {
    const team = od.players.filter((p) => p.team === myTeam);
    const poorest = team.slice().sort((a, b) => a.netWorth - b.netWorth)[0];
    if (poorest === me && me.lastHits >= 100) bad(`Lowest net worth on your team (${k(me.netWorth)}) despite playing a farming role.`, 1);
  }

  points.sort((a, b) => b.weight - a.weight);
  const anyBad = points.some((p) => p.tone === "bad");
  return {
    hero,
    headline: anyBad ? points.find((p) => p.tone === "bad").text : "No obvious mistake in your numbers. Some games are lost in the draft or by teammates.",
    points: points.map((p) => ({ tone: p.tone, text: p.text })),
    advice: "Take a 10 minute break before you queue again. Stand up, drink water, then decide.",
    detail: od ? (lane ? "replay" : "scoreboard") : "live",
  };
}

// ---------------------------------------------------------------- 5. weekly summary

function parseDay(day) {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function formatDay(t) {
  return new Date(t).toISOString().slice(0, 10);
}

// Monday of the week that `day` (YYYY-MM-DD) is in.
function weekStartOf(day) {
  const t = parseDay(day);
  const dow = new Date(t).getUTCDay();
  return formatDay(t - ((dow + 6) % 7) * DAY);
}

function addDays(day, n) {
  return formatDay(parseDay(day) + n * DAY);
}

function weekly(days, start) {
  const end = addDays(start, 6);
  const inWeek = days.filter((d) => d.day >= start && d.day <= end);
  const matches = [];
  for (const d of inWeek) for (const [id, m] of Object.entries(d.matches || {})) if (m.result) matches.push(Object.assign({ id, day: d.day }, m));
  const wins = matches.filter((m) => m.result === "win").length;

  const heroes = {};
  for (const m of matches) {
    const h = m.details && m.details.hero;
    if (!h) continue;
    heroes[h] = heroes[h] || { hero: h, games: 0, wins: 0 };
    heroes[h].games++;
    if (m.result === "win") heroes[h].wins++;
  }
  const heroList = Object.values(heroes);
  const best = heroList.filter((h) => h.games >= 2).sort((a, b) => pct(b.wins, b.games) - pct(a.wins, a.games) || b.games - a.games)[0] ||
    heroList.sort((a, b) => b.wins - a.wins || b.games - a.games)[0] || null;

  // Enemy heroes in the games you lost, from OpenDota's scoreboard.
  const against = {};
  for (const m of matches) {
    const od = m.opendota;
    if (!od || od.status !== "ready") continue;
    const me = od.players.find((p) => p.isMe);
    const myTeam = (me && me.team) || (m.details && m.details.team);
    for (const p of od.players) {
      if (p.team === myTeam || !p.hero) continue;
      const a = (against[p.hero] = against[p.hero] || { hero: p.hero, games: 0, losses: 0 });
      a.games++;
      if (m.result === "loss") a.losses++;
    }
  }
  const worst = Object.values(against).filter((a) => a.losses >= 2).sort((a, b) => b.losses - a.losses || a.games - b.games)[0] || null;

  const kda = matches.map((m) => m.details).filter((x) => x && x.kills != null);
  const daysPlayed = inWeek.filter((d) => Object.keys(d.matches || {}).length).length;
  return {
    start,
    end,
    games: matches.length,
    wins,
    losses: matches.length - wins,
    daysPlayed,
    limitDays: inWeek.filter((d) => d.lockedAt).length,
    blockedLaunches: inWeek.reduce((a, d) => a + (d.blockedLaunches || 0), 0),
    best,
    worst,
    kda: kda.length ? { kills: round1(avg(kda.map((x) => x.kills))), deaths: round1(avg(kda.map((x) => x.deaths))), assists: round1(avg(kda.map((x) => x.assists))) } : null,
    heroes: heroList.sort((a, b) => b.games - a.games),
  };
}

module.exports = { heroReport, counters, yourCounters, laneResults, yourLane, goldSwing, tiltCheck, weekly, weekStartOf, addDays, parseDay };
