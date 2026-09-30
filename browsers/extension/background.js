importScripts("rules.js");

function enforce(details) {
  if (details.frameId !== 0) return;
  const target = verdict(details.url);
  if (target) chrome.tabs.update(details.tabId, { url: target });
}

// Full page loads.
chrome.webNavigation.onBeforeNavigate.addListener(enforce);
// SPA route changes (history.pushState / replaceState), e.g. clicking Home inside Messenger.
chrome.webNavigation.onHistoryStateUpdated.addListener(enforce);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(enforce);
