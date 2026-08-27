(() => {
  const GUARDIAN_VERSION = "2026-08-18-2";
  if (window.__xfmGuardian === GUARDIAN_VERSION) return;
  window.__xfmGuardian = GUARDIAN_VERSION;
  document.querySelectorAll('#xfmGuardianRoot, [aria-label="Guardian compact popup"]').forEach(node => node.remove());

  const normalizedHost = location.hostname.toLowerCase().replace(/^(?:www|mobile|m)\./, "");
  const isTelegramPage = normalizedHost === "t.me" || normalizedHost === "telegram.me" || normalizedHost === "web.telegram.org";
  const isMobileDevice = navigator.userAgentData?.mobile === true ||
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "") ||
    Math.min(screen.width || innerWidth, screen.height || innerHeight) <= 700 ||
    (navigator.maxTouchPoints > 1 && (
      globalThis.matchMedia?.("(pointer: coarse)")?.matches || Math.min(innerWidth, innerHeight) <= 900
    ));
  const viewportSize = () => ({
    width: Math.max(1, Math.round(window.visualViewport?.width || window.innerWidth)),
    height: Math.max(1, Math.round(window.visualViewport?.height || window.innerHeight))
  });
  const state = { mode: isTelegramPage ? "TG" : "X", data: {}, dragging: false, scanToken: 0 };

  const root = document.createElement("div");
  root.id = "xfmGuardianRoot";
  root.setAttribute("aria-label", "Guardian popup");
  root.style.cssText = [
    "position:fixed",
    "right:8px",
    "bottom:8px",
    "z-index:2147483647",
    "display:flex",
    "flex-direction:column",
    "gap:var(--xfm-gap)",
    "padding:var(--xfm-padding)",
    "width:318px",
    "max-width:calc(100vw - 12px)",
    "max-height:430px",
    "min-height:0",
    "--xfm-gap:6px",
    "--xfm-padding:9px",
    "--xfm-button-padding:5px 7px",
    "--xfm-control-padding:6px 7px",
    "--xfm-control-font:10px",
    "--xfm-title-font:12px",
    "--xfm-logo-size:26px",
    "--xfm-queue-height:132px",
    "box-sizing:border-box",
    "overflow:hidden",
    "border:1px solid rgba(148,163,184,0.35)",
    "border-radius:8px",
    "background:rgba(15,23,42,0.94)",
    "backdrop-filter:blur(10px)",
    "box-shadow:0 10px 30px rgba(0,0,0,0.45)",
    "font:11px/1.3 Arial,Segoe UI,sans-serif",
    "color:#e5eefb"
  ].join(";");

  const compactMetrics = () => {
    const viewport = viewportSize();
    const mobile = isMobileDevice || viewport.width <= 600;
    return {
      mobile,
      viewport,
      width: mobile ? Math.min(272, Math.max(220, Math.round(viewport.width * 0.68))) : 318,
      maxHeight: mobile ? Math.min(340, Math.max(210, Math.floor(viewport.height * 0.44))) : Math.min(430, Math.max(280, viewport.height - 16)),
      offset: mobile ? 6 : 8
    };
  };
  const applyCompactLayout = () => {
    const metrics = compactMetrics();
    root.style.width = `${metrics.width}px`;
    root.style.maxHeight = `${metrics.maxHeight}px`;
    root.style.setProperty("--xfm-gap", metrics.mobile ? "4px" : "6px");
    root.style.setProperty("--xfm-padding", metrics.mobile ? "6px" : "9px");
    root.style.setProperty("--xfm-button-padding", metrics.mobile ? "4px 5px" : "5px 7px");
    root.style.setProperty("--xfm-control-padding", metrics.mobile ? "5px 6px" : "6px 7px");
    root.style.setProperty("--xfm-control-font", metrics.mobile ? "9px" : "10px");
    root.style.setProperty("--xfm-title-font", metrics.mobile ? "11px" : "12px");
    root.style.setProperty("--xfm-logo-size", metrics.mobile ? "22px" : "26px");
    root.style.setProperty("--xfm-queue-height", metrics.mobile ? "92px" : "132px");
    if (root.style.right !== "auto") {
      root.style.right = `${metrics.offset}px`;
      root.style.bottom = `${metrics.offset}px`;
    }
  };
  applyCompactLayout();

  const makeButton = (label, active = false, compact = false) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.style.cssText = [
      "border:1px solid rgba(148,163,184,0.42)",
      "border-radius:6px",
      "padding:" + (compact ? "var(--xfm-button-padding)" : "7px 10px"),
      "cursor:pointer",
      "background:" + (active ? "#1d9bf0" : "rgba(30,41,59,0.85)"),
      "color:#f8fbff",
      "font-weight:600",
      "font-size:var(--xfm-control-font)",
      "line-height:1",
      "touch-action:manipulation",
      "transition:background 0.15s ease, transform 0.15s ease",
      "white-space:nowrap"
    ].join(";");
    button.onmouseenter = () => { if (!button.disabled) button.style.transform = "translateY(-1px)"; };
    button.onmouseleave = () => { button.style.transform = "none"; };
    button.onpointerdown = () => { if (!button.disabled) button.style.transform = "scale(.98)"; };
    button.onpointerup = () => { if (!button.disabled) button.style.transform = "translateY(-1px)"; };
    return button;
  };

  const linkInput = document.createElement("input");
  linkInput.type = "url";
  linkInput.placeholder = isTelegramPage ? "https://t.me/channel" : "https://x.com/user/status/123";
  linkInput.style.cssText = [
    "width:100%",
    "box-sizing:border-box",
    "border:1px solid rgba(148,163,184,0.35)",
    "border-radius:6px",
    "padding:var(--xfm-control-padding)",
    "background:rgba(15,23,42,0.7)",
    "color:#e5eefb",
    "outline:none",
    "font-size:var(--xfm-control-font)",
    "touch-action:manipulation"
  ].join(";");

  const rowTop = document.createElement("div");
  rowTop.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:var(--xfm-gap);cursor:move;user-select:none;touch-action:none";
  rowTop.title = "Drag to move Guardian";

  const sourceGroup = document.createElement("div");
  sourceGroup.style.cssText = "display:flex;gap:var(--xfm-gap);align-items:center;flex:1;min-width:0";

  const guardianBrand = document.createElement("div");
  guardianBrand.style.cssText = "display:flex;align-items:center;gap:5px;margin-right:auto;min-width:0";
  const guardianLogo = document.createElement("img");
  guardianLogo.src = chrome.runtime.getURL("logo.png");
  guardianLogo.alt = "Smart AutoBot";
  guardianLogo.style.cssText = "display:block;width:var(--xfm-logo-size);height:var(--xfm-logo-size);flex:0 0 var(--xfm-logo-size);object-fit:contain;border-radius:5px";
  const guardianTitle = document.createElement("strong");
  guardianTitle.textContent = "Guardian";
  guardianTitle.style.cssText = "font-size:var(--xfm-title-font);color:#f8fbff;white-space:nowrap";
  guardianBrand.append(guardianLogo, guardianTitle);

  const progressBody = document.createElement("div");
  progressBody.style.cssText = "display:grid;flex:1 1 auto;gap:var(--xfm-gap);min-height:0;overflow:auto;padding-right:2px;scrollbar-width:thin";

  const xButton = makeButton("X", state.mode === "X", true);
  const tgButton = makeButton("TG", state.mode === "TG", true);
  const closeButton = makeButton("X", false, true);
  closeButton.title = "Close Guardian";
  closeButton.style.minWidth = "22px";

  xButton.disabled = isTelegramPage;
  tgButton.disabled = !isTelegramPage;
  xButton.title = isTelegramPage ? "Open Guardian on X to use X mode" : "X Guardian";
  tgButton.title = isTelegramPage ? "Telegram Guardian" : "Open Guardian on Telegram to use TG mode";
  if (xButton.disabled) xButton.style.opacity = "0.45";
  if (tgButton.disabled) tgButton.style.opacity = "0.45";

  xButton.onclick = () => {
    state.mode = "X";
    xButton.style.background = "#1d9bf0";
    tgButton.style.background = "rgba(30,41,59,0.85)";
    linkInput.placeholder = "https://x.com/user/status/123";
    queueTitle.textContent = "X profile queue";
    linkInput.value = state.data?.xLink || (location.href.includes("/status/") ? location.href : "");
    renderProgress(state.data);
  };

  tgButton.onclick = () => {
    state.mode = "TG";
    tgButton.style.background = "#1d9bf0";
    xButton.style.background = "rgba(30,41,59,0.85)";
    linkInput.placeholder = "https://t.me/channel";
    queueTitle.textContent = "Telegram link queue";
    linkInput.value = state.data?.telegramLink || telegramSource(location.href)?.url || "";
    renderProgress(state.data);
  };

  const applyPosition = position => {
    if (state.dragging) return;
    const left = Number(position?.left), top = Number(position?.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) {
      const metrics = compactMetrics();
      root.style.left = "auto";
      root.style.top = "auto";
      root.style.right = `${metrics.offset}px`;
      root.style.bottom = `${metrics.offset}px`;
      return;
    }
    const metrics = compactMetrics();
    const width = root.offsetWidth || metrics.width;
    const height = root.offsetHeight || metrics.maxHeight;
    root.style.left = `${Math.min(Math.max(0, left), Math.max(0, metrics.viewport.width - width))}px`;
    root.style.top = `${Math.min(Math.max(0, top), Math.max(0, metrics.viewport.height - height))}px`;
    root.style.right = "auto";
    root.style.bottom = "auto";
  };

  const showWindow = () => {
    root.style.display = "flex";
    requestAnimationFrame(() => applyPosition(state.data?.popupPosition));
  };

  const hideWindow = () => { root.style.display = "none"; };

  closeButton.onclick = () => {
    hideWindow();
    sendGuardianMessage({ type: "guardian:hide" });
  };

  sourceGroup.append(guardianBrand, xButton, tgButton);
  rowTop.append(sourceGroup, closeButton);

  const controlsRow = document.createElement("div");
  controlsRow.style.cssText = "display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;align-items:center";

  const linkButton = makeButton("Link", false, true);
  const startButton = makeButton("Start", true, true);
  const stopButton = makeButton("Stop", false, true);
  linkButton.style.flex = "0 0 auto";
  startButton.style.flex = "0 0 auto";
  stopButton.style.flex = "0 0 auto";
  linkButton.style.width = startButton.style.width = stopButton.style.width = "100%";

  const statsGrid = document.createElement("div");
  statsGrid.style.cssText = "display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;overflow:hidden;border:1px solid rgba(148,163,184,0.28);border-radius:6px;background:rgba(148,163,184,0.22)";
  const statNodes = {};
  for (const label of ["Total", "Pending", "Processing", "Completed", "Skipped", "Failed"]) {
    const cell = document.createElement("div");
    cell.style.cssText = "min-width:0;padding:5px 3px;background:rgba(15,23,42,0.96);text-align:center";
    const value = document.createElement("strong");
    value.textContent = "0";
    value.style.cssText = "display:block;font-size:12px;color:#f8fbff";
    const caption = document.createElement("span");
    caption.textContent = label;
    caption.style.cssText = "display:block;margin-top:1px;font-size:8px;color:#94a3b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
    cell.append(value, caption);
    statsGrid.append(cell);
    statNodes[label] = value;
  }

  const currentPanel = document.createElement("section");
  currentPanel.style.cssText = "display:grid;gap:3px;padding:5px 0;border-top:1px solid rgba(148,163,184,0.25);border-bottom:1px solid rgba(148,163,184,0.25)";
  const currentTitle = document.createElement("strong");
  currentTitle.textContent = "Current processing";
  currentTitle.style.cssText = "font-size:10px;color:#f8fbff";
  currentPanel.append(currentTitle);
  const currentValues = {};
  const addCurrentRow = (label, key, link = false) => {
    const row = document.createElement("div");
    row.style.cssText = "display:grid;grid-template-columns:64px minmax(0,1fr);gap:5px;align-items:start;min-width:0";
    const name = document.createElement("span");
    name.textContent = label;
    name.style.cssText = "color:#94a3b8;font-size:10px";
    const value = document.createElement(link ? "a" : "span");
    value.textContent = "-";
    value.style.cssText = "min-width:0;color:#e5eefb;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    if (link) { value.target = "_blank"; value.rel = "noopener"; value.style.color = "#38bdf8"; }
    row.append(name, value);
    currentPanel.append(row);
    currentValues[key] = value;
  };
  addCurrentRow("Queue number", "number");
  addCurrentRow("Status", "status");
  addCurrentRow("Profile", "profile");
  addCurrentRow("Profile / Post", "link", true);
  addCurrentRow("Details", "detail");
  currentValues.detail.style.whiteSpace = "normal";
  currentValues.detail.style.overflowWrap = "anywhere";

  const queueSection = document.createElement("section");
  queueSection.style.cssText = "display:grid;gap:4px;min-height:0;overflow:hidden";
  const queueTitle = document.createElement("strong");
  queueTitle.textContent = "Guardian queue";
  queueTitle.style.cssText = "font-size:10px;color:#f8fbff";
  const queueList = document.createElement("div");
  queueList.style.cssText = "display:grid;gap:4px;max-height:var(--xfm-queue-height);overflow:auto;padding-right:2px;scrollbar-width:thin";
  queueSection.append(queueTitle, queueList);

  let contextWarningShown = false;
  const sendGuardianMessage = message => new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      const runtime = globalThis.chrome?.runtime;
      if (!runtime?.id) throw new Error("Extension context invalidated.");
      const pending = runtime.sendMessage(message, response => {
        const failure = runtime.lastError;
        if (failure) finish({ ok: false, error: failure.message });
        else finish(response || { ok: true });
      });
      if (pending?.then) pending.then(response => finish(response || { ok: true })).catch(error => finish({ ok: false, error: error?.message || String(error) }));
    } catch (error) {
      const text = error?.message || String(error);
      const contextInvalid = /extension context invalidated/i.test(text) || !globalThis.chrome?.runtime?.id;
      if (!contextInvalid) {
        try {
          const retry = globalThis.chrome.runtime.sendMessage(message);
          if (retry?.then) {
            retry.then(response => finish(response || { ok: true })).catch(retryError => finish({ ok: false, error: retryError?.message || String(retryError) }));
          } else {
            finish(retry || { ok: true });
          }
          return;
        } catch {}
      }
      if (contextInvalid) {
        linkButton.disabled = true;
        startButton.disabled = true;
        stopButton.disabled = true;
        if (!contextWarningShown) {
          contextWarningShown = true;
          window.alert("The extension was reloaded. Refresh this page to reconnect Guardian.");
        }
      }
      finish({ ok: false, error: contextInvalid ? "Refresh this page to reconnect Guardian." : text, contextInvalid });
    }
  }).then(result => {
    if (result?.ok !== false || result.contextInvalid) return result;
    const contextInvalid = /extension context invalidated/i.test(result.error || "") || !globalThis.chrome?.runtime?.id;
    if (!contextInvalid) return result;
    linkButton.disabled = true;
    startButton.disabled = true;
    stopButton.disabled = true;
    if (!contextWarningShown) {
      contextWarningShown = true;
      window.alert("The extension was reloaded. Refresh this page to reconnect Guardian.");
    }
    return { ...result, error: "Refresh this page to reconnect Guardian.", contextInvalid: true };
  });

  const showMessageFailure = (result, fallback) => {
    if (result?.ok !== false) return false;
    if (!result.contextInvalid) window.alert(result.error || fallback);
    return true;
  };

  let drag = null;
  rowTop.addEventListener("pointerdown", event => {
    if (event.button !== 0 || event.target.closest("button")) return;
    const rect = root.getBoundingClientRect();
    drag = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
    state.dragging = true;
    root.style.left = `${rect.left}px`;
    root.style.top = `${rect.top}px`;
    root.style.right = "auto";
    root.style.bottom = "auto";
    rowTop.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  rowTop.addEventListener("pointermove", event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const viewport = viewportSize();
    const maxLeft = Math.max(0, viewport.width - root.offsetWidth);
    const maxTop = Math.max(0, viewport.height - root.offsetHeight);
    root.style.left = `${Math.min(Math.max(0, event.clientX - drag.offsetX), maxLeft)}px`;
    root.style.top = `${Math.min(Math.max(0, event.clientY - drag.offsetY), maxTop)}px`;
  });

  const finishDrag = event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (rowTop.hasPointerCapture(event.pointerId)) rowTop.releasePointerCapture(event.pointerId);
    drag = null;
    state.dragging = false;
    const position = { left: parseFloat(root.style.left) || 0, top: parseFloat(root.style.top) || 0 };
    state.data = { ...(state.data || {}), popupPosition: position };
    sendGuardianMessage({ type: "guardian:position", position });
  };
  rowTop.addEventListener("pointerup", finishDrag);
  rowTop.addEventListener("pointercancel", finishDrag);
  const refreshViewport = () => {
    applyCompactLayout();
    applyPosition(state.data?.popupPosition);
  };
  window.addEventListener("resize", refreshViewport);
  window.visualViewport?.addEventListener("resize", refreshViewport);
  window.visualViewport?.addEventListener("scroll", refreshViewport);

  const normalizeXStatusLink = value => {
    const text = String(value || "").trim();
    if (!text) return "";
    try {
      const url = new URL(text.startsWith("http") ? text : `https://${text}`);
      const host = (url.hostname || "").replace(/^(?:www|mobile|m)\./, "").toLowerCase();
      if (!["x.com", "twitter.com"].includes(host)) return "";
      const match = /^\/([^/]+)\/status\/(\d+)/.exec(url.pathname);
      return match ? `https://x.com/${match[1]}/status/${match[2]}` : "";
    } catch {
      return "";
    }
  };

  const normalizeWebLink = (value, base = location.href) => {
    try {
      const url = new URL(String(value || "").trim(), base);
      if (!["http:", "https:"].includes(url.protocol)) return "";
      url.hash = "";
      url.hostname = url.hostname.toLowerCase().replace(/^(?:www|mobile|m)\./, "").replace(/^telegram\.me$/, "t.me");
      if (["x.com", "twitter.com"].includes(url.hostname) && /\/status\/\d+/.test(url.pathname)) return normalizeXStatusLink(url.href);
      if (url.hostname === "t.me") {
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts[0]?.toLowerCase() === "s") parts.shift();
        url.pathname = `/${parts.join("/")}`;
      }
      return url.href;
    } catch { return ""; }
  };

  const telegramSource = value => {
    try {
      const raw = String(value || "").trim();
      const deep = /^tg:\/\/resolve\?/i.test(raw) ? new URL(raw) : null;
      if (deep) {
        const channel = deep.searchParams.get("domain") || "";
        const messageId = Number(deep.searchParams.get("post")) || 0;
        return channel ? { channel, messageId, url: `https://t.me/${channel}${messageId ? `/${messageId}` : ""}` } : null;
      }
      const url = new URL(raw, "https://t.me/");
      const host = url.hostname.toLowerCase().replace(/^(?:www|mobile|m)\./, "");
      if (!["t.me", "telegram.me"].includes(host)) return null;
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0]?.toLowerCase() === "s") parts.shift();
      if (!parts[0]) return null;
      if (parts[0].toLowerCase() === "c" && parts[1]) {
        const messageId = Number(parts.at(-1)) || 0;
        return { channel: `c/${parts[1]}`, messageId, url: `https://t.me/${parts.join("/")}`, private: true };
      }
      return { channel: parts[0], messageId: Number(parts[1]) || 0, url: `https://t.me/${parts.join("/")}` };
    } catch { return null; }
  };

  const telegramUiLink = (value, channel, messageId) => {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase().replace(/^(?:www|mobile|m)\./, "");
      if (!["t.me", "telegram.me"].includes(host)) return false;
      const parts = url.pathname.split("/").filter(Boolean);
      if (!parts.length || parts[0].toLowerCase() === "share") return true;
      if (parts[0].toLowerCase() === String(channel || "").toLowerCase()) {
        if (parts.length === 1) return true;
        if (messageId && Number(parts[1]) === Number(messageId)) return true;
      }
      return false;
    } catch { return true; }
  };

  async function collectTelegramLinksBelow(sourceValue, scanToken) {
    const source = telegramSource(sourceValue);
    if (!source || !isTelegramPage) return [];
    const sourceKey = `${source.channel}/${source.messageId}`;
    let sourceNode = source.messageId
      ? document.querySelector(`.tgme_widget_message[data-post="${CSS.escape(sourceKey)}"], [data-post="${CSS.escape(sourceKey)}"]`) ||
        document.querySelector(`[data-message-id="${CSS.escape(String(source.messageId))}"], [data-mid="${CSS.escape(String(source.messageId))}"], #message${CSS.escape(String(source.messageId))}`) ||
        [...document.querySelectorAll('a[href*="t.me/"], a[href*="telegram.me/"]')]
          .find(anchor => telegramSource(anchor.href)?.channel.toLowerCase() === source.channel.toLowerCase() && telegramSource(anchor.href)?.messageId === source.messageId)?.closest('[data-post], .Message, .message, [class*="message"]')
      : null;
    const messageSelector = '.tgme_widget_message, [data-post], [data-message-id], [data-mid], .Message, .message, [class*="message"]';
    sourceNode = sourceNode?.closest?.(messageSelector) || sourceNode;
    sourceNode?.scrollIntoView({ block: "start", inline: "nearest" });
    await new Promise(resolve => setTimeout(resolve, 700));

    if (scanToken !== state.scanToken) return [];
    const seen = new Set();
    const collected = [];
    let unchanged = 0;
    let previousMessageCount = 0;
    let previousLinkCount = 0;
    for (let round = 0; round < 160 && unchanged < 10; round++) {
      if (scanToken !== state.scanToken) return [];
      const messages = [...new Set([...document.querySelectorAll(messageSelector)].map(node => node.closest(messageSelector) || node))];
      const startIndex = sourceNode ? messages.indexOf(sourceNode) : -1;
      const candidates = startIndex >= 0 ? messages.slice(startIndex) : messages.filter(node => {
        const rect = node.getBoundingClientRect();
        return rect.bottom >= 0;
      });
      for (const message of candidates) {
        for (const anchor of message.querySelectorAll("a[href]")) {
          const link = normalizeXStatusLink(anchor.href);
          if (!link || seen.has(link)) continue;
          seen.add(link);
          collected.push(link);
        }
      }
      const changed = messages.length !== previousMessageCount || collected.length !== previousLinkCount;
      unchanged = changed ? 0 : unchanged + 1;
      previousMessageCount = messages.length;
      previousLinkCount = collected.length;
      if (scanToken !== state.scanToken) return [];
      window.scrollBy({ top: Math.max(480, Math.floor((window.visualViewport?.height || window.innerHeight) * 0.82)), left: 0, behavior: "smooth" });
      await new Promise(resolve => setTimeout(resolve, isMobileDevice ? 1100 : 850));
    }
    return collected;
  }

  const normalizeStatus = value => {
    const status = String(value || "").trim();
    if (!status || status === "Ready") return "Pending";
    if (status === "Already Completed") return "Completed";
    if (["Scanning", "Reviewing"].includes(status)) return "Processing";
    return status;
  };

  const statusColor = status => ({
    Pending: "#facc15", Processing: "#38bdf8", Completed: "#34d399", Skipped: "#cbd5e1", Failed: "#fb7185"
  })[status] || "#cbd5e1";

  const profileFromCandidate = candidate => {
    if (candidate?.profile) return candidate.profile;
    const match = /^https:\/\/x\.com\/([^/]+)\//i.exec(candidate?.postUrl || "");
    return match && match[1].toLowerCase() !== "i" ? match[1] : "";
  };

  const sectionState = data => state.mode === "TG"
    ? {
        candidates: Array.isArray(data?.telegramCandidates) ? data.telegramCandidates : [],
        status: data?.telegramStatus || "Idle",
        currentIndex: data?.telegramCurrentIndex,
        currentProfile: "",
        currentLink: data?.telegramCurrentLink || "",
        processingDetail: data?.telegramProcessingDetail || data?.telegramError || ""
      }
    : {
        candidates: Array.isArray(data?.candidates) ? data.candidates : [],
        status: data?.xStatus || data?.status || "Idle",
        currentIndex: data?.currentIndex,
        currentProfile: data?.currentProfile || "",
        currentLink: data?.currentLink || "",
        processingDetail: data?.processingDetail || data?.error || ""
      };

  const renderProgress = nextState => {
    state.data = nextState || {};
    const view = sectionState(state.data);
    const candidates = view.candidates;
    const counts = { Pending: 0, Processing: 0, Completed: 0, Skipped: 0, Failed: 0 };
    for (const candidate of candidates) {
      const status = normalizeStatus(candidate.status);
      if (status in counts) counts[status]++;
    }
    statNodes.Total.textContent = String(candidates.length);
    for (const key of Object.keys(counts)) statNodes[key].textContent = String(counts[key]);

    const declaredIndex = Number.isInteger(view.currentIndex) ? view.currentIndex : -1;
    const processingIndex = candidates.findIndex(item => normalizeStatus(item.status) === "Processing");
    const candidateIndex = declaredIndex >= 0 && declaredIndex < candidates.length ? declaredIndex : processingIndex;
    const currentIndex = declaredIndex >= 0 && (view.currentLink || view.currentProfile) ? declaredIndex : candidateIndex;
    const current = candidateIndex >= 0 && candidateIndex < candidates.length ? candidates[candidateIndex] : null;
    const currentLink = view.currentLink || current?.postUrl || current?.profileUrl || "";
    const currentProfile = state.mode === "TG" ? "" : view.currentProfile || profileFromCandidate(current);
    const currentStatus = current ? normalizeStatus(current.status) : normalizeStatus(view.status);
    currentValues.number.textContent = currentIndex >= 0 ? (currentIndex < candidates.length ? `#${currentIndex + 1} of ${candidates.length}` : `#${currentIndex + 1}`) : "-";
    currentValues.status.textContent = currentLink || currentProfile ? currentStatus : "-";
    currentValues.status.style.color = statusColor(currentStatus);
    currentValues.profile.textContent = currentProfile ? `@${currentProfile.replace(/^@/, "")}` : "-";
    currentValues.link.textContent = currentLink || "-";
    currentValues.link.href = currentLink || "#";
    currentValues.link.style.pointerEvents = currentLink ? "auto" : "none";
    currentValues.detail.textContent = view.processingDetail || current?.detail || "-";
    currentValues.detail.title = currentValues.detail.textContent;

    queueList.replaceChildren();
    if (!candidates.length) {
      const empty = document.createElement("p");
      empty.textContent = "No links collected yet.";
      empty.style.cssText = "margin:0;padding:6px 0;color:#94a3b8;text-align:center;font-size:9px";
      queueList.append(empty);
      return;
    }
    candidates.forEach((candidate, index) => {
      const status = normalizeStatus(candidate.status);
      const details = document.createElement("details");
      details.style.cssText = "padding:5px;border:1px solid rgba(148,163,184,0.25);border-radius:5px;background:rgba(15,23,42,0.72);min-width:0";
      if (status === "Processing") details.open = true;
      const summary = document.createElement("summary");
      summary.style.cssText = "cursor:pointer;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px;align-items:center;min-width:0";
      const label = document.createElement("span");
      const profile = state.mode === "TG" ? "" : profileFromCandidate(candidate);
      label.textContent = `#${candidate.serial || index + 1} ${profile ? `@${profile}` : "Link"}`;
      label.style.cssText = "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:9px;font-weight:700;color:#e5eefb";
      const badge = document.createElement("span");
      badge.textContent = status;
      badge.style.cssText = `font-size:8px;font-weight:700;color:${statusColor(status)};white-space:nowrap`;
      summary.append(label, badge);
      const body = document.createElement("div");
      body.style.cssText = "display:grid;gap:3px;padding-top:4px;color:#94a3b8;font-size:9px;min-width:0";
      const link = document.createElement("a");
      const targetUrl = candidate.postUrl || candidate.profileUrl || candidate.sourceLink || "";
      link.href = targetUrl || "#";
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = targetUrl || "No profile or post link";
      link.style.cssText = `color:#38bdf8;overflow-wrap:anywhere;pointer-events:${targetUrl ? "auto" : "none"}`;
      const detail = document.createElement("span");
      detail.textContent = candidate.detail || "No additional processing details.";
      const source = document.createElement("span");
      source.textContent = `Source: ${candidate.sourceLink || "-"}`;
      source.style.overflowWrap = "anywhere";
      body.append(link, detail, source);
      details.append(summary, body);
      queueList.append(details);
    });
  };

  const applyCurrentLink = () => {
    if (state.mode === "X") {
      const auto = normalizeXStatusLink(location.href);
      if (auto) linkInput.value = auto;
      else if (location.href.includes("/status/")) linkInput.value = location.href;
      else linkInput.value = linkInput.value.trim();
    } else if (isTelegramPage) {
      linkInput.value = telegramSource(location.href)?.url || state.data?.telegramLink || linkInput.value.trim();
    }
  };

  const applyState = statePatch => {
    const nextState = statePatch || {};
    renderProgress(nextState);
    const savedLink = state.mode === "TG" ? nextState.telegramLink : nextState.xLink;
    if (savedLink && document.activeElement !== linkInput) linkInput.value = savedLink;
  };

  linkButton.onclick = async () => {
    applyCurrentLink();
    const nextValue = linkInput.value.trim() || window.prompt("Guardian link", state.mode === "X" ? "https://x.com/username/status/123" : "https://t.me/channel");
    if (!nextValue) return;
    linkInput.value = nextValue;
    if (state.mode === "X") {
      const normalized = normalizeXStatusLink(nextValue);
      if (!normalized) {
        window.alert("Use a valid X/Twitter post URL with /status/123.");
        return;
      }
      const result = await sendGuardianMessage({ type: "guardian:save", xLink: normalized });
      showMessageFailure(result, "Guardian link could not be saved.");
    } else {
      const source = telegramSource(nextValue);
      if (!source) {
        window.alert("Use a valid Telegram channel or message link.");
        return;
      }
      const result = await sendGuardianMessage({ type: "guardian:save", telegramLink: source.url });
      if (showMessageFailure(result, "Guardian link could not be saved.")) return;
      const current = telegramSource(location.href);
      if (!current || current.channel.toLowerCase() !== source.channel.toLowerCase() || current.messageId !== source.messageId) location.assign(source.url);
    }
  };

  startButton.onclick = async () => {
    startButton.disabled = true;
    try {
      const activeMode = isTelegramPage ? "TG" : "X";
      if (state.mode !== activeMode) {
        window.alert(activeMode === "TG" ? "Select TG on a Telegram page." : "Select X on an X/Twitter page.");
        return;
      }
      if (state.mode === "X") {
        const sourceLink = normalizeXStatusLink(linkInput.value.trim()) || normalizeXStatusLink(location.href) || "";
        if (!sourceLink) {
          window.alert("Add an X/Twitter post link first.");
          return;
        }
        linkInput.value = sourceLink;
        const saved = await sendGuardianMessage({ type: "guardian:save", xLink: sourceLink });
        if (showMessageFailure(saved, "Guardian X link could not be saved.")) return;
        const started = await sendGuardianMessage({ type: "guardian:start", source: "x" });
        showMessageFailure(started, "Guardian X start failed.");
      } else {
        const inputValue = linkInput.value.trim();
        const sourceUrl = inputValue || location.href;
        const normalizedSource = telegramSource(sourceUrl);
        if (!normalizedSource) {
          window.alert("Add a valid Telegram channel or message link first.");
          return;
        }
        const saved = await sendGuardianMessage({ type: "guardian:save", telegramLink: normalizedSource.url });
        if (showMessageFailure(saved, "Guardian Telegram link could not be saved.")) return;
        const scanToken = ++state.scanToken;
        await sendGuardianMessage({ type: "guardian:telegram-progress", currentLink: sourceUrl, detail: "Scrolling downward from the Telegram source message and detecting links." });
        const links = await collectTelegramLinksBelow(sourceUrl, scanToken);
        if (scanToken !== state.scanToken) return;
        const started = await sendGuardianMessage({ type: "guardian:start", source: "telegram", links });
        showMessageFailure(started, "Guardian Telegram start failed.");
      }
    } finally {
      startButton.disabled = false;
    }
  };

  stopButton.onclick = () => {
    state.scanToken++;
    hideWindow();
    sendGuardianMessage({ type: "guardian:stop" });
  };

  const runtime = globalThis.chrome?.runtime;
  if (runtime?.onMessage?.addListener) runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "guardian:sync") {
      applyState(message.state || {});
      if (typeof message.visible === "boolean") message.visible ? showWindow() : hideWindow();
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "guardian:focus") {
      if (message.state) applyState(message.state);
      showWindow();
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "guardian:close") {
      hideWindow();
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "guardian:stop-local") {
      state.scanToken++;
      hideWindow();
      sendResponse({ ok: true });
      return;
    }
  });

  const storage = globalThis.chrome?.storage;
  if (storage?.onChanged?.addListener) storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.communityReview) return;
    applyState(changes.communityReview.newValue || {});
  });

  controlsRow.append(linkButton, startButton, stopButton);
  progressBody.append(linkInput, controlsRow, statsGrid, currentPanel, queueSection);
  root.append(rowTop, progressBody);
  document.documentElement.append(root);
  root.style.display = "none";
  renderProgress({});
  sendGuardianMessage({ type: "guardian:get" }).then(savedState => {
    if (savedState?.ok === false) return;
    applyState(savedState || {});
    if (savedState?.popupVisible) {
      showWindow();
    }
  });

  if (isTelegramPage) {
    xButton.style.background = "rgba(30,41,59,0.85)";
    tgButton.style.background = "#1d9bf0";
    linkInput.placeholder = "https://t.me/channel";
    queueTitle.textContent = "Telegram link queue";
    applyCurrentLink();
  } else {
    xButton.style.background = "#1d9bf0";
    tgButton.style.background = "rgba(30,41,59,0.85)";
    linkInput.placeholder = "https://x.com/user/status/123";
    queueTitle.textContent = "X profile queue";
    applyCurrentLink();
  }
})();
