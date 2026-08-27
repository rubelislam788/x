// Shared core for the content scripts. Runs on x.com / twitter.com.
// Publishes window.XFM._ (helpers) and hosts the single message router.
// Each engine registers itself as window.XFM.<channel> = { start, resume, stop }.
(() => {
  if (window.XFM?._) return; // already injected in this tab
  window.XFM = window.XFM || {};

  const X = window.XFM._ = {};
  const normalizedHost = location.hostname.toLowerCase().replace(/^(?:www|mobile|m)\./, "");

  X.sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  X.rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  X.isXPage = ["x.com", "twitter.com"].includes(normalizedHost);
  X.isMobile = navigator.userAgentData?.mobile === true ||
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "") ||
    Math.min(screen.width || innerWidth, screen.height || innerHeight) <= 700 ||
    (navigator.maxTouchPoints > 1 && (
      globalThis.matchMedia?.("(pointer: coarse)")?.matches || Math.min(innerWidth, innerHeight) <= 900
    ));

  X.isFollowingPage = () => /\/following(?:\/|$)/.test(location.pathname);
  X.isHomePage = () => /^\/(home)?\/?$/.test(location.pathname);

  X.norm = value => String(value || "").trim().replace(/^@+/, "").toLowerCase().replace(/[^a-z0-9_]/g, "");

  X.userFromHref = href => {
    try {
      const path = new URL(href, location.origin).pathname.split("/").filter(Boolean);
      if (path.length !== 1 || /^(home|explore|notifications|messages|bookmarks|lists|settings|compose|i|search|login|signup|jobs|communities|premium)$/i.test(path[0])) return "";
      return X.norm(path[0]);
    } catch { return ""; }
  };

  X.blockedOrLoggedOut = () => {
    const text = (document.body?.innerText || "").toLowerCase();
    return !!document.querySelector('[data-testid="loginButton"], a[href="/login"], input[name="session[username_or_email]"]') ||
      /captcha|unusual activity|verify your identity|temporarily restricted|something went wrong/.test(text);
  };

  X.visible = element => !!element && element.isConnected && !element.disabled &&
    element.getAttribute?.("aria-disabled") !== "true" && element.getClientRects().length > 0;
  X.scrollTo = element => {
    try { element?.scrollIntoView({ block: X.isMobile ? "center" : "center", inline: "nearest", behavior: "smooth" }); }
    catch { try { element?.scrollIntoView(); } catch {} }
  };
  X.activate = async element => {
    if (!X.visible(element)) return false;
    X.scrollTo(element);
    await X.sleep(X.isMobile ? 320 : 180);
    if (!X.visible(element)) return false;
    try { element.focus?.({ preventScroll: true }); } catch { try { element.focus?.(); } catch {} }
    try { element.click(); return true; } catch { return false; }
  };

  X.request = (message, timeoutMs = 45000) => new Promise(resolve => {
    if (!chrome.runtime?.id) { resolve(null); return; }
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value ?? null);
    };
    const timer = setTimeout(() => finish(null), Math.max(1000, timeoutMs));
    try {
      const pending = chrome.runtime.sendMessage(message, response => {
        const failed = chrome.runtime.lastError;
        finish(failed ? null : response);
      });
      if (pending && typeof pending.then === "function") pending.then(finish).catch(() => finish(null));
    } catch {
      try {
        const pending = chrome.runtime.sendMessage(message);
        if (pending && typeof pending.then === "function") pending.then(finish).catch(() => finish(null));
        else finish(null);
      } catch { finish(null); }
    }
  });
  X.storageCall = (method, ...args) => new Promise(resolve => {
    const area = chrome.storage?.local;
    if (!area || typeof area[method] !== "function") { resolve(null); return; }
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value ?? null);
    };
    try {
      const pending = area[method](...args, value => {
        const failed = chrome.runtime.lastError;
        finish(failed ? null : value ?? true);
      });
      if (pending && typeof pending.then === "function") pending.then(value => finish(value ?? true)).catch(() => finish(null));
    } catch {
      try {
        const pending = area[method](...args);
        if (pending && typeof pending.then === "function") pending.then(value => finish(value ?? true)).catch(() => finish(null));
        else finish(null);
      } catch { finish(null); }
    }
  });
  X.storageGet = async keys => (await X.storageCall("get", keys)) || {};
  X.storageSet = async values => (await X.storageCall("set", values)) !== null;
  X.send = message => X.request(message);
  X.report = (channel, patch) => X.send({ type: "progress", channel, patch });
  X.log = (level, text) => X.send({ type: "log", level, text });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (typeof message?.type !== "string") return;
    if (message.type === "ping") { sendResponse({ ok: true }); return; }
    const match = /^(unfollow|engage):(start|pause|resume|stop)$/.exec(message.type);
    if (!match) return;
    const [, channel, action] = match;
    const engine = window.XFM[channel];
    if (!engine) { sendResponse({ ok: false, error: `${channel} engine is not loaded` }); return; }
    try {
      if (action === "start") engine.start(message.config || {});
      else if (action === "pause") engine.pause();
      else if (action === "resume") engine.resume();
      else engine.stop();
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
  });

  // A reload or SPA navigation drops the engines; pick the run back up where it stopped.
  // Delayed so unfollow.js and engage.js have registered themselves on window.XFM first.
  setTimeout(() => {
    if (!chrome.runtime?.id) return;
    X.request({ type: "get-all" }, 10000).then(response => {
      if (!response || response.ok === false) return;
      if (["Running", "Cooldown", "Demo"].includes(response.unfollow?.status)) window.XFM.unfollow?.resume();
      if (["Running", "Demo"].includes(response.engage?.status)) window.XFM.engage?.resume();
    });
  }, 800);
})();
