// Shared configuration contract. Imported by background.js and popup.js (both ES modules).
// Content scripts never import this file: they only receive plain, pre-validated config objects.

export const KEYS = {
  settings: "settings", unfollow: "state", engage: "engageState", logs: "logs",
  remoteConfig: "remoteConfig", remoteStatus: "remoteConfigStatus",
  community: "communityReview"
};

export const BUILTIN_PROVIDERS = {
  openai: {
    id: "openai",
    label: "OpenAI",
    format: "openai",
    endpoint: "https://api.openai.com/v1/chat/completions",
    keysUrl: "https://platform.openai.com/api-keys",
    headerName: "Authorization",
    headerPrefix: "Bearer ",
    defaultModel: "gpt-4o-mini",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1", "o4-mini"]
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    format: "anthropic",
    endpoint: "https://api.anthropic.com/v1/messages",
    keysUrl: "https://console.anthropic.com/settings/keys",
    headerName: "x-api-key",
    headerPrefix: "",
    defaultModel: "claude-sonnet-5",
    models: ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5-20251001", "claude-fable-5"]
  }
};

export const LIMITS = {
  // Hard ceilings. Random timing can never produce a value outside this window,
  // and never above the maximum the user selected.
  intervalMinSec: 1,
  intervalMaxSec: 600,
  unfollowDelayMinSec: 0.5,
  unfollowDelayMaxSec: 600,
  batchMin: 1,
  batchMax: 200,
  commentMaxChars: 280,
  maxActions: 500
};

export const TIMING_CHOICES = [
  { value: "60", label: "1 minute", seconds: 60 },
  { value: "50", label: "50 seconds", seconds: 50 },
  { value: "random", label: "Random", seconds: null }
];

export const DEFAULT_PROMPT = [
  "You write short, natural replies to posts on X (Twitter).",
  "Author: @{{author}}",
  'Post: """{{text}}"""',
  "",
  "Write exactly one reply in {{language}}, in a {{tone}} tone, under {{maxChars}} characters.",
  "Rules: no hashtags, no links, no @mentions, no surrounding quotes, never say you are an AI,",
  "add nothing except the reply text itself."
].join("\n");

// ---------- comment templates ----------
// A template is a saved reply format. Two modes:
//   "template" — post the body as written. {{ai}} (optional) is the only part the model writes.
//   "rules"    — hand the body to the model as formatting rules; the model writes the whole reply.
// Body placeholders: {{ai}} {{author}} {{mentions}} {{text}} {{tone}} {{language}} {{maxChars}}
// Spin syntax: [one|two|three] picks one option at random, so replies are not identical.

export const TEMPLATE_MODES = [
  { value: "template", label: "Fixed format — post exactly as written" },
  { value: "rules", label: "Format rules — the AI follows them" }
];

// Must stay in step with the `values` object generateComment builds, plus "ai". fillTemplate leaves
// anything else untouched, so a name missing from this list is posted with its braces showing.
export const TEMPLATE_PLACEHOLDERS = ["ai", "author", "language", "maxChars", "mentions", "text", "tone"];

export const DEFAULT_TEMPLATES = [
  {
    id: "t_mention",
    name: "Reply + mention",
    mode: "template",
    body: "{{ai}}\n\n{{mentions}}",
    mentions: [],
    note: "The AI writes the reply, your accounts are mentioned underneath."
  },
  {
    id: "t_rules",
    name: "Short and specific",
    mode: "rules",
    body: [
      "Open by reacting to one concrete detail from the post.",
      "One or two sentences, maximum 180 characters.",
      "No emoji, no hashtags, no questions.",
      "End with a short opinion, not a compliment."
    ].join("\n"),
    mentions: [],
    note: "Style rules only. The AI writes the whole reply."
  }
];

export const DEFAULT_FALLBACK_COMMENTS = [
  "Good point, thanks for sharing this.",
  "This is a useful perspective.",
  "Interesting read, appreciate the post.",
  "Well put. Following along.",
  "Solid take, thanks for posting."
];

export const DEFAULT_SETTINGS = {
  // Global default. Each automation may override it with its own provider ref, so the
  // Like & Comment run and any future AI feature can use different keys.
  activeProvider: "openai",
  openai: { apiKey: "", model: BUILTIN_PROVIDERS.openai.defaultModel },
  anthropic: { apiKey: "", model: BUILTIN_PROVIDERS.anthropic.defaultModel },
  customProviders: [],
  templates: DEFAULT_TEMPLATES,
  unfollow: {
    enabled: true,
    mode: "nonfollowers",
    customMode: "except",
    usernames: [],
    minDelaySec: 0.5,
    maxDelaySec: 0.5,
    batchMin: 20,
    batchMax: 30,
    cooldownMinutes: 5,
    stopAfterMinute: false,
    reloadOnFinished: true,
    autoScroll: true,
    autoRefresh: true
  },
  engage: {
    enabled: false,
    source: "timeline",
    guardianMode: "x",
    postLinks: [],
    profileLinks: [],
    provider: "",       // "" = use activeProvider; otherwise an override for this automation
    templateId: "",     // "" = no template, use the plain prompt
    actions: "both",
    timing: "random",
    randomMinSec: 1,
    randomMaxSec: 5,
    maxActions: 20,
    skipPromoted: true,
    skipReplies: true,
    skipLiked: true,
    minTweetChars: 20,
    skipAuthors: [],
    onlyAuthors: [],
    tone: "friendly",
    language: "English",
    maxChars: 200,
    prompt: DEFAULT_PROMPT,
    useFallback: true,
    fallbackComments: DEFAULT_FALLBACK_COMMENTS,
    stripLinks: true,
    reloadOnFinished: false
  }
};

export const TONES = ["friendly", "supportive", "professional", "curious", "casual", "enthusiastic"];
export const ACTION_MODES = [
  { value: "both", label: "Like + Comment" },
  { value: "like", label: "Like only" },
  { value: "comment", label: "Comment only" }
];

const isPlain = value => !!value && typeof value === "object" && !Array.isArray(value);

export function mergeSettings(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    out[key] = isPlain(value) && isPlain(base?.[key]) ? mergeSettings(base[key], value) : value;
  }
  return out;
}

// mergeSettings assigns any non-plain value straight through, so a field stored under the wrong
// type — or blanked by a popup that saved its form before it was populated — survives the merge.
// The first .map/.join/.length on it then throws, and a blanked prompt reads as "no prompt at all".
// DEFAULT_SETTINGS is the schema, so conform to it once here rather than guarding at every use.
// Fields whose own default is "" (keys, provider overrides) are meant to be empty and stay empty.
function conform(target, schema) {
  for (const [key, expected] of Object.entries(schema)) {
    const value = target[key];
    if (Array.isArray(expected)) {
      if (!Array.isArray(value)) {
        // Older popup versions persisted textareas as a single string. Keep those
        // values long enough for the field-specific normalizers to parse them.
        const textList = new Set(["usernames", "postLinks", "profileLinks", "skipAuthors", "onlyAuthors", "fallbackComments"]);
        target[key] = textList.has(key) && typeof value === "string" ? value : structuredClone(expected);
      }
    } else if (isPlain(expected)) {
      if (!isPlain(value)) target[key] = structuredClone(expected);
      else conform(value, expected);
    } else if (typeof expected === "string" && expected !== "") {
      if (typeof value !== "string" || !value.trim()) target[key] = expected;
    } else if (typeof expected === "number") {
      // Range is background.js sanitize()'s job; this only guarantees it is a usable number.
      if (!Number.isFinite(value)) target[key] = expected;
    } else if (typeof expected === "boolean") {
      // Anything else would render as an unchecked box and then save back as a real false.
      if (typeof value !== "boolean") target[key] = expected;
    }
  }
}

export function withDefaults(stored) {
  // structuredClone matters: sanitize() edits the result in place, and without a fresh
  // copy those edits would land on DEFAULT_SETTINGS itself and poison every later read.
  const settings = mergeSettings(structuredClone(DEFAULT_SETTINGS), stored || {});
  conform(settings, DEFAULT_SETTINGS);
  // Entries missing the field their lookups key on can never resolve, so drop them here
  // instead of letting each caller decide what a nameless endpoint or format means.
  settings.customProviders = settings.customProviders.filter(item => item && item.id);
  settings.templates = settings.templates.filter(item => isPlain(item) && item.id);
  return settings;
}

export const clamp = (value, min, max, fallback) => {
  // An empty field must fall back, not become the minimum: Number("") is 0 and passes isFinite.
  if (value === "" || value === null || value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
};

export const normalizeUsername = value => {
  const raw = String(value || "").trim();
  const profile = /^(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/([^/?#]+)/i.exec(raw);
  return String(profile ? profile[1] : raw).replace(/^@+/, "").toLowerCase().replace(/[^a-z0-9_]/g, "");
};

export function parseUsernames(text) {
  const list = Array.isArray(text) ? text : String(text || "").split(/[\n,;\s]+/);
  return [...new Set(list.map(normalizeUsername).filter(Boolean))];
}

// Single source of truth for action spacing. Returns a plain plan the content
// script can use without re-reading settings, already clamped to the ceilings.
export function timingPlan(engage) {
  const fixed = TIMING_CHOICES.find(choice => choice.value === engage.timing && choice.seconds);
  if (fixed) {
    const ms = fixed.seconds * 1000;
    return { mode: "fixed", minMs: ms, maxMs: ms, label: fixed.label };
  }
  const max = clamp(engage.randomMaxSec, LIMITS.intervalMinSec, LIMITS.intervalMaxSec, 60);
  const min = clamp(engage.randomMinSec, LIMITS.intervalMinSec, max, Math.min(30, max));
  return { mode: "random", minMs: min * 1000, maxMs: max * 1000, label: `Random ${min}-${max}s` };
}

export function findTemplate(settings, id) {
  if (!id) return null;
  return (settings.templates || []).find(item => item.id === id) || null;
}

// [a|b|c] -> one option, chosen per reply so repeated formats do not look identical.
export function spin(text) {
  return String(text || "").replace(/\[([^\[\]]+)\]/g, (whole, group) => {
    const options = group.split("|");
    if (options.length < 2) return whole;
    return options[Math.floor(Math.random() * options.length)].trim();
  });
}

export function fillTemplate(template, values) {
  return String(template || "").replace(/\{\{(\w+)\}\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key] ?? "") : whole);
}

// A template that never asks for AI text needs no provider, so the run can work with no key.
export function templateNeedsAI(template) {
  if (!template) return true;
  if (template.mode === "rules") return true;
  return /\{\{ai\}\}/.test(template.body || "");
}

export function mentionText(template) {
  return (template?.mentions || []).map(name => "@" + name).join(" ");
}

export function sanitizeTemplate(item, index) {
  const mode = item?.mode === "rules" ? "rules" : "template";
  return {
    id: String(item?.id || `t${index}`),
    name: String(item?.name || "Untitled format").slice(0, 60),
    mode,
    body: String(item?.body || "").slice(0, 2000),
    mentions: parseUsernames(item?.mentions).slice(0, 10),
    note: String(item?.note || "").slice(0, 160)
  };
}

export function resolveProvider(settings, ref) {
  const reference = ref || settings.activeProvider;
  if (reference && reference.startsWith("custom:")) {
    const id = reference.slice(7);
    const custom = (settings.customProviders || []).find(item => item.id === id);
    if (!custom) return null;
    const format = custom.format === "anthropic" ? "anthropic" : "openai";
    // A blank Advanced-header field means "use the default for this format". Once the user
    // overrides the header name they own the prefix too, so a blank prefix stays blank.
    const headerName = custom.headerName || (format === "anthropic" ? "x-api-key" : "Authorization");
    const headerPrefix = custom.headerPrefix
      || (custom.headerName ? "" : format === "anthropic" ? "" : "Bearer ");
    return {
      ref: reference,
      label: custom.name || "Custom endpoint",
      format,
      endpoint: custom.url,
      apiKey: custom.apiKey || "",
      model: custom.model || "",
      headerName,
      headerPrefix,
      custom: true
    };
  }
  const builtin = BUILTIN_PROVIDERS[reference];
  if (!builtin) return null;
  const saved = settings[builtin.id] || {};
  return {
    ref: builtin.id,
    label: builtin.label,
    format: builtin.format,
    endpoint: builtin.endpoint,
    apiKey: saved.apiKey || "",
    model: saved.model || builtin.defaultModel,
    headerName: builtin.headerName,
    headerPrefix: builtin.headerPrefix,
    custom: false
  };
}

export function providerLabel(settings, ref) {
  return resolveProvider(settings, ref)?.label || "None";
}

// Every automation reads its provider through here. A blank per-automation ref, or one
// pointing at a deleted custom endpoint, falls back to the global default.
export function providerRefFor(settings, channel) {
  const own = settings?.[channel]?.provider || "";
  if (own && resolveProvider(settings, own)) return own;
  return settings?.activeProvider || "openai";
}

export function resolveProviderFor(settings, channel) {
  return resolveProvider(settings, providerRefFor(settings, channel));
}
