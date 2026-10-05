// Runs in the browser, not in Node: the tab bar at the top of every page on http://home.
// Each page loads it with <script src="/topbar.js" defer></script> in its <head>.
(function () {
  const TABS = [
    ["/", "News"],
    ["/dota", "Dota"],
    ["/blocked", "Blocked sites"],
    ["/settings", "Settings"],
  ];
  const style = document.createElement("style");
  style.textContent = `
    .topbar { position: sticky; top: 0; z-index: 10; background: rgba(13, 15, 19, 0.92); backdrop-filter: blur(8px); border-bottom: 1px solid #262c37; }
    .topbar-in { max-width: 1080px; margin: 0 auto; padding: 0 16px; display: flex; align-items: center; gap: 20px; height: 52px; }
    .topbar-brand { font: 700 15px/1 Inter, system-ui, sans-serif; color: #e8eaee; text-decoration: none; white-space: nowrap; }
    .topbar-brand span { color: #f5b642; }
    .topbar-tabs { display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none; }
    .topbar-tabs::-webkit-scrollbar { display: none; }
    .topbar-tabs a { font: 500 14px/1 Inter, system-ui, sans-serif; color: #8a93a3; text-decoration: none; padding: 9px 12px; border-radius: 8px; white-space: nowrap; }
    .topbar-tabs a:hover { color: #e8eaee; background: #151920; }
    .topbar-tabs a.on { color: #e8eaee; background: #1b2029; }
    @media (max-width: 600px) { .topbar-brand { display: none; } .topbar-in { gap: 0; } }
  `;
  document.head.appendChild(style);
  const here = location.pathname.replace(/\/+$/, "") || "/";
  const bar = document.createElement("nav");
  bar.className = "topbar";
  bar.innerHTML = `<div class="topbar-in"><a class="topbar-brand" href="/">Focus <span>Guard</span></a><div class="topbar-tabs">${TABS.map(
    ([href, label]) => `<a href="${href}"${href === here ? ' class="on" aria-current="page"' : ""}>${label}</a>`
  ).join("")}</div></div>`;
  document.body.insertBefore(bar, document.body.firstChild);
})();
