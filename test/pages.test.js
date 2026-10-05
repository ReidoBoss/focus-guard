// Offline test for the tabs on http://focus: the tab bar, Blocked sites and Settings,
// rendered in a fake DOM against canned /api/settings answers.
// Run: node test/pages.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const DIR = path.join(__dirname, "..", "dota-limit");
const read = (f) => fs.readFileSync(path.join(DIR, f), "utf8");

// Every tab the daemon serves exists and loads the tab bar in <head>, before any inline
// script (the other page tests take the first inline <script> as the page's code).
const pages = JSON.parse(read("daemon.js").match(/const PAGES = (\{[^}]*\})/)[1]);
assert.deepStrictEqual(Object.keys(pages), ["/", "/videos", "/dota", "/blocked", "/settings"]);
for (const file of Object.values(pages)) {
  const html = read(file);
  const head = html.split("</head>")[0];
  assert.ok(head.includes('<script src="/topbar.js" defer></script>'), `${file} loads the tab bar`);
  assert.ok(!/<script>/.test(head), `${file} has no inline script in <head>`);
}
const tabs = read("topbar.js").match(/\["(\/[a-z]*)"/g).map((t) => t.slice(2, -1));
assert.deepStrictEqual(tabs, Object.keys(pages), "the tab bar links every page");
console.log("ok: pages and routes");

// ---- tab bar
function fakeDom() {
  const els = {};
  const made = [];
  const node = () => ({ innerHTML: "", textContent: "", className: "" });
  return {
    els,
    made,
    document: {
      getElementById: (id) => (els[id] = els[id] || node()),
      createElement: (tag) => {
        const n = Object.assign(node(), { tag });
        made.push(n);
        return n;
      },
      head: { appendChild: () => {} },
      body: { firstChild: null, insertBefore: (n) => made.push(n) },
    },
  };
}
for (const [where, on] of [["/blocked", "Blocked sites"], ["/", "News"], ["/settings/", "Settings"]]) {
  const dom = fakeDom();
  vm.runInNewContext(read("topbar.js"), { document: dom.document, location: { pathname: where } });
  const bar = dom.made.filter((n) => n.className === "topbar")[0];
  assert.ok(bar, "tab bar added");
  const current = bar.innerHTML.match(/class="on" aria-current="page">([^<]+)</);
  assert.strictEqual(current && current[1], on, `${where} highlights ${on}`);
  assert.strictEqual((bar.innerHTML.match(/class="on"/g) || []).length, 1);
}
console.log("ok: tab bar");

// ---- Blocked sites and Settings
const base = {
  os: "mac",
  installDir: "/usr/local/focus-guard",
  dotaEnabled: true,
  hasAccount: false,
  config: { mode: "games", maxGames: 4, weekendMode: "same", weekendMaxGames: 7, resetHour: 0, postGameGraceSeconds: 90, opendota: true, tiltCheck: false, parseReplays: true, weeklySummary: true },
  browsers: ["brave", "firefox"],
  sites: { block: ["reddit.com", "<b>x</b>.com"], allow: ["facebook.com/messages"] },
  blockSafari: true,
  adult: { on: true, problem: "Wi-Fi refused <the change>" },
};

async function render(file, settings) {
  const script = read(file).match(/<script>([\s\S]*)<\/script>/)[1];
  const dom = fakeDom();
  vm.runInNewContext(script, {
    console, JSON, Object, Array, String, Promise,
    fetch: async (url) => {
      assert.strictEqual(url, "/api/settings");
      return { json: async () => JSON.parse(JSON.stringify(settings)) };
    },
    document: dom.document,
  });
  await new Promise((r) => setTimeout(r, 20));
  return dom.els.body.innerHTML;
}

(async () => {
  let page = await render("blocked.html", base);
  assert.ok(page.includes("reddit.com") && page.includes("&lt;b&gt;x&lt;/b&gt;.com") && !page.includes("<b>x"), "sites listed and escaped");
  assert.ok(page.includes("facebook.com/messages"), "allowed parts listed");
  assert.ok(page.includes("Brave, Firefox"), "browser names");
  assert.ok(page.includes("Safari") && page.includes("Closed"), "Safari on macOS");
  assert.ok(page.includes("Wi-Fi refused &lt;the change&gt;"), "DNS problem shown");
  assert.ok(page.includes("sudo bash install.sh"));
  page = await render("blocked.html", Object.assign({}, base, { os: "windows", browsers: [], adult: { on: false, problem: null } }));
  assert.ok(!page.includes("Safari"), "no Safari row off macOS");
  assert.ok(page.includes(".\\install.ps1") && page.includes("Administrator"), "Windows installer command");
  assert.ok(page.includes("No browsers were picked") && !page.includes("Last DNS check"));
  console.log("ok: blocked sites page");

  page = await render("settings.html", base);
  assert.ok(page.includes("4 games") && page.includes("Same as weekdays") && page.includes("12 AM"), "limit, weekend and reset hour");
  assert.ok(/Tilt check[\s\S]*?Off/.test(page) && page.includes("Not yet"), "features and account");
  assert.ok(page.includes("install.sh | sudo bash") && page.includes("/usr/local/focus-guard/dota-limit/config.json"));
  page = await render("settings.html", Object.assign({}, base, { os: "windows", installDir: "C:\\Program Files\\FocusGuard", config: Object.assign({}, base.config, { mode: "bo3", resetHour: 16 }) }));
  assert.ok(page.includes("Best of 3") && page.includes("4 PM"));
  assert.ok(page.includes("install.ps1 | iex") && page.includes("C:\\Program Files\\FocusGuard\\dota-limit\\config.json"), "Windows command and path");
  page = await render("settings.html", Object.assign({}, base, { dotaEnabled: false }));
  assert.ok(page.includes("The Dota limit is off.") && !page.includes("Tilt check"));
  console.log("ok: settings page");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
