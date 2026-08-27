// LLM transport. Runs only in the service worker so API keys never enter the X page context.
import {
  resolveProvider, resolveProviderFor, findTemplate, templateNeedsAI,
  spin, fillTemplate, mentionText
} from "./defaults.js";

const TIMEOUT_MS = 30000;

function permissionContains(details) {
  return new Promise((resolve, reject) => {
    const api = chrome.permissions;
    if (!api || typeof api.contains !== "function") { resolve(false); return; }
    let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; error ? reject(error) : resolve(value === true); };
    const callback = value => {
      const failure = chrome.runtime?.lastError;
      finish(failure ? new Error(failure.message) : null, value);
    };
    try {
      const pending = api.contains(details, callback);
      if (pending?.then) pending.then(value => finish(null, value)).catch(error => finish(error));
    } catch {
      try {
        const pending = api.contains(details);
        if (pending?.then) pending.then(value => finish(null, value)).catch(error => finish(error));
        else finish(null, pending);
      } catch (error) { finish(error); }
    }
  });
}

export function resolveEndpoint(url, format) {
  const raw = String(url || "").trim().replace(/\s+/g, "");
  if (!raw) throw new Error("Endpoint URL is empty.");
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error("Endpoint URL is not valid. Include https://"); }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("Endpoint must use http:// or https://");
  const path = parsed.pathname.replace(/\/+$/, "");
  const done = format === "anthropic" ? /\/messages$/ : /\/(chat\/completions|completions|responses)$/;
  if (done.test(path) || parsed.search) return parsed.toString();
  const suffix = format === "anthropic" ? "/messages" : "/chat/completions";
  const base = /\/v\d+$/.test(path) ? path : `${path}/v1`;
  parsed.pathname = `${base}${suffix}`;
  return parsed.toString();
}

export async function hasHostAccess(url) {
  try {
    const origin = new URL(url).origin + "/*";
    return await permissionContains({ origins: [origin] });
  } catch { return false; }
}

function authHeaders(provider) {
  const name = provider.headerName || "Authorization";
  const prefix = provider.headerPrefix ?? "";
  const headers = { "content-type": "application/json" };
  if (provider.apiKey) headers[name] = `${prefix}${provider.apiKey}`;
  if (provider.format === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
    // Required for calls made from a browser-origin context such as an extension worker.
    headers["anthropic-dangerous-direct-browser-access"] = "true";
  }
  return headers;
}

function buildBody(provider, { system, user, maxTokens, temperature }, endpoint = "") {
  if (provider.format === "anthropic") {
    return {
      model: provider.model,
      max_tokens: maxTokens,
      temperature,
      system,
      messages: [{ role: "user", content: user }]
    };
  }
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: user });
  if (/\/responses\/?$/i.test(new URL(endpoint).pathname)) {
    return { model: provider.model, input: messages, max_output_tokens: maxTokens, temperature };
  }
  return { model: provider.model, messages, max_tokens: maxTokens, temperature };
}

function readText(provider, data) {
  if (provider.format === "anthropic") {
    const blocks = Array.isArray(data?.content) ? data.content : [];
    return blocks.filter(block => block?.type === "text").map(block => block.text).join("").trim();
  }
  if (typeof data?.output_text === "string") return data.output_text.trim();
  if (Array.isArray(data?.output)) {
    return data.output.flatMap(item => Array.isArray(item?.content) ? item.content : [])
      .map(part => part?.text || part?.output_text || "").join("").trim();
  }
  const choice = data?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return content.map(part => part?.text || "").join("").trim();
  return String(choice?.text || "").trim();
}

function explain(status, data, provider) {
  const detail = data?.error?.message || data?.message || data?.error || "";
  if (status === 401 || status === 403) return `${provider.label}: the API key was rejected (${status}). Check the key.`;
  if (status === 404) return `${provider.label}: endpoint or model not found (404). Check the URL and model name.`;
  if (status === 429) return `${provider.label}: rate limit or quota reached (429). Wait, then try again.`;
  if (status >= 500) return `${provider.label}: the provider returned ${status}. Try again shortly.`;
  return `${provider.label}: request failed (${status}). ${String(detail).slice(0, 200)}`.trim();
}

async function post(url, headers, body) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "POST", headers, body: JSON.stringify(body), signal: controller.signal,
        cache: "no-store", credentials: "omit"
      });
      const raw = await response.text();
      let data = null;
      try { data = raw ? JSON.parse(raw) : null; } catch { data = { error: { message: raw.slice(0, 200) } }; }
      if (!response.ok && (response.status === 429 || response.status >= 500) && attempt < 2) {
        clearTimeout(timer);
        const retryAfter = Math.min(5000, Math.max(0, Number(response.headers.get("retry-after")) || 0) * 1000);
        await new Promise(resolve => setTimeout(resolve, retryAfter || 700 * (attempt + 1)));
        continue;
      }
      return { response, data };
    } catch (error) {
      lastError = error;
      if (error?.name === "AbortError") break;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 700 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  const host = new URL(url).hostname;
  if (lastError?.name === "AbortError") throw new Error(`AI request to ${host} timed out. Check the mobile connection.`);
  throw new Error(`Could not connect to ${host} from this browser. Check mobile internet, VPN/DNS, and API access.`);
}

export async function callProvider(provider, { system, user, maxTokens = 300, temperature = 0.8 }) {
  if (!provider) throw new Error("No AI provider is selected. Add a key in the API Keys section.");
  if (!provider.apiKey) throw new Error(`${provider.label}: no API key saved yet.`);
  if (!provider.model) throw new Error(`${provider.label}: no model name set.`);

  const url = resolveEndpoint(provider.endpoint, provider.format);
  if (provider.custom && !(await hasHostAccess(url))) {
    throw new Error(`${provider.label}: browser access to ${new URL(url).origin} was not granted. Press Allow access for this endpoint.`);
  }

  const headers = authHeaders(provider);
  const responsesEndpoint = provider.format !== "anthropic" && /\/responses\/?$/i.test(new URL(url).pathname);
  let body = buildBody(provider, { system, user, maxTokens, temperature }, url);
  let { response, data } = await post(url, headers, body);

  // OpenAI-compatible models vary on token and temperature parameter names. Retry only when
  // the provider explicitly rejects one of those compatibility fields.
  for (let compatibilityAttempt = 0; !response.ok && provider.format !== "anthropic" && compatibilityAttempt < 2; compatibilityAttempt++) {
    const detail = String(data?.error?.message || data?.message || "");
    if (!/max_completion_tokens|max_output_tokens|max_tokens|temperature/i.test(detail)) break;
    const retry = { ...body };
    let changed = false;
    if (/temperature/i.test(detail) && Object.prototype.hasOwnProperty.call(retry, "temperature")) {
      delete retry.temperature;
      changed = true;
    }
    if (responsesEndpoint && /max_output_tokens|max_tokens/i.test(detail) && Object.prototype.hasOwnProperty.call(retry, "max_output_tokens")) {
      delete retry.max_output_tokens;
      changed = true;
    } else if (!responsesEndpoint && /max_completion_tokens|max_tokens/i.test(detail)) {
      delete retry.max_tokens;
      retry.max_completion_tokens = maxTokens;
      changed = true;
    }
    if (!changed) break;
    body = retry;
    ({ response, data } = await post(url, headers, retry));
  }
  if (!response.ok) throw new Error(explain(response.status, data, provider));

  const text = readText(provider, data);
  if (!text) throw new Error(`${provider.label}: the response contained no text.`);
  return text;
}

export async function testProvider(settings, ref) {
  const provider = resolveProvider(settings, ref);
  if (!provider) throw new Error("That provider is no longer saved.");
  const text = await callProvider(provider, {
    system: "Reply with the single word: ready",
    user: "Connection test.",
    maxTokens: 16,
    temperature: 0
  });
  return { label: provider.label, model: provider.model, text: text.slice(0, 60) };
}

// `keep` holds the parts a template supplied on purpose (mentions, hashtags, line breaks).
// Without it the generic cleanup would strip the very format the user asked for.
export function sanitizeComment(text, engage, keep = {}) {
  let out = String(text || "").replace(/\r/g, "").trim();
  out = out.replace(/^```[\w]*\s*|\s*```$/g, "").trim();
  out = out.replace(/^["'“”'']+|["'“”'']+$/g, "").trim();
  out = out.replace(/^(reply|comment|response)\s*[:\-–]\s*/i, "").trim();
  if (!keep.mentions) out = out.replace(/^@\w+\s+/g, "").trim();
  if (!keep.hashtags) out = out.replace(/#\w+/g, "");
  out = out.replace(/[ \t]{2,}/g, " ");
  out = keep.lineBreaks ? out.replace(/\n{4,}/g, "\n\n\n").trim() : out.replace(/\n{3,}/g, "\n\n").trim();
  if (engage.stripLinks !== false && !keep.links) {
    out = out.replace(/\bhttps?:\/\/\S+/gi, "").replace(/[ \t]{2,}/g, " ").trim();
  }
  const limit = Math.min(Number(engage.maxChars) || 200, 280);
  if (out.length > limit) {
    const cut = out.slice(0, limit);
    const boundary = cut.lastIndexOf(" ");
    out = (boundary > limit * 0.6 ? cut.slice(0, boundary) : cut).trim().replace(/[,;:]$/, "");
  }
  return out;
}

export async function generateComment(settings, tweet) {
  const engage = settings.engage;
  const template = findTemplate(settings, engage.templateId);
  const provider = resolveProviderFor(settings, "engage");
  const mentions = mentionText(template);
  const values = {
    author: tweet.author || "unknown",
    text: String(tweet.text || "").slice(0, 1200),
    language: engage.language || "English",
    tone: engage.tone || "friendly",
    maxChars: Math.min(Number(engage.maxChars) || 200, 280),
    mentions
  };
  const postWords = String(tweet.text || "").trim().split(/\s+/).filter(Boolean).length;
  const naturalCeiling = Math.min(values.maxChars,
    Math.max(40, Math.round((45 + Math.min(120, postWords * 2.1)) * (0.78 + Math.random() * 0.22))));
  // Spin exactly once per reply. Calling spin() again would draw different [a|b] options, so the
  // character budget and the 280 guard would be measuring a wrapper other than the one posted.
  const body = template ? spin(template.body) : "";
  const assemble = ai => fillTemplate(body, { ...values, ai })
    .replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();

  // A fixed template with no {{ai}} placeholder is pure text: no request, so no key needed.
  if (template && !templateNeedsAI(template)) {
    const text = assemble("").slice(0, 280).trim();
    if (!text) throw new Error(`Format "${template.name}" produced empty text.`);
    return { text, provider: `format: ${template.name}`, model: "none", template: template.name };
  }

  let user = fillTemplate(engage.prompt, values);
  user += `\n\nLength guidance: write a natural reply for this post. Keep it concise when the post is simple and use more context only when needed. Do not pad, repeat, or aim for a fixed length. Stay under ${naturalCeiling} characters (hard maximum ${values.maxChars}).`;
  let budget = naturalCeiling;
  if (template?.mode === "rules") {
    // assemble() rather than the raw body: placeholders must mean the same thing in both modes,
    // otherwise a rules body containing {{author}} would reach the model as literal braces.
    user += `\n\nFollow these formatting rules exactly:\n${assemble("")}`;
  } else if (template) {
    // Fixed format: the model fills only {{ai}}, so ask for a fragment that fits the leftover room.
    budget = Math.max(40, values.maxChars - assemble("").replace(/\s+/g, " ").trim().length);
    user += `\n\nWrite ONLY the part that replaces {{ai}} in this format, nothing else:\n${body}`
      + `\nKeep it under ${budget} characters. Do not add the mentions or the surrounding text yourself.`;
  }

  const raw = await callProvider(provider, {
    system: "You write one short, human-sounding reply. Output only the reply text.",
    user,
    maxTokens: 300,
    temperature: 0.85
  });

  if (template && template.mode === "template") {
    const fragment = sanitizeComment(raw, { ...engage, maxChars: budget }, { lineBreaks: false });
    if (!fragment) throw new Error("The generated reply was empty after cleanup.");
    let text = assemble(fragment);
    if (!text) throw new Error(`Format "${template.name}" produced empty text.`);
    // X hard-rejects past 280. Trim the AI fragment, never the user's mentions or wrapper.
    if (text.length > 280) {
      const over = text.length - 280;
      const shorter = fragment.slice(0, Math.max(0, fragment.length - over - 1)).trim().replace(/[,;:]$/, "");
      text = assemble(shorter).slice(0, 280).trim();
    }
    return { text, provider: provider.label, model: provider.model, template: template.name };
  }

  // Rules mode: the model wrote the whole reply, so keep what the rules asked for. A leading
  // @name is only noise when the format never asked for mentions — otherwise it is the point.
  const keep = template?.mode === "rules"
    ? { hashtags: true, lineBreaks: true, mentions: !!mentions }
    : {};
  const text = sanitizeComment(raw, { ...engage, maxChars: naturalCeiling }, keep);
  if (!text) throw new Error("The generated reply was empty after cleanup.");
  return { text, provider: provider.label, model: provider.model, template: template?.name || "" };
}
