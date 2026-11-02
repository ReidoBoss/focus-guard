importScripts("rules.js");

// The service's site, on port 80 or its fallback port.
const PLAN_BASES = ["http://focus/", "http://focus:8787/"];

// Until today's first tasks are ticked (planLock on), every site goes to the plan page,
// except planAllow (Spotify). If the service can't be reached, nothing is locked.
async function planVerdict(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || ["focus", "localhost", "127.0.0.1"].includes(url.hostname)) return null;
  for (const base of PLAN_BASES) {
    try {
      const p = await (await fetch(base + "api/plan", { cache: "no-store" })).json();
      const host = url.hostname.toLowerCase();
      return p.locked && !p.allow.some((d) => hostMatches(host, d)) ? base + "plan" : null;
    } catch {}
  }
  return null;
}

async function enforce(details) {
  if (details.frameId !== 0) return;
  const target = verdict(details.url) || (await planVerdict(details.url));
  if (target) chrome.tabs.update(details.tabId, { url: target });
}

// Full page loads.
chrome.webNavigation.onBeforeNavigate.addListener(enforce);
// SPA route changes (history.pushState / replaceState), e.g. clicking Home inside Messenger.
chrome.webNavigation.onHistoryStateUpdated.addListener(enforce);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(enforce);
