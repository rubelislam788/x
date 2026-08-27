# X Following Manager

A Chrome extension that manages your X (Twitter) account through the normal web interface. It drives the visible page the same way a person would — it does not call private APIs.

Load the folder with **Load unpacked** at `chrome://extensions`. Open an X tab first, then open the extension popup.

The popup has three sections, in the order you use them: **Automation**, **Formats**, **APIs & Keys**.

---

## 1. Automation

Two independent automations, each with its own **Enable / Disable** buttons at the top of its section. A disabled automation cannot be started and its controls are greyed out. Only one automation runs at a time; starting one while the other is active is refused with a clear message.

### Twitter/X Unfollow

Works on your Following page. Modes: unfollow all, unfollow non-followers, or a custom list (unfollow only those listed, or everyone except those listed). In the first two modes the username list is a protection list.

Configurable: min/max delay between unfollows, batch size range, cooldown length, stop-after-one-minute, reload-when-finished, auto-scroll, auto-refresh.

Each unfollow is verified — the extension confirms the button actually left the "Following" state. An account that cannot be verified is counted as **skipped**, never as unfollowed.

This automation uses no AI, so it needs no key and no format.

### Twitter/X Like & Comment

Reads the Home timeline and acts on posts one at a time. Actions: **Like + Comment**, **Like only**, or **Comment only**.

**API for this automation** and **Comment format** sit directly under Actions, so this automation's key and reply format are chosen where the automation is, not in a different section:

- **API for this automation** — leave it on *Use the default* to follow the global default, or pick any saved provider to override it for this automation only. **Test this API** tests whichever one is actually in effect. Every automation resolves its provider the same way, so a second automation can use a completely different key.
- **Comment format** — a saved format from section 2, or *No format* to use the plain prompt.

A line under the two selects always states what will happen, for example *Format "Reply + mention" is posted as written, with OpenAI filling {{ai}}*.

**Comment timing** — the spacing between actions:

- **1 minute** — 60 seconds between actions
- **50 seconds** — 50 seconds between actions
- **Random** — a fresh interval per action, drawn between your min and max

Random intervals are clamped: never below 5s, never above 600s, and never above the maximum you selected. The maximum is a hard ceiling, enforced both when settings are saved and again inside the engine.

Filters decide which posts qualify: skip promoted, skip replies, skip already-liked, a minimum post length, an allow list of authors, and a skip list of authors.

Reply generation is controlled by tone, language, maximum reply length, and an editable prompt template using `{{text}}`, `{{author}}`, `{{tone}}`, `{{language}}`, `{{maxChars}}`. **Preview a reply** generates one against a sample post, using the selected API and format, so you can tune it without touching your timeline. Generated text is cleaned before posting: quotes, code fences, hashtags, leading mentions and (optionally) links are stripped, and the text is cut to your limit at a word boundary. Anything a format supplied on purpose — its mentions, its line breaks — is kept.

If the API call fails and fallback comments are enabled, one saved comment is used instead, and the log records that a fallback was used.

### Both automations share

**Demo** — walks the same selection logic and reports what *would* happen. Nothing is clicked, liked, or posted.

**Start / Pause / Resume / Stop / Reset**, live counters, the current target, a countdown to the next action, and an activity log. Start asks for confirmation first.

Runs survive page reloads: state is stored in `chrome.storage.local` and the content script resumes where it left off. If X logs out or shows a challenge, the run pauses itself and waits for you. Closing the X tab stops the run.

## 2. Formats

A format is a saved reply shape. Write it once, press **Add**, then pick it in any automation. Each format has a name, a mode, a body, and an optional mention list. Your very first format is selected for Like & Comment automatically; after that, saving a new one never changes what a running automation posts — you pick it with **Use**.

Only the placeholders in the table below are recognised. Anything else in braces would be posted with the braces showing, so **Add** refuses it and names the offender rather than letting a typo reach your timeline.

**Fixed format — post exactly as written.** The body is the reply. Placeholders are filled in:

| Placeholder | Becomes |
| --- | --- |
| `{{ai}}` | the part the AI writes |
| `{{mentions}}` | the accounts in the format's mention list |
| `{{author}}` | the post's author |
| `{{text}}` | the post's text |
| `{{tone}}` | the tone selected in the automation |
| `{{language}}` | the language selected in the automation |
| `{{maxChars}}` | the reply-length limit selected in the automation |

So a body of `{{ai}}\n\n{{mentions}}` posts an AI-written reply with your accounts mentioned underneath. A body with **no** `{{ai}}` is pure text — it is posted as written and no API is called at all, so this mode works with no key saved.

**Format rules — the AI follows them.** The body is handed to the model as instructions, one rule per line, and the model writes the whole reply. Placeholders are filled in first, so a rule may refer to `{{author}}` or `{{mentions}}`. Use this mode for style rules such as *no emoji*, *under 180 characters*, *react to one concrete detail*.

Anywhere in a body, `[nice|great|solid]` picks one option at random per reply, so repeated formats do not read identically. The choice is drawn once per reply, so the text that is measured against X's limit is the text that gets posted.

Character budgeting is automatic: the model is asked for a fragment that fits the room left over after your fixed text, and if the assembled reply would still exceed X's 280-character limit the AI fragment is trimmed — never your mentions or your wrapper.

Each saved format has **Use** (select it for Like & Comment), **Preview** (build a sample reply against a sample post), **Edit**, and **Delete**. Deleting a format in use is safe: the automation falls back to the plain prompt rather than breaking.

## 3. APIs & Keys

Everything credential-related lives here.

**Default API for all automations** is the fallback any automation uses when it has not chosen its own.

### Official keys

Paste the key and it works — there is no connection setup, proxy, or account linking.

| Provider | Where to get a key | Default model |
| --- | --- | --- |
| OpenAI | platform.openai.com/api-keys | `gpt-4o-mini` |
| Anthropic | console.anthropic.com/settings/keys | `claude-sonnet-5` |

Pick the model from the dropdown or type any model name your account can use. **Test connection** sends one tiny request and reports exactly what came back, so a wrong key or model is visible immediately rather than at run time.

### Custom endpoints

For any other endpoint: a proxy, a gateway, a self-hosted server, or another vendor.

Each entry has a name, a request format (**OpenAI compatible** → `/chat/completions`, or **Anthropic compatible** → `/messages`), a URL, a key, and a model. Paste a base URL like `https://api.example.com` or `https://api.example.com/v1` and the correct path is appended; paste a full endpoint and it is used as-is. The resolved request URL is shown under the field before you save.

Press **Add** to save it. Saved endpoints are listed with **Use** (make it the default), **Test**, **Edit**, and **Delete**, and each one also appears in every automation's own API picker. Add as many as you like.

Advanced: override the auth header name and value prefix for gateways that expect something other than `Authorization: Bearer …` or `x-api-key`.

Custom hosts are not in the manifest, so Chrome asks for permission for that specific origin the first time you save one. If you decline, requests to it are blocked and the extension says so rather than failing silently.

Deleting an endpoint that an automation was using is safe — that automation reverts to the default.

### Where keys go

Keys live in `chrome.storage.local` on this machine. They are sent only to the provider endpoint, only from the extension's background worker — never to the X page, and never anywhere else.

---

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest |
| `defaults.js` | Settings schema, limits, timing plan, format engine, per-automation provider resolution |
| `llm.js` | Provider transport, URL resolution, format-aware comment generation and cleanup |
| `background.js` | Service worker: settings, run state, message router, AI proxy |
| `content.js` | Shared content-script core and message router |
| `unfollow.js` | Unfollow engine |
| `engage.js` | Like & comment engine |
| `popup.html` / `popup.css` / `popup.js` | The interface: Automation, Formats, APIs & Keys |

After changing any file, click **Reload** for the extension at `chrome://extensions`, then refresh the X tab.

## Notes

Automated liking and replying is more visible to X than unfollowing. Keep the volume low, keep the intervals long, and use Demo first. Slower settings are safer than fast ones.
