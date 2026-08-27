// Like & Comment engine (X Following Manager). Runs as a content script on x.com/twitter.com.
// Reads the Home timeline, likes and/or posts an AI-written reply, one post at a time,
// spaced by the timing plan the popup selected. Demo mode never clicks anything.
(() => {
  const X = window.XFM?._;
  if (!X || !X.isXPage) return;
  if (window.XFM.engage) return; // already registered in this tab

  let running = false, paused = false, stopped = false;
  // Only the loop holding the current token may act. start() and resume() both bump it, so a
  // late resume callback can never leave a second run() alive on the same closure state.
  let runToken = 0;
  let scanned = 0, processed = 0, liked = 0, commented = 0, skipped = 0;
  let acted = new Set(), config = {}, plan = {}, nextActionAt = null, skipRemaining = 0, linkStatuses = {}, guardianState = null;
  let skipIdleRounds = 0;
  let lastDelaySec = null;
  let manualReplyOpen = false;
  let manualReplyBaseline = new Set();
  let manualReplyComposer = null;
  const mobileTimeout = value => X.isMobile ? Math.round(value * 1.6) : value;
  const tweetSelector = '[data-testid="tweet"]';
  const viewportHeight = () => Math.max(1, window.visualViewport?.height || window.innerHeight);

  const ACTIVITY_LEDGER_KEY = "activityLedger24h";
  const ledgerApplies = () => !config.demo && ["timeline", "guardian", "links"].includes(config.source);
  const ledgerCycle = (now = new Date()) => [
    now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")
  ].join("-");
  const ledgerProfile = username => X.norm(username);

  async function readActivityLedger() {
    const cycle = ledgerCycle();
    const bag = await X.storageGet(ACTIVITY_LEDGER_KEY);
    const stored = bag[ACTIVITY_LEDGER_KEY];
    if (stored?.cycle === cycle && stored.profiles && Array.isArray(stored.records)) return stored;
    const fresh = { cycle, profiles: {}, records: [] };
    await X.storageSet({ [ACTIVITY_LEDGER_KEY]: fresh, engageCompletedPosts: {} });
    return fresh;
  }

  async function activityLedgerReason(username) {
    if (!ledgerApplies()) return "";
    const profile = ledgerProfile(username);
    if (!profile) return "";
    const response = await X.request({ type: "activity:check", profile }, mobileTimeout(8000));
    if (response?.ok) return response.engaged ? response.reason : "";
    const ledger = await readActivityLedger();
    return Object.prototype.hasOwnProperty.call(ledger.profiles, profile)
      ? "Already Engaged with this Profile within the last 24 hours"
      : "";
  }

  async function recordActivityLedger(username, post, outcome) {
    if (!ledgerApplies()) return;
    const profile = ledgerProfile(username || post?.author);
    const actions = Array.isArray(outcome?.detectedActions) ? outcome.detectedActions : [
      outcome?.liked ? "Like" : "",
      outcome?.commented ? "Comment" : ""
    ].filter(Boolean);
    if (!profile || !actions.length) return;
    const now = Date.now();
    const record = {
      at: now,
      profile,
      profileUrl: `https://x.com/${profile}`,
      postId: String(post?.id || ""),
      postUrl: String(post?.url || (post?.id ? `https://x.com/${profile}/status/${post.id}` : "")),
      actions,
      mode: config.queueSource || config.source,
      detected: outcome?.detected === true
    };
    const response = await X.request({ type: "activity:record", record }, mobileTimeout(8000));
    if (response?.ok) return;
    const ledger = await readActivityLedger();
    ledger.records = [...ledger.records, record].slice(-5000);
    const previous = Object.prototype.hasOwnProperty.call(ledger.profiles, profile) ? ledger.profiles[profile] : {};
    ledger.profiles = { ...ledger.profiles, [profile]: {
      ...previous,
      profile,
      profileUrl: record.profileUrl,
      lastAt: now,
      lastPostId: record.postId,
      lastPostUrl: record.postUrl,
      actions: [...new Set([...(previous.actions || []), ...actions])]
    } };
    await X.storageSet({ [ACTIVITY_LEDGER_KEY]: ledger });
  }

  function existingActivityActions(reason) {
    const text = String(reason || "").toLowerCase();
    const actions = [];
    if (/like|liked/.test(text)) actions.push("Like");
    if (/comment|reply|replied/.test(text)) actions.push("Comment");
    return actions.length ? actions : ["Like/Comment"];
  }

  const existingActivityReason = reason =>
    /previously completed|already liked|comment.*already|reply.*already|already visible/i.test(String(reason || ""));

  async function recordExistingActivity(username, post, reason) {
    if (!existingActivityReason(reason)) return;
    await recordActivityLedger(username, post, {
      detected: true,
      detectedActions: existingActivityActions(reason)
    });
  }

  const report = patch => X.report("engage", patch);
  const status = () => config.demo ? "Demo" : "Running";
  const linkMode = () => config.source === "links" && Array.isArray(config.postLinks);
  const telegramGuardianMode = () => linkMode() && config.queueSource === "guardian-tg";
  const guardianMode = () => ["guardian", "profiles"].includes(config.source) && Array.isArray(config.profileLinks);
  const target = () => linkMode()
    ? Math.max(1, config.postLinks.length)
    : guardianMode()
      ? Math.max(1, config.profileLinks.length)
      : Math.max(1, Number(config.maxActions) || 20);

  function nextDelay() {
    if (plan.mode !== "random") return plan.minMs;
    const minSec = Math.ceil(plan.minMs / 1000);
    const maxSec = Math.floor(plan.maxMs / 1000);
    let seconds = X.rand(minSec, Math.max(minSec, maxSec));
    if (maxSec > minSec && seconds === lastDelaySec) {
      seconds = seconds === maxSec ? minSec : seconds + 1;
    }
    lastDelaySec = seconds;
    return seconds * 1000;
  }

  document.addEventListener("click", event => {
    if (!event.isTrusted) return;
    const target = event.target?.closest?.('[data-testid="reply"], [data-testid="tweetButtonInline"], button, [role="button"]');
    if (!target || target.id === "xfmManualReply") return;
    const label = `${target.getAttribute("aria-label") || ""} ${target.textContent || ""}`.trim();
    if (/^reply$/i.test(label) || /\breply\b/i.test(label) && target.getAttribute("data-testid") === "reply") {
      manualReplyBaseline = new Set(replyComposers());
      manualReplyOpen = true;
    }
  }, true);

  document.addEventListener("focusin", event => {
    if (!event.isTrusted || !event.target?.matches?.('[data-testid="tweetTextarea_0"], [contenteditable="true"][role="textbox"]')) return;
    if (!replyComposers().includes(event.target)) return;
    manualReplyBaseline = new Set(replyComposers().filter(node => node !== event.target));
    manualReplyOpen = true;
  }, true);

  function smoothScrollBy(distance, duration = X.rand(700, 1300)) {
    const start = window.scrollY;
    const targetY = Math.max(0, start + distance);
    const started = performance.now();
    return new Promise(resolve => {
      const frame = now => {
        if (stopped) { resolve(); return; }
        const progress = Math.min(1, (now - started) / duration);
        // Ease in/out so the movement does not look like a repeated programmatic jump.
        const eased = progress < 0.5
          ? 2 * progress * progress
          : 1 - Math.pow(-2 * progress + 2, 2) / 2;
        window.scrollTo(0, start + (targetY - start) * eased);
        if (progress < 1) requestAnimationFrame(frame);
        else resolve();
      };
      requestAnimationFrame(frame);
    });
  }

  function smoothScrollToElement(element, block = 0.5) {
    if (!element?.isConnected) return Promise.resolve(false);
    let previous = performance.now();
    const started = previous;
    let settled = 0;
    return new Promise(resolve => {
      const frame = now => {
        if (stopped || !element.isConnected) { resolve(false); return; }
        const elapsed = Math.min(40, Math.max(1, now - previous));
        previous = now;
        if (now - started > 1000) { resolve(true); return; }
        const rect = element.getBoundingClientRect();
        const desiredTop = (viewportHeight() - rect.height) * block;
        const distance = rect.top - desiredTop;
        if (Math.abs(distance) < 2) settled++;
        else settled = 0;
        if (settled >= 3) { resolve(true); return; }
        const maxStep = elapsed * 1.15;
        const step = Math.sign(distance) * Math.min(Math.abs(distance) * 0.18, maxStep);
        window.scrollBy(0, step);
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  }

  // ---------- reading the timeline ----------

  const statusId = article => {
    for (const anchor of article.querySelectorAll('a[href*="/status/"]')) {
      const match = /\/status\/(\d+)/.exec(anchor.getAttribute("href") || "");
      if (match) return match[1];
    }
    return "";
  };

  const authorOf = article => {
    const block = article.querySelector('[data-testid="User-Name"]');
    const scope = block || article;
    return [...scope.querySelectorAll('a[href]')].map(a => X.userFromHref(a.href)).find(Boolean) || "";
  };

  const textOf = article => {
    const primary = [...article.querySelectorAll('[data-testid="tweetText"]')]
      .map(node => node.innerText.trim()).filter(Boolean);
    if (primary.length) return primary.join("\n\n").trim();
    return [...article.querySelectorAll('[lang]')]
      .filter(node => !node.closest('[data-testid="User-Name"]'))
      .map(node => node.innerText.trim()).filter(Boolean).join("\n\n").trim();
  };

  const isPromoted = article =>
    !!article.closest('[data-testid="placementTracking"]') ||
    /(^|\n)\s*(promoted|ad)\s*(\n|$)/i.test(article.innerText || "");

  const isReply = article => {
    const context = article.querySelector('[data-testid="socialContext"]')?.innerText || "";
    return /replying to/i.test(context) || /(^|\n)\s*replying to /i.test(article.innerText || "");
  };

  const alreadyLiked = article => !!article.querySelector(
    '[data-testid="unlike"], button[aria-label*="Unlike" i], [role="button"][aria-label*="Unlike" i], [data-testid="like"][aria-pressed="true"]'
  );

  const currentPost = post => timelinePosts().find(item => item.id === post.id) || post;
  const livePost = post => timelinePosts().find(item => item.id === post.id || item.key === post.key)
    || (post?.article?.isConnected ? post : null);

  function timelinePosts() {
    const out = [];
    const scope = document.querySelector('[data-testid="primaryColumn"]') || document;
    for (const article of scope.querySelectorAll(tweetSelector)) {
      // The open reply modal renders the original post as an article too; it is not timeline work.
      if (!article.isConnected || article.closest('[role="dialog"]')) continue;
      const author = authorOf(article);
      const text = textOf(article);
      const id = statusId(article);
      const key = id || (author && text ? `${author}:${text.slice(0, 60)}` : "");
      if (!author || !key || out.some(item => item.key === key)) continue;
      out.push({ key, id, author, text, article });
    }
    return out;
  }

  function rejection(post) {
    if (acted.has(post.key)) return "already handled";
    if (config.skipPromoted !== false && isPromoted(post.article)) return "promoted post";
    if (isReply(post.article)) return "reply thread";
    if (config.onlyAuthors?.length && !config.onlyAuthors.includes(post.author)) return "author not in allow list";
    if (config.skipAuthors?.some(author => X.norm(author) === X.norm(post.author))) return "author in Authority Skip list";
    if (post.text.length < (Number(config.minTweetChars) || 0)) return "post text too short";
    return null;
  }

  function nextPost() {
    for (const post of timelinePosts()) {
      if (!acted.has(post.key)) {
        const reason = rejection(post);
        if (reason) { acted.add(post.key); scanned++; continue; }
        scanned++;
        return post;
      }
    }
    return null;
  }

  function linkId(url) {
    const match = /\/status\/(\d+)/.exec(String(url || ""));
    return match ? match[1] : "";
  }

  const linkUrlFor = id => (config.postLinks || []).find(url => linkId(url) === id) || "";

  async function setLinkStatus(id, statusName, detail = "") {
    const url = linkUrlFor(id);
    if (!url) return;
    linkStatuses = { ...linkStatuses, [url]: { status: statusName, detail } };
    await report({ linkStatuses });
  }

  async function completedBefore(post) {
    const history = (await X.storageGet("engageCompletedPosts")).engageCompletedPosts || {};
    if (history[post.id]) return "Previously completed by this extension";
    if (alreadyLiked(post.article)) return "Already liked on X";

    const profile = document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
    const me = X.userFromHref(profile?.getAttribute("href") || "");
    if (me) {
      const ownReply = timelinePosts().some(item => item.id !== post.id && item.author === me &&
        (isReply(item.article) || new RegExp(`replying to\\s+@?${post.author}`, "i").test(item.article.innerText || "")));
      if (ownReply) return "Your reply is already visible on X";
    }
    return "";
  }

  async function rememberCompleted(post, outcome) {
    const bag = await X.storageGet("engageCompletedPosts");
    const history = bag.engageCompletedPosts || {};
    history[post.id] = { at: Date.now(), liked: outcome.liked === true, commented: outcome.commented === true };
    const entries = Object.entries(history).sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0)).slice(0, 2000);
    await X.storageSet({ engageCompletedPosts: Object.fromEntries(entries) });
  }

  async function nextLinkedPost() {
    const links = config.postLinks || [];
    const next = links.find(url => {
      const id = linkId(url);
      return id && !acted.has(`link:${id}`);
    });
    if (!next) return { done: true };
    const id = linkId(next);
    if (!location.pathname.includes(`/status/${id}`)) {
      await setLinkStatus(id, "Processing", telegramGuardianMode() ? "Opening Telegram Guardian post link" : "Opening post");
      await report({ status: status(), notice: `Opening post link ${acted.size + 1} of ${links.length} in serial order...` });
      location.href = next;
      return { navigating: true };
    }
    const post = await waitFor(() => timelinePosts().find(item => item.id === id) || null, 15000);
    if (!post) return { error: "The linked post could not be read on X.", id, url: next };
    post.key = `link:${id}`;
    return { post };
  }

  const profileUsername = url => X.userFromHref(url);
  const profileKey = url => `profile:${profileUsername(url)}`;
  const onProfilePage = username => {
    const parts = location.pathname.split("/").filter(Boolean);
    return parts.length === 1 && X.norm(parts[0]) === username;
  };

  async function setGuardianProfileStatus(profileUrl, statusName, detail, postUrl = "") {
    linkStatuses = {
      ...linkStatuses,
      [profileUrl]: {
        ...(linkStatuses[profileUrl] || {}),
        status: statusName,
        detail: String(detail || "").slice(0, 240),
        postUrl: postUrl || linkStatuses[profileUrl]?.postUrl || ""
      }
    };
    await report({ linkStatuses });
  }

  function pinnedPost(article) {
    const context = article.querySelector('[data-testid="socialContext"]');
    if (context && (/pinned/i.test(context.innerText || "") || context.querySelector('svg[aria-label*="Pinned" i]'))) return true;
    return /(^|\n)\s*Pinned( post)?\s*(\n|$)/i.test(article.innerText || "");
  }

  async function guardianProfileEngagement(post) {
    const history = (await X.storageGet("engageCompletedPosts")).engageCompletedPosts || {};
    if (history[post.id]) return "Previously completed by this extension";
    if (alreadyLiked(post.article)) return "Already liked on X";
    const context = post.article.querySelector('[data-testid="socialContext"]');
    if (/\byou (?:replied|commented)\b/i.test(context?.innerText || "") ||
        post.article.querySelector('[aria-label*="You replied" i], [aria-label*="You commented" i]')) {
      return "Your comment is already visible on X";
    }
    return "";
  }

  async function scanGuardianProfilePosts(username, profileUrl, token) {
    window.scrollTo(0, 0);
    await waitFor(() => document.querySelector(tweetSelector), mobileTimeout(15000));
    if (!await wait(650, token)) return { stopped: true, posts: [] };
    const seen = new Set();
    const posts = [];

    for (let round = 0; round < 5 && posts.length < 2; round++) {
      for (const article of document.querySelectorAll(tweetSelector)) {
        const id = statusId(article);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        if (pinnedPost(article) || authorOf(article) !== username) continue;
        const post = {
          id,
          url: `https://x.com/${username}/status/${id}`,
          author: username,
          text: textOf(article).slice(0, 1000),
          reply: isReply(article),
          promoted: isPromoted(article),
          article
        };
        if (guardianPostRejection(post)) continue;

        const savedPost = {
          id: post.id,
          url: post.url,
          author: post.author,
          text: post.text,
          reply: post.reply,
          promoted: post.promoted,
          article: post.article
        };
        posts.push(savedPost);
        if (posts.length === 1) {
          await setGuardianProfileStatus(profileUrl, "Processing", "First relevant post bypassed. Locating only the second relevant post; pinned posts are ignored.");
          await report({ currentTweet: profileUrl, notice: `Locating the second relevant post for @${username}. No post has been opened.` });
          continue;
        }
        await smoothScrollToElement(article, 0.22);
        if (!await wait(X.rand(450, 700), token)) return { stopped: true, posts };
        await setGuardianProfileStatus(profileUrl, "Processing", "Checking the two most recent non-pinned posts. Pinned posts are completely ignored.", savedPost.url);
        await report({ currentTweet: profileUrl, notice: `Checking up to two recent posts for @${username}.` });
        const existingFirst = config.demo ? "" : await guardianProfileEngagement(posts[0]);
        const existing = config.demo ? "" : await guardianProfileEngagement(post);
        return { posts, selected: savedPost, existing: existingFirst ? { post: posts[0], reason: existingFirst } : existing ? { post: savedPost, reason: existing } : null };
      }
      if (posts.length < 2 && round < 4) {
        await smoothScrollBy(Math.min(320, Math.max(220, viewportHeight() * 0.35)), X.rand(650, 900));
        if (!await wait(X.rand(450, 700), token)) return { stopped: true, posts };
      }
    }
    return { posts, selected: posts[1] || null, existing: null };
  }

  function guardianPostRejection(post) {
    if (post.promoted && config.skipPromoted !== false) return "promoted post";
    if (post.reply) return "reply thread";
    if (config.onlyAuthors?.length && !config.onlyAuthors.includes(post.author)) return "author not in allow list";
    if (config.skipAuthors?.some(author => X.norm(author) === X.norm(post.author))) return "author in Authority Skip list";
    if (post.text.length < (Number(config.minTweetChars) || 0)) return "post text too short";
    return "";
  }

  async function guardianExistingEngagement(post, token) {
    const existing = await completedBefore(post);
    if (existing) return existing;
    if (!await wait(450, token)) return "automation stopped";
    return completedBefore(currentPost(post));
  }

  async function finishGuardianProfile(profileUrl, statusName, detail, postUrl = "", patch = {}) {
    acted.add(profileKey(profileUrl));
    guardianState = null;
    linkStatuses = {
      ...linkStatuses,
      [profileUrl]: { status: statusName, detail: String(detail || "").slice(0, 240), postUrl }
    };
    await report({ guardianState: null, linkStatuses, handled: [...acted], ...patch });
  }

  async function nextGuardianProfile(token) {
    if (!guardianState?.profileUrl) {
      const profileUrl = (config.profileLinks || []).find(url => profileUsername(url) && !acted.has(profileKey(url)));
      if (!profileUrl) return { done: true };
      const username = profileUsername(profileUrl);
      scanned++;
      const ledgerReason = await activityLedgerReason(username);
      if (ledgerReason) {
        skipped++;
        await finishGuardianProfile(profileUrl, "Already Completed", ledgerReason, "", { skipped, scanned, notice: ledgerReason });
        return { advanced: true };
      }
      guardianState = { profileUrl, username, phase: "profile", posts: [], checkIndex: 0, selectedPost: null };
      await setGuardianProfileStatus(profileUrl, "Processing", "Opening profile to locate only the second relevant non-pinned post.");
      await report({ guardianState, scanned, currentAuthor: `@${username}`, currentTweet: profileUrl, handled: [...acted], error: "" });
    }

    const { profileUrl, username } = guardianState;
    const ledgerReason = await activityLedgerReason(username);
    if (ledgerReason) {
      skipped++;
      await finishGuardianProfile(profileUrl, "Already Completed", ledgerReason, "", { skipped, notice: ledgerReason });
      return { advanced: true };
    }
    if (!["profile", "acting"].includes(guardianState.phase)) {
      guardianState = { ...guardianState, phase: "profile", posts: [], checkIndex: 0, selectedPost: null };
      await report({ guardianState, currentTweet: profileUrl, notice: `Returning to @${username}'s profile before checking posts.` });
    }
    if (guardianState.phase === "profile") {
      if (!onProfilePage(username)) {
        location.href = profileUrl;
        return { navigating: true };
      }
      await setGuardianProfileStatus(profileUrl, "Processing", "Locating only the second relevant post. Pinned posts are completely ignored.");
      const scan = await scanGuardianProfilePosts(username, profileUrl, token);
      if (!running || stopped || token !== runToken) return { navigating: true };
      if (scan.stopped) return { navigating: true };
      if (scan.existing) {
        skipped++;
        await recordExistingActivity(username, scan.existing.post, scan.existing.reason);
        await finishGuardianProfile(profileUrl, "Already Completed", `Second relevant post already has your engagement (${scan.existing.reason}).`, scan.existing.post.url, { skipped });
        return { advanced: true };
      }
      const selectedPost = scan.selected;
      if (!selectedPost) {
        skipped++;
        await finishGuardianProfile(profileUrl, "Skipped", "A second qualifying non-pinned post was not found on this profile.", "", { skipped });
        return { advanced: true };
      }
      guardianState = { ...guardianState, phase: "acting", selectedPost };
      await setGuardianProfileStatus(profileUrl, "Processing", "Second relevant post has no prior engagement. Opening it for the selected action.", selectedPost.url);
      await report({ guardianState, currentTweet: selectedPost.url, notice: `Opening the second relevant post to engage with @${username}.` });
      location.href = selectedPost.url;
      return { navigating: true };
    }

    const selected = guardianState.selectedPost;
    if (!selected) {
      skipped++;
      await finishGuardianProfile(profileUrl, "Failed", "Guardian could not select a post for engagement.", "", { skipped });
      return { advanced: true };
    }
    if (!location.pathname.includes(`/status/${selected.id}`)) {
      location.href = selected.url;
      return { navigating: true };
    }
    const post = await waitFor(() => timelinePosts().find(item => item.id === selected.id) || null, 15000);
    if (!post) {
      skipped++;
      await finishGuardianProfile(profileUrl, "Failed", "The selected post could not be read on X.", selected.url, { skipped });
      return { advanced: true };
    }
    await setGuardianProfileStatus(profileUrl, "Processing", "Selected post opened. Verifying its current state before performing the action.", selected.url);
    const existing = config.demo ? "" : await guardianExistingEngagement(post, token);
    if (!running || stopped || token !== runToken) return { navigating: true };
    if (existing) {
      skipped++;
      await recordExistingActivity(username, selected, existing);
      await finishGuardianProfile(profileUrl, "Already Completed", `Second relevant post already has your engagement (${existing}).`, selected.url, { skipped });
      return { advanced: true };
    }
    post.key = profileKey(profileUrl);
    return { post, profileUrl, username, selected };
  }

  async function skipOneTimelinePost() {
    for (const post of timelinePosts()) {
      if (!skipRemaining) return null;
      if (acted.has(post.key) || rejection(post)) continue;
      await smoothScrollToElement(post.article, 0.28);
      await X.sleep(X.rand(350, 650));
      acted.add(post.key);
      scanned++;
      skipped++;
      skipRemaining--;
      await smoothScrollBy(Math.min(300, Math.max(180, post.article.getBoundingClientRect().height * 0.35)), X.rand(850, 1250));
      return post;
    }
    return null;
  }

  // ---------- acting ----------

  async function like(post, token) {
    post = livePost(post);
    if (!post) return { ok: false, reason: "post is no longer visible" };
    if (alreadyLiked(post.article)) return { ok: true, already: true };
    const button = await waitFor(() => {
      post = livePost(post);
      if (!post) return null;
      const candidates = [...post.article.querySelectorAll(
        '[data-testid="like"], button[aria-label*="Like" i], [role="button"][aria-label*="Like" i]'
      )];
      return candidates.find(node => X.visible(node) && node.getAttribute("aria-pressed") !== "true" &&
        !/unlike/i.test(node.getAttribute("aria-label") || "")) || null;
    }, mobileTimeout(4000));
    if (!running || stopped || token !== runToken) return { ok: false, reason: "automation stopped" };
    post = livePost(post);
    if (!button) return post && alreadyLiked(post.article) ? { ok: true, already: true } : { ok: false, reason: "like button not found" };
    await smoothScrollToElement(button, 0.62);
    if (!await wait(250, token)) return { ok: false, reason: "automation stopped" };
    post = livePost(post);
    if (!post || !button.isConnected) return { ok: false, reason: "post changed before the Like button could be clicked" };
    if (!await X.activate(button)) return { ok: false, reason: "like button could not be activated" };
    const started = Date.now();
    while (Date.now() - started < mobileTimeout(5000)) {
      post = livePost(post);
      if (post && alreadyLiked(post.article)) return { ok: true };
      if (!await wait(150, token)) return { ok: false, reason: "automation stopped" };
    }
    return { ok: false, reason: "X did not register the like" };
  }

  // The Home timeline has its own "What is happening?!" box, and it also carries
  // data-testid="tweetTextarea_0". A document-wide lookup finds THAT one first, because the
  // reply modal lives in #layers at the end of the body. Every composer lookup here is
  // therefore scoped to the open dialog; anything unscoped talks to the wrong element.
  const topDialog = () => [...document.querySelectorAll('[role="dialog"]')].filter(X.visible).pop() || null;
  const mobileComposeRoute = () => /^\/compose\/(?:post|tweet)(?:\/|$)/.test(location.pathname);
  const submitTestIdSelector = '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]';
  const submitSelector = [
    submitTestIdSelector,
    'button[aria-label="Reply" i]',
    '[role="button"][aria-label="Reply" i]'
  ].join(",");

  const ownsReplyButton = node => {
    const dialog = node?.closest?.('[role="dialog"], [data-testid="sheetDialog"]');
    if (dialog && [...dialog.querySelectorAll(submitSelector)]
      .some(X.visible)) return true;
    let parent = node?.parentElement;
    for (let depth = 0; parent && depth < 24; depth++, parent = parent.parentElement) {
      if ([...parent.querySelectorAll(submitTestIdSelector)]
        .some(X.visible)) return true;
    }
    if (X.isMobile && node?.closest?.('#layers, [data-testid="sheetDialog"]')) {
      return [...document.querySelectorAll('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]')]
        .some(X.visible);
    }
    return false;
  };

  const replyComposers = () => {
    const raw = [...document.querySelectorAll([
      '[data-testid^="tweetTextarea_"]',
      '[data-testid^="tweetTextarea_"] [contenteditable="true"]',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"][aria-label*="reply" i]',
      '[role="textbox"][aria-label*="post your reply" i]',
      'textarea[placeholder*="reply" i]',
      'textarea[aria-label*="reply" i]'
    ].join(","))];
    const editors = raw.flatMap(node => {
      if (node.matches?.('textarea, input, [contenteditable="true"]')) return [node];
      const editable = node.querySelector?.('textarea, input, [contenteditable="true"]');
      return editable ? [editable] : [];
    });
    return [...new Set(editors)].filter(node => X.visible(node) && (
      mobileComposeRoute() || location.pathname.includes("/status/") || ownsReplyButton(node) ||
      (X.isMobile && !!node.closest('#layers, [role="dialog"], [data-testid="sheetDialog"]'))
    ));
  };

  const composer = () => replyComposers().pop() || null;

  function replySubmitFor(box) {
    if (!box?.isConnected) return null;
    const enabled = node => X.visible(node) && node.getAttribute("aria-disabled") !== "true" && !node.disabled;
    const dialog = box.closest('[role="dialog"], [data-testid="sheetDialog"], form');
    if (dialog) {
      const scoped = [...dialog.querySelectorAll(submitSelector)].filter(enabled).pop();
      if (scoped) return scoped;
    }
    let parent = box.parentElement;
    for (let depth = 0; parent && depth < 24; depth++, parent = parent.parentElement) {
      const found = [...parent.querySelectorAll(submitTestIdSelector)].filter(enabled).pop();
      if (found) return found;
    }
    if (X.isMobile) {
      const testIdSubmit = [...document.querySelectorAll('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]')]
        .filter(enabled).pop();
      if (testIdSubmit) return testIdSubmit;
      return [...document.querySelectorAll('button, [role="button"]')].filter(node => {
        if (!enabled(node) || node.closest('[data-testid="tweet"]')) return false;
        const label = `${node.getAttribute("aria-label") || ""} ${node.textContent || ""}`.trim();
        return /^(reply|post)$/i.test(label);
      }).pop() || null;
    }
    return null;
  }

  // Visibility matters here: X can leave an unmounted sheet in the DOM, and treating that as
  // "open" would spin dismissOverlays four times and then pause a healthy run.
  const draftSheetOpen = () =>
    [...document.querySelectorAll('[data-testid="confirmationSheetConfirm"]')].some(X.visible);

  async function waitFor(getter, timeout) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const found = getter();
      if (found) return found;
      await X.sleep(150);
    }
    return null;
  }

  // On X, "Discard" is the sheet's CANCEL slot and "Save" is confirmationSheetConfirm.
  // Clicking the confirm testid would file a draft instead of throwing the text away.
  function discardButton() {
    const sheet = topDialog();
    if (!sheet) return null;
    const buttons = [...sheet.querySelectorAll('button, [role="button"]')].filter(X.visible);
    return buttons.find(button => /^(discard|don.t save|delete)$/i.test((button.textContent || "").trim()))
      || buttons.find(button => button.getAttribute("data-testid") === "confirmationSheetCancel")
      || null;
  }

  const editableText = box => String(box && "value" in box ? box.value : box?.innerText || box?.textContent || "");
  const normalizedEditableText = box => editableText(box).replace(/\u200b/g, "").replace(/\r\n/g, "\n").trim();
  function editableInputEvent(box, type, inputType, data = null) {
    try {
      return box.dispatchEvent(new InputEvent(type, {
        bubbles: true,
        cancelable: type === "beforeinput",
        composed: true,
        inputType,
        data
      }));
    } catch {
      return box.dispatchEvent(new Event(type, { bubbles: true, cancelable: type === "beforeinput" }));
    }
  }
  function selectEditable(box) {
    if ("value" in box) { box.select?.(); return; }
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(box);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  function clearMobileEditable(box) {
    box.focus();
    selectEditable(box);
    editableInputEvent(box, "beforeinput", "deleteContentBackward");
    if ("value" in box) {
      const prototype = box instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(box, ""); else box.value = "";
    } else if (!document.execCommand("delete", false, null)) {
      box.replaceChildren();
    }
    editableInputEvent(box, "input", "deleteContentBackward");
  }

  function insertMobileEditable(box, text, strategy) {
    if ("value" in box) {
      const prototype = box instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(box, text); else box.value = text;
      editableInputEvent(box, "input", "insertText", text);
      box.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    selectEditable(box);
    editableInputEvent(box, "beforeinput", "insertText", text);
    let inserted = normalizedEditableText(box) === text.trim();
    if (strategy === 1) {
      try {
        const transfer = new DataTransfer();
        transfer.setData("text/plain", text);
        box.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
        inserted = normalizedEditableText(box) === text.trim();
      } catch {}
    }
    if (!inserted && strategy < 2) {
      try {
        inserted = document.execCommand("insertText", false, text);
        inserted = normalizedEditableText(box) === text.trim() || inserted;
      } catch {}
    }
    if (!inserted && strategy === 2) {
      try {
        const encoded = document.createElement("div");
        encoded.textContent = text;
        inserted = document.execCommand("insertHTML", false, encoded.innerHTML.replace(/\n/g, "<br>"));
        inserted = normalizedEditableText(box) === text.trim() || inserted;
      } catch {}
    }
    if (!inserted) {
      const selection = getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : document.createRange();
      range.selectNodeContents(box);
      range.deleteContents();
      const node = document.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    editableInputEvent(box, "input", "insertText", text);
    try { box.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: text })); } catch {}
    box.dispatchEvent(new Event("change", { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent("keyup", { key: "Unidentified", bubbles: true }));
  }

  async function typeIntoMobile(box, text) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!box?.isConnected) box = composer();
      if (!box?.isConnected) return false;
      try { box.click(); } catch {}
      try { box.focus({ preventScroll: true }); } catch { box.focus(); }
      clearMobileEditable(box);
      await X.sleep(attempt ? 350 : 250);
      if (!box.isConnected) box = composer();
      if (!box?.isConnected) return false;
      insertMobileEditable(box, text, attempt);
      await X.sleep(220);
      const accepted = await waitFor(() => {
        if (!box.isConnected || normalizedEditableText(box) !== text.trim()) return null;
        return replySubmitFor(box);
      }, mobileTimeout(1600));
      if (accepted) return true;
    }
    return false;
  }

  async function activateReplySubmit(button) {
    if (!X.isMobile) return X.activate(button);
    if (!X.visible(button)) return false;
    try { button.focus?.({ preventScroll: true }); } catch {}
    await X.sleep(220);
    if (!X.visible(button)) return false;
    try { button.click(); return true; } catch { return false; }
  }

  // Closing a composer that holds text makes X raise a "Save post?" sheet one or two frames
  // later. The old code queried for that sheet in the same synchronous tick, found nothing,
  // and left the dialog covering the page for the rest of the run.
  async function dismissOverlays() {
    for (let attempt = 0; attempt < 6; attempt++) {
      if (!composer() && !draftSheetOpen()) return true;
      const composeRoute = mobileComposeRoute();
      if (composer() && !topDialog() && !draftSheetOpen() && !composeRoute) return true;

      if (draftSheetOpen()) {
        const discard = discardButton();
        if (discard) await X.activate(discard);
        else {
          // Last resort: a saved draft is recoverable, a wedged page is not.
          const confirm = [...document.querySelectorAll('[data-testid="confirmationSheetConfirm"]')].find(X.visible);
          if (confirm) await X.activate(confirm);
          X.log("warn", "The draft sheet had no Discard button, so the draft was saved to unblock the page.");
        }
        await waitFor(() => !draftSheetOpen(), 3000);
        continue;
      }

      // Emptying the box first means X closes silently instead of raising "Save post?" at all.
      const box = composer();
      if (box && editableText(box).trim()) {
        if (X.isMobile || "value" in box) {
          clearMobileEditable(box);
        } else {
          box.focus();
          document.execCommand("selectAll", false, null);
          document.execCommand("delete", false, null);
        }
        await X.sleep(300);
      }

      const close = [...document.querySelectorAll('[data-testid="app-bar-close"]')].find(X.visible);
      if (close) await X.activate(close);
      else if (composeRoute && history.length > 1) history.back();
      else document.body.dispatchEvent(new KeyboardEvent("keydown",
        { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true }));
      await waitFor(() => draftSheetOpen() || !composer(), 2500);
    }
    return !composer() && !draftSheetOpen();
  }

  // X's composer is a DraftJS surface: execCommand writes into the document selection, and
  // some builds let both DraftJS and the browser apply the same insert, which doubles the text.
  // So always clear first, then read the box back and only accept an exact match.
  async function typeInto(box, text) {
    if (X.isMobile || "value" in box) return typeIntoMobile(box, text);
    for (let attempt = 0; attempt < 3; attempt++) {
      box.click();
      box.focus();
      await X.sleep(attempt ? 300 : 200);
      if ((box.innerText || "").trim()) {
        document.execCommand("selectAll", false, null);
        document.execCommand("delete", false, null);
        await X.sleep(200);
      }
      if (!document.execCommand("insertText", false, text)) continue;
      await X.sleep(450);
      const typed = (box.innerText || "").replace(/​/g, "").trim();
      if (typed === text.trim()) return true;
      // Wrong content (empty, duplicated, or partial): wipe it and try once more.
      document.execCommand("selectAll", false, null);
      document.execCommand("delete", false, null);
      await X.sleep(250);
    }
    return false;
  }

  async function comment(article, text, token) {
    if (!running || stopped || token !== runToken) return { ok: false, reason: "automation stopped" };
    let box = composer();
    if (!box) {
      const reply = await waitFor(() => [...article.querySelectorAll(
        '[data-testid="reply"], button[aria-label*="Reply" i], [role="button"][aria-label*="Reply" i]'
      )].find(X.visible) || [...document.querySelectorAll('[data-testid="reply"]')]
        .filter(X.visible).pop() || null, mobileTimeout(5000));
      if (!reply) return { ok: false, reason: "reply button not found" };
      await smoothScrollToElement(reply, 0.62);
      if (!await wait(250, token)) return { ok: false, reason: "automation stopped" };
      if (!await X.activate(reply)) return { ok: false, reason: "reply button could not be activated" };
      box = await waitFor(composer, mobileTimeout(5000));
    }
    if (!box) return { ok: false, reason: "the reply box did not open" };
    if (!running || stopped || token !== runToken) return { ok: false, reason: "automation stopped" };
    await report({ notice: "Reply box detected. Inserting the generated Reply..." });
    if (!await typeInto(box, text)) {
      await dismissOverlays();
      return { ok: false, reason: "the reply text could not be typed correctly" };
    }
    box = composer() || box;

    let submit = await waitFor(() => {
      return replySubmitFor(box);
    }, mobileTimeout(2500));
    if (!running || stopped || token !== runToken) return { ok: false, reason: "automation stopped" };
    if (!submit && X.isMobile && box.isConnected) {
      if (await typeIntoMobile(box, text)) {
        box = composer() || box;
        submit = await waitFor(() => replySubmitFor(box), mobileTimeout(1800));
      }
    }
    if (!submit) { await dismissOverlays(); return { ok: false, reason: "the Reply button never became active" }; }
    if (!await activateReplySubmit(submit)) { await dismissOverlays(); return { ok: false, reason: "the Reply button could not be activated" }; }

    // Success means THIS dialog's composer went away. Testing document-wide would never
    // succeed, because the Home timeline composer stays on the page the whole time.
    const sent = await waitFor(() => {
      if (!box.isConnected || !normalizedEditableText(box)) return true;
      const notice = [...document.querySelectorAll('[role="alert"], [data-testid="toast"]')]
        .map(node => node.innerText || "").join(" ");
      return /(?:reply|post).*(?:sent|posted)|sent.*(?:reply|post)/i.test(notice) || null;
    }, mobileTimeout(9000));
    if (!sent) {
      const failure = [...document.querySelectorAll('[role="alert"], [data-testid="toast"]')]
        .map(node => node.innerText || "").join(" ");
      await dismissOverlays();
      return { ok: false, reason: /limit|try again|wrong/i.test(failure) ? failure.slice(0, 80).trim() : "the reply was not posted" };
    }
    await dismissOverlays();
    return { ok: true };
  }

  async function commentText(post) {
    const request = X.request(
      { type: "ai:comment", tweet: { author: post.author, text: post.text } },
      X.isMobile ? 20000 : 45000
    );
    const response = X.isMobile
      ? await Promise.race([
          request,
          X.sleep(18000).then(() => ({ ok: false, error: "AI reply generation timed out on the mobile connection" }))
        ])
      : await request;
    if (response?.ok && response.text) return { text: response.text, source: response.provider || "AI" };

    const list = (config.fallbackComments || []).filter(Boolean);
    if (config.useFallback !== false && list.length) {
      X.log("warn", `AI reply failed (${response?.error || "unknown"}); using a saved fallback comment.`);
      return { text: list[X.rand(0, list.length - 1)], source: "fallback" };
    }
    return { error: response?.error || "no reply text was generated" };
  }

  function installManualReplyButton() {
    const openComposer = replyComposers().filter(node => !manualReplyBaseline.has(node)).pop() || null;
    const existing = document.getElementById("xfmManualReply");
    const existingClear = document.getElementById("xfmManualReplyClear");
    if (manualReplyOpen && manualReplyComposer && !manualReplyComposer.isConnected) {
      manualReplyOpen = false; manualReplyBaseline = new Set(); manualReplyComposer = null;
    }
    if (!manualReplyOpen || !openComposer) {
      existing?.remove();
      existingClear?.remove();
      document.getElementById("xfmManualReplyHost")?.remove();
      if (manualReplyOpen && !openComposer && [...manualReplyBaseline].some(node => !node.isConnected)) {
        manualReplyOpen = false; manualReplyBaseline = new Set();
      }
      return;
    }
    manualReplyComposer = openComposer;
    let host = document.getElementById("xfmManualReplyHost");
    if (!host) {
      host = document.createElement("div");
      host.id = "xfmManualReplyHost";
      host.style.cssText = "position:fixed;right:16px;bottom:88px;z-index:2147483647;display:flex;gap:8px;align-items:center;pointer-events:auto";
      document.body.appendChild(host);
    }
    if (existing && existing.parentElement === host && existingClear?.parentElement === host) return;
    existing?.remove(); existingClear?.remove();
    const button = document.createElement("button");
    button.id = "xfmManualReply";
    button.type = "button";
    button.textContent = "Generate & Reply";
    button.style.cssText = "position:static;flex:0 0 auto;padding:8px 12px;border:0;border-radius:999px;background:#1d9bf0;color:#fff;font:600 13px system-ui;line-height:1;cursor:pointer;box-sizing:border-box;box-shadow:0 2px 8px rgba(0,0,0,.25)";
    button.title = "Generate a reply for this Reply box";
    button.setAttribute("aria-label", "Generate reply");
    const clear = document.createElement("button");
    clear.id = "xfmManualReplyClear";
    clear.type = "button";
    clear.textContent = "Clear";
    clear.title = "Clear generated reply";
    clear.style.cssText = button.style.cssText.replace("#1d9bf0", "#536471");
    clear.addEventListener("click", () => { const box = manualReplyComposer || composer(); if (box) { typeInto(box, ""); box.focus?.({ preventScroll: true }); } });
    host.append(button, clear);
    button.addEventListener("click", async event => {
      if (!event.isTrusted) return;
      if (running) { button.textContent = "Automation running"; return; }
      const post = timelinePosts().find(item => !isReply(item.article)) || (() => {
        const article = [...document.querySelectorAll(tweetSelector)]
          .find(item => !isReply(item));
        if (!article) return null;
        const id = statusId(article);
        return { article, id, key: id || "manual", author: authorOf(article), text: textOf(article) };
      })();
      if (!post) { button.textContent = "Post not found"; return; }
      button.disabled = true;
      button.textContent = "Reading...";
      try {
        const draft = await commentText(post);
        if (draft.error) throw new Error(draft.error);
        let box = composer();
        if (!box) throw new Error("Reply box is no longer open.");
        if (!await typeInto(box, draft.text)) throw new Error("Generated text could not be inserted.");
        button.textContent = "Reply ready";
        setTimeout(() => { if (button.isConnected) { button.disabled = false; button.textContent = "Generate & Reply"; } }, 2500);
      } catch (error) {
        button.disabled = false;
        button.textContent = "Try again";
        X.log("warn", `Manual reply failed: ${error?.message || error}`);
      }
    });
  }

  async function openPost(post, token) {
    if (!post.id) return { error: "post link was not found" };
    const link = [...post.article.querySelectorAll(`a[href*="/status/${post.id}"]`)]
      .find(anchor => X.visible(anchor));
    if (!link) return { error: "post link was not visible" };
    await smoothScrollToElement(link, 0.45);
    if (!await wait(200, token)) return { error: "automation stopped" };
    if (!await X.activate(link)) return { error: "post link could not be activated" };
    const detail = await waitFor(() => {
      if (!location.pathname.includes(`/status/${post.id}`)) return null;
      return timelinePosts().find(item => item.id === post.id) || null;
    }, mobileTimeout(10000));
    if (!running || stopped || token !== runToken) return { error: "automation stopped" };
    if (!detail) return { error: "post detail did not open" };
    const text = textOf(detail.article);
    return { post: { ...detail, text: text || post.text } };
  }

  async function readPost(post, token, boundedToPost = false) {
    const words = post.text.trim().split(/\s+/).filter(Boolean).length;
    const readingMs = Math.min(4000, Math.max(500, Math.round(words / 8 * 1000)));
    if (boundedToPost) {
      const viewport = viewportHeight();
      const topOffset = Math.min(96, Math.max(56, viewport * 0.1));
      let rect = post.article.getBoundingClientRect();
      if (rect.top < topOffset - 16 || rect.top > topOffset + 80) {
        await smoothScrollBy(rect.top - topOffset, X.rand(550, 900));
      }
      const started = Date.now();
      for (let step = 0; step < 12; step++) {
        rect = post.article.getBoundingClientRect();
        const remaining = rect.bottom - (viewport - 32);
        if (remaining <= 0) break;
        if (!await wait(Math.min(650, Math.max(250, readingMs / 4)), token)) return null;
        await smoothScrollBy(Math.min(remaining, Math.max(160, viewport * 0.38)), X.rand(600, 950));
      }
      const remainingRead = Math.max(0, readingMs - (Date.now() - started));
      if (remainingRead && !await wait(remainingRead, token)) return null;
      return currentPost(post);
    }
    const rect = post.article.getBoundingClientRect();
    if (rect.top < 0 || rect.top > viewportHeight() * 0.55) {
      await smoothScrollToElement(post.article, 0.16);
    }
    if (!await wait(readingMs, token)) return null;
    return currentPost(post);
  }

  async function settleGuardianPost(post, token) {
    if (!guardianMode()) return true;
    post = currentPost(post);
    const rect = post.article.getBoundingClientRect();
    const belowViewport = Math.max(0, rect.bottom - (viewportHeight() - 36));
    if (belowViewport > 0) {
      await smoothScrollBy(Math.min(110, belowViewport), X.rand(450, 700));
      if (!await wait(250, token)) return false;
    }
    const lift = Math.min(64, Math.max(0, window.scrollY));
    if (lift > 0) {
      await smoothScrollBy(-lift, X.rand(420, 650));
      if (!await wait(250, token)) return false;
    }
    return true;
  }

  async function returnToTimeline() {
    if (X.isHomePage()) return;
    history.back();
    const home = await waitFor(() => X.isHomePage(), 10000);
    if (!home) location.href = "https://x.com/home";
    else await X.sleep(700);
  }

  async function handle(post, alreadyOpen = false, token = runToken) {
    const wantLike = config.actions === "like" || config.actions === "both";
    const wantComment = config.actions === "comment" || config.actions === "both";
    const result = { liked: false, commented: false, comment: "", source: "" };

    if (config.demo) {
      result.liked = wantLike;
      result.commented = wantComment;
      result.comment = wantComment ? "(demo: no reply was generated or posted)" : "";
      return { ok: true, ...result };
    }

    if (!alreadyOpen) {
      const opened = await openPost(post, token);
      if (opened.error) return { ok: false, reason: opened.error };
      post = opened.post;
    }

    try {
      let draftPromise = wantComment && !linkMode() ? commentText(post) : null;
      post = await readPost(post, token, linkMode() || guardianMode());
      if (!post || !running || stopped || token !== runToken) return { ok: false, reason: "automation stopped" };
      if (linkMode()) {
        const existing = await completedBefore(post);
        if (existing) return { ok: false, skip: true, reason: existing };
        if (wantComment) draftPromise = commentText(post);
      }

      if (wantLike) {
        post = livePost(post);
        if (!post) return { ok: false, reason: "post is no longer visible" };
        const outcome = await like(post, token);
        if (!outcome.ok) return { ok: false, reason: outcome.reason };
        if (outcome.already && !wantComment) return { ok: false, skip: true, reason: "Already liked on X" };
        result.liked = outcome.already !== true;
      }

      if (wantComment) {
        if (!running || stopped || token !== runToken) return { ok: false, reason: "automation stopped" };
        post = livePost(post);
        if (!post) return { ok: false, reason: "post is no longer visible" };
        const replyTarget = { id: post.id, key: post.key, url: post.url, author: post.author, text: post.text, article: post.article };
        await report({ notice: `Generating a Reply for @${replyTarget.author}...` });
        const draft = await draftPromise;
        if (draft.error) {
          if (!result.liked) return { ok: false, reason: draft.error };
          if (X.isMobile) return { ok: false, ...result, reason: `Like completed, but Reply text could not be generated: ${draft.error}` };
          await settleGuardianPost(post, token);
          return { ok: true, ...result, partial: `liked, but no reply was posted (${draft.error})` };
        }
        await report({ notice: `Reply generated via ${draft.source}. Opening the mobile composer for @${replyTarget.author}...` });
        let outcome = await comment(post.article, draft.text, token);
        if (!outcome.ok && X.isMobile && running && !stopped && token === runToken) {
          await report({ notice: `Retrying the mobile Reply composer for @${replyTarget.author}.` });
          await dismissOverlays();
          if (await wait(600, token)) {
            post = await waitFor(() => livePost(replyTarget), mobileTimeout(5000));
            if (post) outcome = await comment(post.article, draft.text, token);
            else outcome = { ok: false, reason: "the original post did not return after closing the mobile Reply composer" };
          }
        }
        if (!outcome.ok) {
          X.log("warn", `Reply to @${replyTarget.author} failed: ${outcome.reason}.`);
          if (!result.liked) return { ok: false, reason: outcome.reason };
          if (X.isMobile) return { ok: false, ...result, reason: `Like completed, but Reply failed: ${outcome.reason}` };
          if (post) await settleGuardianPost(post, token);
          return { ok: true, ...result, partial: `liked, but the reply failed (${outcome.reason})` };
        }
        result.commented = true;
        result.comment = draft.text;
        result.source = draft.source;
      }
      if (!await settleGuardianPost(post, token)) return { ok: false, reason: "automation stopped" };
      return { ok: true, ...result };
    } finally {
      if (!alreadyOpen) await returnToTimeline();
    }
  }

  async function handleWithRetry(post, alreadyOpen = false, token = runToken) {
    const retries = Math.max(0, Math.min(3, Number(config.retryCount ?? 0)));
    let outcome;
    for (let attempt = 0; attempt <= retries; attempt++) {
      outcome = await handle(post, alreadyOpen, token);
      if (outcome.ok || outcome.skip || attempt === retries || stopped) return outcome;
      await report({ notice: `Retrying @${post.author} after: ${outcome.reason}.` });
      if (!await wait(X.rand(700, 1300), token)) return { ok: false, reason: "automation stopped" };
      if (!alreadyOpen) post = currentPost(post);
    }
    return outcome;
  }

  // ---------- loop ----------

  async function wait(ms, token) {
    const until = Date.now() + ms;
    while (Date.now() < until && running && !stopped && token === runToken) {
      if (paused) { await X.sleep(200); continue; }
      await X.sleep(Math.min(250, Math.max(50, until - Date.now())));
    }
    return running && !stopped && token === runToken;
  }

  async function finish(patch) {
    running = false;
    guardianState = null;
    // Never hand the tab back with a modal or draft sheet still covering it.
    if (!config.demo) await dismissOverlays();
    await report({ currentTweet: "", currentAuthor: "", nextActionAt: null, guardianState: null, ...patch });
    if (config.reloadOnFinished === true) setTimeout(() => location.reload(), 800);
  }

  async function run(token) {
    if (!linkMode() && !guardianMode() && !X.isHomePage()) {
      const notice = "Opening the Home timeline...";
      await report({ status: status(), notice });
      location.href = "https://x.com/home";
      return;
    }
    let idleRounds = 0;
    while (running && !stopped && token === runToken) {
      if (paused) { await X.sleep(400); continue; }
      if (processed >= target()) {
        return finish({ status: "Completed", error: "",
          notice: guardianMode()
            ? `Finished all ${processed} ${config.source === "profiles" ? "Profile Link" : "Guardian"} profile(s): ${liked} liked, ${commented} replied.`
            : config.demo
              ? `Demo complete: ${processed} post(s) matched. Nothing was liked or posted.`
              : `Finished: ${liked} liked, ${commented} replied.` });
      }
      if (X.blockedOrLoggedOut()) {
        paused = true;
        await report({ status: "Paused", nextActionAt: null,
          error: "X is logged out, unavailable, or showing a security challenge. Resolve it, then press Resume." });
        continue;
      }

      // A leftover modal or draft sheet swallows every click behind it, so clear it before
      // touching the timeline again rather than failing silently on each following post.
      if (!config.demo && (composer() || draftSheetOpen())) {
        if (!await dismissOverlays()) {
          paused = true;
          await report({ status: "Paused", nextActionAt: null,
            error: "A dialog is open on X and could not be closed. Close it yourself, then press Resume." });
          continue;
        }
        await X.sleep(500);
      }

      if (skipRemaining) {
        const bypassed = await skipOneTimelinePost();
        if (bypassed) {
          skipIdleRounds = 0;
          await report({ skipped, scanned, skipRemaining, handled: [...acted],
            notice: `Passed @${bypassed.author} without liking or commenting.` });
          await X.sleep(X.rand(350, 700));
          continue;
        }
        if (skipRemaining) {
          skipIdleRounds++;
          if (skipIdleRounds >= 3) {
            skipRemaining = 0;
            skipIdleRounds = 0;
            await report({ skipRemaining, notice: "No additional qualifying posts were available to pass. Continuing the timeline scan." });
          } else {
            await smoothScrollBy(Math.min(320, viewportHeight() * 0.32), X.rand(1000, 1500));
            await X.sleep(X.rand(450, 900));
            continue;
          }
        }
      }

    if (guardianMode()) {
        const guardian = await nextGuardianProfile(token);
        if (guardian.navigating) return;
        if (guardian.advanced) continue;
        if (guardian.done) return finish({ status: "Completed", error: "", guardianState: null,
          notice: `Finished ${config.source === "profiles" ? "Profile Link" : "Guardian"} profiles: ${processed} completed, ${skipped} skipped or failed, ${liked} liked, ${commented} replied.` });

        const post = guardian.post;
        await report({ status: status(), currentAuthor: `@${guardian.username}`,
          currentTweet: guardian.selected.url, error: "" });
        const outcome = await handleWithRetry(post, true, token);
        if (!running || stopped || token !== runToken) break;
        if (!outcome.ok) {
          skipped++;
          await finishGuardianProfile(guardian.profileUrl, "Failed", outcome.reason, guardian.selected.url, { skipped });
        } else {
          processed++;
          if (outcome.liked) liked++;
          if (outcome.commented) commented++;
          if (!config.demo) await rememberCompleted(post, outcome);
          await recordActivityLedger(guardian.username, post, outcome);
          await finishGuardianProfile(
            guardian.profileUrl,
            config.demo ? "Skipped" : "Completed",
            config.demo ? "Demo: profile checked, no action taken." : "Profile completed with the selected Like/Comment action.",
            guardian.selected.url,
            { processed, liked, commented, lastComment: outcome.comment || "" }
          );
        }
        const remaining = (config.profileLinks || []).some(url => !acted.has(profileKey(url)));
        if (remaining) {
          const delay = nextDelay();
          nextActionAt = Date.now() + delay;
          await report({ nextActionAt, notice: `Next ${config.source === "profiles" ? "Profile Link" : "Guardian"} profile in about ${Math.round(delay / 1000)}s.` });
          if (!await wait(delay, token)) break;
          nextActionAt = null;
        }
        continue;
      }

      if (linkMode()) {
        const linked = await nextLinkedPost();
        if (linked.navigating) return;
        if (linked.done) return finish({ status: "Completed", error: "",
          notice: `Finished all ${(config.postLinks || []).length} linked post(s): ${processed} completed, ${skipped} skipped or failed, ${liked} liked, ${commented} replied.` });
        if (linked.error) {
          acted.add(`link:${linked.id}`);
          scanned++;
          skipped++;
          await setLinkStatus(linked.id, "Failed", linked.error);
          await report({ skipped, scanned, handled: [...acted],
            notice: `Skipped unreadable ${telegramGuardianMode() ? "Telegram Guardian link" : "Post Link"}: ${linked.error}` });
          await X.sleep(500);
          continue;
        }
        const post = linked.post;
        acted.add(post.key);
        scanned++;
        await setLinkStatus(post.id, "Processing", "Checking existing actions");
        await report({ status: status(), scanned, currentAuthor: "@" + post.author,
          currentTweet: post.text.slice(0, 120) || "(no text)", error: "" });
        const existing = config.demo ? "" : await completedBefore(post);
        if (existing) {
          skipped++;
          await recordExistingActivity(post.author, post, existing);
          await setLinkStatus(post.id, "Already Completed", existing);
          await report({ skipped, scanned, handled: [...acted], notice: `Skipped @${post.author}: ${existing}.` });
          continue;
        }
        const ledgerReason = await activityLedgerReason(post.author);
        if (ledgerReason) {
          skipped++;
          await setLinkStatus(post.id, "Already Completed", ledgerReason);
          await report({ skipped, scanned, handled: [...acted], notice: ledgerReason });
          continue;
        }
        await setLinkStatus(post.id, "Processing", "Reading post and performing actions");
        const outcome = await handleWithRetry(post, true, token);
        if (!outcome.ok) {
          skipped++;
          await setLinkStatus(post.id, outcome.skip ? "Skipped" : "Failed", outcome.reason);
          await report({ skipped, scanned, handled: [...acted], notice: `Skipped @${post.author}: ${outcome.reason}.` });
        } else {
          processed++;
          if (outcome.liked) liked++;
          if (outcome.commented) commented++;
          if (!config.demo) await rememberCompleted(post, outcome);
          await recordActivityLedger(post.author, post, outcome);
          await setLinkStatus(post.id, config.demo ? "Skipped" : "Completed",
            config.demo ? "Demo: no action taken" : "Like/comment completed");
          await report({ processed, liked, commented, scanned, handled: [...acted],
            lastComment: outcome.comment || "", notice: `@${post.author}: linked post processed.` });
        }
        const remaining = (config.postLinks || []).some(url => !acted.has(`link:${linkId(url)}`));
        if (remaining) {
          const delay = nextDelay();
          nextActionAt = Date.now() + delay;
          await report({ nextActionAt, notice: `Next linked post in about ${Math.round(delay / 1000)}s.` });
          if (!await wait(delay, token)) break;
          nextActionAt = null;
        }
        continue;
      }

      const post = nextPost();
      if (!post) {
        idleRounds++;
        if (idleRounds > 10) {
          return finish({ status: processed ? "Completed" : "Error", scanned,
            ...(processed
              ? { notice: `No more matching posts. ${liked} liked, ${commented} replied.` }
              : { error: "No matching posts were found in the timeline. Loosen the filters and try again." }) });
        }
        await smoothScrollBy(Math.min(340, viewportHeight() * 0.34), X.rand(1100, 1700));
        await X.sleep(X.rand(500, 900));
        continue;
      }

      idleRounds = 0;
      skipIdleRounds = 0;
      acted.add(post.key);
      await report({ status: status(), scanned, currentAuthor: "@" + post.author,
        currentTweet: post.text.slice(0, 120) || "(no text)", error: "" });

      const ledgerReason = await activityLedgerReason(post.author);
      if (ledgerReason) {
        skipped++;
        await report({ skipped, scanned, handled: [...acted], notice: ledgerReason });
        await X.sleep(500);
        continue;
      }

      const outcome = await handleWithRetry(post, false, token);
      if (!outcome.ok) {
        skipped++;
        if (outcome.skip) await recordExistingActivity(post.author, post, outcome.reason);
        await report({ skipped, scanned, handled: [...acted],
          notice: `Skipped @${post.author}: ${outcome.reason}.` });
        await X.sleep(1200);
        continue;
      }

      processed++;
      if (outcome.liked) liked++;
      if (outcome.commented) commented++;
      if (!config.demo) await rememberCompleted(post, outcome);
      await recordActivityLedger(post.author, post, outcome);
      skipRemaining = X.rand(1, 2);
      const summary = outcome.partial
        ? `@${post.author}: ${outcome.partial}.`
        : config.demo
          ? `Demo: @${post.author} would be ${config.actions === "like" ? "liked" : config.actions === "comment" ? "replied to" : "liked and replied to"}.`
          : `@${post.author}: ${outcome.commented ? `replied via ${outcome.source}` : "liked"}.`;
      await report({
        processed, liked, commented, scanned, handled: [...acted],
        lastComment: outcome.comment || "", notice: summary, skipRemaining
      });

      if (processed >= target()) continue;
      const delay = nextDelay();
      nextActionAt = Date.now() + delay;
      // Carry the outcome into the countdown notice; a bare countdown hides what just happened.
      await report({ nextActionAt, notice: `${summary} Next in about ${Math.round(delay / 1000)}s.` });
      if (!await wait(delay, token)) break;
      nextActionAt = null;
    }
    if (token !== runToken) return; // a newer loop owns the state now
    if (stopped) {
      if (!config.demo) await dismissOverlays();
      await report({ status: "Idle", currentTweet: "", currentAuthor: "", nextActionAt: null, notice: "" });
    }
  }

  // ---------- lifecycle ----------

  function apply(state) {
    config = { ...state };
    const raw = state.plan || {};
    const minMs = Math.max(1000, Number(raw.minMs) || 5000);
    const maxMs = Math.max(minMs, Number(raw.maxMs) || minMs);
    plan = { mode: raw.mode === "random" ? "random" : "fixed", minMs, maxMs };
    acted = new Set(state.handled || []);
    scanned = state.scanned || 0; processed = state.processed || 0;
    liked = state.liked || 0; commented = state.commented || 0; skipped = state.skipped || 0;
    skipRemaining = Math.max(0, Number(state.skipRemaining) || 0);
    skipIdleRounds = 0;
    linkStatuses = state.linkStatuses && typeof state.linkStatuses === "object" ? state.linkStatuses : {};
    guardianState = state.guardianState && typeof state.guardianState === "object" ? state.guardianState : null;
    nextActionAt = state.nextActionAt || null;
  }

  window.XFM.engage = {
    start(incoming) {
      apply({ ...incoming, handled: [], scanned: 0, processed: 0, liked: 0, commented: 0, skipped: 0,
        skipRemaining: 0, guardianState: null, linkStatuses: incoming.source === "links"
          ? Object.fromEntries((incoming.postLinks || []).map(url => [url, { status: "Pending", detail: "" }]))
          : incoming.source === "guardian"
            ? Object.fromEntries((incoming.profileLinks || []).map(url => [url, { status: "Pending", detail: "Waiting in Guardian profile queue." }]))
            : {} });
      running = true; paused = false; stopped = false;
      const token = ++runToken;
      report({ status: status(), scanned: 0, processed: 0, liked: 0, commented: 0, skipped: 0, skipRemaining: 0, linkStatuses, guardianState: null,
        target: target(), currentTweet: "", currentAuthor: "", lastComment: "", error: "", nextActionAt: null,
        notice: `Spacing: ${plan.mode === "random" ? `random ${Math.round(plan.minMs / 1000)}-${Math.round(plan.maxMs / 1000)}s` : `${Math.round(plan.minMs / 1000)}s`}.` });
      run(token);
    },
    pause() { paused = true; },
    resume() {
      if (running) { paused = false; return; }
      // running is set here, not in the callback: the await below is a gap where a second
      // resume (or the auto-resume in content.js) would otherwise start a duplicate loop.
      running = true; paused = false; stopped = false;
      const token = ++runToken;
      X.request({ type: "get-all" }, mobileTimeout(10000)).then(response => {
        if (token !== runToken) return;
        if (!response || response.error || !response.settings) { running = false; return; }
        apply({ ...response.settings.engage, ...response.engage, plan: response.engage.plan || response.plan });
        run(token);
      });
    },
    stop() { stopped = true; running = false; paused = false; runToken++; }
  };
  installManualReplyButton();
  setInterval(installManualReplyButton, 1200);
})();
