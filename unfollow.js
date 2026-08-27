// Unfollow engine (X Following Manager). Runs as a content script on x.com/twitter.com.
(() => {
  const X = window.XFM?._;
  if (!X || !X.isXPage) return;
  if (window.XFM.unfollow) return; // already registered in this tab

  const viewportHeight = () => Math.max(1, window.visualViewport?.height || window.innerHeight);

  let running = false, paused = false, stopped = false;
  let processed = 0, unfollowed = 0, total = 0, skipped = 0, demoMatches = 0;
  let discovered = new Set(), acted = new Set(), config = {}, refreshes = 0;
  let batchCount = 0, batchTarget = 0, cooldownUntil = null, nextActionAt = null;
  const report = patch => X.report("unfollow", patch);
  const status = () => config.demo ? "Demo" : "Running";

  function usernameFromRow(row) {
    const preferred = row?.querySelector('[data-testid="User-Name"] a[href]');
    const links = preferred ? [preferred] : [...(row?.querySelectorAll('a[href]') || [])];
    return links.map(a => X.userFromHref(a.href)).find(Boolean) || "";
  }

  function rows() {
    const scope = document.querySelector('[data-testid="primaryColumn"]') || document;
    const candidates = [...scope.querySelectorAll('[data-testid="UserCell"]')];
    const out = [];
    for (const row of candidates) {
      const link = usernameFromRow(row);
      if (link && !out.some(item => item.username === link)) out.push({ username: link, row });
    }
    return out;
  }

  function rowForUsername(username) {
    return rows().find(item => item.username === username)?.row || null;
  }

  function loggedInUsername() {
    const preferred = document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
    const direct = preferred ? X.userFromHref(preferred.href) : "";
    if (direct) return direct;

    // The compact/mobile X navigation often drops the desktop test id but keeps
    // an accessible Profile link. Use only explicit profile-labelled links here.
    const labelled = [...document.querySelectorAll('a[href][aria-label*="profile" i], a[href][data-testid*="profile" i]')]
      .map(link => X.userFromHref(link.href)).find(Boolean);
    if (labelled) return labelled;

    // On the account's own /following route the first path segment is the only
    // reliable identity left after responsive navigation is collapsed.
    const parts = location.pathname.split("/").filter(Boolean);
    return parts.length === 2 && X.norm(parts[1]) === "following" ? X.norm(parts[0]) : "";
  }

  function ownFollowingPage() {
    const path = location.pathname.split("/").filter(Boolean).map(X.norm);
    return path.length === 2 && path[1] === "following" && !!path[0] && path[0] === loggedInUsername();
  }

  function buttonFor(row) {
    const buttons = [...row.querySelectorAll('button, [role="button"]')];
    return buttons.find(b => {
      const test = (b.getAttribute("data-testid") || "").toLowerCase();
      const label = (b.getAttribute("aria-label") || b.textContent || "").trim().toLowerCase();
      return test === "unfollow" || test.includes("unfollow") || /^(following|unfollow)(\s|$)/.test(label) ||
        (/\bfollowing\b/.test(label) && !/\bnot following\b/.test(label));
    });
  }

  function followsBack(row) {
    return !!row.querySelector('[data-testid="userFollowIndicator"]') || /follows you/i.test(row.innerText || "");
  }

  function confirmationButton() {
    const exact = [...document.querySelectorAll('[data-testid*="confirmationSheetConfirm"], [data-testid*="Confirm"]')]
      .find(X.visible);
    if (exact) return exact;
    const dialogs = [...document.querySelectorAll('[role="dialog"], [data-testid*="confirmationSheet"]')];
    for (const dialog of dialogs) {
      const button = [...dialog.querySelectorAll('button, [role="button"]')].find(candidate => {
        const text = `${candidate.getAttribute("aria-label") || ""} ${candidate.textContent || ""}`.toLowerCase();
        return X.visible(candidate) && /unfollow|confirm|yes/.test(text) && !/cancel|no|keep/.test(text);
      });
      if (button) return button;
    }
    return null;
  }

  async function waitForConfirmation(timeout = 5000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const button = confirmationButton();
      if (button) return button;
      await X.sleep(120);
    }
    return null;
  }

  function stillFollowing(row) {
    return followingState(row) === true;
  }

  function followingState(row) {
    if (!row?.isConnected) return null;
    const button = buttonFor(row);
    if (button) return true;
    const follow = [...row.querySelectorAll('button, [role="button"]')].find(candidate => {
      const test = (candidate.getAttribute("data-testid") || "").toLowerCase();
      const label = `${candidate.getAttribute("aria-label") || ""} ${candidate.textContent || ""}`.trim().toLowerCase();
      return !/unfollow/.test(test) && (/(^|-)follow$/.test(test) || /^follow(\s|$)/.test(label));
    });
    return follow ? false : null;
  }

  async function waitForUnfollowState(username, row, timeout = 7000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      row = row?.isConnected && usernameFromRow(row) === username ? row : rowForUsername(username);
      if (followingState(row) === false) return true;
      await X.sleep(150);
    }
    return false;
  }

  async function clickUnfollow(username, row) {
    for (let attempt = 0; attempt < 3; attempt++) {
      row = row?.isConnected && usernameFromRow(row) === username ? row : rowForUsername(username);
      if (!row?.isConnected) return { ok: false, reason: "account is no longer visible" };
      const visibleName = usernameFromRow(row);
      if (visibleName !== username) return { ok: false, reason: "account changed" };
      if (!stillFollowing(row)) return { ok: false, reason: "account is already unfollowed" };
      let button = buttonFor(row);
      if (!X.visible(button)) { await X.sleep(600); button = buttonFor(row); }
      if (!X.visible(button)) return { ok: false, reason: "following button not found" };
      X.scrollTo(button);
      await X.sleep(250);
      button = buttonFor(row);
      if (!X.visible(button)) continue;
      if (!await X.activate(button)) continue;
      const confirm = await waitForConfirmation(X.isMobile ? 5500 : 3500);
      if (confirm) {
        if (!await X.activate(confirm)) continue;
        if (await waitForUnfollowState(username, row, X.isMobile ? 10000 : 7000)) return { ok: true };
      } else if (await waitForUnfollowState(username, row, X.isMobile ? 4500 : 2500)) {
        return { ok: true };
      }
      await X.sleep(700);
    }
    return { ok: false, reason: "X did not change the account's Following state" };
  }

  function profileActionButton(username) {
    const scope = document.querySelector('[data-testid="primaryColumn"]') || document.querySelector('main') || document.body;
    const target = X.norm(username);
    const candidates = [...scope.querySelectorAll('button, [role="button"]')].filter(button => {
      if (!X.visible(button)) return false;
      // Tweet action bars and user cells contain their own Follow buttons. The
      // profile-header control is outside those containers.
      if (button.closest('article, [data-testid="UserCell"], [role="dialog"]')) return false;
      const test = (button.getAttribute("data-testid") || "").toLowerCase();
      const label = `${button.getAttribute("aria-label") || ""} ${button.textContent || ""}`.trim().toLowerCase();
      return test === "follow" || test === "unfollow" || /-(follow|unfollow)$/.test(test) ||
        /^(follow|following|unfollow)(\s|$)/.test(label);
    });
    if (!candidates.length) return null;

    const ranked = candidates.map((button, index) => {
      const test = (button.getAttribute("data-testid") || "").toLowerCase();
      const label = `${button.getAttribute("aria-label") || ""} ${button.textContent || ""}`.trim().toLowerCase();
      let score = 0;
      if (test === "follow" || test === "unfollow") score += 100;
      else if (/(^|-)follow$|-(unfollow)$/.test(test)) score += 90;
      if (/^(follow|following|unfollow)(\s|$)/.test(label)) score += 40;
      if (target && (label.includes(`@${target}`) || X.norm(label).includes(target))) score += 20;
      return { button, score, index };
    }).sort((a, b) => b.score - a.score || a.index - b.index);
    return ranked[0]?.button || null;
  }

  function profileIsFollowing(username) {
    const button = profileActionButton(username);
    if (!button) return null;
    const test = (button.getAttribute("data-testid") || "").toLowerCase();
    const label = `${button.getAttribute("aria-label") || ""} ${button.textContent || ""}`.toLowerCase();
    if (/unfollow/.test(test) || /\bfollowing\b/.test(label)) return true;
    if (/(^|[-\s])follow($|[-\s])/.test(test) || /^\s*follow\b/.test(label)) return false;
    return null;
  }

  async function waitForProfile(username, timeout = 10000) {
    const started = Date.now();
    while (Date.now() - started < timeout && running && !stopped) {
      if (X.blockedOrLoggedOut()) return { state: "blocked" };
      if (X.norm(location.pathname.split("/").filter(Boolean)[0]) !== X.norm(username)) {
        await X.sleep(250);
        continue;
      }
      const state = profileIsFollowing(username);
      if (state !== null) return { state: state ? "following" : "unfollowed" };
      if (/couldn't find this account|page doesn't exist|account suspended/i.test(document.body?.innerText || "")) {
        return { state: "missing" };
      }
      await X.sleep(250);
    }
    return { state: "timeout" };
  }

  async function clickProfileUnfollow(username) {
    const state = await waitForProfile(username);
    if (state.state !== "following") return { ok: false, reason: state.state === "unfollowed" ? "account is already unfollowed" : `profile ${state.state}` };
    let button = profileActionButton(username);
    if (!X.visible(button)) return { ok: false, reason: "profile Following button not found" };
    X.scrollTo(button);
    await X.sleep(250);
    button = profileActionButton(username);
    if (!X.visible(button) || profileIsFollowing(username) !== true) {
      return { ok: false, reason: "profile Following button changed before it could be clicked" };
    }
    if (!await X.activate(button)) return { ok: false, reason: "profile Following button could not be clicked" };
    const confirm = await waitForConfirmation(X.isMobile ? 5500 : 3500);
    if (confirm && !await X.activate(confirm)) return { ok: false, reason: "unfollow confirmation could not be clicked" };
    const started = Date.now();
    while (Date.now() - started < (X.isMobile ? 10000 : 7000) && running && !stopped) {
      if (profileIsFollowing(username) === false) return { ok: true };
      await X.sleep(150);
    }
    return { ok: false, reason: "X did not change the profile's Following state" };
  }

  function wanted(username, row) {
    const list = new Set(config.usernames || []);
    if (config.mode !== "custom" && list.has(username)) return false;
    if (config.mode === "all") return true;
    if (config.mode === "nonfollowers") return !followsBack(row);
    return config.customMode === "only" ? list.has(username) : !list.has(username);
  }

  async function runCooldown(options = {}) {
    cooldownUntil = cooldownUntil && cooldownUntil > Date.now() ? cooldownUntil : Date.now() + config.cooldownMs;
    nextActionAt = cooldownUntil;
    await report({ status: "Cooldown", batchCount, batchTarget, cooldownUntil, nextActionAt, error: "",
      notice: `Batch complete. Cooling down for ${Math.round(config.cooldownMs / 60000)} minutes before continuing.` });
    while (Date.now() < cooldownUntil && running && !stopped) {
      if (paused) { await X.sleep(500); continue; }
      const seconds = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
      await report({ status: "Cooldown", nextActionAt, notice: `Cooldown: ${Math.floor(seconds / 60)}m ${seconds % 60}s remaining.` });
      await X.sleep(Math.min(1000, cooldownUntil - Date.now()));
    }
    if (!running || stopped) return false;
    batchCount = 0;
    batchTarget = X.rand(config.batchMin, config.batchMax);
    cooldownUntil = null;
    nextActionAt = null;
    await report({ status: status(), batchCount, batchTarget, cooldownUntil, nextActionAt,
      notice: "Cooldown complete. Continuing..." });
    if (options.refresh !== false && config.autoRefresh !== false) {
      await X.sleep(500);
      location.reload();
      return false;
    }
    return true;
  }

  function shouldAutoStop() {
    return config.stopAfterMinute && config.startedAt && Date.now() - config.startedAt >= 60000;
  }

  async function runCustomOnly() {
    const queue = [...new Set((config.usernames || []).map(X.norm).filter(Boolean))];
    total = Math.max(total, queue.length);
    if (!discovered.size) discovered = new Set(queue);
    await report({ total, discovered: [...discovered], remaining: Math.max(0, total - processed), error: "" });
    if (!batchTarget) batchTarget = X.rand(config.batchMin, config.batchMax);
    if (cooldownUntil && cooldownUntil > Date.now() && !await runCooldown({ refresh: false })) return;

    while (running && !stopped) {
      if (paused) { await X.sleep(500); continue; }
      if (shouldAutoStop()) {
        running = false;
        await report({ status: "Completed", currentUsername: "", nextActionAt: null, notice: "Stopped automatically after 1 minute." });
        return;
      }
      const username = queue.find(item => !acted.has(item));
      if (!username) break;
      if (X.blockedOrLoggedOut()) {
        paused = true;
        await report({ status: "Paused", error: "X is logged out, unavailable, or showing a security challenge. Resolve it, then press Resume." });
        continue;
      }
      await report({ status: status(), currentUsername: "@" + username, remaining: Math.max(0, total - processed) });
      if (X.norm(location.pathname.split("/").filter(Boolean)[0]) !== username || location.pathname.split("/").filter(Boolean).length !== 1) {
        location.href = `https://x.com/${username}`;
        return;
      }
      let result;
      if (config.demo) {
        const profile = await waitForProfile(username);
        result = profile.state === "following"
          ? { ok: true, demo: true }
          : { ok: false, reason: profile.state === "unfollowed" ? "account is already unfollowed" : `profile ${profile.state}` };
      } else {
        result = await clickProfileUnfollow(username);
      }
      if (!result.ok && result.reason === "profile blocked") {
        paused = true;
        await report({ status: "Paused", error: "X is logged out, unavailable, or showing a security challenge. Resolve it, then press Resume." });
        continue;
      }
      acted.add(username); processed++;
      if (!result.ok) {
        skipped++;
        await report({ processed, skipped, handled: [...acted], remaining: Math.max(0, total - processed), currentUsername: "@" + username,
          notice: `Skipped @${username}: ${result.reason}.` });
      } else if (result.demo) {
        demoMatches++;
        await report({ processed, demoMatches, handled: [...acted], remaining: Math.max(0, total - processed),
          notice: `Demo: @${username} would be unfollowed. No action was clicked.` });
      } else {
        unfollowed++; batchCount++;
        await report({ processed, unfollowed, batchCount, batchTarget, handled: [...acted], remaining: Math.max(0, total - processed) });
      }
      const next = queue.find(item => !acted.has(item));
      if (!next) continue;
      if (result.demo) {
        if (!await controlledWait(700)) return;
      } else if (result.ok && batchCount >= batchTarget) {
        if (!await runCooldown({ refresh: false })) return;
      } else if (result.ok && running && !stopped) {
        const delay = X.rand(config.minDelayMs, config.maxDelayMs);
        nextActionAt = Date.now() + delay;
        await report({ nextActionAt, notice: `Next action in ${(delay / 1000).toFixed(1)} seconds.` });
        if (!await controlledWait(delay)) return;
        nextActionAt = null;
      }
      // The next iteration navigates to the next target profile, preserving serial order.
      location.href = `https://x.com/${next}`;
      return;
    }
    if (stopped) return;
    running = false;
    await report({ status: "Completed", remaining: 0, currentUsername: "", nextActionAt: null, error: "",
      notice: config.demo ? `Demo complete: ${demoMatches} account(s) matched. Nothing was unfollowed.` : "Completed." });
    if (config.reloadOnFinished !== false) setTimeout(() => location.reload(), 700);
  }

  async function run() {
    if (config.mode === "custom" && config.customMode === "only") {
      await runCustomOnly();
      return;
    }
    const followingPage = config.mode === "nonfollowers" ? X.isFollowingPage() : ownFollowingPage();
    if (!followingPage) {
      const username = loggedInUsername();
      if (!username) {
        running = false;
        await report({ status: "Error", error: "Could not identify the logged-in profile. Open your Following page and start again." });
        return;
      }
      location.href = `https://x.com/${username}/following`;
      return;
    }
    if (!batchTarget) batchTarget = X.rand(config.batchMin, config.batchMax);
    if (cooldownUntil && cooldownUntil > Date.now()) {
      if (!await runCooldown()) return;
    }
    let idleRounds = 0;
    while (running && !stopped) {
      if (paused) { await X.sleep(500); continue; }
      if (shouldAutoStop()) {
        running = false;
        await report({ status: "Completed", currentUsername: "", nextActionAt: null,
          notice: "Stopped automatically after 1 minute." });
        if (config.reloadOnFinished !== false) setTimeout(() => location.reload(), 700);
        return;
      }
      if (X.blockedOrLoggedOut()) {
        paused = true;
        await report({ status: "Paused", error: "X is logged out, unavailable, or showing a security challenge. Resolve it, then press Resume." });
        continue;
      }
      const batch = rows();
      let foundNew = false;
      for (const item of batch) {
        if (!discovered.has(item.username)) { discovered.add(item.username); total++; foundNew = true; }
      }
      if (foundNew) await report({ total, discovered: [...discovered], remaining: Math.max(0, total - processed), error: "", notice: "" });
      const item = batch.find(candidate => !acted.has(candidate.username));
      if (item) {
        idleRounds = 0;
        if (!wanted(item.username, item.row)) {
          acted.add(item.username); processed++;
          await report({ processed, handled: [...acted], remaining: Math.max(0, total - processed), currentUsername: "@" + item.username });
          continue;
        }
        await report({ currentUsername: "@" + item.username, status: status() });
        if (config.demo) {
          acted.add(item.username); processed++; demoMatches++;
          await report({ processed, demoMatches, handled: [...acted], remaining: Math.max(0, total - processed),
            notice: `Demo: @${item.username} would be unfollowed. No action was clicked.` });
          await controlledWait(700);
          continue;
        }
        const result = await clickUnfollow(item.username, item.row);
        if (!result.ok) {
          acted.add(item.username); processed++;
          skipped++;
          await report({ processed, handled: [...acted], skipped,
            remaining: Math.max(0, total - processed), currentUsername: "@" + item.username,
            notice: `Skipped @${item.username}: ${result.reason}. The account was not counted as unfollowed.` });
          continue;
        }
        acted.add(item.username); unfollowed++; processed++; batchCount++;
        await report({ processed, unfollowed, batchCount, batchTarget, handled: [...acted], remaining: Math.max(0, total - processed) });
        if (batchCount >= batchTarget) {
          if (!await runCooldown()) return;
        } else if (running && !stopped) {
          const delay = X.rand(config.minDelayMs, config.maxDelayMs);
          nextActionAt = Date.now() + delay;
          await report({ nextActionAt, notice: `Next action in ${(delay / 1000).toFixed(1)} seconds.` });
          if (!await controlledWait(delay)) break;
          nextActionAt = null;
        }
        continue;
      }
      idleRounds++;
      if (config.autoScroll !== false) {
        const visibleRows = rows();
        const last = visibleRows[visibleRows.length - 1]?.row;
        if (last) {
          last.scrollIntoView({ block: "center", behavior: "smooth" });
          window.scrollBy({ top: Math.max(350, viewportHeight() * 0.6), behavior: "smooth" });
        }
        else window.scrollBy({ top: Math.max(500, viewportHeight() * 0.8), behavior: "smooth" });
      }
      await X.sleep(1200);
      if (idleRounds > 8) {
        if (config.autoRefresh !== false && refreshes < 2) {
          refreshes++;
          await report({ refreshes, status: status(), error: "", notice: "Refreshing the Following list to load more accounts..." });
          await X.sleep(500);
          location.reload();
          return;
        }
        if (processed === 0) {
          running = false;
          await report({ status: "Error", error: "No following accounts were detected. Check that X's Following page is open." });
        }
        break;
      }
    }
    if (stopped) {
      await report({ status: "Idle", currentUsername: "", nextActionAt: null, notice: "" });
    } else if (running) {
      running = false;
      await report({ status: "Completed", remaining: 0, currentUsername: "", nextActionAt: null, error: "",
        notice: config.demo ? `Demo complete: ${demoMatches} account(s) matched. Nothing was unfollowed.` : "Completed." });
      if (config.reloadOnFinished !== false) setTimeout(() => location.reload(), 700);
    }
  }

  async function controlledWait(ms) {
    const until = Date.now() + ms;
    while (Date.now() < until && running && !stopped) {
      if (paused) { await X.sleep(50); continue; }
      await X.sleep(Math.min(50, until - Date.now()));
    }
    return running && !stopped;
  }

  function apply(state) {
    config = {
      ...state,
      minDelayMs: Math.max(500, (Number(state.minDelaySec) || 0.5) * 1000),
      maxDelayMs: Math.max(500, (Number(state.maxDelaySec) || 0.5) * 1000),
      cooldownMs: Math.max(0, (Number(state.cooldownMinutes) ?? 5) * 60000),
      batchMin: Math.max(1, Number(state.batchMin) || 20),
      batchMax: Math.max(1, Number(state.batchMax) || 30)
    };
    if (config.maxDelayMs < config.minDelayMs) config.maxDelayMs = config.minDelayMs;
    if (config.batchMax < config.batchMin) config.batchMax = config.batchMin;
    processed = state.processed || 0; unfollowed = state.unfollowed || 0; total = state.total || 0;
    skipped = state.skipped || 0; demoMatches = state.demoMatches || 0;
    acted = new Set(state.handled || []); discovered = new Set(state.discovered || state.handled || []);
    refreshes = state.refreshes || 0; batchCount = state.batchCount || 0;
    batchTarget = state.batchTarget || X.rand(config.batchMin, config.batchMax);
    cooldownUntil = state.cooldownUntil || null; nextActionAt = state.nextActionAt || null;
    total = Math.max(total, discovered.size);
  }

  window.XFM.unfollow = {
    start(incoming) {
      apply({ ...incoming, handled: [], discovered: [], processed: 0, unfollowed: 0, total: 0,
        skipped: 0, demoMatches: 0, refreshes: 0, batchCount: 0, batchTarget: 0, cooldownUntil: null });
      running = true; paused = false; stopped = false;
      report({ status: status(), total: 0, processed: 0, unfollowed: 0, skipped: 0, demoMatches: 0,
        remaining: 0, batchCount, batchTarget, cooldownUntil: null, nextActionAt: null, error: "", notice: "" });
      run();
    },
    pause() { paused = true; },
    resume() {
      if (running) { paused = false; return; }
      // Claim the run before awaiting storage, otherwise a second resume arriving during the
      // round-trip starts a duplicate loop over the same counters.
      running = true; paused = false; stopped = false;
      X.request({ type: "get-all" }, 10000).then(response => {
        if (!response || response.ok === false || !response.settings) {
          running = false;
          return;
        }
        if (!running || stopped) return;
        apply({ ...response.settings.unfollow, ...response.unfollow });
        run();
      });
    },
    stop() { stopped = true; running = false; paused = false; }
  };
})();
