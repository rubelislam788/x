import {
  BUILTIN_PROVIDERS, DEFAULT_SETTINGS, TONES, ACTION_MODES, LIMITS, TEMPLATE_MODES,
  TEMPLATE_PLACEHOLDERS, parseUsernames, timingPlan, providerLabel, providerRefFor,
  findTemplate, templateNeedsAI, withDefaults
} from "./defaults.js";

const MOBILE_DEVICE = navigator.userAgentData?.mobile === true ||
  /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "") ||
  Math.min(screen.width || innerWidth, screen.height || innerHeight) <= 700 ||
  (navigator.maxTouchPoints > 1 && (
    globalThis.matchMedia?.("(pointer: coarse)")?.matches || Math.min(innerWidth, innerHeight) <= 900
  ));
document.documentElement.classList.toggle("mobileDevice", MOBILE_DEVICE);

const $ = id => document.getElementById(id);
const all = selector => [...document.querySelectorAll(selector)];
const ACTIVE = ["Running", "Paused", "Cooldown", "Demo"];
const SAMPLE_TWEET = {
  author: "example",
  text: "Shipped a small refactor today and the build time dropped by half. Small wins add up."
};

function normalizePostLink(value) {
  try {
    const input = String(value || "").trim().replace(/[),.;!?]+$/, "");
    const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    const host = url.hostname.toLowerCase().replace(/^(?:www|mobile|m)\./, "");
    if (!["x.com", "twitter.com"].includes(host)) return "";
    const direct = /^\/([^/]+)\/status\/(\d+)/i.exec(url.pathname);
    if (direct && direct[1].toLowerCase() !== "i") return `https://x.com/${direct[1]}/status/${direct[2]}`;
    const id = /\/status\/(\d+)/i.exec(url.pathname)?.[1];
    return id ? `https://x.com/i/web/status/${id}` : "";
  } catch { return ""; }
}

function parsePostLinks(value) {
  const text = Array.isArray(value) ? value.join("\n") : String(value || "");
  const matches = text.match(/(?:https?:\/\/)?(?:(?:www|mobile|m)\.)?(?:x|twitter)\.com\/[^\s<>"']+/gi) || [];
  return [...new Set(matches.map(normalizePostLink).filter(Boolean))].slice(0, 500);
}
function normalizeProfileLink(value) { try { const u = new URL(String(value || "").trim(), "https://x.com/"); const host = u.hostname.toLowerCase().replace(/^(?:www|mobile|m)\./, ""); const user = u.pathname.split("/").filter(Boolean)[0]; return ["x.com","twitter.com"].includes(host) && /^[A-Za-z0-9_]{1,15}$/.test(user || "") ? `https://x.com/${user}` : ""; } catch { return ""; } }
function parseProfileLinks(value) { return [...new Set((Array.isArray(value) ? value.join("\n") : String(value || "")).split(/[\n,;\s]+/).map(normalizeProfileLink).filter(Boolean))].slice(0, 500); }

function setPostLinkHint(id, links, prefix = "") {
  const hint = $(id);
  if (!hint) return;
  hint.textContent = `${prefix}${links.length} unique Post Link${links.length === 1 ? "" : "s"}. Duplicate or invalid links are ignored.`;
}

async function importPostLinkFile(inputId, boxId, hintId, saveImmediately) {
  const input = $(inputId);
  const box = $(boxId);
  const file = input?.files?.[0];
  if (!file || !box) return;
  try {
    const imported = parsePostLinks(await file.text());
    const links = parsePostLinks(`${box.value}\n${imported.join("\n")}`);
    box.value = links.join("\n");
    setPostLinkHint(hintId, links, `${imported.length} detected from ${file.name}. `);
    if (saveImmediately) {
      const response = await send({ type: "save-settings", patch: { engage: { postLinks: links } } });
      if (response.ok === false) throw new Error(response.error);
      if (response.settings) adopt(response.settings);
    }
  } catch (error) {
    const hint = $(hintId);
    if (hint) hint.textContent = `Could not read this text file: ${error?.message || error}`;
  } finally {
    input.value = "";
  }
}

let settings = withDefaults();
let editingId = null;
let editingFormatId = null;
let pending = null;
let account = { signedIn: false };
let adminData = { users: [], logs: [], apis: [], remote: { config: {} } };
let adminFilter = "active";
let assigningProviderId = "";
let remote = { config: { config_version: 0, maintenance_mode: false, policy: {} }, status: { state: "offline" } };
let community = { status: "Idle", sourceLinks: [], candidates: [] };
let activeConfig = "";
let refreshBusy = false;
let accountRefreshBusy = false;
let latestRuntime = null;
const providerAvailability = new Map();
// Guards persist(): true only once fill() has written the stored values into the form.
let populated = false;

// Never trust the worker's payload shape. After an update Chrome can keep the previous
// service worker alive, and that older code answers with an older schema: a missing key
// then throws inside a render and takes the whole popup down. Filling the gaps on arrival
// keeps this file working against any version of the worker.
function adopt(incoming) {
  if (incoming) settings = withDefaults(incoming);
  return settings;
}

function renderRemote(incoming) {
  if (incoming) remote = incoming;
  const config = remote.config || {};
  const bar = $("remoteBar");
  if (bar) {
  const status = remote.status || {};
  $("remoteVersion").textContent = `Version ${config.config_version || 0}`;
  $("remoteSync").textContent = status.lastSyncedAt
    ? `${status.state || "offline"} · ${new Date(status.lastSyncedAt).toLocaleString()}` : (status.state || "Not synced");
  const warning = $("remoteWarning");
  warning.hidden = !config.maintenance_mode && !status.error;
  warning.textContent = config.maintenance_mode ? "Maintenance mode is active. New automation runs are blocked." : (status.error || "");
  $("remoteBar").className = `remoteBar${config.maintenance_mode ? " maintenance" : status.state === "error" ? " error" : ""}`;
  }
  const policy = config.policy || {};
  for (const button of all('[data-run="unfollow"]')) button.disabled = config.maintenance_mode || policy.allow_unfollow === false;
  for (const button of all('[data-run="engage"]')) button.disabled = config.maintenance_mode || policy.allow_engage === false;
  for (const button of all('[data-test]')) button.disabled = policy.allow_ai === false || policy.allow_user_api_keys === false;
  const apiTab = document.querySelector('.bottomTab[data-tab="custom"]');
  if (apiTab) apiTab.disabled = policy.allow_user_api_keys === false;
  const customPanel = document.querySelector('[data-provider-panel="custom"]');
  if (customPanel) customPanel.disabled = policy.allow_custom_providers === false;
  const customView = document.querySelector('[data-provider-view="custom"]');
  if (customView) customView.classList.toggle("disabled", policy.allow_custom_providers === false);
}

function normalizeGuardianStatus(status) {
  const value = String(status || "").trim();
  if (!value) return "Pending";
  if (value === "Ready") return "Pending";
  if (value === "Already Completed") return "Completed";
  if (value === "Processing") return "Processing";
  if (value === "Completed") return "Completed";
  if (value === "Skipped") return "Skipped";
  if (value === "Failed") return "Failed";
  return value;
}

function guardianCounts(candidates) {
  return candidates.reduce((out, item) => {
    const status = normalizeGuardianStatus(item.status);
    if (status in out) out[status]++;
    return out;
  }, { Pending: 0, Processing: 0, Completed: 0, Skipped: 0, Failed: 0 });
}

function renderGuardianQueue(queueId, emptyId, summaryId, candidates, type) {
  candidates = Array.isArray(candidates) ? candidates : [];
  const counts = guardianCounts(candidates);
  const summary = $(summaryId);
  const empty = $(emptyId);
  const queue = $(queueId);
  if (summary) summary.textContent = `Pending: ${counts.Pending} | Processing: ${counts.Processing} | Completed: ${counts.Completed} | Skipped: ${counts.Skipped} | Failed: ${counts.Failed}`;
  if (empty) empty.hidden = candidates.length > 0;
  if (!queue) return;
  queue.replaceChildren();

  for (const [index, candidate] of candidates.entries()) {
    const item = document.createElement("article");
    const normalized = normalizeGuardianStatus(candidate.status);
    item.className = `communityCandidate status-${normalized.toLowerCase().replace(/ /g, "-")}`;

    const title = document.createElement("div");
    title.className = "cardHead";
    const heading = document.createElement("b");
    const serial = candidate.serial || index + 1;
    heading.textContent = type === "x" && candidate.profile ? `#${serial} @${candidate.profile}` : `#${serial} Link`;
    const statusBadge = document.createElement("span");
    statusBadge.className = `badge status-${normalized.toLowerCase().replace(/ /g, "-")}`;
    statusBadge.textContent = normalized;
    title.append(heading, statusBadge);
    item.append(title);

    const details = document.createElement("details");
    details.className = "communityDetails";
    const detailsSummary = document.createElement("summary");
    detailsSummary.textContent = "Details";
    details.append(detailsSummary);

    const primaryUrl = type === "x"
      ? candidate.profileUrl || (candidate.profile ? `https://x.com/${candidate.profile}` : "")
      : candidate.postUrl || "";
    const primaryInfo = document.createElement("p");
    if (primaryUrl) {
      const label = document.createElement("strong");
      label.textContent = type === "x" ? "Profile: " : "Link: ";
      const link = document.createElement("a");
      link.href = primaryUrl;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = primaryUrl;
      primaryInfo.append(label, link);
    } else {
      primaryInfo.textContent = type === "x" ? "No X profile" : "No collected link";
      primaryInfo.className = "muted";
    }
    details.append(primaryInfo);

    if (type === "x" && candidate.postUrl) {
      const postInfo = document.createElement("p");
      const label = document.createElement("strong");
      label.textContent = "Checked/selected post: ";
      const postLink = document.createElement("a");
      postLink.href = candidate.postUrl;
      postLink.target = "_blank";
      postLink.rel = "noopener";
      postLink.textContent = candidate.postUrl;
      postInfo.append(label, postLink);
      details.append(postInfo);
    }

    const meta = document.createElement("p");
    meta.className = "muted";
    let metaText = `Source: ${candidate.sourceLink || "-"}`;
    if (candidate.detail) metaText += ` | ${candidate.detail}`;
    meta.textContent = metaText;
    details.append(meta);
    item.append(details);
    queue.append(item);
  }
}

function renderCommunity(incoming) {
  if (incoming) community = incoming;
  const xCandidates = Array.isArray(community.candidates) ? community.candidates : [];
  const telegramCandidates = Array.isArray(community.telegramCandidates) ? community.telegramCandidates : [];
  const statusNode = $("communityStatus");
  const telegramStatusNode = $("telegramGuardianStatus");
  const linksNode = $("communityLinks");
  const telegramNode = $("guardianTelegramLink");

  if (statusNode) statusNode.textContent = community.xStatus || "Idle";
  if (telegramStatusNode) telegramStatusNode.textContent = community.telegramStatus || "Idle";
  if (linksNode) linksNode.value = (community.sourceLinks || []).join("\n");
  if (telegramNode) telegramNode.value = community.telegramLink || "";

  renderGuardianQueue("communityQueue", "communityEmpty", "communitySummary", xCandidates, "x");
  renderGuardianQueue("telegramQueue", "telegramEmpty", "telegramSummary", telegramCandidates, "telegram");
}

const send = message => new Promise(resolve => {
  let settled = false;
  const finish = value => { if (settled) return; settled = true; resolve(value); };
  try {
    const pending = chrome.runtime.sendMessage(message, response => {
      const failure = chrome.runtime.lastError;
      finish(failure
        ? { ok: false, error: `${failure.message}. Reload the extension and try again.` }
        : response || { ok: false, error: "The extension worker did not respond." });
    });
    if (pending?.then) pending.then(response => finish(response || { ok: false, error: "The extension worker did not respond." }))
      .catch(error => finish({ ok: false, error: `${error?.message || error}. Reload the extension and try again.` }));
  } catch (error) {
    try {
      const pending = chrome.runtime.sendMessage(message);
      if (pending?.then) pending.then(response => finish(response || { ok: false, error: "The extension worker did not respond." }))
        .catch(retryError => finish({ ok: false, error: `${retryError?.message || retryError}. Reload the extension and try again.` }));
      else finish({ ok: false, error: `${error?.message || error}. Reload the extension and try again.` });
    } catch (retryError) {
      finish({ ok: false, error: `${retryError?.message || retryError}. Reload the extension and try again.` });
    }
  }
});

function permissionCall(method, details) {
  return new Promise((resolve, reject) => {
    const api = chrome.permissions;
    if (!api || typeof api[method] !== "function") { reject(new Error("Browser permission API is unavailable.")); return; }
    let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; error ? reject(error) : resolve(value); };
    const callback = value => {
      const failure = chrome.runtime.lastError;
      finish(failure ? new Error(failure.message) : null, value);
    };
    try {
      const pending = api[method](details, callback);
      if (pending?.then) pending.then(value => finish(null, value)).catch(error => finish(error));
    } catch {
      try {
        const pending = api[method](details);
        if (pending?.then) pending.then(value => finish(null, value)).catch(error => finish(error));
        else finish(null, pending);
      } catch (error) { finish(error); }
    }
  });
}

// ---------- generic path binding ----------

const getPath = (object, path) => path.split(".").reduce((value, key) => value?.[key], object);
function setPath(object, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  let cursor = object;
  for (const key of keys) cursor = cursor[key] = cursor[key] || {};
  cursor[last] = value;
}

function readControl(element) {
  if (element.type === "checkbox") return element.checked;
  if (element.type === "number") return element.value === "" ? "" : Number(element.value);
  const type = element.dataset.type;
  if (type === "usernames") return parseUsernames(element.value);
  if (type === "lines") return element.value.split("\n").map(line => line.trim()).filter(Boolean);
  if (type === "post-links") return parsePostLinks(element.value);
  if (type === "profile-links") return parseProfileLinks(element.value);
  return element.value;
}

function writeControl(element, value) {
  if (element.type === "checkbox") { element.checked = value === true; return; }
  if (element.type === "radio") { element.checked = String(value) === element.value; return; }
  const type = element.dataset.type;
  if (type === "usernames") { element.value = (value || []).map(name => "@" + name).join("\n"); return; }
  if (type === "lines") { element.value = (value || []).join("\n"); return; }
  if (type === "post-links") { element.value = parsePostLinks(value).join("\n"); return; }
  if (type === "profile-links") { element.value = parseProfileLinks(value).join("\n"); return; }
  element.value = value ?? "";
}

function collect() {
  const patch = {};
  for (const element of all("[data-path]")) {
    if (element.type === "radio" && !element.checked) continue;
    setPath(patch, element.dataset.path, readControl(element));
  }
  return patch;
}

function fill() {
  for (const element of all("[data-path]")) writeControl(element, getPath(settings, element.dataset.path));
  // Set the moment the values land, so a later render throwing still leaves the form saveable.
  populated = true;
  // After the values, not before: these rebuild option lists and apply the selected value
  // themselves, so if one ever throws the rest of the form is already populated rather than
  // left blank — a blank form is what collect() would otherwise save over the real settings.
  renderProviderChoices();
  renderFormatChoices();
  syncConditionalFields();
  renderToggles();
  renderCustomList();
  renderFormatList();
}

async function persist() {
  // Refuse to save a form nobody has populated yet. collect() reads the live DOM, so saving before
  // the first successful fill() would write empty strings over every real setting the user has.
  if (!populated) return { ok: false, error: "Settings are still loading. Try again in a moment." };
  const response = await send({ type: "save-settings", patch: collect() });
  if (response.settings) {
    adopt(response.settings);
    renderProviderChoices();
    renderFormatChoices();
    renderToggles();
  }
  return response;
}

// keep number inputs honest without fighting the user mid-typing
async function persistAndRefill() {
  const response = await persist();
  if (response.ok === false) return response;
  fill();
  return response;
}

function syncConditionalFields() {
  $("unfollowCustomOptions").hidden = settings.unfollow.mode !== "custom";
  const guardianModeField = $("guardianModeField");
  if (guardianModeField) guardianModeField.hidden = settings.engage.source !== "guardian";
  const postLinkField = $("postLinkField");
  if (postLinkField) postLinkField.hidden = settings.engage.source !== "links";
  const profileLinkField = $("profileLinkField");
  if (profileLinkField) profileLinkField.hidden = settings.engage.source !== "profiles";
  setPostLinkHint("postLinkHint", settings.engage.postLinks || []);
  setGuardianModeButtons("main", settings.engage.guardianMode || "x");
  const random = settings.engage.timing === "random";
  $("randomRange").hidden = !random;
  const plan = timingPlan(settings.engage);
  $("timingHint").textContent = random
    ? `Each wait is picked at random between ${Math.round(plan.minMs / 1000)}s and ${Math.round(plan.maxMs / 1000)}s, never above the maximum.`
    : `Every action waits ${Math.round(plan.minMs / 1000)} seconds.`;
  renderFormatHint();
}

function setGuardianModeButtons(scope, value) {
  for (const button of all(`[data-guardian-scope="${scope}"]`)) {
    button.setAttribute("aria-pressed", String(button.dataset.guardianMode === value));
  }
}

function selectedGuardianMode(scope) {
  return document.querySelector(`[data-guardian-scope="${scope}"][aria-pressed="true"]`)?.dataset.guardianMode || "x";
}

// Spells out exactly what this automation will do, so the two selects need no guessing.
function renderFormatHint() {
  const template = findTemplate(settings, settings.engage.templateId);
  const label = providerLabel(settings, providerRefFor(settings, "engage"));
  const source = settings.engage.provider ? label : `${label} (default)`;
  if (!template) {
    $("engageFormatHint").textContent = `Replies are written by ${source} from the prompt template.`;
    return;
  }
  $("engageFormatHint").textContent = templateNeedsAI(template)
    ? template.mode === "rules"
      ? `${source} writes each reply following the rules in "${template.name}".`
      : `Format "${template.name}" is posted as written, with ${source} filling {{ai}}.`
    : `Format "${template.name}" is posted exactly as written. No API is used.`;
}

// ---------- APIs & keys ----------

function setOptions(select, options, value) {
  select.innerHTML = "";
  for (const option of options) {
    const node = document.createElement("option");
    node.value = option.value;
    node.textContent = option.label;
    select.append(node);
  }
  select.value = options.some(option => option.value === value) ? value : options[0]?.value ?? "";
}

const providerOptions = () => [
  ...Object.values(BUILTIN_PROVIDERS).map(provider => ({ value: provider.id, label: provider.label })),
  ...settings.customProviders.map(item => ({ value: `custom:${item.id}`, label: `${item.name} (custom)` }))
];

function renderProviderChoices() {
  const options = providerOptions();
  const activeSelect = $("activeProvider");
  if (activeSelect) setOptions(activeSelect, options, settings.activeProvider);

  // Each automation may override the default, so its own picker leads with "use the default".
  for (const channel of ["engage"]) {
    const select = $(`${channel}Provider`);
    if (!select) continue;
    setOptions(select, [
      { value: "", label: `Use the default (${providerLabel(settings, settings.activeProvider)})` },
      ...options
    ], settings[channel].provider || "");
  }

  for (const provider of Object.values(BUILTIN_PROVIDERS)) {
    const pill = $(`${provider.id}Pill`);
    if (!pill) continue;
    const saved = settings[provider.id];
    const isActive = settings.activeProvider === provider.id;
    pill.textContent = !saved.apiKey ? "Not set" : isActive ? "Default" : "Key saved";
    pill.className = `pill${!saved.apiKey ? "" : isActive ? " active" : " ok"}`;
  }
}

async function testProvider(ref, resultId) {
  const result = $(resultId);
  result.className = "result busy";
  result.textContent = "Testing...";
  const saved = await persist();
  if (saved.ok === false) {
    result.className = "result bad";
    result.textContent = saved.error;
    return false;
  }
  const response = await send({ type: "provider:test", ref });
  result.className = `result ${response.ok ? "ok" : "bad"}`;
  result.textContent = response.ok
    ? `Connected. ${response.label} replied using ${response.model}.`
    : response.error;
  refresh();
  return response.ok === true;
}

// ---------- section 2: automation ----------

function renderToggles() {
  for (const channel of ["unfollow", "engage"]) {
    const on = settings[channel].enabled === true;
    for (const button of all(`[data-enable="${channel}"]`)) {
      button.setAttribute("aria-pressed", String(String(button.dataset.value) === String(on)));
    }
    $(`${channel}Body`).classList.toggle("disabled", !on);
  }
}

const countdown = target => {
  if (!target) return "";
  const seconds = Math.ceil((target - Date.now()) / 1000);
  if (seconds <= 0) return "";
  return seconds >= 60 ? `in ${Math.floor(seconds / 60)}m ${seconds % 60}s` : `in ${seconds}s`;
};

function renderRuntime(state) {
  latestRuntime = state;
  for (const element of all("[data-stat]")) {
    const [channel, key] = element.dataset.stat.split(".");
    const value = state[channel]?.[key];
    element.textContent = typeof value === "number" ? value : (value || (element.tagName === "STRONG" ? "-" : ""));
  }
  for (const element of all("[data-countdown]")) {
    const channel = element.dataset.countdown;
    element.textContent = countdown(state[channel]?.nextActionAt || state[channel]?.cooldownUntil);
  }
  for (const channel of ["unfollow", "engage"]) {
    const status = state[channel]?.status || "Idle";
    const busy = ACTIVE.includes(status);
    const otherBusy = ACTIVE.includes(state[channel === "unfollow" ? "engage" : "unfollow"]?.status || "Idle");
    const enabled = settings[channel].enabled === true;
    // The picker dot is the only sign of life for whichever card is currently hidden.
    const dot = $(`${channel}Dot`);
    dot.className = `dot ${status === "Error" ? "bad" : busy ? "run" : enabled ? "on" : "off"}`;
    dot.title = status === "Error" ? "Error" : busy ? status : enabled ? "Enabled" : "Disabled";
    for (const button of all(`[data-run="${channel}"]`)) button.disabled = busy || otherBusy || !enabled;
    const pauseButton = $(`${channel}Body`).querySelector(`[data-cmd="${channel}:pause"]`);
    if (pauseButton) pauseButton.disabled = !["Running", "Demo", "Cooldown"].includes(status);
    const resumeButton = $(`${channel}Body`).querySelector(`[data-cmd="${channel}:resume"]`);
    if (resumeButton) resumeButton.disabled = !["Paused", "Error"].includes(status);
    const stopButton = $(`${channel}Body`).querySelector(`[data-cmd="${channel}:stop"]`);
    if (stopButton) stopButton.disabled = !busy && status !== "Error";
  }
  const main = $("engageMainControl");
  if (main) {
    const status = state.engage?.status || "Idle";
    const paused = status === "Paused";
    const running = ["Running", "Demo", "Cooldown"].includes(status);
    main.textContent = paused ? "Resume" : running ? "Stop" : "Start";
    main.classList.toggle("running", running);
    main.classList.toggle("paused", paused);
    main.disabled = !settings.engage.enabled || (!running && !paused && ACTIVE.includes(state.unfollow?.status || "Idle"));
  }
  const queue = $("engageQueue");
  const queueList = $("engageQueueList");
  const queueSummary = $("engageQueueSummary");
  const runtimeStatuses = state.engage?.linkStatuses || {};
  const statuses = Object.keys(runtimeStatuses).length || settings.engage.source !== "links"
    ? runtimeStatuses
    : Object.fromEntries((settings.engage.postLinks || []).map(url => [url, { status: "Pending", detail: "Waiting in Post Link queue." }]));
  queue.hidden = !Object.keys(statuses).length;
  queueList.innerHTML = "";
  const counts = { Pending: 0, Processing: 0, Completed: 0, Skipped: 0, Failed: 0 };
  for (const [index, [url, entry]] of Object.entries(statuses).entries()) {
    const rawStatus = entry.status || "Pending";
    const displayStatus = rawStatus === "Already Completed" ? "Completed" : rawStatus;
    if (displayStatus in counts) counts[displayStatus]++;
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = `#${index + 1} ${url.replace(/^https?:\/\//, "")}`;
    const badge = document.createElement("b");
    badge.textContent = displayStatus;
    badge.className = `queueStatus ${String(displayStatus).toLowerCase().replace(/\s+/g, "-")}`;
    item.append(link, badge);
    if (entry.detail) {
      const detail = document.createElement("span");
      detail.className = "queueDetail";
      detail.textContent = entry.detail;
      item.append(detail);
    }
    queueList.append(item);
  }
  if (queueSummary) queueSummary.textContent = `Pending: ${counts.Pending} | Processing: ${counts.Processing} | Completed: ${counts.Completed} | Skipped: ${counts.Skipped} | Failed: ${counts.Failed}`;
}

function renderLogs(logs) {
  const list = $("logList");
  list.innerHTML = "";
  for (const entry of logs || []) {
    const item = document.createElement("li");
    if (entry.level) item.className = entry.level;
    const time = document.createElement("b");
    time.textContent = new Date(entry.t).toLocaleTimeString();
    item.append(time, document.createTextNode(entry.text));
    list.append(item);
  }
  if (!list.children.length) list.innerHTML = '<li>No activity yet.</li>';
}

async function refresh() {
  if (refreshBusy) return;
  refreshBusy = true;
  try {
    const state = await send({ type: "get-all" });
    if (state.ok === false || !state.settings) return;
    const firstLoad = !populated;
    adopt(state.settings);
    if (firstLoad) {
      fill();
      for (const button of all("[data-enable]")) button.disabled = false;
    }
    renderRuntime(state);
    renderLogs(state.logs);
    renderRemote(state.remote);
    renderCommunity(state.community);
  } finally {
    refreshBusy = false;
  }
}

async function startRun(channel, demo) {
  const saved = await persist();
  if (saved.ok === false) {
    // Without this the button looks dead: the run never starts and nothing says why.
    await send({ type: "progress", channel, patch: { notice: saved.error } });
    refresh();
    return;
  }
  const started = await send({ type: `${channel}:start`, demo });
  if (started.ok === false) {
    await send({ type: "progress", channel, patch: { status: "Error", error: started.error, notice: "" } });
  }
  refresh();
}

async function runButton(button, action) {
  if (button.disabled) return;
  button.disabled = true;
  try { return await action(); }
  finally { button.disabled = false; }
}

// ---------- section 3: custom endpoints ----------

const customForm = () => ({
  name: $("customName").value.trim(),
  format: $("customFormat").value,
  url: $("customUrl").value.trim(),
  apiKey: $("customKey").value.trim(),
  model: $("customModel").value.trim(),
  headerName: $("customHeaderName").value.trim(),
  headerPrefix: $("customHeaderPrefix").value
});

function resetCustomForm() {
  editingId = null;
  for (const id of ["customName", "customUrl", "customKey", "customModel", "customHeaderName", "customHeaderPrefix"]) $(id).value = "";
  $("customFormat").value = "openai";
  $("customFormTitle").textContent = "Add an endpoint";
  $("customAdd").textContent = "Add";
  $("customCancel").hidden = true;
  $("urlPreview").textContent = "";
  $("customResult").textContent = "";
}

async function requestHostAccess(url) {
  try {
    const origin = new URL(url).origin + "/*";
    if (await permissionCall("contains", { origins: [origin] })) return true;
    return await permissionCall("request", { origins: [origin] });
  } catch { return false; }
}

async function saveCustom() {
  const form = customForm();
  const result = $("customResult");
  if (!form.url || !form.model) {
    result.className = "result bad";
    result.textContent = "A URL and a model name are both required.";
    return null;
  }
  const preview = await send({ type: "provider:resolve-url", url: form.url, format: form.format });
  if (preview.ok === false) {
    result.className = "result bad";
    result.textContent = preview.error;
    return null;
  }
  if (!(await requestHostAccess(preview.url))) {
    result.className = "result bad";
    result.textContent = "Browser access to that endpoint was not granted, so requests would be blocked.";
    return null;
  }
  const id = editingId || `c${Date.now().toString(36)}`;
  const others = settings.customProviders.filter(item => item.id !== id);
  const patch = { customProviders: [...others, { id, ...form, name: form.name || "Custom endpoint" }] };
  const response = await send({ type: "save-settings", patch });
  if (response.ok === false || !response.settings) {
    result.className = "result bad";
    result.textContent = response.error || "The endpoint could not be saved.";
    return null;
  }
  if (response.settings) adopt(response.settings);
  resetCustomForm();
  renderProviderChoices();
  renderCustomList();
  result.className = "result ok";
  result.textContent = `Saved. Request URL: ${preview.url}`;
  return id;
}

function editCustom(id) {
  const item = settings.customProviders.find(entry => entry.id === id);
  if (!item) return;
  editingId = id;
  $("customName").value = item.name || "";
  $("customFormat").value = item.format || "openai";
  $("customUrl").value = item.url || "";
  $("customKey").value = item.apiKey || "";
  $("customModel").value = item.model || "";
  $("customHeaderName").value = item.headerName || "";
  $("customHeaderPrefix").value = item.headerPrefix || "";
  $("customFormTitle").textContent = "Edit endpoint";
  $("customAdd").textContent = "Save changes";
  $("customCancel").hidden = false;
  updateUrlPreview();
  $("customName").focus();
}

async function removeCustom(id) {
  const patch = { customProviders: settings.customProviders.filter(item => item.id !== id) };
  if (settings.activeProvider === `custom:${id}`) patch.activeProvider = "openai";
  const response = await send({ type: "save-settings", patch });
  if (response.ok === false) {
    $("customResult").className = "result bad";
    $("customResult").textContent = response.error;
    return;
  }
  if (response.settings) adopt(response.settings);
  if (editingId === id) resetCustomForm();
  renderProviderChoices();
  renderCustomList();
}

async function useCustom(id) {
  const response = await send({ type: "save-settings", patch: { activeProvider: `custom:${id}` } });
  if (response.ok === false) {
    $("customResult").className = "result bad";
    $("customResult").textContent = response.error;
    return;
  }
  if (response.settings) adopt(response.settings);
  renderProviderChoices();
  renderCustomList();
}

function renderCustomList() {
  const list = $("customList");
  list.innerHTML = "";
  $("customCount").textContent = String(settings.customProviders.length);
  $("customEmpty").hidden = settings.customProviders.length > 0;
  for (const item of settings.customProviders) {
    const inUse = settings.activeProvider === `custom:${item.id}`;
    const assigned = item.assigned === true;
    const node = document.createElement("li");
    if (inUse) node.className = "inUse";

    const title = document.createElement("div");
    title.className = "customName";
    title.append(document.createTextNode(item.name));
    const badge = document.createElement("span");
    badge.className = `pill${inUse ? " active" : ""}`;
    badge.textContent = inUse ? "In use" : assigned ? "Assigned" : item.format === "anthropic" ? "Anthropic" : "OpenAI";
    title.append(badge);

    const meta = document.createElement("div");
    meta.className = "customMeta";
    meta.textContent = `${item.url} · ${item.model || "no model"} · ${item.apiKey ? "key saved" : "no key"}`;

    const buttons = document.createElement("div");
    buttons.className = "customButtons";
    const actions = [
      ["Use", () => useCustom(item.id)],
      ["Test", () => testProvider(`custom:${item.id}`, "customResult")]
    ];
    if (!assigned) actions.push(
      ["Edit", () => editCustom(item.id)],
      ["Delete", () => confirmAction("Delete endpoint", `Remove "${item.name}" from the saved list?`, () => removeCustom(item.id))]
    );
    buttons.classList.toggle("three", actions.length === 3);
    for (const [label, handler] of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      if (label === "Use") button.disabled = inUse;
      if (label === "Delete") button.className = "muted";
      button.addEventListener("click", handler);
      buttons.append(button);
    }
    node.append(title, meta, buttons);
    list.append(node);
  }
  if (!$("adminPanel")?.hidden) renderAdminApis();
}

async function updateUrlPreview() {
  const url = $("customUrl").value.trim();
  if (!url) { $("urlPreview").textContent = ""; return; }
  const response = await send({ type: "provider:resolve-url", url, format: $("customFormat").value });
  $("urlPreview").textContent = response.ok === false ? response.error : `Requests go to ${response.url}`;
}

// ---------- comment formats ----------

const formatForm = () => ({
  id: editingFormatId || "",
  name: $("formatName").value.trim(),
  mode: $("formatMode").value,
  body: $("formatBody").value,
  mentions: parseUsernames($("formatMentions").value)
});

function renderFormatChoices() {
  setOptions($("engageTemplate"), [
    { value: "", label: "No format — use the prompt" },
    ...settings.templates.map(item => ({ value: item.id, label: item.name }))
  ], settings.engage.templateId || "");
}

function renderFormatModeHint() {
  const rules = $("formatMode").value === "rules";
  $("formatBodyLabel").textContent = rules ? "Format rules (one per line)" : "Format";
  $("formatBody").placeholder = rules
    ? "One or two sentences, under 180 characters.\nNo emoji and no hashtags."
    : "{{ai}}\n\n{{mentions}}";
  $("formatModeHint").textContent = rules
    ? "The AI writes the whole reply and obeys these rules. Placeholders are not needed."
    : "Posted exactly as written. Add {{ai}} wherever the AI should write; without it, no API is used.";
}

function resetFormatForm() {
  editingFormatId = null;
  $("formatName").value = "";
  $("formatMode").value = "template";
  $("formatBody").value = "";
  $("formatMentions").value = "";
  $("formatFormTitle").textContent = "Add a format";
  $("formatAdd").textContent = "Add";
  $("formatCancel").hidden = true;
  $("formatResult").textContent = "";
  $("formatResult").className = "result";
  renderFormatModeHint();
}

async function saveFormat() {
  const form = formatForm();
  const result = $("formatResult");
  const fail = message => {
    result.className = "result bad";
    result.textContent = message;
    return null;
  };
  if (!form.name || !form.body.trim()) return fail("A name and a format body are both required.");

  // An unrecognised placeholder is left untouched when the reply is built, so a typo like
  // {{mention}} would be posted to X with the braces showing. Catch it here, not on the timeline.
  const used = [...new Set((form.body.match(/\{\{(\w+)\}\}/g) || []).map(token => token.slice(2, -2)))];
  const unknown = used.filter(name => !TEMPLATE_PLACEHOLDERS.includes(name));
  if (unknown.length) {
    const names = unknown.map(name => `{{${name}}}`).join(", ");
    const verb = unknown.length > 1 ? "are not placeholders and would be" : "is not a placeholder and would be";
    return fail(`${names} ${verb} posted with the braces showing. `
      + `Available: ${TEMPLATE_PLACEHOLDERS.map(name => `{{${name}}}`).join(" ")}.`);
  }
  const id = editingFormatId || `t${Date.now().toString(36)}`;
  const previous = settings.templates.find(item => item.id === id);
  const others = settings.templates.filter(item => item.id !== id);
  const patch = {
    templates: [...others, { ...form, id, note: previous?.note || "" }]
  };
  // Select a first format automatically, but never silently replace one the user already chose.
  const selects = !editingFormatId && !settings.engage.templateId;
  if (selects) patch.engage = { templateId: id };
  const response = await send({ type: "save-settings", patch });
  if (response.ok === false) return fail(response.error);
  if (response.settings) adopt(response.settings);
  resetFormatForm();
  fill();
  const saved = $("formatResult");
  saved.className = "result ok";
  saved.textContent = selects
    ? `Saved "${form.name}" and selected it for Like & Comment.`
    : `Saved "${form.name}". Press Use on it to switch an automation over.`;
  return id;
}

function editFormat(id) {
  const item = settings.templates.find(entry => entry.id === id);
  if (!item) return;
  editingFormatId = id;
  $("formatName").value = item.name || "";
  $("formatMode").value = item.mode === "rules" ? "rules" : "template";
  $("formatBody").value = item.body || "";
  $("formatMentions").value = (item.mentions || []).map(name => "@" + name).join("\n");
  $("formatFormTitle").textContent = "Edit format";
  $("formatAdd").textContent = "Save changes";
  $("formatCancel").hidden = false;
  $("formatResult").textContent = "";
  $("formatResult").className = "result";
  renderFormatModeHint();
  $("formatName").focus();
}

async function removeFormat(id) {
  // The worker clears any automation still pointing at a template that no longer exists.
  const response = await send({ type: "save-settings", patch: { templates: settings.templates.filter(item => item.id !== id) } });
  if (response.ok === false) {
    $("formatResult").className = "result bad";
    $("formatResult").textContent = response.error;
    return;
  }
  if (response.settings) adopt(response.settings);
  if (editingFormatId === id) resetFormatForm();
  fill();
}

async function useFormat(id) {
  const response = await send({ type: "save-settings", patch: { engage: { templateId: id } } });
  if (response.ok === false) {
    $("formatResult").className = "result bad";
    $("formatResult").textContent = response.error;
    return;
  }
  if (response.settings) adopt(response.settings);
  fill();
}

async function previewFormat(template, resultId) {
  const result = $(resultId);
  result.className = "result busy";
  result.textContent = "Building a sample reply...";
  const response = await send({ type: "template:preview", template, tweet: SAMPLE_TWEET });
  result.className = `result ${response.ok ? "ok" : "bad"}`;
  result.textContent = response.ok ? `${response.provider}:\n${response.text}` : response.error;
}

function renderFormatList() {
  const list = $("formatList");
  list.innerHTML = "";
  $("formatCount").textContent = String(settings.templates.length);
  $("formatEmpty").hidden = settings.templates.length > 0;
  for (const item of settings.templates) {
    const inUse = settings.engage.templateId === item.id;
    const node = document.createElement("li");
    if (inUse) node.className = "inUse";

    const title = document.createElement("div");
    title.className = "customName";
    title.append(document.createTextNode(item.name));
    const badge = document.createElement("span");
    badge.className = `pill${inUse ? " active" : ""}`;
    badge.textContent = inUse ? "In use" : item.mode === "rules" ? "Rules" : "Fixed";
    title.append(badge);

    const body = document.createElement("div");
    body.className = "customBody";
    body.textContent = item.body;

    const meta = document.createElement("div");
    meta.className = "customMeta";
    const parts = [templateNeedsAI(item) ? "uses the AI" : "no API needed"];
    if (item.mentions?.length) parts.push(item.mentions.map(name => "@" + name).join(" "));
    if (item.note) parts.push(item.note);
    meta.textContent = parts.join(" · ");

    const buttons = document.createElement("div");
    buttons.className = "customButtons";
    for (const [label, handler] of [
      ["Use", () => useFormat(item.id)],
      ["Preview", () => previewFormat(item, "formatResult")],
      ["Edit", () => editFormat(item.id)],
      ["Delete", () => confirmAction("Delete format", `Remove "${item.name}"? Any automation using it falls back to the prompt.`, () => removeFormat(item.id))]
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      if (label === "Use") button.disabled = inUse;
      if (label === "Delete") button.className = "muted";
      button.addEventListener("click", handler);
      buttons.append(button);
    }
    node.append(title, body, meta, buttons);
    list.append(node);
  }
}

// ---------- confirm modal ----------

function confirmAction(title, text, action) {
  pending = action;
  $("confirmTitle").textContent = title;
  $("confirmText").textContent = text;
  $("confirmModal").hidden = false;
  $("approveConfirm").focus();
}
function closeConfirm() { pending = null; $("confirmModal").hidden = true; }

// ---------- wiring ----------

function populateStaticOptions() {
  for (const provider of Object.values(BUILTIN_PROVIDERS)) {
    const list = $(`${provider.id}Models`);
    for (const model of provider.models) {
      const option = document.createElement("option");
      option.value = model;
      list.append(option);
    }
    $(`${provider.id}KeysUrl`).href = provider.keysUrl;
  }
  for (const [id, values] of [
    ["engageActions", ACTION_MODES],
    ["engageTone", TONES.map(tone => ({ value: tone, label: tone }))],
    ["formatMode", TEMPLATE_MODES]
  ]) {
    const select = $(id);
    for (const item of values) {
      const option = document.createElement("option");
      option.value = item.value;
      option.textContent = item.label;
      select.append(option);
    }
  }
  for (const element of all('[data-path$="randomMinSec"], [data-path$="randomMaxSec"]')) {
    element.min = LIMITS.intervalMinSec;
    element.max = LIMITS.intervalMaxSec;
  }
}

function showTab(name) {
  if (name !== "account" && !account.signedIn) name = "account";
  if (name !== "account" && account.signedIn) {
    const profile = account.profile || {};
    if (profile.access_granted !== true && !["owner", "admin"].includes(profile.role)) name = "account";
    const full = ["owner", "admin"].includes(profile.role);
    const required = name === "custom" ? "api_keys" : name === "formats" || name === "community" ? "engage" : "";
    if (required && !full && profile.permissions?.[required] !== true) name = "account";
  }
  for (const tab of all(".tab")) tab.classList.toggle("active", tab.dataset.tab === name);
  for (const tab of all(".bottomTab")) tab.classList.toggle("active", tab.dataset.tab === name);
  for (const panel of all(".panel")) panel.classList.toggle("active", panel.id === `panel-${name}`);
  document.querySelector("main").scrollTop = 0;
  window.scrollTo(0, 0);
}

function renderAccount(context) {
  account = context || { signedIn: false };
  $("accountSignedOut").hidden = account.signedIn === true;
  const profile = account.profile || {};
  const approved = account.signedIn && profile.status === "active" && (["owner", "admin"].includes(profile.role) || profile.access_granted === true);
  $("accountPending").hidden = !account.signedIn || approved;
  $("accountSignedIn").hidden = !approved;
  if (!account.signedIn) return;
  const ownerTelegram = String(account.ownerTelegram || "@yourusername");
  $("pendingTelegramLabel").textContent = `Telegram: ${ownerTelegram}`;
  $("pendingTelegram").href = `https://t.me/${ownerTelegram.replace(/^@/, "")}`;
  if (!approved) {
    for (const tab of all('.bottomTab:not([data-tab="account"])')) tab.disabled = true;
    return;
  }
  $("profileName").value = profile.display_name || account.user?.user_metadata?.full_name || "";
  $("profileEmail").textContent = account.user?.email || profile.email || "";
  $("accountRole").textContent = profile.role || "user";
  $("profileStatus").textContent = profile.status || "Unknown";
  $("profileLastSeen").textContent = profile.last_seen_at ? new Date(profile.last_seen_at).toLocaleString() : "Not recorded";
  const full = ["owner", "admin"].includes(profile.role);
  $("profileAccess").textContent = approved ? "Approved" : "Waiting for approval";
  const permissions = profile.permissions || {};
  $("profilePermissions").innerHTML = "";
  for (const name of ["unfollow", "engage", "api_keys"]) {
    const item = document.createElement("span");
    item.textContent = `${name}: ${["owner", "admin"].includes(profile.role) || permissions[name] === true ? "allowed" : "disabled"}`;
    if (["owner", "admin"].includes(profile.role) || permissions[name] === true) item.className = "on";
    $("profilePermissions").append(item);
  }
  const assigned = Array.isArray(account.assignedApis) ? account.assignedApis : [];
  $("profileAssignedApis").innerHTML = "";
  for (const api of assigned) {
    const item = document.createElement("span");
    item.className = "on";
    item.textContent = api.name || "Custom API";
    $("profileAssignedApis").append(item);
  }
  if (!assigned.length) $("profileAssignedApis").innerHTML = "<span>Default AI only</span>";
  $("adminPanel").hidden = !["owner", "admin"].includes(profile.role) || profile.status !== "active";
  $("adminTelegram").value = account.ownerTelegram || "@yourusername";
  for (const tab of all('.bottomTab:not([data-tab="account"])')) tab.disabled = !approved;
  for (const tab of all('.bottomTab[data-tab="community"]')) tab.disabled = !full && permissions.engage !== true;
  for (const tab of all('.bottomTab[data-tab="custom"], .tab[data-tab="custom"]')) {
    tab.disabled = !full && permissions.api_keys !== true;
  }
  if (["owner", "admin"].includes(profile.role) && profile.status === "active") loadAdmin();
  loadAccountActivity();
  if (!approved) showTab("account");
}

async function loadAccountActivity() {
  const response = await send({ type: "account:activity" });
  if (response.ok === false) return;
  $("profileSession").textContent = response.expiresAt ? new Date(response.expiresAt * 1000).toLocaleString() : "-";
  const list = $("profileActivity"); list.innerHTML = "";
  for (const entry of response.logs || []) {
    const item = document.createElement("li");
    item.textContent = `${new Date(entry.created_at).toLocaleString()}  ${entry.action}`;
    list.append(item);
  }
  if (!list.children.length) list.innerHTML = "<li>No activity yet.</li>";
}

async function refreshAccount() {
  if (accountRefreshBusy) return;
  accountRefreshBusy = true;
  try {
    const response = await send({ type: "auth:status" });
    if (response && response.signedIn !== undefined) {
      renderAccount(response);
      if (response.signedIn) send({ type: "account:touch" });
    }
  } finally {
    accountRefreshBusy = false;
  }
}

async function loadAdmin() {
  const result = $("adminResult");
  const response = await send({ type: "admin:list" });
  if (response.ok === false) { result.className = "result bad"; result.textContent = response.error; return; }
  adminData = { users: response.users || [], logs: response.logs || [], apis: response.apis || [], remote: response.remote || { config: {} } };
  renderAdminStats();
  renderAdminUsers();
  renderAdminApis();
  fillAdminConfig();
  const logs = $("adminLogs"); logs.innerHTML = "";
  for (const entry of adminData.logs) {
    const item = document.createElement("li"); item.textContent = `${new Date(entry.created_at).toLocaleString()}  ${entry.action}`;
    logs.append(item);
  }
  if (!logs.children.length) logs.innerHTML = "<li>No audit activity.</li>";
  result.className = "result";
  result.textContent = "";
}

const userName = user => String(user?.display_name || "").trim() || "Unnamed user";
const userApiIds = user => Array.isArray(user?.assigned_api_ids) ? user.assigned_api_ids.map(String) : [];
const adminApiCatalog = () => {
  const catalog = new Map();
  for (const api of adminData.apis || []) if (api?.id) catalog.set(String(api.id), api);
  for (const api of settings.customProviders || []) if (api?.id) catalog.set(String(api.id), api);
  return [...catalog.values()];
};

function renderAdminStats() {
  const users = adminData.users;
  const apiIds = new Set([
    ...(settings.customProviders || []).map(api => api.id),
    ...(adminData.apis || []).map(api => api.id)
  ].filter(Boolean));
  const values = [
    ["Users", users.length],
    ["Active", users.filter(user => user.status === "active").length],
    ["Access", users.filter(user => user.access_granted === true).length],
    ["APIs", apiIds.size]
  ];
  $("adminStats").innerHTML = values.map(([label, value]) => `<div><b>${value}</b><span>${label}</span></div>`).join("");
}

function renderAdminUsers() {
  for (const button of all("[data-admin-filter]")) button.classList.toggle("active", button.dataset.adminFilter === adminFilter);
  const users = adminData.users.filter(user => user.status === adminFilter);
  $("adminUserCount").textContent = `${users.length} ${adminFilter} user${users.length === 1 ? "" : "s"}`;
  const list = $("adminUsers");
  list.innerHTML = "";
  for (const user of users) {
    const item = document.createElement("li");
    const summary = document.createElement("div"); summary.className = "adminUserSummary";
    const nameButton = document.createElement("button"); nameButton.type = "button"; nameButton.className = "adminUserName"; nameButton.textContent = userName(user);
    nameButton.addEventListener("click", () => item.classList.toggle("open"));
    const badges = document.createElement("div"); badges.className = "adminUserBadges";
    badges.innerHTML = `<span>${escapeHtml(user.status || "unknown")}</span><span>${user.access_granted ? "Access" : "No access"}</span>`;
    summary.append(nameButton, badges);

    const details = document.createElement("div"); details.className = "adminUserDetails";
    const email = document.createElement("p"); email.className = "adminUserEmail";
    email.textContent = `${user.email || "No email"} · ${user.last_seen_at ? `Last active ${new Date(user.last_seen_at).toLocaleString()}` : "No activity recorded"}`;
    const controls = document.createElement("div"); controls.className = "adminControls";
    const nameLabel = document.createElement("label"); nameLabel.textContent = "Name";
    const nameInput = document.createElement("input"); nameInput.value = user.display_name || ""; nameInput.maxLength = 80; nameLabel.append(nameInput);
    const statusLabel = document.createElement("label"); statusLabel.textContent = "Status";
    const status = document.createElement("select");
    for (const value of ["active", "paused", "suspended", "banned"]) status.add(new Option(value, value, false, user.status === value));
    statusLabel.append(status);
    const roleLabel = document.createElement("label"); roleLabel.textContent = "Role";
    const role = document.createElement("select");
    for (const value of user.role === "owner" ? ["owner"] : ["user", "admin"]) role.add(new Option(value, value, false, user.role === value));
    roleLabel.append(role);
    const accessLabel = document.createElement("label"); accessLabel.textContent = "Extension access";
    const access = document.createElement("select");
    access.add(new Option("Allowed", "true", false, user.access_granted === true));
    access.add(new Option("Removed", "false", false, user.access_granted !== true));
    accessLabel.append(access);
    const perms = document.createElement("div"); perms.className = "adminPerms";
    const checks = {};
    for (const permission of ["unfollow", "engage", "api_keys"]) {
      const label = document.createElement("label"); const checkbox = document.createElement("input");
      checkbox.type = "checkbox"; checkbox.checked = user.permissions?.[permission] === true; checks[permission] = checkbox;
      label.append(checkbox, document.createTextNode(permission)); perms.append(label);
    }
    const assignedNames = userApiIds(user).map(id => settings.customProviders.find(api => api.id === id)?.name || adminData.apis.find(api => api.id === id)?.name || id);
    const assigned = document.createElement("div"); assigned.className = "adminAssigned";
    assigned.textContent = `Assigned AI/API: ${assignedNames.length ? assignedNames.join(", ") : "Default AI only"}`;
    const activity = document.createElement("details"); activity.className = "adminUserActivity";
    const activitySummary = document.createElement("summary"); activitySummary.textContent = "Recent activity";
    const activityList = document.createElement("ul"); activityList.className = "auditList";
    const activityRows = adminData.logs.filter(entry => entry.target_id === user.id || entry.actor_id === user.id).slice(0, 5);
    for (const entry of activityRows) {
      const row = document.createElement("li");
      row.textContent = `${new Date(entry.created_at).toLocaleString()} - ${entry.action}`;
      activityList.append(row);
    }
    if (!activityRows.length) activityList.innerHTML = "<li>No activity recorded.</li>";
    activity.append(activitySummary, activityList);
    const save = document.createElement("button"); save.type = "button"; save.className = "primary adminSaveUser"; save.textContent = "Save User";
    role.disabled = account.profile?.role !== "owner" || user.role === "owner";
    if (user.role === "owner") {
      for (const control of [nameInput, status, role, access, ...Object.values(checks), save]) control.disabled = true;
    }
    save.addEventListener("click", async () => {
      save.disabled = true;
      const update = await send({ type: "admin:update-user", userId: user.id, patch: {
        display_name: nameInput.value, status: status.value, role: role.value,
        access_granted: access.value === "true",
        permissions: Object.fromEntries(Object.entries(checks).map(([key, box]) => [key, box.checked]))
      } });
      save.disabled = false;
      $("adminResult").className = update.ok === false ? "result bad" : "result ok";
      $("adminResult").textContent = update.ok === false ? update.error : `${userName({ display_name: nameInput.value })} updated.`;
      if (update.ok !== false) await loadAdmin();
    });
    controls.append(nameLabel, statusLabel, roleLabel, accessLabel, perms, assigned, save);
    details.append(email, controls, activity);
    item.append(summary, details);
    list.append(item);
  }
  $("adminUsersEmpty").hidden = users.length > 0;
}

function renderAdminApis() {
  const list = $("adminApiList");
  list.innerHTML = "";
  const providers = adminApiCatalog();
  $("adminApiEmpty").hidden = providers.length > 0;
  for (const provider of providers) {
    const assigned = adminData.users.filter(user => userApiIds(user).includes(provider.id)).length;
    const item = document.createElement("div"); item.className = "adminApiItem";
    const name = document.createElement("strong"); name.textContent = provider.name || "Custom API";
    const button = document.createElement("button"); button.type = "button"; button.textContent = "Assign Users";
    button.addEventListener("click", () => openApiAssign(provider.id));
    const meta = document.createElement("small"); meta.textContent = `${provider.model || "No model"} · ${assigned} assigned user${assigned === 1 ? "" : "s"}`;
    item.append(name, button, meta); list.append(item);
  }
}

function openApiAssign(providerId) {
  const provider = adminApiCatalog().find(item => item.id === providerId);
  if (!provider) return;
  assigningProviderId = providerId;
  $("apiAssignTitle").textContent = `Assign ${provider.name || "Custom API"}`;
  $("apiAssignResult").textContent = "";
  const host = $("apiAssignUsers"); host.innerHTML = "";
  for (const user of adminData.users.filter(item => item.role !== "owner")) {
    const label = document.createElement("label"); label.className = "apiAssignUser";
    const input = document.createElement("input"); input.type = "checkbox"; input.value = user.id; input.checked = userApiIds(user).includes(providerId);
    const name = document.createElement("span"); name.textContent = userName(user);
    label.append(input, name); host.append(label);
  }
  if (!host.children.length) host.innerHTML = '<p class="empty">No assignable users.</p>';
  $("apiAssignModal").hidden = false;
}

function closeApiAssign() {
  assigningProviderId = "";
  $("apiAssignModal").hidden = true;
}

function fillAdminConfig() {
  const config = adminData.remote?.config || {};
  const policy = config.policy || {};
  $("adminMaintenance").checked = config.maintenance_mode === true;
  for (const [id, key] of [["adminAllowUnfollow", "allow_unfollow"], ["adminAllowEngage", "allow_engage"], ["adminAllowAi", "allow_ai"], ["adminAllowKeys", "allow_user_api_keys"], ["adminAllowCustom", "allow_custom_providers"], ["adminFallback", "fallback_enabled"]]) $(id).checked = policy[key] !== false;
  for (const [id, key] of [["adminEngageMax", "engage_max_actions"], ["adminEngageMin", "engage_min_delay_sec"], ["adminEngageMaxDelay", "engage_max_delay_sec"], ["adminUnfollowMin", "unfollow_min_delay_sec"], ["adminUnfollowMax", "unfollow_max_delay_sec"], ["adminCooldown", "cooldown_minutes"], ["adminRemotePrompt", "remote_prompt"], ["adminOpenaiModel", "openai_model"], ["adminAnthropicModel", "anthropic_model"]]) $(id).value = policy[key] ?? "";
}

function optionalAdminNumber(id) {
  const value = $(id).value.trim();
  return value === "" ? null : Number(value);
}

function escapeHtml(value) { return String(value || "").replace(/[&<>\"']/g, char => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[char])); }

// Shows one automation card and hides the other. Hidden cards stay in the DOM, so collect()
// still saves their fields and renderRuntime still updates their counters — only the display
// changes. Nothing here writes to storage, so a 1s refresh can never move the open card.
function showAutomation(channel) {
  for (const button of all("[data-auto]")) {
    const on = button.dataset.auto === channel;
    button.classList.toggle("active", on);
    button.setAttribute("aria-selected", String(on));
  }
  for (const name of ["unfollow", "engage"]) $(`${name}Section`).hidden = name !== channel;
  document.querySelector("main").scrollTop = 0;
  window.scrollTo(0, 0);
}

function showProviderPanel(name) {
  for (const button of all("[data-provider-panel]")) button.classList.toggle("active", button.dataset.providerPanel === name);
  for (const panel of all("[data-provider-view]")) panel.hidden = panel.dataset.providerView !== name;
}

function copySelectOptions(from, to, value) {
  to.innerHTML = "";
  for (const option of from.options) to.add(new Option(option.textContent, option.value));
  to.value = value || "";
}

function renderAiChoices() {
  const host = $("aiChoiceList");
  if (!host) return;
  host.replaceChildren();
  const providers = [
    ...Object.values(BUILTIN_PROVIDERS).map(item => ({ ref: item.id, name: item.name || item.label || item.id, model: settings[item.id]?.model || "", configured: !!settings[item.id]?.apiKey })),
    ...(settings.customProviders || []).map(item => ({ ref: `custom:${item.id}`, name: item.name || "Custom API", model: item.model || "", configured: !!item.apiKey }))
  ];
  for (const provider of providers) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `aiChoice${settings.activeProvider === provider.ref ? " active" : ""}`;
    const indicator = document.createElement("span");
    const state = providerAvailability.get(provider.ref) || (provider.configured ? "available" : "unavailable");
    indicator.className = `aiState ${state}`;
    const name = document.createElement("b"); name.textContent = provider.name;
    const model = document.createElement("small");
    model.textContent = `${provider.model || "Not configured"} · ${state === "limited" ? "Limit reached" : state === "available" ? "Available" : "Unavailable"}`;
    button.append(indicator, name, model);
    button.addEventListener("click", async () => {
      button.disabled = true;
      const result = $("aiChoiceResult");
      result.className = "result busy"; result.textContent = `Checking ${provider.name}...`;
      const tested = await send({ type: "provider:test", ref: provider.ref });
      const limitReached = tested.ok !== true && /(?:429|rate limit|quota|usage limit|credit|billing limit)/i.test(tested.error || "");
      providerAvailability.set(provider.ref, tested.ok === true ? "available" : limitReached ? "limited" : "unavailable");
      if (tested.ok !== true) {
        result.className = "result bad"; result.textContent = tested.error || `${provider.name} is unavailable or its limit has been reached.`;
        renderAiChoices();
        return;
      }
      const saved = await send({ type: "save-settings", patch: { activeProvider: provider.ref, engage: { provider: "" } } });
      if (saved.settings) adopt(saved.settings);
      result.className = "result ok"; result.textContent = `${provider.name} is now the default AI.`;
      renderAiChoices();
    });
    host.append(button);
  }
}

function openConfigModal(name) {
  activeConfig = name;
  $("configTitle").textContent = `${name[0].toUpperCase()}${name.slice(1)} settings`;
  for (const view of all(".configView")) view.hidden = view.id !== `config${name[0].toUpperCase()}${name.slice(1)}`;
  $("saveConfig").hidden = name === "process";
  $("configResult").textContent = "";
  if (name === "use") {
    $("modalSource").value = settings.engage.source;
    const modalGuardianModeField = $("modalGuardianModeField");
    if (modalGuardianModeField) modalGuardianModeField.hidden = settings.engage.source !== "guardian";
    const modalPostLinkField = $("modalPostLinkField");
    if (modalPostLinkField) modalPostLinkField.hidden = settings.engage.source !== "links";
    $("modalPostLinkBox").value = (settings.engage.postLinks || []).join("\n");
    $("modalProfileLinkBox").value = (settings.engage.profileLinks || []).join("\n");
    $("modalProfileLinkField").hidden = settings.engage.source !== "profiles";
    setPostLinkHint("modalPostLinkHint", settings.engage.postLinks || []);
    setGuardianModeButtons("modal", settings.engage.guardianMode || "x");
    copySelectOptions($("engageProvider"), $("modalProvider"), settings.engage.provider);
    copySelectOptions($("engageTemplate"), $("modalTemplate"), settings.engage.templateId);
  } else if (name === "process") {
    renderAiChoices();
  } else if (name === "command") {
    $("modalActions").value = settings.engage.actions;
    $("modalRandomMin").value = settings.engage.randomMinSec;
    $("modalRandomMax").value = settings.engage.randomMaxSec;
  } else if (name === "topic") {
    $("modalMinTweet").value = settings.engage.minTweetChars;
    $("modalOnlyAuthors").value = (settings.engage.onlyAuthors || []).map(name => `@${name}`).join("\n");
    $("modalSkipAuthors").value = (settings.engage.skipAuthors || []).map(name => `@${name}`).join("\n");
    $("modalSkipPromoted").checked = settings.engage.skipPromoted;
    $("modalSkipLiked").checked = settings.engage.skipLiked;
  } else if (name === "target") {
    $("modalMaxActions").value = settings.engage.maxActions;
    $("modalMaxChars").value = settings.engage.maxChars;
  }
  $("configModal").hidden = false;
}

async function saveConfigModal() {
  let patch = {};
  if (activeConfig === "use") patch = {
    source: $("modalSource").value,
    guardianMode: selectedGuardianMode("modal"),
    postLinks: parsePostLinks($("modalPostLinkBox").value), profileLinks: parseProfileLinks($("modalProfileLinkBox").value),
    provider: $("modalProvider").value, templateId: $("modalTemplate").value
  };
  if (activeConfig === "command") patch = { actions: $("modalActions").value,
    randomMinSec: Number($("modalRandomMin").value), randomMaxSec: Number($("modalRandomMax").value) };
  if (activeConfig === "topic") patch = { minTweetChars: Number($("modalMinTweet").value),
    onlyAuthors: parseUsernames($("modalOnlyAuthors").value), skipAuthors: parseUsernames($("modalSkipAuthors").value),
    skipPromoted: $("modalSkipPromoted").checked, skipLiked: $("modalSkipLiked").checked };
  if (activeConfig === "target") patch = { maxActions: Number($("modalMaxActions").value), maxChars: Number($("modalMaxChars").value) };
  const response = await send({ type: "save-settings", patch: { engage: patch } });
  const result = $("configResult");
  if (response.ok === false) { result.className = "result bad"; result.textContent = response.error; return; }
  adopt(response.settings); fill(); result.className = "result ok"; result.textContent = "Saved.";
}

function wire() {
  for (const tab of all(".tab")) tab.addEventListener("click", () => showTab(tab.dataset.tab));
  for (const tab of all(".bottomTab")) tab.addEventListener("click", () => showTab(tab.dataset.tab));
  for (const button of all("[data-provider-panel]")) button.addEventListener("click", () => showProviderPanel(button.dataset.providerPanel));
  for (const button of all("[data-config-modal]")) button.addEventListener("click", () => openConfigModal(button.dataset.configModal));
  const mainRunControl = $("engageMainControl");
  if (mainRunControl) mainRunControl.addEventListener("click", () => runButton(mainRunControl, async () => {
    const status = latestRuntime?.engage?.status || "Idle";
    if (status === "Paused" || status === "Error") await send({ type: "engage:resume" });
    else if (["Running", "Demo", "Cooldown"].includes(status)) await send({ type: "engage:stop" });
    else await startRun("engage", false);
    await refresh();
  }));
  for (const button of all("[data-guardian-mode]")) {
    button.addEventListener("click", async () => {
      const scope = button.dataset.guardianScope;
      setGuardianModeButtons(scope, button.dataset.guardianMode);
      if (scope !== "main") return;
      const response = await send({ type: "save-settings", patch: { engage: { guardianMode: button.dataset.guardianMode } } });
      if (response.settings) { adopt(response.settings); fill(); }
    });
  }
  const modalSource = $("modalSource");
  if (modalSource) {
    modalSource.addEventListener("change", () => {
      const modalGuardianModeField = $("modalGuardianModeField");
      if (modalGuardianModeField) modalGuardianModeField.hidden = modalSource.value !== "guardian";
      const modalPostLinkField = $("modalPostLinkField");
      if (modalPostLinkField) modalPostLinkField.hidden = modalSource.value !== "links";
      const modalProfileLinkField = $("modalProfileLinkField");
      if (modalProfileLinkField) modalProfileLinkField.hidden = modalSource.value !== "profiles";
    });
  }
  const postLinkFile = $("postLinkFile");
  if (postLinkFile) postLinkFile.addEventListener("change", () => importPostLinkFile("postLinkFile", "postLinkBox", "postLinkHint", true));
  const modalPostLinkFile = $("modalPostLinkFile");
  if (modalPostLinkFile) modalPostLinkFile.addEventListener("change", () => importPostLinkFile("modalPostLinkFile", "modalPostLinkBox", "modalPostLinkHint", false));
  const modalPostLinkBox = $("modalPostLinkBox");
  if (modalPostLinkBox) modalPostLinkBox.addEventListener("blur", () => {
    const links = parsePostLinks(modalPostLinkBox.value);
    modalPostLinkBox.value = links.join("\n");
    setPostLinkHint("modalPostLinkHint", links);
  });
  for (const button of all("[data-jump]")) button.addEventListener("click", () => {
    const target = $(button.dataset.jump);
    if (target?.tagName === "DETAILS") target.open = true;
    target?.scrollIntoView({ block: "start", behavior: "smooth" });
    target?.focus?.();
  });
  for (const button of all("[data-auto]")) {
    button.addEventListener("click", () => showAutomation(button.dataset.auto));
  }

  // "Manage APIs" / "Manage formats" jump straight to the section that owns the setting.
  for (const link of all("[data-goto]")) {
    link.addEventListener("click", event => {
      event.preventDefault();
      showTab(link.dataset.goto);
    });
  }

  for (const element of all("[data-path]")) {
    const immediate = element.tagName === "SELECT" || element.type === "checkbox" || element.type === "radio";
    element.addEventListener(immediate ? "change" : "blur", async () => {
      // Numbers are clamped by the worker, so redraw to show the value that was actually stored.
      let response;
      if (immediate || element.type === "number") response = await persistAndRefill();
      else {
        response = await persist();
        // Text fields get repaired too: emptying the prompt restores the default, and without
        // this the box would keep showing blank while a real prompt sat in storage.
        if (response.ok !== false) {
          writeControl(element, getPath(settings, element.dataset.path));
          syncConditionalFields();
        }
      }
      if (response.ok === false) {
        element.setCustomValidity?.(response.error || "This setting could not be saved.");
        element.reportValidity?.();
      } else {
        element.setCustomValidity?.("");
      }
    });
  }

  for (const button of all("[data-reveal]")) {
    button.addEventListener("click", () => {
      const input = $(button.dataset.reveal);
      const hidden = input.type === "password";
      input.type = hidden ? "text" : "password";
      button.textContent = hidden ? "Hide" : "Show";
    });
  }

  for (const button of all("[data-test]")) {
    button.addEventListener("click", () => runButton(button,
      () => testProvider(button.dataset.test, `${button.dataset.test}Result`)));
  }

  for (const button of all("[data-enable]")) {
    button.addEventListener("click", () => runButton(button, async () => {
      const channel = button.dataset.enable;
      const enable = button.dataset.value === "true";
      const response = await send({ type: "save-settings", patch: { [channel]: { enabled: enable } } });
      if (response.ok === false) {
        await send({ type: "progress", channel, patch: { error: response.error } });
        await refresh();
        return;
      }
      if (response.settings) adopt(response.settings);
      renderToggles();
      refresh();
    }));
  }

  for (const button of all("[data-run]")) {
    button.addEventListener("click", () => runButton(button, async () => {
      const channel = button.dataset.run;
      const demo = button.dataset.demo === "true";
      if (demo) return await startRun(channel, true);
      const text = channel === "unfollow"
        ? "Accounts will be unfollowed one at a time, with delays and cooldowns between batches."
        : settings.engage.source === "guardian"
          ? settings.engage.guardianMode === "tg"
            ? "Telegram Guardian post links will be opened serially and processed with the selected actions."
            : "X Guardian profiles will be processed serially. Pinned posts are ignored and only the second relevant post is checked before the selected actions run."
          : settings.engage.source === "links"
            ? "Post Links will be opened serially, read with minimal scrolling, skipped when already engaged, and processed with the selected actions."
          : settings.engage.source === "profiles"
            ? "Saved Profile Links will be visited serially. Pinned posts are ignored and only the two most recent qualifying posts are checked before processing."
          : "Posts from the selected source will be processed on your account, one at a time.";
      confirmAction(channel === "unfollow" ? "Start unfollowing" : "Start liking and commenting", text, () => startRun(channel, false));
    }));
  }

  for (const button of all("[data-cmd]")) {
    button.addEventListener("click", () => runButton(button, async () => {
      const command = button.dataset.cmd;
      if (command.endsWith(":reset")) {
        return confirmAction("Reset progress", "Saved counters are cleared and the page worker stops.", async () => {
          await send({ type: command });
          refresh();
        });
      }
      const response = await send({ type: command });
      if (response.ok === false) {
        const channel = command.split(":")[0];
        await send({ type: "progress", channel, patch: { error: response.error } });
      }
      refresh();
    }));
  }

  $("resetPrompt").addEventListener("click", async () => {
    const response = await send({ type: "save-settings", patch: { engage: { prompt: DEFAULT_SETTINGS.engage.prompt } } });
    if (response.ok === false) {
      $("previewResult").className = "result bad";
      $("previewResult").textContent = response.error;
      return;
    }
    if (response.settings) adopt(response.settings);
    fill();
  });

  $("previewComment").addEventListener("click", () => runButton($("previewComment"), async () => {
    const result = $("previewResult");
    result.className = "result busy";
    result.textContent = "Asking the model...";
    const saved = await persist();
    if (saved.ok === false) {
      result.className = "result bad";
      result.textContent = saved.error;
      return;
    }
    const response = await send({ type: "ai:comment", tweet: SAMPLE_TWEET });
    result.className = `result ${response.ok ? "ok" : "bad"}`;
    result.textContent = response.ok ? `${response.provider}: ${response.text}` : response.error;
  }));

  $("customAdd").addEventListener("click", () => runButton($("customAdd"), saveCustom));
  $("customCancel").addEventListener("click", resetCustomForm);
  $("customTest").addEventListener("click", () => runButton($("customTest"), async () => {
    const form = customForm();
    const result = $("customResult");
    if (!form.url || !form.model) {
      result.className = "result bad";
      result.textContent = "Add a URL and a model name before testing.";
      return;
    }
    result.className = "result busy";
    result.textContent = "Saving, then testing...";
    const id = await saveCustom();
    if (id) await testProvider(`custom:${id}`, "customResult");
  }));
  $("customUrl").addEventListener("blur", updateUrlPreview);
  $("customFormat").addEventListener("change", updateUrlPreview);

  $("clearLogs").addEventListener("click", async () => { await send({ type: "clear-logs" }); refresh(); });
  $("cancelConfirm").addEventListener("click", closeConfirm);
  $("approveConfirm").addEventListener("click", () => {
    const action = pending;
    closeConfirm();
    action?.();
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !$("confirmModal").hidden) closeConfirm();
    if (event.key === "Escape" && !$("configModal").hidden) $("configModal").hidden = true;
    if (event.key === "Escape" && !$("apiAssignModal").hidden) closeApiAssign();
  });

  $("formatAdd").addEventListener("click", () => runButton($("formatAdd"), saveFormat));
  $("formatCancel").addEventListener("click", resetFormatForm);
  $("formatMode").addEventListener("change", renderFormatModeHint);
  $("formatPreview").addEventListener("click", () => runButton($("formatPreview"), async () => {
    const form = formatForm();
    if (!form.body.trim()) {
      $("formatResult").className = "result bad";
      $("formatResult").textContent = "Write something in the format box first.";
      return;
    }
    const name = form.name || "Untitled preview";
    await previewFormat({ ...form, name }, "formatResult");
  }));

  const authAction = async () => {
    const result = $("accountAuthResult");
    result.className = "result busy"; result.textContent = "Working...";
    const response = await send({ type: "auth:google" });
    if (response.ok === false) { result.className = "result bad"; result.textContent = response.error; return; }
    if (response.pending) {
      result.className = "result ok";
      result.textContent = "Google sign-in opened in a new tab. Complete it, then reopen the extension.";
      return;
    }
    result.className = "result ok";
    result.textContent = response.needsVerification ? "Check your email to verify the account." : "Signed in.";
    await refreshAccount();
  };
  $("accountGoogle").addEventListener("click", authAction);
  $("accountLogout").addEventListener("click", async () => { await send({ type: "auth:logout" }); renderAccount({ signedIn: false }); });
  $("pendingLogout").addEventListener("click", async () => { await send({ type: "auth:logout" }); renderAccount({ signedIn: false }); });
  $("pendingRefresh").addEventListener("click", refreshAccount);
  $("saveProfileName").addEventListener("click", () => runButton($("saveProfileName"), async () => {
    const result = $("profileResult");
    const response = await send({ type: "account:update-profile", displayName: $("profileName").value });
    result.className = response.ok === false ? "result bad" : "result ok";
    result.textContent = response.ok === false ? response.error : "Name saved.";
    if (response.ok !== false) await refreshAccount();
  }));
  for (const button of all("[data-admin-filter]")) {
    button.addEventListener("click", () => {
      adminFilter = button.dataset.adminFilter;
      renderAdminUsers();
    });
  }
  $("closeApiAssign").addEventListener("click", closeApiAssign);
  $("cancelApiAssign").addEventListener("click", closeApiAssign);
  $("saveApiAssign").addEventListener("click", () => runButton($("saveApiAssign"), async () => {
    const result = $("apiAssignResult");
    const catalogProvider = adminApiCatalog().find(item => item.id === assigningProviderId);
    if (!catalogProvider) {
      result.className = "result bad";
      result.textContent = "This Custom API is no longer available.";
      return;
    }
    const provider = settings.customProviders.find(item => item.id === assigningProviderId) || null;
    const userIds = all('#apiAssignUsers input[type="checkbox"]:checked').map(input => input.value);
    const response = await send({ type: "admin:set-api-users", providerId: assigningProviderId, provider, userIds });
    result.className = response.ok === false ? "result bad" : "result ok";
    result.textContent = response.ok === false ? response.error : `Access saved for ${userIds.length} user${userIds.length === 1 ? "" : "s"}.`;
    if (response.ok === false) return;
    await loadAdmin();
    closeApiAssign();
    $("adminResult").className = "result ok";
    $("adminResult").textContent = `Custom API access updated for ${userIds.length} user${userIds.length === 1 ? "" : "s"}.`;
  }));
  $("saveAdminConfig").addEventListener("click", () => runButton($("saveAdminConfig"), async () => {
    const result = $("adminResult");
    const policy = {
      allow_unfollow: $("adminAllowUnfollow").checked,
      allow_engage: $("adminAllowEngage").checked,
      allow_ai: $("adminAllowAi").checked,
      allow_user_api_keys: $("adminAllowKeys").checked,
      allow_custom_providers: $("adminAllowCustom").checked,
      fallback_enabled: $("adminFallback").checked,
      engage_max_actions: optionalAdminNumber("adminEngageMax"),
      engage_min_delay_sec: optionalAdminNumber("adminEngageMin"),
      engage_max_delay_sec: optionalAdminNumber("adminEngageMaxDelay"),
      unfollow_min_delay_sec: optionalAdminNumber("adminUnfollowMin"),
      unfollow_max_delay_sec: optionalAdminNumber("adminUnfollowMax"),
      cooldown_minutes: optionalAdminNumber("adminCooldown"),
      remote_prompt: $("adminRemotePrompt").value.trim(),
      openai_model: $("adminOpenaiModel").value.trim(),
      anthropic_model: $("adminAnthropicModel").value.trim()
    };
    const response = await send({ type: "admin:update-config", maintenance_mode: $("adminMaintenance").checked, policy });
    result.className = response.ok === false ? "result bad" : "result ok";
    result.textContent = response.ok === false ? response.error : `Configuration saved (version ${response.config?.config_version || 0}).`;
    if (response.ok !== false) await loadAdmin();
  }));
  $("saveAdminSettings").addEventListener("click", async () => {
    const result = $("adminResult");
    const response = await send({ type: "admin:update-settings", ownerTelegram: $("adminTelegram").value });
    result.className = response.ok === false ? "result bad" : "result ok";
    result.textContent = response.ok === false ? response.error : "Telegram username saved.";
    if (response.ok !== false) refreshAccount();
  });
  $("adminRefresh").addEventListener("click", loadAdmin);
  const communityScan = $("communityScan");
  if (communityScan) {
    communityScan.addEventListener("click", () => runButton(communityScan, async () => {
      const result = $("communityResult");
      if (result) { result.className = "result busy"; result.textContent = "Opening Guardian popup..."; }

      const response = await send({ type: "guardian:focus", target: settings.engage.guardianMode || "x" });
      if (response.ok === false) {
        if (result) {
          result.className = "result bad";
          result.textContent = response.error || "Guardian popup could not be opened.";
        }
        return;
      }

      renderCommunity(response);
      if (result) {
        result.className = "result ok";
        result.textContent = "Guardian popup opened. Add a source link there to scan.";
      }
    }));
  }

  const guardianStop = $("guardianStop");
  if (guardianStop) {
    guardianStop.addEventListener("click", () => runButton(guardianStop, async () => {
      const response = await send({ type: "guardian:stop" });
      const result = $("communityResult");
      if (result) {
        result.className = response.ok === false ? "result bad" : "result ok";
        result.textContent = response.ok === false ? response.error : "Guardian stopped and popup closed.";
      }
      renderCommunity(response);
    }));
  }

  const guardianClearQueue = $("guardianClearQueue");
  if (guardianClearQueue) {
    guardianClearQueue.addEventListener("click", () => {
      confirmAction("Clear Guardian queues", "All X profiles, Telegram links, and live statuses will be removed. Completed-post duplicate history will be kept.", () => runButton(guardianClearQueue, async () => {
        const response = await send({ type: "guardian:clear" });
        const result = $("communityResult");
        if (response.ok === false) {
          if (result) { result.className = "result bad"; result.textContent = response.error; }
          return;
        }
        renderCommunity(response);
        if (result) { result.className = "result ok"; result.textContent = "Guardian queue cleared."; }
      }));
    });
  }

  $("closeConfig").addEventListener("click", () => { $("configModal").hidden = true; });
  $("saveConfig").addEventListener("click", () => runButton($("saveConfig"), saveConfigModal));
}

async function initialize() {
  populateStaticOptions();
  wire();
  const state = await send({ type: "get-all" });
  if (state.ok === false || !state.settings) {
    populated = false;
    const warning = $("remoteWarning");
    if (warning) {
      warning.hidden = false;
      warning.textContent = state.error || "The extension worker did not respond. Reload the extension.";
    }
    const remoteBar = $("remoteBar");
    if (remoteBar) remoteBar.className = "remoteBar error";
    for (const button of all("[data-run], [data-enable], [data-test]")) button.disabled = true;
    showAutomation("unfollow");
    refreshAccount();
    setInterval(refresh, 1000);
    setInterval(refreshAccount, 30000);
    return;
  }
  adopt(state.settings);
  fill();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.communityReview) return;
    renderCommunity(changes.communityReview.newValue || {});
  });
  // Open the card the user most likely came for: whichever is running, else the only one they
  // have enabled. Falling straight back to Unfollow keeps the first-open view predictable.
  const running = ["unfollow", "engage"].find(name => ACTIVE.includes(state[name]?.status));
  const onlyEngage = settings.engage.enabled && !settings.unfollow.enabled;
  showAutomation(running || (onlyEngage ? "engage" : "unfollow"));
  renderRuntime(state);
  renderLogs(state.logs);
  renderRemote(state.remote);
  renderCommunity(state.community);
  resetCustomForm();
  resetFormatForm();
  await refreshAccount();
  if (!account.signedIn || !account.profile || (account.profile.access_granted !== true && !["owner", "admin"].includes(account.profile.role))) showTab("account");
  setInterval(refresh, 1000);
  setInterval(refreshAccount, 30000);
}

initialize();
