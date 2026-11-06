# Preference Collector

A SillyTavern user extension that turns roleplay replies into preference data (DPO / ORPO / IPO / KTO / SFT).

It adds 👍 / 👎 to every assistant message and stores the rating **per swipe** inside the chat's message
metadata, so it survives reloads and normal chat saves. The export is JSONL, one record per line.

## Install

In SillyTavern: **Extensions** → **Install extension** → paste this URL:

```
https://github.com/thijsi123/sillytavern-preference-collector
```

No server plugin, no config, no build step. SillyTavern shallow-clones it, and the extension reads its own
folder name at runtime, so the repo can be cloned under any folder name. After installing, reload the page
and enable **Preference Collector** in the Extensions panel.

Works on desktop and on the mobile web UI (same SillyTavern server, same dataset file).

## Quick usage

| What you did | What gets exported |
| --- | --- |
| Reply is bad → 👎 | The reply becomes `rejected` |
| Reply is good → 👍 | The reply becomes `chosen` |
| Reply is almost good → edit it → 👍 | The edited text becomes `chosen`; the pre-edit text becomes `rejected` |
| Reply is bad → swipe → better reply → 👍 | The disliked swipe becomes `rejected`; the liked swipe becomes `chosen` |
| Model returned nothing → 👎 on the empty swipe | Exported as an `empty` rejected sample (reasoning kept if enabled) |
| Shift-click a thumb | Opens the tag/note dialog, plus the saved reasoning for that swipe |
| Alt-click a thumb | Clears the rating on that swipe |

Slash commands for a keyboard-only flow: `/pc-like` and `/pc-dislike` rate the last assistant reply.

### On a phone

On a coarse-pointer (touch) device the extension switches to a **floating 👍/👎 bar** pinned above the input
area instead of injecting into each message. It always rates the newest assistant reply, and it works even
when a theme hides or clips the message action bar.

| Touch action | Result |
| --- | --- |
| Tap 👍 / 👎 on the floating bar | Rate the newest reply |
| Long-press 👍 / 👎 (≈0.5 s) | Open the tag/note dialog |
| Panel → **Like last reply** / **Dislike last reply** | Same, without the bar |
| `/pc-like`, `/pc-dislike` | Same, from the chat input |

The floating bar is controlled by **Show floating buttons** (`auto` / `always` / `never`):

- `auto` (default) — message thumbs on mouse/trackpad, floating bar on touch screens.
- `always` — message thumbs **and** the floating bar everywhere.
- `never` — only message thumbs.

On desktop, the thumbs are appended at the **right end** of the message action bar (the slot that survives
`overflow-x: hidden` clipping on narrow windows).

## Why "per swipe" matters

`message.extra` is only the **currently selected swipe's** metadata. Every swipe has its own metadata in
`message.swipe_info[i].extra`, and `swipes[swipe_id]` is where SillyTavern actually stores text. Editing a
message rewrites `swipes[swipe_id]`; it does not keep the old text.

Consequences that the extension handles:

- A rating is written to `swipe_info[i].extra.preference` **and** mirrored to `message.extra.preference`
  when `i` is the selected swipe.
- `swipes[i]` can be `""` while `swipe_info[i].extra.reasoning` is full of text. That is a real failure
  mode (reasoning ate the whole token budget) and is exported as an `empty` sample.
- `mes` can be empty or belong to a different swipe than the one being viewed, so nothing reads `mes`
  directly for rating/export.
- Ratings and the captured prompt live **inside the chat file**, so exporting from another machine only
  works after that chat has been loaded, or via **Export all chats** on the server holding the files.

Stored shape:

```json
{
  "mes": "the selected swipe text",
  "swipes": ["swipe 0 text", "swipe 1 text"],
  "swipe_id": 1,
  "extra": { "preference": { "...": "selected swipe's rating" } },
  "swipe_info": [
    { "extra": { "preference": { "...": "swipe 0 rating" } } },
    { "send_date": "...", "gen_started": "...", "gen_finished": "...", "extra": { "...": "swipe 1 metadata" } }
  ]
}
```

## Prompt capture

SillyTavern sends two very different things depending on the API:

- chat-completion APIs: `eventTypes.CHAT_COMPLETION_PROMPT_READY` → `data.chat` (array of messages)
- text-completion APIs: `eventTypes.GENERATE_AFTER_COMBINE_PROMPTS` → `data.prompt` (string)

The extension listens to both, keeps the last one per generation, and attaches it to the message/swipe
that generation produced. When you rate that swipe, the prompt is stored on the rating.

That captured prompt is the **actual** system prompt + character card + world info + author's note +
example dialogue as the model saw it. Export uses it when present (`prompt_source: "captured"`), and
falls back to the reconstructed chat history (`prompt_source: "reconstructed"`) for ratings imported from
another session. It makes chat files heavier, so both capture and inclusion are toggleable.

## Where it exports to

There are two destinations, and they serve different purposes.

### 1. The dataset folder (default, persistent)

Every rating is merged into one cumulative file on the server:

```
data/<user>/files/preference-dataset.jsonl
data/<user>/files/preference-dataset.manifest.json
```

That is the user's **`files` directory** — the same folder the Data Bank uses. The extension writes through
`POST /api/files/upload`, so it needs no server-side changes. The API rejects subdirectories, so the folder
cannot contain a nested `preference-dataset/` folder; the dataset is a single file plus a manifest beside it.

Behavior:

- **Merge, not append.** Records are keyed by `id` (`chat_key:message_id:chosen_swipe:rejected_swipe:type:pair_source`).
  Re-rating a swipe, editing its note or adding tags replaces that line instead of duplicating it.
- **Auto-sync after each rating** (on by default, scope selectable: current chat or all chats).
- **Sync current chat / Sync all chats** buttons merge on demand.
- **Rebuild dataset file** replaces the file with exactly what is currently in the chats (drops records whose chat
  was deleted, and drops ratings you cleared, since those no longer exist in any chat).
- The manifest holds counts (records / likes / dislikes / empty / edited / tagged), chats, characters, models seen,
  a tag histogram, and `model_agnostic: true` + `prompt_shape`.

Because the file is flat, a second ST instance writing to the same user would race with it. Merge is
read-modify-write; do not run `Sync all` from two browsers at the same time.

### 2. Browser downloads (portable copy)

`Export current chat` / `Export all chats` still download a standalone `.jsonl` to your browser's Downloads
folder. Good for backups, or for moving the dataset to a training box without touching `data/`.

## Model-agnostic by design

The dataset keeps prompts as plain chat messages:

```json
"prompt": [{ "role": "system", "content": "..." }, { "role": "user", "content": "..." }]
```

No `<|im_start|>`, no `<start_of_turn>`, no Llama headers. One file therefore trains on Qwen, Gemma,
DeepSeek, Llama, Mistral, ... because the trainer/tokenizer applies that model's own chat template. If a
trainer insists on pre-rendered text, render it at conversion time (do not hand-edit the dataset):

```bash
python tools/preference_to_training.py preference-dataset.jsonl --out ./qwen   --format chatml
python tools/preference_to_training.py preference-dataset.jsonl --out ./gemma  --format gemma
python tools/preference_to_training.py preference-dataset.jsonl --out ./llama  --format llama3
python tools/preference_to_training.py preference-dataset.jsonl --out ./mistral --format mistral
python tools/preference_to_training.py preference-dataset.jsonl --out ./hf     --format sharegpt
```

## Exported dataset

Each line is one object. Example pair:

```json
{
  "id": "Example Chat - 2026-01-01 @12h 00m 00s 000ms::4:1:0:pair:swipe",
  "source": "sillytavern",
  "format_version": 2,
  "type": "pair",
  "pair_source": "swipe",
  "created_at": "2026-11-05T21:20:00.000Z",
  "chat_id": "Example Chat - 2026-01-01 @12h 00m 00s 000ms",
  "chat_key": "...",
  "message_id": 4,
  "character": { "name": "Example Character", "avatar": "Example.png" },
  "group": null,
  "user": { "name": "User" },
  "model": "your-model-name",
  "api": "custom",
  "persona": "",
  "persona_name": "User",
  "context": [
    { "role": "user", "name": "User", "content": "..." },
    { "role": "assistant", "name": "Example Character", "content": "..." }
  ],
  "prompt": [ { "role": "system", "content": "..." } ],
  "prompt_source": "captured",
  "prompt_text": "system: ...\n\nuser: ...",
  "chosen": "...",
  "rejected": "...",
  "chosen_meta": {
    "swipe_id": 1, "rating": "like", "rated_at": "...", "edited": false, "edited_from": null,
    "empty": false, "note": null, "tags": ["good restraint"], "model": "...", "api": "...", "reasoning": null
  },
  "rejected_meta": {
    "swipe_id": 0, "rating": "dislike", "rated_at": "...", "edited": false, "edited_from": null,
    "empty": false, "note": null, "tags": ["ignored user action"], "model": "...", "api": "...", "reasoning": "..."
  },
  "tags": ["good restraint", "ignored user action"],
  "notes": null,
  "character_card": { "name": "Example Character", "description": "...", "...": "..." }
}
```

`type` is one of:

- `pair` — has both `chosen` and `rejected` (DPO / ORPO / IPO). `pair_source` says how it was made:
  `swipe` (different swipes), `edit` (original vs your edit), `empty` (a real swipe vs a blank generation).
- `like` — only `chosen` (SFT)
- `dislike` — only `rejected` (KTO)
- `empty` — only `rejected`, and `rejected` is `""`; the reasoning is in `rejected_meta.reasoning`.
  Keep these out of DPO (a blank chosen text is a data bug), use them for KTO / reward-model negatives.

For `pair` records `prompt` is the prompt of the generation that produced the **chosen** side, which is the
right one to train on.

## Discriminator fields worth knowing

- `type`: `pair` (DPO-ready), `like` (SFT), `dislike` (KTO), `empty` (blank generation, KTO negative).
- `pair_source`: `swipe` (different swipes), `edit` (original vs your edit), `empty` (a real swipe vs a blank one).
- `prompt_source`: `captured` (the exact prompt sent) or `reconstructed` (chat history only).
- `chosen_meta.empty` / `rejected_meta.empty`: the text is `""` and the reasoning is the only surviving output.
- `tags`: union of both sides' failure tags; also mirrored per side.

## Buttons

In the settings section and in the extensions-menu panel:

- **Sync current chat** / **Sync dataset** — merge this chat's ratings into the dataset file.
- **Sync all chats** — scan every character chat and group chat on the server and merge everything.
- **Rebuild dataset file** — replace the dataset file with only the ratings currently present in chats.
- **Export current chat** / **Export all chats** — download a standalone `.jsonl` (browser Downloads).
- **Clear ratings in current chat** — removes the `preference` objects from all swipes in the open chat.

Clearing a rating does not rewrite the dataset file; run **Rebuild dataset file** if you want the cleared
rating gone from the dataset too.

The settings panel controls:

- number of context messages to include (default 12)
- include the character card
- include saved reasoning
- create pairs from edits
- include liked-only / disliked-only samples
- include empty / reasoning-only generations
- capture the outgoing prompt, and store it with ratings
- auto-sync on rating, its scope, and the dataset file name
- the failure-tag list shown in the shift-click dialog

## Converting to training data

`tools/preference_to_training.py` (stdlib only) turns the dataset into DPO / SFT / KTO files:

```bash
python tools/preference_to_training.py data/default-user/files/preference-dataset.jsonl --out ./dataset
```

It writes `dpo.jsonl`, `sft.jsonl` and `kto.jsonl`, drops empty/`like`-only records from the DPO set,
de-duplicates identical pairs, and keeps prompts in chat-message form by default. Use `--format` to render a
specific chat template (`chatml`, `gemma`, `llama3`, `mistral`, `sharegpt`), `--tags` to filter (for example
`--tags "ignored user action,forced escalation"`) and `--min-context` to skip turns with too little history.

## Notes

- Empty swipes are ignored for likes and for DPO pairs; only explicitly disliked empty swipes become
  `empty` samples.
- To capture the pre-edit version, rate or edit a message while the extension is loaded. If a message was
  edited before the extension loaded, the original text is no longer in the chat file.
- The chat file has an `integrity` slug in `chat_metadata`. The extension only mutates message metadata and
  then saves through SillyTavern's own save path (`saveChatConditional`), so the slug is preserved.
- Group chats are supported for exports; ratings are saved through the group-aware save path.

## Changelog

### 1.1.3
- Wider touch detection for the floating bar: SillyTavern's own `isMobile()`, `ontouchstart`,
  `navigator.maxTouchPoints > 0`, and `(pointer: coarse)` — not just the media query. Fixes phones that
  report a fine pointer (e.g. desktop-site mode) and so showed neither thumbs nor the floating bar.
- Floating bar also appears as a fallback on narrow windows (≤1000 px) even without touch.
- Floating bar z-index raised so it cannot sit behind the input form or mobile overlays.

### 1.1.2
- **Fixed activation**: `init` was not exported from `index.js`, so SillyTavern loaded the file but never
  ran it (`hook "activate" references "init" which is not an exported function`). No buttons, no menu entry,
  no settings panel on any device. This was the real "doesn't show up" bug.
- Floating 👍/👎 bar for touch devices: in `auto` mode coarse-pointer devices get the bar instead of message
  thumbs (theme-proof), with tap-to-rate and long-press-for-tags/note.
- `showFloatingButtons` setting (`auto` / `always` / `never`).

### 1.1.1
- Message thumbs are appended at the right end of the action bar instead of before the edit button; on
  narrow/mobile screens they were the first thing clipped by `overflow-x: hidden`.
- `.pc_rating_button` no longer shrinks; larger tap target on coarse pointers.
- Long-press a thumb on touch devices to open the tag/note dialog (shift-click equivalent).
- **Like last reply** / **Dislike last reply** buttons in the extensions-menu panel and the settings panel,
  as a fallback when a theme hides message buttons.
- Console warning when no thumbs could be injected.

### 1.1.0
- Cumulative model-agnostic dataset in `data/<user>/files/`, merge by record id, auto-sync, manifest.
- Prompt capture from both chat-completion and text-completion APIs.
- Failure tags, per-swipe reasoning, empty/reasoning-only negative samples.
- `tools/preference_to_training.py` with messages / sharegpt / chatml / gemma / llama3 / mistral output.

### 1.0.0
- Initial: per-swipe thumbs, edit pairs, swipe pairs, JSONL export.
