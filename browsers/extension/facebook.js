(() => {
  const MESSAGES_URL = "https://www.facebook.com/messages/";
  const ALLOWED = ["/messages", "/login", "/checkpoint", "/two_step_verification"];

  const allowed = (href) => {
    try {
      const p = new URL(href, location.href).pathname;
      return ALLOWED.some((a) => p === a || p.startsWith(a + "/"));
    } catch {
      return true;
    }
  };

  const check = () => {
    if (!allowed(location.href)) location.replace(MESSAGES_URL);
  };

  check();

  // Navigation API fires for pushState/replaceState too, before the new view renders.
  if (window.navigation) {
    navigation.addEventListener("navigate", (e) => {
      if (!allowed(e.destination.url)) {
        if (e.cancelable) e.preventDefault();
        location.replace(MESSAGES_URL);
      }
    });
  }

  // Fallback in case a route change slips past the events above.
  window.addEventListener("popstate", check);
  setInterval(check, 300);
})();
