const MESSAGES_URL = "https://www.facebook.com/messages/";

const BLOCKED_HOSTS = ["youtube.com", "youtu.be", "reddit.com", "redd.it"];

// Paths on facebook.com that stay reachable. Login paths are kept so you can sign back in.
const FB_ALLOWED_PREFIXES = ["/messages", "/login", "/checkpoint", "/two_step_verification"];

function hostMatches(host, domain) {
  return host === domain || host.endsWith("." + domain);
}

// Returns a redirect target, or null if the URL is fine.
function verdict(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();

  if (BLOCKED_HOSTS.some((d) => hostMatches(host, d))) return "about:blank";

  if (hostMatches(host, "facebook.com")) {
    const ok = FB_ALLOWED_PREFIXES.some((p) => url.pathname === p || url.pathname.startsWith(p + "/"));
    return ok ? null : MESSAGES_URL;
  }
  return null;
}
