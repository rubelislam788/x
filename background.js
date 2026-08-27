import {
  KEYS, DEFAULT_SETTINGS, withDefaults, mergeSettings, clamp, LIMITS,
  parseUsernames, normalizeUsername, timingPlan, resolveProvider, resolveProviderFor, providerRefFor,
  sanitizeTemplate, findTemplate, templateNeedsAI
} from "./defaults.js";
import { generateComment, testProvider, resolveEndpoint } from "./llm.js";

const SUPABASE_URL = "https://xlheiteyhehitebsexox.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_QLmZcK9-N1S-oP4_hpFaWg_u8MsW7l-";
const SUPABASE_SESSION_KEY = "supabaseSession";
const ACTIVITY_LEDGER_KEY = "activityLedger24h";
const ACTIVITY_LEDGER_ALARM = "activity-ledger-midnight";
const ASSIGNED_PROVIDERS_KEY = "assignedCustomProviders";
const LAST_ACTIVE_TAB_KEY = "lastActiveTabId";

const CONTENT_FILES = ["content.js", "unfollow.js", "engage.js"];
const X_TAB_URLS = ["https://x.com/*", "https://*.x.com/*", "https://twitter.com/*", "https://*.twitter.com/*"];
const TELEGRAM_TAB_URLS = ["https://t.me/*", "https://*.t.me/*", "https://telegram.me/*", "https://*.telegram.me/*", "https://web.telegram.org/*"];
const GUARDIAN_URLS = [...X_TAB_URLS, ...TELEGRAM_TAB_URLS];
const X_URL = /^https:\/\/(?:(?:www|mobile|m)\.)?(?:x|twitter)\.com(?:\/|$)/i;
const TELEGRAM_URL = /^https:\/\/(?:(?:(?:www|mobile|m)\.)?(?:t\.me|telegram\.me)|web\.telegram\.org)(?:\/|$)/i;
const ACTIVE = ["Running", "Paused", "Cooldown", "Demo"];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const REMOTE_DEFAULT = {
  config_version: 0, maintenance_mode: false, updated_at: null,
  policy: { allow_unfollow: true, allow_engage: true, allow_ai: true, allow_user_api_keys: true,
    allow_custom_providers: true, fallback_enabled: true }
};

const activityLedgerCycle = (now = new Date()) => [
  now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")
].join("-");

function extensionApiCall(target, method, ...args) {
  return new Promise((resolve, reject) => {
    if (!target || typeof target[method] !== "function") {
      reject(new Error(`Browser API ${method} is unavailable.`));
      return;
    }
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    const callback = value => {
      const lastError = chrome.runtime?.lastError;
      finish(lastError ? new Error(lastError.message || String(lastError)) : null, value);
    };
    try {
      const pending = target[method](...args, callback);
      if (pending && typeof pending.then === "function") {
        pending.then(value => finish(null, value)).catch(error => finish(error));
      }
    } catch (callbackError) {
      try {
        const pending = target[method](...args);
        if (pending && typeof pending.then === "function") {
          pending.then(value => finish(null, value)).catch(error => finish(error));
        } else {
          finish(null, pending);
        }
      } catch (error) {
        finish(error || callbackError);
      }
    }
  });
}

const localStorageGet = async keys => (await extensionApiCall(chrome.storage?.local, "get", keys)) || {};
const localStorageSet = values => extensionApiCall(chrome.storage?.local, "set", values);
const localStorageRemove = keys => extensionApiCall(chrome.storage?.local, "remove", keys);
const storageAreaGet = async (area, keys) => (await extensionApiCall(area, "get", keys)) || {};
const storageAreaSet = (area, values) => extensionApiCall(area, "set", values);
const tabsQuery = query => extensionApiCall(chrome.tabs, "query", query);
const tabsGet = tabId => extensionApiCall(chrome.tabs, "get", tabId);
const tabsUpdate = (tabId, properties) => extensionApiCall(chrome.tabs, "update", tabId, properties);
const tabsCreate = properties => extensionApiCall(chrome.tabs, "create", properties);
const tabsSendMessage = (tabId, message) => extensionApiCall(chrome.tabs, "sendMessage", tabId, message);
const executeScript = details => extensionApiCall(chrome.scripting, "executeScript", details);

async function rotateActivityLedger() {
  const cycle = activityLedgerCycle();
  const bag = await localStorageGet(ACTIVITY_LEDGER_KEY);
  const stored = bag[ACTIVITY_LEDGER_KEY];
  if (stored?.cycle === cycle && stored.profiles && Array.isArray(stored.records)) return;
  await localStorageSet({ [ACTIVITY_LEDGER_KEY]: { cycle, profiles: {}, records: [] }, engageCompletedPosts: {} });
}

let activityLedgerQueue = Promise.resolve();

function queueActivityLedger(task) {
  const pending = activityLedgerQueue.then(task, task);
  activityLedgerQueue = pending.catch(() => null);
  return pending;
}

const normalizeLedgerProfile = value => String(value || "").trim().replace(/^@+/, "").toLowerCase().replace(/[^a-z0-9_]/g, "");

async function activityLedgerStatus(profileValue) {
  await activityLedgerQueue.catch(() => null);
  await rotateActivityLedger();
  const profile = normalizeLedgerProfile(profileValue);
  const ledger = (await localStorageGet(ACTIVITY_LEDGER_KEY))[ACTIVITY_LEDGER_KEY] || { profiles: {} };
  const engaged = !!profile && Object.prototype.hasOwnProperty.call(ledger.profiles || {}, profile);
  return { ok: true, engaged, reason: engaged ? "Already Engaged with this Profile within the last 24 hours" : "" };
}

function recordActivity(recordValue) {
  return queueActivityLedger(async () => {
    await rotateActivityLedger();
    const profile = normalizeLedgerProfile(recordValue?.profile);
    const actions = [...new Set((Array.isArray(recordValue?.actions) ? recordValue.actions : [])
      .map(value => String(value || "").trim()).filter(value => ["Like", "Comment", "Like/Comment"].includes(value)))];
    if (!profile || !actions.length) return { ok: false, error: "A profile and activity are required." };
    const bag = await localStorageGet(ACTIVITY_LEDGER_KEY);
    const ledger = bag[ACTIVITY_LEDGER_KEY] || { cycle: activityLedgerCycle(), profiles: {}, records: [] };
    const now = Date.now();
    const record = {
      at: now,
      profile,
      profileUrl: `https://x.com/${profile}`,
      postId: String(recordValue?.postId || "").replace(/\D/g, "").slice(0, 32),
      postUrl: normalizeXPostLink(recordValue?.postUrl) || "",
      actions,
      mode: String(recordValue?.mode || "unknown").slice(0, 40),
      detected: recordValue?.detected === true
    };
    const previous = Object.prototype.hasOwnProperty.call(ledger.profiles || {}, profile) ? ledger.profiles[profile] : {};
    ledger.records = [...(Array.isArray(ledger.records) ? ledger.records : []), record].slice(-5000);
    ledger.profiles = { ...(ledger.profiles || {}), [profile]: {
      ...previous,
      profile,
      profileUrl: record.profileUrl,
      lastAt: now,
      lastPostId: record.postId,
      lastPostUrl: record.postUrl,
      actions: [...new Set([...(previous.actions || []), ...actions])]
    } };
    await localStorageSet({ [ACTIVITY_LEDGER_KEY]: ledger });
    return { ok: true };
  });
}

function scheduleActivityLedgerRotation() {
  const midnight = new Date();
  midnight.setHours(24, 0, 1, 0);
  chrome.alarms.create(ACTIVITY_LEDGER_ALARM, { when: midnight.getTime() });
}

function normalizeXPostLink(value) {
  try {
    const url = new URL(String(value || "").trim());
    const host = url.hostname.toLowerCase().replace(/^(?:www|mobile|m)\./, "").replace(/^telegram\.me$/, "t.me");
    if (!["x.com", "twitter.com"].includes(host)) return "";
    const direct = /^\/([^/]+)\/status\/(\d+)/i.exec(url.pathname);
    if (direct && direct[1].toLowerCase() !== "i") return `https://x.com/${direct[1]}/status/${direct[2]}`;
    const match = /\/status\/(\d+)/i.exec(url.pathname);
    return match ? `https://x.com/i/web/status/${match[1]}` : "";
  } catch { return ""; }
}
function normalizeXProfileLink(value) {
  try {
    const url = new URL(String(value || "").trim(), "https://x.com/");
    const host = url.hostname.toLowerCase().replace(/^(?:www|mobile|m)\./, "");
    if (!["x.com", "twitter.com"].includes(host)) return "";
    const username = url.pathname.split("/").filter(Boolean)[0] || "";
    if (!/^[A-Za-z0-9_]{1,15}$/.test(username) || /^(home|explore|notifications|messages|bookmarks|lists|settings|compose|i|search|login|signup|jobs|communities|premium)$/i.test(username)) return "";
    return `https://x.com/${username.toLowerCase()}`;
  } catch { return ""; }
}
function normalizeGuardianLink(value, base = "https://t.me/") {
  try {
    const url = new URL(String(value || "").trim(), base);
    const host = url.hostname.toLowerCase().replace(/^(?:www|mobile|m)\./, "").replace(/^telegram\.me$/, "t.me");
    if (["x.com", "twitter.com"].includes(host)) return normalizeXPostLink(url.href);
    if (host !== "t.me") return "";
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0]?.toLowerCase() === "s") parts.shift();
    if (!parts.length || ["share", "iv", "login"].includes(parts[0].toLowerCase())) return "";
    return `https://t.me/${parts.join("/")}`;
  } catch { return ""; }
}
function normalizeAssignedApiIds(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(item => String(item || "").trim()).filter(Boolean))].slice(0, 25);
}
function sanitizeAccountProvider(item) {
  const id = String(item?.id || "").trim().slice(0, 80);
  const url = String(item?.url || "").trim();
  const model = String(item?.model || "").trim().slice(0, 120);
  if (!id || !url || !model) return null;
  return {
    id,
    name: String(item?.name || "Custom API").trim().slice(0, 60),
    url,
    apiKey: String(item?.apiKey || "").trim(),
    model,
    format: item?.format === "anthropic" ? "anthropic" : "openai",
    headerName: String(item?.headerName || "").trim().slice(0, 80),
    headerPrefix: typeof item?.headerPrefix === "string" ? item.headerPrefix.slice(0, 80) : "",
    assigned: true
  };
}
function decodeHtmlAttribute(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)));
}
function normalizeCollectedLink(value, base = "https://t.me/") {
  try {
    const url = new URL(decodeHtmlAttribute(value), base);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.hash = "";
    url.hostname = url.hostname.toLowerCase().replace(/^(?:www|mobile|m)\./, "").replace(/^telegram\.me$/, "t.me");
    if (["x.com", "twitter.com"].includes(url.hostname) && /\/status\/\d+/.test(url.pathname)) return normalizeXPostLink(url.href);
    if (url.hostname === "t.me") {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0]?.toLowerCase() === "s") parts.shift();
      url.pathname = `/${parts.join("/")}`;
    }
    return url.href;
  } catch { return ""; }
}
function isTelegramUiLink(value, channel = "", messageId = "") {
  try {
    const url = new URL(value);
    if (url.hostname !== "t.me") return false;
    const parts = url.pathname.split("/").filter(Boolean);
    if (!parts.length || parts[0].toLowerCase() === "share") return true;
    if (channel && parts[0].toLowerCase() === channel.toLowerCase()) {
      if (parts.length === 1) return true;
      if (messageId && parts[1] === String(messageId)) return true;
    }
    return false;
  } catch { return true; }
}
function extractTelegramLinksFromHtml(html, channel, sourceId) {
  const links = [];
  const seen = new Set();
  let highestId = Number(sourceId) || 0;
  const messagePattern = /<div\b[^>]*class="[^"]*tgme_widget_message[^"]*"[^>]*data-post="([^"]+)"[^>]*>([\s\S]*?)(?=<div\b[^>]*class="[^"]*tgme_widget_message|$)/gi;
  for (const match of String(html || "").matchAll(messagePattern)) {
    const post = decodeHtmlAttribute(match[1]);
    const [postChannel, rawId] = post.split("/");
    const messageId = Number(rawId) || 0;
    if (!messageId || messageId <= Number(sourceId || 0) || postChannel.toLowerCase() !== String(channel || "").toLowerCase()) continue;
    highestId = Math.max(highestId, messageId);
    for (const anchor of match[2].matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>/gi)) {
      const link = normalizeCollectedLink(anchor[1], `https://t.me/${channel}/${messageId}`);
      if (!link || isTelegramUiLink(link, channel, messageId) || seen.has(link)) continue;
      seen.add(link);
      links.push(link);
    }
  }
  return { links, highestId };
}
function validateRemote(row) {
  const raw = row?.policy && typeof row.policy === "object" && !Array.isArray(row.policy) ? row.policy : {};
  const bool = (name, fallback = true) => typeof raw[name] === "boolean" ? raw[name] : fallback;
  const optional = (name, min, max) => raw[name] == null || raw[name] === "" ? null : clamp(raw[name], min, max, min);
  const optionalDelay = name => {
    if (raw[name] == null || raw[name] === "") return null;
    const value = Number(raw[name]);
    return Number.isFinite(value) ? Math.min(LIMITS.unfollowDelayMaxSec,
      Math.max(LIMITS.unfollowDelayMinSec, Math.round(value * 2) / 2)) : LIMITS.unfollowDelayMinSec;
  };
  return {
    config_version: Math.max(0, Number(row?.config_version) || 0),
    maintenance_mode: row?.maintenance_mode === true,
    updated_at: row?.updated_at || null,
    policy: {
      allow_unfollow: bool("allow_unfollow"), allow_engage: bool("allow_engage"), allow_ai: bool("allow_ai"),
      allow_user_api_keys: bool("allow_user_api_keys"), allow_custom_providers: bool("allow_custom_providers"),
      fallback_enabled: bool("fallback_enabled"),
      unfollow_max_actions: optional("unfollow_max_actions", 1, LIMITS.maxActions),
      unfollow_min_delay_sec: optionalDelay("unfollow_min_delay_sec"),
      unfollow_max_delay_sec: optionalDelay("unfollow_max_delay_sec"),
      batch_min: optional("batch_min", LIMITS.batchMin, LIMITS.batchMax),
      batch_max: optional("batch_max", LIMITS.batchMin, LIMITS.batchMax),
      cooldown_minutes: optional("cooldown_minutes", 0, 120),
      engage_max_actions: optional("engage_max_actions", 1, LIMITS.maxActions),
      engage_min_delay_sec: optional("engage_min_delay_sec", LIMITS.intervalMinSec, LIMITS.intervalMaxSec),
      engage_max_delay_sec: optional("engage_max_delay_sec", LIMITS.intervalMinSec, LIMITS.intervalMaxSec),
      remote_prompt: typeof raw.remote_prompt === "string" ? raw.remote_prompt.slice(0, 4000) : "",
      openai_model: typeof raw.openai_model === "string" ? raw.openai_model.slice(0, 100) : "",
      anthropic_model: typeof raw.anthropic_model === "string" ? raw.anthropic_model.slice(0, 100) : ""
    }
  };
}

async function remoteCache() {
  const bag = await localStorageGet([KEYS.remoteConfig, KEYS.remoteStatus]);
  return { config: validateRemote(bag[KEYS.remoteConfig] || REMOTE_DEFAULT),
    status: bag[KEYS.remoteStatus] || { state: "offline", lastSyncedAt: null, attemptedAt: null, error: "" } };
}

async function refreshRemoteConfig() {
  const session = await activeSession();
  if (!session) throw new Error("Sign in is required to refresh remote configuration.");
  try {
    const rows = await supabaseFetch("/rest/v1/extension_config?id=eq.true&select=*", {}, session.access_token);
    if (!rows?.[0]) throw new Error("Remote configuration is not initialized. Run supabase-schema.sql.");
    const config = validateRemote(rows[0]);
    const status = { state: "connected", lastSyncedAt: new Date().toISOString(), attemptedAt: new Date().toISOString(), error: "" };
    await localStorageSet({ [KEYS.remoteConfig]: config, [KEYS.remoteStatus]: status });
    return { config, status };
  } catch (error) {
    const status = { state: "error", lastSyncedAt: (await remoteCache()).status.lastSyncedAt || null,
      attemptedAt: new Date().toISOString(),
      error: error?.message || String(error) };
    await localStorageSet({ [KEYS.remoteStatus]: status });
    const cached = await remoteCache();
    return { ...cached, status };
  }
}

async function supabaseFetch(path, options = {}, accessToken = "") {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken || SUPABASE_ANON_KEY}`,
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!response.ok) throw new Error(data?.msg || data?.message || data?.error_description || `Account request failed (${response.status}).`);
  return data;
}

async function storedSession() {
  return (await localStorageGet(SUPABASE_SESSION_KEY))[SUPABASE_SESSION_KEY] || null;
}

async function saveSession(session) {
  if (!session) await localStorageRemove(SUPABASE_SESSION_KEY);
  else await localStorageSet({ [SUPABASE_SESSION_KEY]: session });
}

async function activeSession() {
  let session = await storedSession();
  if (!session?.access_token) return null;
  if ((session.expires_at || 0) * 1000 > Date.now() + 60000) return session;
  if (!session.refresh_token) { await saveSession(null); return null; }
  try {
    const refreshed = await supabaseFetch("/auth/v1/token?grant_type=refresh_token", {
      method: "POST", body: JSON.stringify({ refresh_token: session.refresh_token })
    });
    session = { ...refreshed, expires_at: Math.floor(Date.now() / 1000) + refreshed.expires_in };
    await saveSession(session);
    return session;
  } catch { await saveSession(null); return null; }
}

async function accountContext() {
  const session = await activeSession();
  if (!session) { await localStorageRemove(ASSIGNED_PROVIDERS_KEY); return { signedIn: false }; }
  const user = session.user || await supabaseFetch("/auth/v1/user", {}, session.access_token);
  const rows = await supabaseFetch(`/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=*`, {}, session.access_token);
  const profile = rows?.[0] || null;
  const appSettings = (await supabaseFetch("/rest/v1/app_settings?id=eq.true&select=*", {}, session.access_token).catch(() => []))[0] || {};
  const catalog = (Array.isArray(appSettings.custom_apis) ? appSettings.custom_apis : []).map(sanitizeAccountProvider).filter(Boolean);
  const assignedIds = new Set(normalizeAssignedApiIds(profile?.assigned_api_ids));
  const fullAccess = ["owner", "admin"].includes(profile?.role);
  const assignedApis = catalog.filter(item => fullAccess || assignedIds.has(item.id));
  await localStorageSet({ [ASSIGNED_PROVIDERS_KEY]: assignedApis });
  const localSettings = await localStorageGet("ownerTelegram");
  const ownerTelegram = appSettings.owner_telegram || localSettings.ownerTelegram || "@yourusername";
  return { signedIn: true, user, profile, appSettings, ownerTelegram,
    assignedApis: assignedApis.map(item => ({ id: item.id, name: item.name, format: item.format, model: item.model })),
    session: { expires_at: session.expires_at } };
}

async function audit(action, details = {}, targetId = null) {
  const session = await activeSession();
  if (!session?.user?.id) return;
  await supabaseFetch("/rest/v1/audit_logs", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ actor_id: session.user.id, target_id: targetId, action, details })
  }, session.access_token).catch(() => {});
}

async function requireAccess(feature) {
  const account = await accountContext();
  if (!account.signedIn) throw new Error("Sign in from the Account section first.");
  if (!account.profile) throw new Error("Account database is not configured. Run supabase-schema.sql in Supabase.");
  if (account.profile.status !== "active") throw new Error(`This account is ${account.profile.status || "restricted"}.`);
  if (account.profile.access_granted !== true && !["owner", "admin"].includes(account.profile.role)) {
    throw new Error("Your account is waiting for Owner/Admin access approval.");
  }
  if (!["owner", "admin"].includes(account.profile.role) && account.profile.permissions?.[feature] !== true) {
    throw new Error(`Your account does not have permission to use ${feature}.`);
  }
  return account;
}

async function requireRemoteFeature(feature) {
  const remote = (await remoteCache()).config;
  if (remote.maintenance_mode) throw new Error("The extension is temporarily unavailable for maintenance.");
  const field = feature === "unfollow" ? "allow_unfollow" : feature === "engage" ? "allow_engage" : "allow_ai";
  if (remote.policy[field] === false) throw new Error(`${feature} is disabled by the remote administrator.`);
  return remote;
}
export const DEFAULT_UNFOLLOW = {
  status: "Idle", demo: false, total: 0, processed: 0, unfollowed: 0, skipped: 0, demoMatches: 0,
  remaining: 0, currentUsername: "", error: "", notice: "", startedAt: null, handled: [], discovered: [],
  refreshes: 0, batchCount: 0, batchTarget: 0, cooldownUntil: null, nextActionAt: null, tabId: null
};

export const DEFAULT_ENGAGE = {
  status: "Idle", demo: false, scanned: 0, processed: 0, liked: 0, commented: 0, skipped: 0,
  target: 0, currentTweet: "", currentAuthor: "", lastComment: "", error: "", notice: "",
  startedAt: null, handled: [], nextActionAt: null, tabId: null, plan: null, skipRemaining: 0,
  source: "", queueSource: "", postLinks: [], profileLinks: [], linkStatuses: {}, guardianState: null
};
const DEFAULT_COMMUNITY = {
  status: "Idle", xStatus: "Idle", telegramStatus: "Idle",
  sourceLinks: [], candidates: [], telegramCandidates: [], processedProfiles: [], processedPosts: [],
  currentIndex: -1, currentProfile: "", currentLink: "", processingDetail: "",
  telegramCurrentIndex: -1, telegramCurrentLink: "", telegramProcessingDetail: "",
  popupOpen: false, popupTabId: null, popupPosition: null, error: "", telegramError: "", updatedAt: null,
  xLink: "", telegramLink: "", telegramLinks: []
};

const FALLBACK = { [KEYS.unfollow]: DEFAULT_UNFOLLOW, [KEYS.engage]: DEFAULT_ENGAGE };
async function readCommunity() {
  const bag = await localStorageGet(KEYS.community);
  const stored = bag[KEYS.community] || {};
  const state = { ...DEFAULT_COMMUNITY, ...stored };
  if (!Array.isArray(stored.telegramCandidates)) {
    const legacy = (Array.isArray(state.candidates) ? state.candidates : []).filter(item => String(item?.id || "").startsWith("telegram:"));
    if (legacy.length) {
      state.telegramCandidates = legacy;
      state.candidates = state.candidates.filter(item => !String(item?.id || "").startsWith("telegram:"));
    }
  }
  if (!Object.prototype.hasOwnProperty.call(stored, "xStatus") && state.candidates.length) state.xStatus = stored.status || "Ready";
  if (!Object.prototype.hasOwnProperty.call(stored, "telegramStatus") && state.telegramCandidates.length) state.telegramStatus = stored.status || "Ready";
  return state;
}
async function notifyGuardianClients(state) {
  const next = state || (await readCommunity());
  const tabs = await tabsQuery({ url: GUARDIAN_URLS }).catch(() => []);
  for (const tab of tabs) {
    try { await tabsSendMessage(tab.id, { type: "guardian:sync", state: next, visible: next.popupOpen === true && next.popupTabId === tab.id }).catch(() => {}); }
    catch {}
  }
  return next;
}

async function writeCommunity(patch) { const next = { ...(await readCommunity()), ...patch, updatedAt: new Date().toISOString() }; await localStorageSet({ [KEYS.community]: next }); return notifyGuardianClients(next); }

async function syncGuardianFromEngage(state) {
  if (!["guardian", "guardian-x", "guardian-tg"].includes(state.queueSource) || state.demo === true) return;
  const community = await readCommunity();
  const statuses = state.linkStatuses && typeof state.linkStatuses === "object" ? state.linkStatuses : {};
  if (state.queueSource === "guardian-tg") {
    const byPostId = new Map();
    for (const [url, entry] of Object.entries(statuses)) {
      const postId = /\/status\/(\d+)/.exec(normalizeXPostLink(url))?.[1];
      if (postId) byPostId.set(postId, entry);
    }
    const telegramCandidates = community.telegramCandidates.map(candidate => {
      if (candidate.status === "Skipped") return candidate;
      const postId = /\/status\/(\d+)/.exec(normalizeXPostLink(candidate.postUrl))?.[1];
      const entry = postId ? byPostId.get(postId) : null;
      if (!entry) return candidate;
      const status = entry.status === "Already Completed" || entry.status === "Completed"
        ? "Completed"
        : entry.status === "Processing" && !ACTIVE.includes(state.status)
          ? "Pending"
          : ["Pending", "Processing", "Skipped", "Failed"].includes(entry.status) ? entry.status : candidate.status;
      return { ...candidate, status, detail: String(entry.detail || candidate.detail || "").slice(0, 240) };
    });
    const pending = telegramCandidates.some(item => ["Ready", "Pending", "Processing"].includes(item.status));
    const status = ACTIVE.includes(state.status) ? "Processing" : pending ? "Ready" : telegramCandidates.length ? "Completed" : "Idle";
    const currentIndex = telegramCandidates.findIndex(item => item.status === "Processing");
    const current = currentIndex >= 0 ? telegramCandidates[currentIndex] : null;
    await writeCommunity({
      status,
      telegramStatus: status,
      telegramCandidates,
      telegramCurrentIndex: currentIndex,
      telegramCurrentLink: current?.postUrl || "",
      telegramProcessingDetail: current?.detail || state.notice || "",
      telegramError: state.error || ""
    });
    return;
  }
  const byProfile = new Map();
  for (const [url, entry] of Object.entries(statuses)) {
    const profileUrl = normalizeXProfileLink(url);
    const profile = profileUrl.split("/").pop();
    if (profile) byProfile.set(profile, entry);
  }
  const candidates = community.candidates.map(candidate => {
    const profile = String(candidate.profile || "").replace(/^@/, "").toLowerCase();
    const entry = profile ? byProfile.get(profile) : null;
    if (!entry) return candidate;
    const status = entry.status === "Already Completed" || entry.status === "Completed"
      ? "Completed"
      : entry.status === "Processing" && !ACTIVE.includes(state.status)
        ? "Pending"
        : ["Pending", "Processing", "Skipped", "Failed"].includes(entry.status) ? entry.status : candidate.status;
    return {
      ...candidate,
      status,
      postUrl: normalizeXPostLink(entry.postUrl) || candidate.postUrl || "",
      postId: /\/status\/(\d+)/.exec(entry.postUrl || candidate.postUrl || "")?.[1] || candidate.postId || "",
      detail: String(entry.detail || candidate.detail || "").slice(0, 240)
    };
  });
  const pending = candidates.some(item => ["Ready", "Pending", "Processing"].includes(item.status));
  const status = ACTIVE.includes(state.status) ? "Processing" : pending ? "Ready" : candidates.length ? "Completed" : "Idle";
  const currentIndex = candidates.findIndex(item => item.status === "Processing");
  const current = currentIndex >= 0 ? candidates[currentIndex] : null;
  const activePost = state.guardianState?.phase === "acting" ? state.guardianState?.selectedPost?.url : "";
  const currentProfile = current?.profile || state.guardianState?.username || String(state.currentAuthor || "").replace(/^@/, "");
  const processedProfiles = candidates.filter(item => item.status === "Completed").map(item => item.profile).filter(Boolean);
  const processedPosts = candidates.filter(item => item.status === "Completed").map(item => item.postId).filter(Boolean);
  await writeCommunity({
    candidates,
    status,
    xStatus: status,
    currentIndex,
    currentProfile,
    currentLink: normalizeXPostLink(activePost) || current?.postUrl || current?.profileUrl || "",
    processingDetail: current?.detail || state.notice || "",
    processedProfiles: [...new Set(processedProfiles)],
    processedPosts: [...new Set(processedPosts)]
  });
}

async function navigateCommunity(tabId, url) {
  const loaded=new Promise(resolve => { const timeout=setTimeout(done,10000); function done(){clearTimeout(timeout);chrome.tabs.onUpdated.removeListener(listener);resolve();} function listener(id,info){if(id===tabId&&info.status==="complete")done();} chrome.tabs.onUpdated.addListener(listener); });
  try {
    await tabsUpdate(tabId, { url, active: false });
  } catch {
    // Android browsers can reject tabs.update when no focused window exists. Navigate
    // inside the already-registered content tab instead of asking Chrome for a window.
    await executeScript({ target: { tabId }, func: target => { location.href = target; }, args: [url] });
  }
  await Promise.race([loaded, sleep(10000)]);
  await ensureContent(tabId).catch(() => false);
  await sleep(900);
}
async function pageResult(tabId, func, ...args) { const result=await executeScript({target:{tabId},func,args}); return result?.[0]?.result; }
async function collectCommentersOnPage() {
  const sourceId = /\/status\/(\d+)/.exec(location.pathname)?.[1] || "";
  const norm = value => String(value || "").replace(/^@/, "").toLowerCase().replace(/[^a-z0-9_]/g, "");
  const reserved = new Set(["home", "explore", "notifications", "messages", "i", "search", "settings", "compose"]);
  const usernameFrom = article => [
    ...article.querySelectorAll('[data-testid="User-Name"] a[href]'),
    ...article.querySelectorAll('a[href*="/status/"]'),
    ...article.querySelectorAll('a[href]')
  ]
    .map(anchor => {
      try {
        const url = new URL(anchor.href);
        const parts = url.pathname.split("/").filter(Boolean);
        if (!parts.length || reserved.has(parts[0].toLowerCase())) return "";
        if (parts.length > 1 && !(parts.length >= 3 && parts[1].toLowerCase() === "status" && /^\d+$/.test(parts[2]))) return "";
        return norm(parts[0]);
      }
      catch { return ""; }
    }).find(Boolean) || "";
  const mobile = navigator.userAgentData?.mobile === true || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "");
  const activate = async element => {
    if (!element?.isConnected || !element.getClientRects().length) return false;
    try { element.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" }); } catch {}
    await new Promise(resolve => setTimeout(resolve, mobile ? 320 : 160));
    try { element.click(); return true; } catch { return false; }
  };
  window.scrollTo(0, 0);
  await new Promise(resolve => setTimeout(resolve, mobile ? 1200 : 700));
  const profiles = new Set();
  let unchangedRounds = 0;
  let previousCount = 0;

  for (let step = 0; step < 120 && unchangedRounds < 10; step++) {
    for (const article of document.querySelectorAll('[data-testid="tweet"]')) {
      const articleText = article.innerText || "";
      const isPromoted = !!article.closest('[data-testid="placementTracking"]') ||
        !!article.querySelector('[data-testid="promotedIndicator"], [data-testid*="promoted" i], [aria-label*="Promoted" i], [aria-label*="Sponsored" i]') ||
        /(^|\n)\s*(?:promoted|sponsored|ad)\s*(?:\n|$)/i.test(articleText);
      if (isPromoted) continue;
      const isSource = [...article.querySelectorAll('a[href*="/status/"]')]
        .some(anchor => new RegExp(`/status/${sourceId}(?:$|[/?#])`).test(anchor.href));
      if (isSource) continue;
      const username = usernameFrom(article);
      if (username) profiles.add(username);
    }

    let expanded = false;
    for (const button of document.querySelectorAll('button, [role="button"]')) {
      const label = `${button.getAttribute("aria-label") || ""} ${button.textContent || ""}`.trim();
      if (button.getClientRects().length && /(?:show|view|load)(?: more| additional| hidden)? (?:repl(?:y|ies)|comments?)|show this thread/i.test(label)) {
        if (await activate(button)) expanded = true;
      }
    }

    if (profiles.size === previousCount && !expanded) unchangedRounds++;
    else unchangedRounds = 0;
    previousCount = profiles.size;
    window.scrollBy({ top: Math.max(520, window.innerHeight * 0.82), behavior: "smooth" });
    await new Promise(resolve => setTimeout(resolve, expanded ? (mobile ? 1600 : 1100) : (mobile ? 1200 : 850)));
  }
  return [...profiles];
}

async function readRuntime(key) {
  const bag = await localStorageGet(key);
  return { ...FALLBACK[key], ...(bag[key] || {}) };
}
async function writeRuntime(key, patch) {
  const next = { ...(await readRuntime(key)), ...patch };
  await localStorageSet({ [key]: next });
  return next;
}
async function getLocalSettings() {
  const bag = await localStorageGet(KEYS.settings);
  return withDefaults(bag[KEYS.settings]);
}
async function getSettings() {
  const localSettings = await getLocalSettings();
  const assigned = (await localStorageGet(ASSIGNED_PROVIDERS_KEY))[ASSIGNED_PROVIDERS_KEY] || [];
  const providers = new Map(assigned.filter(item => item?.id).map(item => [String(item.id), { ...item, assigned: true }]));
  for (const item of localSettings.customProviders || []) if (item?.id) providers.set(String(item.id), item);
  localSettings.customProviders = [...providers.values()];
  const local = sanitize(localSettings);
  const remote = (await remoteCache()).config;
  const p = remote.policy;
  const out = structuredClone(local);
  if (!p.allow_unfollow) out.unfollow.enabled = false;
  if (!p.allow_engage) out.engage.enabled = false;
  if (p.unfollow_min_delay_sec != null) out.unfollow.minDelaySec = Math.max(out.unfollow.minDelaySec, p.unfollow_min_delay_sec);
  if (p.unfollow_max_delay_sec != null) out.unfollow.maxDelaySec = Math.min(out.unfollow.maxDelaySec, p.unfollow_max_delay_sec);
  if (out.unfollow.maxDelaySec < out.unfollow.minDelaySec) out.unfollow.maxDelaySec = out.unfollow.minDelaySec;
  if (p.batch_min != null) out.unfollow.batchMin = Math.max(out.unfollow.batchMin, p.batch_min);
  if (p.batch_max != null) out.unfollow.batchMax = Math.min(out.unfollow.batchMax, p.batch_max);
  if (out.unfollow.batchMax < out.unfollow.batchMin) out.unfollow.batchMax = out.unfollow.batchMin;
  if (p.cooldown_minutes != null) out.unfollow.cooldownMinutes = Math.max(out.unfollow.cooldownMinutes, p.cooldown_minutes);
  if (p.engage_max_actions != null) out.engage.maxActions = Math.min(out.engage.maxActions, p.engage_max_actions);
  if (p.engage_min_delay_sec != null) out.engage.randomMinSec = Math.max(out.engage.randomMinSec, p.engage_min_delay_sec);
  if (p.engage_max_delay_sec != null) out.engage.randomMaxSec = Math.min(out.engage.randomMaxSec, p.engage_max_delay_sec);
  if (out.engage.randomMaxSec < out.engage.randomMinSec) out.engage.randomMaxSec = out.engage.randomMinSec;
  if (!p.fallback_enabled) out.engage.useFallback = false;
  if (p.remote_prompt) out.engage.prompt = p.remote_prompt;
  if (p.openai_model) out.openai.model = p.openai_model;
  if (p.anthropic_model) out.anthropic.model = p.anthropic_model;
  if (!p.allow_custom_providers && out.activeProvider.startsWith("custom:")) out.activeProvider = "openai";
  if (!p.allow_custom_providers && out.engage.provider.startsWith("custom:")) out.engage.provider = "";
  return sanitize(out);
}
let settingsSaveQueue = Promise.resolve();

function saveSettings(patch) {
  const pending = settingsSaveQueue.then(() => saveSettingsNow(patch), () => saveSettingsNow(patch));
  settingsSaveQueue = pending.catch(() => null);
  return pending;
}

async function saveSettingsNow(patch) {
  const requested = patch || {};
  const next = sanitize(mergeSettings(await getLocalSettings(), requested));
  if (requested.unfollow?.enabled === true) next.engage.enabled = false;
  if (requested.engage?.enabled === true) next.unfollow.enabled = false;
  await localStorageSet({ [KEYS.settings]: next });
  const stops = [];
  if (requested.unfollow?.enabled === false || requested.engage?.enabled === true) stops.push(control("unfollow", "stop"));
  if (requested.engage?.enabled === false || requested.unfollow?.enabled === true) stops.push(control("engage", "stop"));
  await Promise.all(stops);
  return getSettings();
}

function sanitize(settings) {
  const out = withDefaults(settings);
  const u = out.unfollow;
  u.usernames = parseUsernames(u.usernames);
  const delayValue = (value, min, fallback) => {
    if (value === "" || value === null || value === undefined) return fallback;
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(LIMITS.unfollowDelayMaxSec, Math.max(min, Math.round(number * 2) / 2));
  };
  u.minDelaySec = delayValue(u.minDelaySec, LIMITS.unfollowDelayMinSec, 0.5);
  u.maxDelaySec = delayValue(u.maxDelaySec, u.minDelaySec, u.minDelaySec);
  u.batchMin = clamp(u.batchMin, LIMITS.batchMin, LIMITS.batchMax, 20);
  u.batchMax = clamp(u.batchMax, u.batchMin, LIMITS.batchMax, Math.max(u.batchMin, 30));
  u.cooldownMinutes = clamp(u.cooldownMinutes, 0, 120, 5);
  if (!["all", "nonfollowers", "custom"].includes(u.mode)) u.mode = "nonfollowers";
  if (!["except", "only"].includes(u.customMode)) u.customMode = "except";

  const e = out.engage;
  if (!["timeline", "guardian", "links", "profiles"].includes(e.source)) e.source = "timeline";
  if (!["x", "tg"].includes(e.guardianMode)) e.guardianMode = "x";
  const storedPostLinks = Array.isArray(e.postLinks) ? e.postLinks : typeof e.postLinks === "string"
    ? e.postLinks.split(/[\r\n\s,;]+/) : [];
  e.postLinks = [...new Set(storedPostLinks.map(normalizeXPostLink).filter(Boolean))].slice(0, 500);
  const storedProfileLinks = Array.isArray(e.profileLinks) ? e.profileLinks : typeof e.profileLinks === "string" ? e.profileLinks.split(/[\r\n\s,;]+/) : [];
  e.profileLinks = [...new Set(storedProfileLinks.map(normalizeXProfileLink).filter(Boolean))].slice(0, 500);
  if (!["both", "like", "comment"].includes(e.actions)) e.actions = "both";
  if (!["random"].includes(e.timing)) e.timing = "random";
  e.randomMaxSec = clamp(e.randomMaxSec, LIMITS.intervalMinSec, LIMITS.intervalMaxSec, 5);
  e.randomMinSec = clamp(e.randomMinSec, LIMITS.intervalMinSec, e.randomMaxSec, 1);
  e.skipReplies = true;
  e.maxActions = clamp(e.maxActions, 1, LIMITS.maxActions, 20);
  e.maxChars = clamp(e.maxChars, 20, LIMITS.commentMaxChars, 200);
  e.minTweetChars = clamp(e.minTweetChars, 0, 500, 20);
  e.skipAuthors = parseUsernames(e.skipAuthors);
  e.onlyAuthors = parseUsernames(e.onlyAuthors);
  const storedFallbackComments = Array.isArray(e.fallbackComments) ? e.fallbackComments : typeof e.fallbackComments === "string"
    ? e.fallbackComments.split(/\r?\n/) : [];
  e.fallbackComments = storedFallbackComments
    .map(item => String(item).trim()).filter(Boolean).slice(0, 40);

  out.templates = (Array.isArray(out.templates) ? out.templates : []).slice(0, 40).map(sanitizeTemplate);
  // A template the user deleted must not keep steering the run.
  if (e.templateId && !out.templates.some(item => item.id === e.templateId)) e.templateId = "";
  // Same for a per-automation provider pointing at a removed custom endpoint.
  for (const channel of ["unfollow", "engage"]) {
    const ref = out[channel].provider;
    if (ref && !resolveProvider(out, ref)) out[channel].provider = "";
  }

  out.customProviders = (out.customProviders || []).slice(0, 25).map(item => ({
    id: String(item.id),
    name: String(item.name || "Custom endpoint").slice(0, 60),
    url: String(item.url || "").trim(),
    apiKey: String(item.apiKey || "").trim(),
    model: String(item.model || "").trim(),
    format: item.format === "anthropic" ? "anthropic" : "openai",
    headerName: String(item.headerName || "").trim(),
    headerPrefix: typeof item.headerPrefix === "string" ? item.headerPrefix : undefined,
    assigned: item.assigned === true
  }));
  for (const id of ["openai", "anthropic"]) {
    out[id].apiKey = String(out[id].apiKey || "").trim();
    out[id].model = String(out[id].model || "").trim() || DEFAULT_SETTINGS[id].model;
  }
  if (!resolveProvider(out, out.activeProvider)) out.activeProvider = "openai";
  return out;
}

async function addLog(level, text) {
  const bag = await localStorageGet(KEYS.logs);
  const logs = [{ t: Date.now(), level, text: String(text || "").slice(0, 240) }, ...(bag[KEYS.logs] || [])];
  await localStorageSet({ [KEYS.logs]: logs.slice(0, 40) });
}

async function getRememberedTab() {
  let stored = {};
  try {
    stored = chrome.storage.session
      ? await storageAreaGet(chrome.storage.session, LAST_ACTIVE_TAB_KEY)
      : await localStorageGet(LAST_ACTIVE_TAB_KEY);
  } catch {
    stored = await localStorageGet(LAST_ACTIVE_TAB_KEY);
  }
  const id = Number(stored?.[LAST_ACTIVE_TAB_KEY]);
  return Number.isInteger(id) ? tabsGet(id).catch(() => null) : null;
}

async function rememberActiveTab(tabId) {
  if (!Number.isInteger(tabId)) return;
  const value = { [LAST_ACTIVE_TAB_KEY]: tabId };
  try {
    if (chrome.storage.session) await storageAreaSet(chrome.storage.session, value);
    else await localStorageSet(value);
  } catch {
    await localStorageSet(value);
  }
}

async function queryActiveTab() {
  // Some mobile extension hosts do not expose a focused window. Try the broadest
  // supported query forms instead of allowing "No window" to escape to the UI.
  for (const query of [
    { active: true, lastFocusedWindow: true },
    { active: true, currentWindow: true },
    { active: true }
  ]) {
    try {
      const [tab] = await tabsQuery(query);
      if (tab) return tab;
    } catch {}
  }
  return getRememberedTab();
}

async function queryTabsSafe(query) {
  try { return await tabsQuery(query); } catch { return []; }
}

async function findXTab(preferredId) {
  const preferred = Number(preferredId);
  if (Number.isInteger(preferred)) {
    const tab = await tabsGet(preferred).catch(() => null);
    if (tab && X_URL.test(tab.url || "")) return tab;
  }
  const active = await queryActiveTab();
  if (active && X_URL.test(active.url || "")) return active;
  const remembered = await getRememberedTab();
  if (remembered && X_URL.test(remembered.url || "")) return remembered;
  const matched = (await queryTabsSafe({ url: X_TAB_URLS }))[0];
  if (matched) return matched;
  return (await queryTabsSafe({})).find(tab => X_URL.test(tab.url || "")) || null;
}

async function findGuardianTab(preferredId, target = "") {
  const mode = String(target || "").toLowerCase();
  const supported = url => mode === "tg" || mode === "telegram" ? TELEGRAM_URL.test(url || "")
    : mode === "x" ? X_URL.test(url || "") : X_URL.test(url || "") || TELEGRAM_URL.test(url || "");
  const preferred = Number(preferredId);
  if (Number.isInteger(preferred)) {
    const tab = await tabsGet(preferred).catch(() => null);
    if (tab && supported(tab.url)) return tab;
  }
  const active = await queryActiveTab();
  if (active && supported(active.url)) return active;
  const remembered = await getRememberedTab();
  if (remembered && supported(remembered.url)) return remembered;
  const matched = (await queryTabsSafe({ url: mode === "tg" || mode === "telegram" ? TELEGRAM_TAB_URLS : mode === "x" ? X_TAB_URLS : GUARDIAN_URLS }))[0];
  if (matched) return matched;
  return (await queryTabsSafe({})).find(tab => supported(tab.url)) || null;
}

async function waitForTabComplete(tabId, timeoutMs = 15000) {
  const current = await tabsGet(tabId).catch(() => null);
  if (current?.status === "complete") return current;
  await new Promise(resolve => {
    const timeout = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    function listener(id, info) {
      if (id === tabId && info.status === "complete") done();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
  return tabsGet(tabId).catch(() => null);
}

async function createXAutomationTab(url, fallbackTabId = null) {
  let tab = await tabsCreate({ url, active: true }).catch(() => null);
  if (!Number.isInteger(tab?.id) && Number.isInteger(fallbackTabId)) {
    tab = await tabsUpdate(fallbackTabId, { url, active: false }).catch(() => null);
    if (!Number.isInteger(tab?.id)) {
      await executeScript({ target: { tabId: fallbackTabId }, func: target => { location.href = target; }, args: [url] }).catch(() => null);
      tab = await tabsGet(fallbackTabId).catch(() => null);
    }
  }
  if (!Number.isInteger(tab?.id)) throw new Error("The browser could not open an X automation tab.");
  await waitForTabComplete(tab.id);
  return (await tabsGet(tab.id).catch(() => null)) || tab;
}

async function ping(tabId) {
  try { return (await tabsSendMessage(tabId, { type: "ping" }))?.ok === true; }
  catch { return false; }
}

async function ensureContent(tabId) {
  if (await ping(tabId)) return true;
  try { await executeScript({ target: { tabId }, files: CONTENT_FILES }); }
  catch { return false; }
  for (let attempt = 0; attempt < 12; attempt++) {
    if (await ping(tabId)) return true;
    await sleep(200);
  }
  return false;
}

async function dispatch(message, preferredId) {
  const tab = await findXTab(preferredId);
  if (!tab) throw new Error("Open X in a browser tab first.");
  if (!(await ensureContent(tab.id))) throw new Error("The X page is not ready. Refresh the tab and try again.");
  const response = await tabsSendMessage(tab.id, message);
  if (response?.ok === false) throw new Error(response.error || "The X automation engine rejected the command.");
  return tab;
}
async function stopChannelEverywhere(channel, preferredId) {
  const tabs = await queryTabsSafe({ url: X_TAB_URLS }).catch(() => []);
  const ids = [...new Set([preferredId, ...tabs.map(tab => tab.id)].filter(Number.isInteger))];
  await Promise.all(ids.map(async tabId => {
    if (!(await ensureContent(tabId))) return;
    await tabsSendMessage(tabId, { type: `${channel}:stop` }).catch(() => null);
  }));
}
async function otherIsBusy(key) {
  const other = key === KEYS.unfollow ? KEYS.engage : KEYS.unfollow;
  const state = await readRuntime(other);
  return ACTIVE.includes(state.status);
}

async function startUnfollow(demo, preferredTabId) {
  const account = await requireAccess("unfollow");
  await requireRemoteFeature("unfollow");
  const settings = await getSettings();
  if (!settings.unfollow.enabled) throw new Error("Unfollow automation is disabled. Press Enable in its section first.");
  if (settings.unfollow.mode === "custom" && !settings.unfollow.usernames.length) {
    throw new Error("Custom mode needs at least one username.");
  }
  if (await otherIsBusy(KEYS.unfollow)) throw new Error("Stop the Like & Comment run first. Only one automation runs at a time.");
  const existing = await readRuntime(KEYS.unfollow);
  if (ACTIVE.includes(existing.status)) return existing;

  const tab = await findXTab(preferredTabId);
  if (!tab) throw new Error("Open X in a browser tab first.");
  const startedAt = Date.now();
  const runConfig = { ...settings.unfollow, demo: demo === true, startedAt };
  await localStorageSet({
    [KEYS.unfollow]: {
      ...DEFAULT_UNFOLLOW, ...runConfig, status: demo ? "Demo" : "Running", tabId: tab.id,
      notice: demo ? "Demo: nothing will be unfollowed." : ""
    }
  });
  if (!(await getSettings()).unfollow.enabled) {
    await writeRuntime(KEYS.unfollow, { status: "Idle", notice: "", nextActionAt: null });
    return readRuntime(KEYS.unfollow);
  }
  await dispatch({ type: "unfollow:start", config: runConfig }, tab.id);
  await addLog("info", demo ? "Unfollow demo started." : "Unfollow run started.");
  await audit(demo ? "unfollow_demo_started" : "unfollow_started", { email: account.user.email });
  return readRuntime(KEYS.unfollow);
}

async function startEngage(demo, preferredTabId) {
  const account = await requireAccess("engage");
  const remote = await requireRemoteFeature("engage");
  const settings = await getSettings();
  const engage = settings.engage;
  if (!engage.enabled) throw new Error("Like & Comment automation is disabled. Press Enable in its section first.");
  if (await otherIsBusy(KEYS.engage)) throw new Error("Stop the Unfollow run first. Only one automation runs at a time.");
  const existing = await readRuntime(KEYS.engage);
  if (ACTIVE.includes(existing.status)) return existing;

  const template = findTemplate(settings, engage.templateId);
  // A fixed format with no {{ai}} slot writes the whole reply itself, so no key is required.
  const needsAI = engage.actions !== "like" && templateNeedsAI(template);
  if (needsAI && !remote.policy.allow_ai) throw new Error("AI replies are disabled by the remote administrator.");
  if (needsAI && !demo) {
    const provider = resolveProviderFor(settings, "engage");
    const ready = provider && provider.apiKey && provider.model;
    if (!ready && !(engage.useFallback && engage.fallbackComments.length)) {
      throw new Error("Commenting needs a working API key for this automation, or fallback comments with fallback enabled.");
    }
  }
  const runEngage = { ...engage };
  let guardianProfiles = new Set();
  let guardianTelegramPostIds = new Set();
  let guardianTabId = null;
  if (engage.source === "links") {
    runEngage.postLinks = [...engage.postLinks];
    runEngage.profileLinks = [];
    runEngage.queueSource = "post-links";
    if (!runEngage.postLinks.length) throw new Error("Post Link mode needs at least one valid X/Twitter post link.");
  } else if (engage.source === "profiles") {
    runEngage.postLinks = [];
    runEngage.profileLinks = [...engage.profileLinks];
    runEngage.queueSource = "profile-links";
    runEngage.source = "profiles";
    if (!runEngage.profileLinks.length) throw new Error("Profile Link mode needs at least one valid X/Twitter profile link.");
  } else if (engage.source === "guardian") {
    const community = await readCommunity();
    guardianTabId = community.popupTabId;
    if (engage.guardianMode === "tg") {
      const links = [];
      const seen = new Set();
      for (const item of community.telegramCandidates || []) {
        if (["Completed", "Already Completed", "Skipped"].includes(item.status)) continue;
        const link = normalizeXPostLink(item.postUrl);
        const postId = /\/status\/(\d+)/.exec(link)?.[1];
        if (!link || !postId || seen.has(postId)) continue;
        seen.add(postId);
        guardianTelegramPostIds.add(postId);
        links.push(link);
      }
      runEngage.postLinks = links;
      runEngage.profileLinks = [];
      if (!runEngage.postLinks.length) {
        const telegramCandidates = community.telegramCandidates.map(candidate =>
          ["Completed", "Already Completed", "Skipped"].includes(candidate.status)
            ? candidate
            : { ...candidate, status: "Skipped", detail: "Skipped: this Telegram item is not a pending X/Twitter post link." });
        await writeCommunity({ telegramCandidates, telegramStatus: "Skipped", telegramCurrentIndex: -1, telegramCurrentLink: "", telegramProcessingDetail: "" });
        throw new Error("Telegram Guardian has no pending X/Twitter post links.");
      }
      runEngage.source = "links";
      runEngage.queueSource = "guardian-tg";
    } else {
      const profiles = [];
      const seen = new Set();
      for (const item of community.candidates || []) {
        if (["Completed", "Already Completed", "Skipped"].includes(item.status)) continue;
        const profileUrl = normalizeXProfileLink(item.profileUrl || `https://x.com/${item.profile || ""}`);
        const profile = profileUrl.split("/").pop();
        if (!profileUrl || !profile || seen.has(profile)) continue;
        seen.add(profile);
        guardianProfiles.add(profile);
        profiles.push(profileUrl);
      }
      runEngage.postLinks = [];
      runEngage.profileLinks = profiles;
      if (!runEngage.profileLinks.length) throw new Error("X Guardian has no pending profiles. Scan a source post first.");
      runEngage.source = "guardian";
      runEngage.queueSource = "guardian-x";
    }
  }
  let tab = await findXTab(preferredTabId || guardianTabId);
  if (!tab) {
    const firstTarget = runEngage.source === "links"
      ? runEngage.postLinks[0]
      : ["guardian", "profiles"].includes(runEngage.source) ? runEngage.profileLinks[0] : "";
    if (firstTarget) tab = await createXAutomationTab(firstTarget, String(runEngage.queueSource || "").startsWith("guardian") ? guardianTabId : null);
  }
  if (!tab) throw new Error("Open X in a browser tab first.");
  if (runEngage.queueSource === "guardian-x") {
    if (!demo) {
      const community = await readCommunity();
      const candidates = community.candidates.map(candidate => {
        const profile = String(candidate.profile || "").replace(/^@/, "").toLowerCase();
        if (!profile || !guardianProfiles.has(profile)) return candidate;
        return { ...candidate, status: "Pending", postUrl: "", detail: "Waiting for the 24-Hour Activity Watch check before any profile visit." };
      });
      await writeCommunity({
        status: "Processing",
        xStatus: "Processing",
        candidates,
        currentIndex: -1,
        currentProfile: "",
        currentLink: "",
        processingDetail: "Checking Guardian profiles against the 24-Hour Activity Watch before visiting them."
      });
    }
  }
  const plan = timingPlan(engage);
  const startedAt = Date.now();
  await localStorageSet({
    [KEYS.engage]: {
      ...DEFAULT_ENGAGE, ...runEngage, status: demo ? "Demo" : "Running", demo: demo === true, startedAt,
      tabId: tab.id, target: runEngage.source === "links" ? runEngage.postLinks.length : ["guardian", "profiles"].includes(runEngage.source) ? runEngage.profileLinks.length : engage.maxActions, plan,
      source: runEngage.source, queueSource: runEngage.queueSource || "", postLinks: runEngage.postLinks,
      profileLinks: runEngage.profileLinks || [], guardianState: null,
      linkStatuses: runEngage.source === "links"
        ? Object.fromEntries(runEngage.postLinks.map(url => [url, { status: "Pending", detail: "" }]))
        : ["guardian", "profiles"].includes(runEngage.source)
          ? Object.fromEntries(runEngage.profileLinks.map(url => [url, { status: "Pending", detail: runEngage.source === "profiles" ? "Waiting in Profile Link queue." : "Waiting in Guardian profile queue." }]))
        : {},
      notice: demo ? "Demo: nothing will be liked or posted." : `Spacing: ${plan.label}.`
    }
  });
  if (runEngage.queueSource === "guardian-tg" && !demo) {
    const community = await readCommunity();
    const seen = new Set();
    const telegramCandidates = community.telegramCandidates.map(candidate => {
      if (["Completed", "Already Completed", "Skipped"].includes(candidate.status)) return candidate;
      const link = normalizeXPostLink(candidate.postUrl);
      const postId = /\/status\/(\d+)/.exec(link)?.[1];
      if (!link || !postId) return { ...candidate, status: "Skipped", detail: "Skipped: this Telegram item is not an X/Twitter post link." };
      if (seen.has(postId)) return { ...candidate, status: "Skipped", detail: "Skipped duplicate X/Twitter post link." };
      seen.add(postId);
      return guardianTelegramPostIds.has(postId)
        ? { ...candidate, postUrl: link, status: "Pending", detail: "Queued from Telegram for the selected Like/Comment automation." }
        : candidate;
    });
    await writeCommunity({ status: "Processing", telegramStatus: "Processing", telegramCandidates, telegramCurrentIndex: -1, telegramCurrentLink: "", telegramProcessingDetail: "Waiting to open the first Telegram Guardian post link." });
  }
  if (!(await getSettings()).engage.enabled) {
    const stopped = await writeRuntime(KEYS.engage, { status: "Idle", notice: "", nextActionAt: null, guardianState: null });
    await syncGuardianFromEngage(stopped);
    return stopped;
  }
  try {
    await dispatch({ type: "engage:start", config: { ...runEngage, demo: demo === true, startedAt, plan } }, tab.id);
  } catch (error) {
    const failed = await writeRuntime(KEYS.engage, { status: "Error", error: error.message || String(error) });
    await syncGuardianFromEngage(failed);
    throw error;
  }
  await addLog("info", `${demo ? "Engagement demo" : "Engagement run"} started (${plan.label}).`);
  await audit(demo ? "engage_demo_started" : "engage_started", { source: engage.source, guardianMode: engage.guardianMode, links: runEngage.postLinks.length, profiles: runEngage.profileLinks?.length || 0 });
  return readRuntime(KEYS.engage);
}

async function control(channel, action) {
  const key = channel === "engage" ? KEYS.engage : KEYS.unfollow;
  const state = await readRuntime(key);
  if (action === "reset") {
    await stopChannelEverywhere(channel, state.tabId);
    if (channel === "engage" && String(state.queueSource || "").startsWith("guardian") && !state.demo) {
      await syncGuardianFromEngage({ ...state, status: "Idle" });
    }
    await localStorageSet({ [key]: FALLBACK[key] });
    return FALLBACK[key];
  }
  const status = action === "pause" ? "Paused"
    : action === "resume" ? (state.demo ? "Demo" : "Running")
    : "Idle";
  const patch = { status };
  if (action === "resume") { patch.error = ""; patch.notice = "Resumed."; }
  if (action === "stop") { patch.error = ""; patch.notice = ""; patch.currentUsername = ""; patch.currentTweet = ""; patch.nextActionAt = null; patch.guardianState = null; }
  if (action === "stop") {
    const next = await writeRuntime(key, patch);
    await stopChannelEverywhere(channel, state.tabId);
    if (channel === "engage") await syncGuardianFromEngage(next);
    return readRuntime(key);
  }
  try { await dispatch({ type: `${channel}:${action}` }, state.tabId); }
  catch (error) {
    if (action === "pause" || action === "resume") {
      const failed = await writeRuntime(key, { status: "Error", error: error.message });
      if (channel === "engage") await syncGuardianFromEngage(failed);
      return failed;
    }
  }
  const next = await writeRuntime(key, patch);
  if (channel === "engage") await syncGuardianFromEngage(next);
  return readRuntime(key);
}

const HANDLERS = {
  "activity:check": async message => activityLedgerStatus(message.profile),
  "activity:record": async message => recordActivity(message.record),
  "get-all": async () => {
    let remote = await remoteCache();
    const attempted = Date.parse(remote.status.attemptedAt || remote.status.lastSyncedAt || 0);
    if (await storedSession() && (!attempted || Date.now() - attempted > 5 * 60 * 1000)) remote = await refreshRemoteConfig();
    return { settings: await getSettings(), unfollow: await readRuntime(KEYS.unfollow),
      engage: await readRuntime(KEYS.engage), community: await readCommunity(), logs: (await localStorageGet(KEYS.logs))[KEYS.logs] || [], remote };
  },
  "save-settings": async message => ({ settings: await saveSettings(message.patch) }),
  "provider:test": async message => {
    await requireAccess("api_keys");
    const remote = await requireRemoteFeature("ai");
    if (!remote.policy.allow_user_api_keys) throw new Error("User API keys are disabled by the remote administrator.");
    const settings = await getSettings();
    // "channel:engage" tests whatever that automation would actually use right now.
    const ref = String(message.ref || "").startsWith("channel:")
      ? providerRefFor(settings, message.ref.slice(8))
      : message.ref;
    const result = await testProvider(settings, ref);
    await addLog("info", `${result.label} test passed (${result.model}).`);
    return { ok: true, ...result };
  },
  "provider:resolve-url": async message => ({ url: resolveEndpoint(message.url, message.format) }),
  "unfollow:start": async (message, sender) => startUnfollow(message.demo === true, sender.tab?.id),
  "engage:start": async (message, sender) => startEngage(message.demo === true, sender.tab?.id),
  "community:get": readCommunity,
  "guardian:get": async (message, sender) => {
    const tabId = Number.isInteger(sender.tab?.id) ? sender.tab.id : null;
    const current = await readCommunity();
    const state = tabId !== null && (X_URL.test(sender.tab?.url || "") || TELEGRAM_URL.test(sender.tab?.url || ""))
      ? await writeCommunity({ popupTabId: current.popupOpen ? current.popupTabId : tabId })
      : current;
    if (tabId !== null) await rememberActiveTab(tabId);
    return { ...state, popupVisible: state.popupOpen === true && state.popupTabId === tabId };
  },
  "guardian:save": async message => {
    const patch = {};
    if (Object.prototype.hasOwnProperty.call(message, "xLink")) patch.xLink = String(message.xLink || "").trim();
    if (Object.prototype.hasOwnProperty.call(message, "telegramLink")) patch.telegramLink = String(message.telegramLink || "").trim();
    return writeCommunity(patch);
  },
  "guardian:focus": async (message, sender) => {
    const saved = await readCommunity();
    let tab = Number.isInteger(saved.popupTabId) ? await tabsGet(saved.popupTabId).catch(() => null) : null;
    if (!tab) tab = await findGuardianTab(sender.tab?.id, message.target);
    if (!tab && message.target) tab = await findGuardianTab(sender.tab?.id);
    if (!tab) throw new Error("Open an X or Telegram tab before opening Guardian.");
    const state = await writeCommunity({ popupOpen: true, popupTabId: tab.id });
    let focused = await tabsSendMessage(tab.id, { type: "guardian:focus", state }).then(() => true).catch(() => false);
    if (!focused) {
      await executeScript({ target: { tabId: tab.id }, files: ["guardian.js"] }).catch(() => null);
      focused = await tabsSendMessage(tab.id, { type: "guardian:focus", state }).then(() => true).catch(() => false);
    }
    if (!focused) throw new Error("Guardian could not connect to this tab. Refresh the page and try again.");
    return { ...state, tabId: tab.id };
  },
  "guardian:hide": async () => {
    const state = await readCommunity();
    if (Number.isInteger(state.popupTabId)) await tabsSendMessage(state.popupTabId, { type: "guardian:close" }).catch(() => null);
    return writeCommunity({ popupOpen: false, popupTabId: null });
  },
  "guardian:position": async message => {
    const left = Number(message.position?.left), top = Number(message.position?.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return readCommunity();
    return writeCommunity({ popupPosition: { left: Math.max(0, Math.round(left)), top: Math.max(0, Math.round(top)) } });
  },
  "guardian:telegram-progress": async message => writeCommunity({
    status: "Scanning",
    telegramStatus: "Scanning",
    telegramCurrentIndex: Math.max(0, Number(message.currentIndex) || 0),
    telegramCurrentLink: String(message.currentLink || "").slice(0, 2000),
    telegramProcessingDetail: String(message.detail || "Scrolling below the Telegram source and collecting links.").slice(0, 240),
    telegramError: ""
  }),
  "guardian:start": async (message, sender) => {
    const state = await readCommunity();
    const source = String(message.source || "x").toLowerCase();
    const senderUrl = String(sender.tab?.url || sender.url || "");
    if (["telegram", "tg"].includes(source)) {
      if (!TELEGRAM_URL.test(senderUrl)) throw new Error("Open Guardian on a Telegram page and select TG before starting.");
      if (!state.telegramLink) throw new Error("Save a Telegram link in Guardian first.");
      await writeCommunity({ status: "Scanning", telegramStatus: "Scanning", telegramLink: state.telegramLink, telegramCandidates: [], telegramLinks: [], telegramCurrentIndex: 0, telegramCurrentLink: state.telegramLink, telegramProcessingDetail: "Scrolling below the Telegram source and collecting message links.", telegramError: "" });
      let links = Array.isArray(message.links) ? message.links : [];
      const normalizedSource = normalizeGuardianLink(state.telegramLink);
      if (!normalizedSource) throw new Error("Save a valid Telegram channel or message link first.");
      return HANDLERS["guardian:telegram-links"]({ links, sourceLink: normalizedSource });
    }
    if (!X_URL.test(senderUrl)) throw new Error("Open Guardian on an X/Twitter page and select X before starting.");
    if (!state.xLink) throw new Error("Save an X Link in Guardian first.");
    return HANDLERS["community:scan"]({ sourceLinks: [state.xLink], tabId: sender.tab?.id });
  },
  "guardian:stop": async () => {
    const engage = await readRuntime(KEYS.engage);
    if (String(engage.queueSource || "").startsWith("guardian") && ACTIVE.includes(engage.status)) await control("engage", "stop");
    const tabs = await tabsQuery({ url: GUARDIAN_URLS }).catch(() => []);
    await Promise.all(tabs.filter(tab => Number.isInteger(tab.id)).map(tab => tabsSendMessage(tab.id, { type: "guardian:stop-local" }).catch(() => null)));
    return writeCommunity({ status: "Idle", xStatus: "Idle", telegramStatus: "Idle", currentIndex: -1, currentProfile: "", currentLink: "", processingDetail: "", telegramCurrentIndex: -1, telegramCurrentLink: "", telegramProcessingDetail: "", popupOpen: false, popupTabId: null, error: "", telegramError: "" });
  },
  "guardian:clear": async () => {
    const engage = await readRuntime(KEYS.engage);
    if (String(engage.queueSource || "").startsWith("guardian") && ACTIVE.includes(engage.status)) {
      throw new Error("Stop the Guardian-sourced Automation before clearing its queue.");
    }
    return writeCommunity({ status: "Idle", xStatus: "Idle", telegramStatus: "Idle", candidates: [], telegramCandidates: [], telegramLinks: [], processedProfiles: [], processedPosts: [], currentIndex: -1, currentProfile: "", currentLink: "", processingDetail: "", telegramCurrentIndex: -1, telegramCurrentLink: "", telegramProcessingDetail: "", error: "", telegramError: "" });
  },
  "guardian:telegram-links": async message => {
    const source = normalizeGuardianLink(message.sourceLink || "");
    const parts = source ? new URL(source).pathname.split("/").filter(Boolean) : [];
    const channel = parts[0] || "", messageId = parts[1] || "";
    const seen = new Set(source ? [normalizeCollectedLink(source)] : []);
    const links = [];
    for (const raw of (Array.isArray(message.links) ? message.links : [])) {
      const link = normalizeCollectedLink(raw, source || "https://t.me/");
      if (!link || isTelegramUiLink(link, channel, messageId) || seen.has(link)) continue;
      seen.add(link);
      links.push(link);
    }
    const telegramCandidates = links.map((postUrl, index) => ({
      id: `telegram:${index + 1}:${postUrl}`,
      profile: "",
      postUrl,
      postId: "",
      sourceLink: source || message.sourceLink || "",
      serial: index + 1,
      status: "Ready",
      detail: "Collected from a Telegram message below the source."
    }));
    return writeCommunity({
      status: links.length ? "Ready" : "Skipped",
      telegramStatus: links.length ? "Ready" : "Skipped",
      telegramLinks: links,
      telegramCandidates,
      telegramCurrentIndex: -1,
      telegramCurrentLink: "",
      telegramProcessingDetail: "",
      telegramError: links.length ? "" : "No links were found below this Telegram source."
    });
  },
  "community:scan": async message => {
    await requireAccess("engage");
    const authoritySkip = new Set((await getSettings()).engage.skipAuthors || []);
    const rawLinks = (Array.isArray(message.sourceLinks) ? message.sourceLinks : []).map(value => String(value).trim()).filter(Boolean);
    if (rawLinks.length > 5) throw new Error("Guardian accepts a maximum of 5 source post links.");
    const sourceLinks = [...new Set(rawLinks.map(normalizeXPostLink).filter(Boolean))];
    if (!sourceLinks.length) throw new Error("No valid X post link found. Use a link containing /status/ followed by the post ID.");
    const previous = await readCommunity();
    const preferredTabId = Number.isInteger(message.tabId) ? message.tabId : previous.popupTabId;
    const tab = await findXTab(preferredTabId);
    if (!tab) throw new Error("Open X in a browser tab first.");
    const profiles = new Map();
    await writeCommunity({ status: "Scanning", xStatus: "Scanning", sourceLinks, candidates: [], processedProfiles: [], processedPosts: [], currentIndex: -1, currentProfile: "", currentLink: sourceLinks[0] || "", processingDetail: "Finding commenter usernames and generating profile links.", error: "" });

    for (const source of sourceLinks) {
      await writeCommunity({ status: "Scanning", xStatus: "Scanning", currentLink: source, processingDetail: "Scanning all loaded comments and reply branches for unique usernames." });
      await navigateCommunity(tab.id, source);
      const commenters = await pageResult(tab.id, collectCommentersOnPage) || [];
      for (const profile of commenters) {
        const profileUrl = normalizeXProfileLink(`https://x.com/${profile}`);
        const username = profileUrl.split("/").pop();
        if (profileUrl && username && !profiles.has(username)) profiles.set(username, { profileUrl, source, skipped: authoritySkip.has(username) });
      }
    }

    const candidates = [...profiles.entries()].map(([profile, item], index) => ({
      id: `profile:${profile}`,
      profile,
      profileUrl: item.profileUrl,
      postUrl: "",
      postId: "",
      sourceLink: item.source,
      serial: index + 1,
      status: item.skipped ? "Skipped" : "Ready",
      detail: item.skipped ? "Skipped by Authority Skip list." : "Profile generated from a unique commenter username. Waiting for Guardian automation."
    }));
    return writeCommunity({
      status: candidates.length ? "Ready" : "Skipped",
      xStatus: candidates.length ? "Ready" : "Skipped",
      candidates,
      processedProfiles: [],
      processedPosts: [],
      currentIndex: -1,
      currentProfile: "",
      currentLink: "",
      processingDetail: "",
      error: candidates.length ? "" : "No commenter profiles were found on the source post."
    });
  },
  "ai:comment": async message => {
    await requireAccess("engage");
    await requireRemoteFeature("ai");
    const settings = await getSettings();
    const result = await generateComment(settings, message.tweet || {});
    return { ok: true, ...result };
  },
  // Preview a specific format without saving it as the active one.
  "template:preview": async message => {
    await requireAccess("engage");
    const settings = await getSettings();
    const draft = sanitizeTemplate(message.template || {}, 0);
    if (templateNeedsAI(draft)) await requireRemoteFeature("ai");
    const staged = {
      ...settings,
      templates: [...settings.templates.filter(item => item.id !== draft.id), draft],
      engage: { ...settings.engage, templateId: draft.id }
    };
    const result = await generateComment(staged, message.tweet || {});
    return { ok: true, ...result };
  },
  progress: async message => {
    const key = message.channel === "engage" ? KEYS.engage : KEYS.unfollow;
    const state = await writeRuntime(key, message.patch || {});
    if (message.channel === "engage") await syncGuardianFromEngage(state);
    return state;
  },
  log: async message => { await addLog(message.level || "info", message.text); return { ok: true }; },
  "clear-logs": async () => { await localStorageSet({ [KEYS.logs]: [] }); return { ok: true }; }
};

HANDLERS["auth:status"] = async () => accountContext();
async function saveGoogleCallback(callback) {
  const url = new URL(callback);
  const params = new URLSearchParams(url.hash.slice(1) || url.search.slice(1));
  const accessToken = params.get("access_token"), refreshToken = params.get("refresh_token");
  if (!accessToken) throw new Error(params.get("error_description") || "Google sign-in returned no session.");
  const expiresIn = Number(params.get("expires_in")) || 3600;
  const user = await supabaseFetch("/auth/v1/user", {}, accessToken);
  await saveSession({ access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn, user });
  await audit("login", { method: "google" });
  return accountContext();
}

HANDLERS["account:activity"] = async () => {
  const account = await accountContext();
  if (!account.signedIn) throw new Error("Sign in required.");
  const session = await activeSession();
  const logs = await supabaseFetch(`/rest/v1/audit_logs?actor_id=eq.${account.user.id}&select=*&order=created_at.desc&limit=50`, {}, session.access_token);
  return { logs, expiresAt: session.expires_at };
};
HANDLERS["auth:google"] = async () => {
  const openTabFallback = async () => {
    const mobileRedirect = chrome.runtime.getURL("auth.html");
    const mobileUrl = `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(mobileRedirect)}`;
    const tab = await tabsCreate({ url: mobileUrl });
    await localStorageSet({ mobileAuthTabId: tab.id });
    return { ok: true, pending: true };
  };
  if (typeof chrome.identity?.launchWebAuthFlow !== "function" || typeof chrome.identity?.getRedirectURL !== "function") {
    return openTabFallback();
  }
  const redirect = chrome.identity.getRedirectURL("supabase");
  const url = `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirect)}`;
  try {
    const callback = await extensionApiCall(chrome.identity, "launchWebAuthFlow", { url, interactive: true });
    if (!callback) throw new Error("Google sign-in was cancelled.");
    return saveGoogleCallback(callback);
  } catch (error) {
    const text = error?.message || "";
    if (/cancel|denied|did not approve|closed by user/i.test(text)) throw error;
    return openTabFallback();
  }
};
HANDLERS["auth:complete"] = async (message, sender) => {
  if (!sender.url?.startsWith(chrome.runtime.getURL("auth.html"))) throw new Error("Invalid authentication callback.");
  return saveGoogleCallback(message.callback);
};

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url || !/[#&]access_token=/.test(changeInfo.url)) return;
  const stored = await localStorageGet("mobileAuthTabId");
  if (stored.mobileAuthTabId !== tabId) return;
  try {
    await saveGoogleCallback(changeInfo.url);
    await localStorageRemove("mobileAuthTabId");
    await tabsUpdate(tabId, { url: chrome.runtime.getURL("auth.html#done") });
  } catch (error) {
    await addLog("error", error?.message || String(error));
  }
});
HANDLERS["auth:logout"] = async () => {
  const session = await activeSession();
  if (session) await supabaseFetch("/auth/v1/logout", { method: "POST" }, session.access_token).catch(() => {});
  await saveSession(null);
  await localStorageRemove(ASSIGNED_PROVIDERS_KEY);
  return { signedIn: false };
};
HANDLERS["account:touch"] = async () => {
  const account = await accountContext();
  if (!account.signedIn || !account.profile || account.profile.status !== "active") return { ok: false };
  await supabaseFetch(`/rest/v1/profiles?id=eq.${account.user.id}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ last_seen_at: new Date().toISOString() })
  }, (await activeSession()).access_token);
  return { ok: true };
};
HANDLERS["account:update-profile"] = async message => {
  const account = await accountContext();
  if (!account.signedIn || !account.profile) throw new Error("Sign in first.");
  const displayName = String(message.displayName || "").trim().replace(/\s+/g, " ").slice(0, 80);
  if (!displayName) throw new Error("Name is required.");
  const session = await activeSession();
  await supabaseFetch(`/rest/v1/profiles?id=eq.${encodeURIComponent(account.user.id)}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ display_name: displayName })
  }, session.access_token);
  await audit("profile_name_updated", { displayName });
  return { ok: true, displayName };
};
HANDLERS["admin:list"] = async () => {
  const account = await requireAccess("engage");
  if (!["owner", "admin"].includes(account.profile.role)) throw new Error("Admin access required.");
  const session = await activeSession();
  const [users, logs, remote] = await Promise.all([
    supabaseFetch("/rest/v1/profiles?select=*&order=created_at.desc", {}, session.access_token),
    supabaseFetch("/rest/v1/audit_logs?select=*&order=created_at.desc&limit=200", {}, session.access_token),
    refreshRemoteConfig()
  ]);
  const apis = (Array.isArray(account.appSettings?.custom_apis) ? account.appSettings.custom_apis : [])
    .map(sanitizeAccountProvider).filter(Boolean).map(({ apiKey, ...item }) => ({ ...item, hasKey: !!apiKey }));
  return { account, users, logs, remote, apis };
};
HANDLERS["admin:update-config"] = async message => {
  const account = await requireAccess("engage");
  if (!["owner", "admin"].includes(account.profile?.role)) throw new Error("Admin access required.");
  const current = (await remoteCache()).config;
  const validated = validateRemote({ ...current, maintenance_mode: message.maintenance_mode,
    policy: message.policy, config_version: current.config_version });
  const session = await activeSession();
  const rows = await supabaseFetch("/rest/v1/extension_config?id=eq.true", {
    method: "PATCH", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ maintenance_mode: validated.maintenance_mode, policy: validated.policy })
  }, session.access_token);
  if (!rows?.[0]) throw new Error("Remote configuration could not be updated.");
  const config = validateRemote(rows?.[0]);
  const status = { state: "connected", lastSyncedAt: new Date().toISOString(), attemptedAt: new Date().toISOString(), error: "" };
  await localStorageSet({ [KEYS.remoteConfig]: config, [KEYS.remoteStatus]: status });
  await audit("extension_config_updated", { config_version: config.config_version,
    maintenance_mode: config.maintenance_mode, policy: config.policy });
  return { ok: true, config, status };
};
HANDLERS["admin:update-user"] = async message => {
  const account = await requireAccess("engage");
  if (!["owner", "admin"].includes(account.profile.role)) throw new Error("Admin access required.");
  const userId = String(message.userId || "").trim();
  if (!userId) throw new Error("User ID is required.");
  const session = await activeSession();
  const targetRows = await supabaseFetch(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=id,role`, {}, session.access_token);
  const target = targetRows?.[0];
  if (!target) throw new Error("User not found.");
  if (target.role === "owner") throw new Error("The Owner account cannot be modified from this control.");
  const allowed = {};
  if (["active", "paused", "suspended", "banned"].includes(message.patch?.status)) allowed.status = message.patch.status;
  if (Object.prototype.hasOwnProperty.call(message.patch || {}, "display_name")) {
    const displayName = String(message.patch.display_name || "").trim().replace(/\s+/g, " ").slice(0, 80);
    if (displayName) allowed.display_name = displayName;
  }
  if (typeof message.patch?.access_granted === "boolean") allowed.access_granted = message.patch.access_granted;
  if (message.patch?.permissions && typeof message.patch.permissions === "object") {
    allowed.permissions = Object.fromEntries(["unfollow", "engage", "api_keys"]
      .map(name => [name, message.patch.permissions[name] === true]));
  }
  if (account.profile.role === "owner" && ["admin", "user"].includes(message.patch?.role)) allowed.role = message.patch.role;
  if (!Object.keys(allowed).length) throw new Error("No valid user changes were provided.");
  await supabaseFetch(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(allowed)
  }, session.access_token);
  await audit("user_updated", allowed, userId);
  return { ok: true };
};
HANDLERS["admin:set-api-users"] = async message => {
  const account = await requireAccess("engage");
  if (!["owner", "admin"].includes(account.profile?.role)) throw new Error("Admin access required.");
  const providerId = String(message.providerId || message.provider?.id || "").trim().slice(0, 80);
  if (!providerId) throw new Error("A valid Custom API configuration is required.");
  const selected = new Set((Array.isArray(message.userIds) ? message.userIds : []).map(String));
  const session = await activeSession();
  const [settingsRows, users] = await Promise.all([
    supabaseFetch("/rest/v1/app_settings?id=eq.true&select=*", {}, session.access_token),
    supabaseFetch("/rest/v1/profiles?select=id,role,assigned_api_ids", {}, session.access_token)
  ]);
  const appSettings = settingsRows?.[0] || {};
  const existingCatalog = (Array.isArray(appSettings.custom_apis) ? appSettings.custom_apis : [])
    .map(sanitizeAccountProvider).filter(Boolean);
  const existing = existingCatalog.find(item => item.id === providerId);
  const incoming = message.provider ? sanitizeAccountProvider(message.provider) : null;
  const provider = incoming || existing;
  if (!provider || provider.id !== providerId) throw new Error("This Custom API no longer exists.");
  if (!provider.apiKey && existing?.apiKey) provider.apiKey = existing.apiKey;
  const catalog = existingCatalog.filter(item => item.id !== provider.id);
  catalog.push(provider);
  await supabaseFetch("/rest/v1/app_settings?id=eq.true", {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ custom_apis: catalog, updated_at: new Date().toISOString() })
  }, session.access_token);
  let changed = 0;
  for (const user of users || []) {
    if (user.role === "owner") continue;
    const ids = new Set(normalizeAssignedApiIds(user.assigned_api_ids));
    if (selected.has(String(user.id))) ids.add(provider.id); else ids.delete(provider.id);
    const next = [...ids];
    if (JSON.stringify(next) === JSON.stringify(normalizeAssignedApiIds(user.assigned_api_ids))) continue;
    await supabaseFetch(`/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ assigned_api_ids: next })
    }, session.access_token);
    changed++;
  }
  await audit("custom_api_access_updated", { apiId: provider.id, apiName: provider.name, selectedUsers: selected.size, changed });
  return { ok: true, changed };
};
HANDLERS["admin:update-settings"] = async message => {
  const account = await requireAccess("engage");
  if (!["owner", "admin"].includes(account.profile?.role)) throw new Error("Admin access required.");
  const value = String(message.ownerTelegram || "").trim();
  if (!/^@?[A-Za-z0-9_]{3,64}$/.test(value)) throw new Error("Enter a valid Telegram username.");
  const ownerTelegram = value.startsWith("@") ? value : `@${value}`;
  const session = await activeSession();
  const rows = await supabaseFetch("/rest/v1/app_settings?id=eq.true", {
    method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ owner_telegram: ownerTelegram, updated_at: new Date().toISOString() })
  }, session.access_token);
  if (!rows?.[0]) throw new Error("Owner settings could not be updated.");
  await localStorageSet({ ownerTelegram });
  await audit("owner_telegram_updated", { ownerTelegram });
  return { ok: true, ownerTelegram };
};

for (const channel of ["unfollow", "engage"]) {
  for (const action of ["pause", "resume", "stop", "reset"]) {
    HANDLERS[`${channel}:${action}`] = () => control(channel, action);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = HANDLERS[message?.type];
  if (!handler) return false;
  Promise.resolve(handler(message, sender))
    .then(result => sendResponse(result ?? { ok: true }))
    .catch(async error => {
      const text = error?.message || String(error);
      if (["engage:start", "unfollow:start"].includes(message.type)) {
        const key = message.type.startsWith("engage") ? KEYS.engage : KEYS.unfollow;
        await writeRuntime(key, { status: "Error", error: text });
      }
      const telegramGuardianStart = message.type === "guardian:start" && ["telegram", "tg"].includes(String(message.source || "").toLowerCase());
      if (message.type === "community:scan" || (message.type === "guardian:start" && !telegramGuardianStart)) {
        await writeCommunity({ status: "Error", xStatus: "Error", error: text });
      }
      if (telegramGuardianStart) {
        await writeCommunity({ status: "Error", telegramStatus: "Error", telegramError: text, telegramProcessingDetail: "" });
      }
      // URL previews fail on every partially-typed address; that is not activity worth logging.
      if (message.type !== "provider:resolve-url") await addLog("error", text);
      sendResponse({ ok: false, error: text });
    });
  return true;
});

chrome.tabs.onActivated.addListener(({ tabId }) => { rememberActiveTab(tabId); });
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab?.active && (changeInfo.status === "loading" || changeInfo.status === "complete")) rememberActiveTab(tabId);
});

chrome.runtime.onInstalled.addListener(() => {
  saveSettings({ unfollow: { minDelaySec: 0.5, maxDelaySec: 0.5 } });
  rotateActivityLedger();
  scheduleActivityLedgerRotation();
});
chrome.runtime.onStartup.addListener(() => {
  rotateActivityLedger();
  scheduleActivityLedgerRotation();
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== ACTIVITY_LEDGER_ALARM) return;
  rotateActivityLedger().finally(scheduleActivityLedgerRotation);
});
rotateActivityLedger();
scheduleActivityLedgerRotation();

chrome.tabs.onRemoved.addListener(async tabId => {
  for (const [channel, key] of [["unfollow", KEYS.unfollow], ["engage", KEYS.engage]]) {
    const state = await readRuntime(key);
    if (state.tabId === tabId && ACTIVE.includes(state.status)) {
      await writeRuntime(key, { status: "Idle", notice: "The X tab was closed, so the run stopped.", nextActionAt: null });
      await addLog("warn", `${channel} run stopped: the X tab was closed.`);
    }
  }
});
