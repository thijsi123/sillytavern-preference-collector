import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
import { Popup, POPUP_RESULT, POPUP_TYPE } from '../../../popup.js';

const MODULE_NAME = 'preference-collector';

/**
 * The folder this extension is installed under. SillyTavern clones a repo into
 * `third-party/<repo-name>`, so the name is not guaranteed to be
 * `preference-collector`. Derive it from the module URL instead of hardcoding it
 * (it is used for the settings template path).
 */
const EXTENSION_FOLDER = (() => {
    try {
        const segments = new URL(import.meta.url).pathname.split('/').filter(Boolean);
        return segments[segments.length - 2] || MODULE_NAME;
    } catch {
        return MODULE_NAME;
    }
})();
const SETTINGS_KEY = 'preferenceCollector';
const PREF_KEY = 'preference';

/**
 * Text of a swipe as it existed when the extension first saw it in this session.
 * Used to recover the pre-edit version when the user edits a reply and then rates it.
 * @type {Map<string, string>}
 */
const originalTextCache = new Map();

/**
 * The exact prompt that was sent for a swipe, captured from SillyTavern's
 * generation events. Keyed the same way as originalTextCache.
 * @type {Map<string, {kind: string, prompt: any, api: string|null, model: string|null, captured_at: string}>}
 */
const promptCache = new Map();

/**
 * Prompt captured by the most recent generation event, waiting to be attached
 * to the message/swipe that generation produced.
 * @type {{kind: string, prompt: any, api: string|null, model: string|null, at: number}|null}
 */
let pendingPrompt = null;

const PROMPT_MAX_AGE_MS = 5 * 60 * 1000;

const defaultSettings = {
    enabled: true,
    showButtons: true,
    contextMessages: 12,
    includeCharacterCard: true,
    includeReasoning: false,
    includeEditedPairs: true,
    includeLikedSingles: true,
    includeDislikedSingles: false,
    includeEmptySamples: true,
    capturePrompt: true,
    includePrompt: true,
    datasetFileName: 'preference-dataset.jsonl',
    autoSyncDataset: true,
    datasetScope: 'chat',
    failureTags: 'ignored user action, contradicted user action, repeated card detail, no room to react, forced escalation, internal monologue dump, repetition, wrong voice, empty reply',
};

function ctx() {
    return getContext();
}

function notify(type, message, title = 'Preference Collector') {
    try {
        if (typeof toastr !== 'undefined' && typeof toastr[type] === 'function') {
            toastr[type](message, title);
        } else {
            console.log(`[${title}] ${message}`);
        }
    } catch (error) {
        console.debug(MODULE_NAME, error);
    }
}

function getSettings() {
    if (!extension_settings[SETTINGS_KEY] || typeof extension_settings[SETTINGS_KEY] !== 'object') {
        extension_settings[SETTINGS_KEY] = {};
    }

    const settings = extension_settings[SETTINGS_KEY];
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (settings[key] === undefined) {
            settings[key] = value;
        }
    }

    return settings;
}

function saveSettings() {
    try {
        ctx().saveSettingsDebounced();
    } catch (error) {
        console.debug(MODULE_NAME, error);
    }
}

function currentSwipeId(message) {
    return Number.isInteger(message?.swipe_id) ? message.swipe_id : 0;
}

/**
 * Per-swipe metadata (`swipe_info[i].extra`) is the authoritative source for
 * model, api and reasoning. `message.extra` only mirrors the selected swipe.
 * @param {object} message
 * @param {number} swipeId
 * @returns {object}
 */
function swipeExtra(message, swipeId) {
    const infoExtra = message?.swipe_info?.[swipeId]?.extra;

    if (infoExtra && typeof infoExtra === 'object') {
        return infoExtra;
    }

    if (currentSwipeId(message) === swipeId && message?.extra && typeof message.extra === 'object') {
        return message.extra;
    }

    return {};
}

function swipeText(message, swipeId) {
    if (Array.isArray(message?.swipes) && typeof message.swipes[swipeId] === 'string') {
        return message.swipes[swipeId];
    }

    if (currentSwipeId(message) === swipeId && typeof message?.mes === 'string') {
        return message.mes;
    }

    return '';
}

function getPreference(message, swipeId) {
    const infoPreference = message?.swipe_info?.[swipeId]?.extra?.[PREF_KEY] ?? null;

    if (infoPreference) {
        return infoPreference;
    }

    // Older ratings (or ratings written before swipe_info existed) may only live
    // on the selected swipe's `extra`.
    if (currentSwipeId(message) === swipeId) {
        return message?.extra?.[PREF_KEY] ?? null;
    }

    return null;
}

function ensureSwipeData(message) {
    if (!message || typeof message !== 'object') {
        return false;
    }

    if (!Array.isArray(message.swipes)) {
        message.swipes = [typeof message.mes === 'string' ? message.mes : ''];
    }

    if (!Number.isInteger(message.swipe_id)) {
        message.swipe_id = 0;
    }

    if (!Array.isArray(message.swipe_info)) {
        message.swipe_info = [];
    }

    if (!message.extra || typeof message.extra !== 'object') {
        message.extra = {};
    }

    for (let i = 0; i < message.swipes.length; i++) {
        if (!message.swipe_info[i] || typeof message.swipe_info[i] !== 'object') {
            message.swipe_info[i] = {};
        }

        if (!message.swipe_info[i].extra || typeof message.swipe_info[i].extra !== 'object') {
            message.swipe_info[i].extra = {};
        }
    }

    return true;
}

/**
 * Writes a preference into both the per-swipe metadata (source of truth) and the
 * currently selected message metadata (so the UI updates without a swipe sync).
 * @param {object} message
 * @param {number} swipeId
 * @param {object|null} preference
 */
function writePreference(message, swipeId, preference) {
    if (!ensureSwipeData(message)) {
        return;
    }

    if (preference) {
        message.swipe_info[swipeId].extra[PREF_KEY] = preference;

        if (currentSwipeId(message) === swipeId) {
            message.extra[PREF_KEY] = preference;
        }
    } else {
        delete message.swipe_info[swipeId].extra[PREF_KEY];

        if (currentSwipeId(message) === swipeId) {
            delete message.extra[PREF_KEY];
        }
    }
}

async function saveChat() {
    try {
        await ctx().saveChat();
    } catch (error) {
        console.error(MODULE_NAME, 'Failed to save chat', error);
        notify('error', 'Could not save the rating to the chat file.');
    }
}

function messageKey(messageId, swipeId) {
    const chatId = ctx().getCurrentChatId() ?? 'current-chat';
    return `${chatId}::${messageId}::${swipeId}`;
}

function captureOriginal(messageId) {
    const context = ctx();
    const message = context.chat?.[messageId];

    if (!message || message.is_user || message.is_system) {
        return;
    }

    // Capture every swipe, not just the selected one. Editing a swipe requires
    // selecting it first, but generating/keeping them all means the pre-edit
    // text is still available later in the session.
    const swipeCount = Math.max(Array.isArray(message.swipes) ? message.swipes.length : 1, 1);

    for (let swipeId = 0; swipeId < swipeCount; swipeId++) {
        const key = messageKey(messageId, swipeId);
        if (originalTextCache.has(key)) {
            continue;
        }

        const text = String(swipeText(message, swipeId) ?? '');
        if (text.length > 0) {
            originalTextCache.set(key, text);
        }
    }
}

function flattenPrompt(prompt) {
    if (!prompt) {
        return null;
    }

    if (typeof prompt === 'string') {
        return prompt;
    }

    if (Array.isArray(prompt)) {
        return prompt.map(entry => {
            if (!entry || typeof entry !== 'object') {
                return String(entry ?? '');
            }

            const role = entry.role ?? entry.name ?? 'unknown';
            const content = typeof entry.content === 'string'
                ? entry.content
                : Array.isArray(entry.content)
                    ? entry.content.map(part => part?.text ?? (typeof part === 'string' ? part : '')).filter(Boolean).join('\n')
                    : JSON.stringify(entry.content ?? '');

            return `${role}: ${content}`;
        }).join('\n\n');
    }

    return JSON.stringify(prompt);
}

function sanitizePrompt(prompt) {
    if (!Array.isArray(prompt)) {
        return typeof prompt === 'string' ? prompt : null;
    }

    return prompt.map(entry => {
        if (!entry || typeof entry !== 'object') {
            return { role: 'unknown', content: String(entry ?? '') };
        }

        const sanitized = { role: entry.role ?? 'unknown' };
        if (typeof entry.name === 'string' && entry.name.length > 0) {
            sanitized.name = entry.name;
        }

        if (typeof entry.content === 'string') {
            sanitized.content = entry.content;
        } else if (Array.isArray(entry.content)) {
            sanitized.content = entry.content
                .map(part => (typeof part === 'string' ? part : part?.text ?? ''))
                .filter(Boolean)
                .join('\n');
        } else if (entry.content !== undefined) {
            sanitized.content = JSON.stringify(entry.content);
        }

        for (const key of ['tool_call_id', 'tool_calls', 'name', 'role']) {
            if (entry[key] !== undefined && sanitized[key] === undefined) {
                sanitized[key] = entry[key];
            }
        }

        return sanitized;
    });
}

function capturePromptEvent(kind, prompt) {
    if (!getSettings().capturePrompt || !prompt) {
        return;
    }

    const model = (() => {
        try {
            return ctx().getChatCompletionModel?.() ?? null;
        } catch {
            return null;
        }
    })();

    pendingPrompt = {
        kind,
        prompt: kind === 'chat' ? sanitizePrompt(prompt) : String(prompt),
        api: ctx().mainApi ?? null,
        model,
        at: Date.now(),
    };
}

function attachPendingPrompt(messageId) {
    if (!pendingPrompt || Date.now() - pendingPrompt.at > PROMPT_MAX_AGE_MS) {
        return;
    }

    const message = ctx().chat?.[messageId];
    if (!message || message.is_user || message.is_system) {
        return;
    }

    const swipeId = currentSwipeId(message);
    promptCache.set(messageKey(messageId, swipeId), {
        kind: pendingPrompt.kind,
        prompt: pendingPrompt.prompt,
        api: pendingPrompt.api,
        model: pendingPrompt.model,
        captured_at: new Date().toISOString(),
    });

    pendingPrompt = null;
}

function getPersonaDescription() {
    const context = ctx();
    const powerUser = context.powerUserSettings ?? {};
    const descriptions = powerUser.persona_descriptions ?? {};
    const active = Object.values(descriptions).find(persona => persona?.name && persona.name === context.name1);

    return active?.description
        ?? powerUser.persona_description
        ?? Object.values(descriptions)[0]?.description
        ?? '';
}

function getPersonaName() {
    const context = ctx();
    const descriptions = context.powerUserSettings?.persona_descriptions ?? {};
    const active = Object.values(descriptions).find(persona => persona?.name && persona.name === context.name1);
    return active?.name ?? context.name1 ?? null;
}

function createPreference(message, swipeId, messageId, text, rating, note, tags, existing) {
    const key = messageKey(messageId, swipeId);
    const captured = originalTextCache.get(key);
    const existingEditedFrom = existing?.editedFrom && existing.editedFrom !== text ? existing.editedFrom : null;
    const capturedEditedFrom = captured !== undefined && captured !== text ? captured : null;
    const editedFrom = existingEditedFrom ?? capturedEditedFrom;
    const extra = swipeExtra(message, swipeId);
    const settings = getSettings();

    const preference = {
        version: 1,
        rating,
        text,
        note: note || '',
        tags: Array.isArray(tags) ? tags.filter(Boolean) : [],
        editedFrom: editedFrom ?? null,
        edited: !!editedFrom,
        empty: text.trim().length === 0,
        ratedAt: new Date().toISOString(),
        swipeId,
        messageId,
        swipeCount: Math.max(Array.isArray(message.swipes) ? message.swipes.length : 1, 1),
        model: extra.model ?? message.extra?.model ?? null,
        api: extra.api ?? message.extra?.api ?? null,
        persona: getPersonaDescription(),
        persona_name: getPersonaName(),
    };

    if (settings.includeReasoning) {
        const reasoning = extra.reasoning ?? message.extra?.reasoning;
        if (reasoning) {
            preference.reasoning = reasoning;
        }
    }

    if (settings.capturePrompt && settings.includePrompt) {
        const capturedPrompt = promptCache.get(key);
        if (capturedPrompt) {
            preference.prompt = capturedPrompt.prompt;
            preference.prompt_kind = capturedPrompt.kind;
            preference.prompt_captured_at = capturedPrompt.captured_at;
            if (capturedPrompt.model) {
                preference.model = capturedPrompt.model;
            }
            if (capturedPrompt.api) {
                preference.api = capturedPrompt.api;
            }
        }
    }

    return preference;
}

/**
 * Small dialog for shift-click: pick failure-mode tags and optionally write a note.
 * @param {object} message
 * @param {number} swipeId
 * @param {string} rating
 * @param {object} existing
 * @returns {Promise<{tags: string[], note: string}|null>}
 */
async function showRatingDialog(message, swipeId, rating, existing) {
    const settings = getSettings();
    const available = String(settings.failureTags ?? '')
        .split(',')
        .map(tag => tag.trim())
        .filter(Boolean);
    const selected = new Set(Array.isArray(existing?.tags) ? existing.tags : []);
    const reasoning = String(swipeExtra(message, swipeId).reasoning ?? '').slice(0, 3000);

    const content = $(`
        <div class="pc_settings pc_dialog">
            <div class="pc_hint">
                Mark this reply as <b>${rating === 'like' ? 'chosen' : 'rejected'}</b>.
                Tags are optional; they end up in the exported record as <code>tags</code>.
            </div>
            <div class="pc_tag_list"></div>
            <label class="pc_field pc_block" for="pc_dialog_note">
                <span>Note</span>
                <textarea id="pc_dialog_note" class="text_pole textarea_compact" rows="3"
                    placeholder="e.g. did not react to my last action"></textarea>
            </label>
            <details class="pc_details">
                <summary>Saved reasoning</summary>
                <pre class="pc_reasoning"></pre>
            </details>
            <label class="pc_field pc_block" for="pc_dialog_custom">
                <span>Add a tag</span>
                <input id="pc_dialog_custom" class="text_pole" type="text" placeholder="custom tag">
            </label>
        </div>
    `);

    const list = content.find('.pc_tag_list');
    for (const tag of available) {
        const label = $('<label class="checkbox_label pc_tag_label"></label>');
        const checkbox = $('<input type="checkbox">').prop('checked', selected.has(tag)).val(tag);
        label.append(checkbox).append($('<span></span>').text(tag));
        list.append(label);
    }

    content.find('#pc_dialog_note').val(existing?.note ?? '');
    content.find('.pc_reasoning').text(reasoning || 'No reasoning saved for this swipe.');
    content.find('.pc_details').toggle(reasoning.length > 0);

    const result = await new Popup(content, POPUP_TYPE.TEXT, '', {
        okButton: 'Save rating',
        cancelButton: 'Cancel',
        wide: false,
    }).show();

    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return null;
    }

    const tags = [];
    content.find('.pc_tag_label input:checked').each((_index, element) => {
        tags.push(String(element.value));
    });

    const custom = String(content.find('#pc_dialog_custom').val() ?? '').trim();
    if (custom.length > 0) {
        tags.push(custom);
    }

    return { tags, note: String(content.find('#pc_dialog_note').val() ?? '') };
}

async function rateMessage(messageId, rating, withDialog, withClear) {
    const context = ctx();
    const settings = getSettings();

    if (!settings.enabled) {
        return;
    }

    const message = context.chat?.[messageId];
    if (!message || message.is_user || message.is_system) {
        return;
    }

    const swipeId = currentSwipeId(message);
    const text = String(message.mes ?? swipeText(message, swipeId) ?? '');
    const isEmpty = text.trim().length === 0;

    const existing = getPreference(message, swipeId) ?? {};
    let note = typeof existing.note === 'string' ? existing.note : '';
    let tags = Array.isArray(existing.tags) ? existing.tags : [];

    if (withClear) {
        if (!existing.rating) {
            notify('info', 'There is no rating to clear on this swipe.');
            return;
        }

        writePreference(message, swipeId, null);
        await saveChat();
        refreshMessageButtons(messageId);
        updateStats();
        notify('info', 'Rating cleared.');
        return;
    }

    if (isEmpty && rating === 'like') {
        notify('warning', 'This swipe is empty. An empty generation can only be saved as rejected.');
        return;
    }

    if (withDialog) {
        const dialog = await showRatingDialog(message, swipeId, rating, existing);
        if (!dialog) {
            return;
        }

        note = dialog.note;
        tags = dialog.tags;
    }

    const textChanged = typeof existing.text === 'string' && existing.text !== text;

    if (existing.rating === rating && !withDialog && !textChanged) {
        notify('info', `Already marked as ${rating === 'like' ? 'chosen' : 'rejected'}. Shift-click to add tags/note, Alt-click to clear.`);
        return;
    }

    if (isEmpty && !isEmptySampleEnabled()) {
        notify('info', 'Empty-swipe samples are disabled in the extension settings.');
        return;
    }

    const preference = createPreference(message, swipeId, messageId, text, rating, note, tags, existing);
    writePreference(message, swipeId, preference);
    originalTextCache.set(messageKey(messageId, swipeId), text);
    await saveChat();
    refreshMessageButtons(messageId);
    updateStats();

    if (settings.autoSyncDataset) {
        void syncDataset(settings.datasetScope || 'chat', { silent: true });
    }

    if (isEmpty) {
        notify('success', 'Saved an empty generation as rejected (reasoning kept if enabled).');
        return;
    }

    notify('success', rating === 'like' ? 'Saved as chosen.' : 'Saved as rejected.');
}

function isEmptySampleEnabled() {
    return !!getSettings().includeEmptySamples;
}

async function onMessageEdited(messageId) {
    const context = ctx();
    const message = context.chat?.[messageId];

    if (!message || message.is_user || message.is_system) {
        return;
    }

    const swipeId = currentSwipeId(message);
    const currentText = String(message.mes ?? '');
    const key = messageKey(messageId, swipeId);
    const before = originalTextCache.get(key);
    const existing = getPreference(message, swipeId);
    const original = before !== undefined
        ? before
        : (existing?.text && existing.text !== currentText ? existing.text : undefined);

    if (original !== undefined && original !== currentText) {
        if (existing) {
            const updated = {
                ...existing,
                editedFrom: existing.editedFrom ?? original,
                edited: true,
                editedAt: new Date().toISOString(),
            };

            // If the user already chose this reply, an edit is normally them
            // improving the chosen answer. Keep a disliked version as the
            // original rejected text until they re-rate it.
            if (existing.rating === 'like') {
                updated.text = currentText;
                updated.empty = currentText.trim().length === 0;
            }

            writePreference(message, swipeId, updated);
            await saveChat();
        } else {
            writePreference(message, swipeId, {
                version: 1,
                editedFrom: original,
                editedAt: new Date().toISOString(),
            });
            await saveChat();
        }
    }

    originalTextCache.set(key, currentText);
    refreshMessageButtons(messageId);
}

function injectMessageButtons(messageId) {
    const settings = getSettings();

    if (!settings.enabled || !settings.showButtons) {
        return;
    }

    const message = ctx().chat?.[messageId];
    if (!message || message.is_user || message.is_system) {
        return;
    }

    const element = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!element) {
        return;
    }

    const buttons = element.querySelector('.mes_buttons');
    if (!buttons) {
        return;
    }

    let like = buttons.querySelector('.pc_like');
    let dislike = buttons.querySelector('.pc_dislike');

    if (!like || !dislike) {
        like = document.createElement('div');
        like.className = 'mes_button pc_rating_button pc_like fa-solid fa-thumbs-up';

        dislike = document.createElement('div');
        dislike.className = 'mes_button pc_rating_button pc_dislike fa-solid fa-thumbs-down';

        const editButton = buttons.querySelector('.mes_edit');
        if (editButton) {
            buttons.insertBefore(like, editButton);
            buttons.insertBefore(dislike, editButton);
        } else {
            buttons.appendChild(like);
            buttons.appendChild(dislike);
        }
    }

    updateMessageButtonState(messageId, like, dislike);
}

function updateMessageButtonState(messageId, likeElement = null, dislikeElement = null) {
    const message = ctx().chat?.[messageId];
    if (!message) {
        return;
    }

    const element = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!element) {
        return;
    }

    const like = likeElement ?? element.querySelector('.pc_like');
    const dislike = dislikeElement ?? element.querySelector('.pc_dislike');
    if (!like || !dislike) {
        return;
    }

    const preference = getPreference(message, currentSwipeId(message));
    const rating = preference?.rating ?? null;
    const note = preference?.note ? ` Note: ${preference.note}` : '';
    const tags = Array.isArray(preference?.tags) && preference.tags.length > 0 ? ` Tags: ${preference.tags.join(', ')}` : '';
    const edited = preference?.edited ? ' (edited)' : '';

    like.classList.toggle('pc_active_like', rating === 'like');
    dislike.classList.toggle('pc_active_dislike', rating === 'dislike');

    like.title = rating === 'like'
        ? `Liked${edited}. Shift-click to edit tags/note, Alt-click to clear.${note}${tags}`
        : 'Like this reply (chosen). Shift-click for tags/note, Alt-click to clear.';
    dislike.title = rating === 'dislike'
        ? `Disliked${edited}. Shift-click to edit tags/note, Alt-click to clear.${note}${tags}`
        : 'Dislike this reply (rejected). Shift-click for tags/note, Alt-click to clear.';
}

function refreshMessageButtons(messageId) {
    injectMessageButtons(messageId);
    updateMessageButtonState(messageId);
}

function refreshAllMessageButtons() {
    const settings = getSettings();

    if (!settings.enabled || !settings.showButtons) {
        document.querySelectorAll('.pc_rating_button').forEach(element => element.remove());
        return;
    }

    document.querySelectorAll('#chat .mes').forEach(element => {
        const messageId = Number(element.getAttribute('mesid'));
        if (Number.isInteger(messageId)) {
            const message = ctx().chat?.[messageId];
            if (message && !originalTextCache.has(messageKey(messageId, currentSwipeId(message)))) {
                captureOriginal(messageId);
            }
            refreshMessageButtons(messageId);
        }
    });
}

function getContextMessages(messages, messageId, meta) {
    const maxMessages = Math.max(0, Number(getSettings().contextMessages) || 0);

    if (maxMessages === 0) {
        return [];
    }

    const usable = [];
    for (let i = 0; i < messageId; i++) {
        const message = messages[i];
        if (!message || message.is_system || message.extra?.isSmallSys) {
            continue;
        }

        const content = typeof message.mes === 'string' ? message.mes : '';
        if (content.trim().length === 0) {
            continue;
        }

        usable.push({
            role: message.is_user ? 'user' : 'assistant',
            name: message.name || (message.is_user ? meta.user.name : meta.character?.name || 'Assistant'),
            content,
        });
    }

    return usable.slice(-maxMessages);
}

function formatContext(context) {
    return context
        .map(message => `${message.name || (message.role === 'user' ? 'User' : 'Assistant')}: ${message.content}`)
        .join('\n\n');
}

function characterCardSummary(character) {
    if (!character) {
        return null;
    }

    const card = {
        name: character.name,
        description: character.description,
        personality: character.personality,
        scenario: character.scenario,
        first_mes: character.first_mes,
        mes_example: character.mes_example,
        system_prompt: character.system_prompt,
        post_history_instructions: character.post_history_instructions,
        creator_notes: character.creator_notes,
        character_version: character.character_version,
        tags: Array.isArray(character.tags) && character.tags.length > 0 ? character.tags : undefined,
    };

    for (const key of Object.keys(card)) {
        if (card[key] === undefined || card[key] === null || card[key] === '') {
            delete card[key];
        }
    }

    return Object.keys(card).length > 0 ? card : null;
}

function currentChatMeta() {
    const context = ctx();
    const character = context.characterId !== undefined && context.characterId !== null
        ? context.characters?.[context.characterId]
        : null;
    const group = context.groupId
        ? context.groups?.find(item => item.id === context.groupId)
        : null;
    const chatId = context.getCurrentChatId() ?? null;

    return {
        chat_key: `${chatId ?? 'current'}::${character?.avatar ?? group?.id ?? 'chat'}`,
        chat_id: chatId,
        character: character ? { name: character.name, avatar: character.avatar } : null,
        group: group ? { id: group.id, name: group.name } : null,
        user: { name: context.name1 || 'User' },
        character_card: characterCardSummary(character),
    };
}

function characterChatMeta(character, chatId) {
    return {
        chat_key: `${chatId}::${character.avatar}`,
        chat_id: chatId,
        character: { name: character.name, avatar: character.avatar },
        group: null,
        user: { name: ctx().name1 || 'User' },
        character_card: characterCardSummary(character),
    };
}

function groupChatMeta(group, chatId) {
    const context = ctx();
    const members = (group.members ?? [])
        .map(avatar => context.characters?.find(character => character?.avatar === avatar)?.name)
        .filter(Boolean);

    return {
        chat_key: `${chatId}::group::${group.id}`,
        chat_id: chatId,
        character: null,
        group: { id: group.id, name: group.name, members },
        user: { name: context.name1 || 'User' },
        character_card: null,
    };
}

function preferenceMeta(preference) {
    if (!preference) {
        return null;
    }

    const reasoning = preference.reasoning ? String(preference.reasoning) : null;

    return {
        swipe_id: preference.swipeId ?? null,
        rating: preference.rating ?? null,
        rated_at: preference.ratedAt ?? null,
        edited: !!preference.edited,
        edited_from: preference.editedFrom ?? null,
        empty: preference.empty ?? (typeof preference.text === 'string' && preference.text.trim().length === 0),
        note: preference.note || null,
        tags: Array.isArray(preference.tags) && preference.tags.length > 0 ? preference.tags : null,
        model: preference.model ?? null,
        api: preference.api ?? null,
        reasoning,
    };
}

function makeRecord({ meta, messageId, context, type, pairSource, chosen, rejected }) {
    const settings = getSettings();
    const chosenPreference = chosen?.preference ?? null;
    const rejectedPreference = rejected?.preference ?? null;
    const capturedPrompt = chosenPreference?.prompt ?? rejectedPreference?.prompt ?? null;
    const tags = [
        ...(Array.isArray(chosenPreference?.tags) ? chosenPreference.tags : []),
        ...(Array.isArray(rejectedPreference?.tags) ? rejectedPreference.tags : []),
    ].filter((tag, index, list) => list.indexOf(tag) === index);

    const record = {
        id: `${meta.chat_key}:${messageId}:${chosen?.swipeId ?? 'x'}:${rejected?.swipeId ?? 'x'}:${type}:${pairSource ?? 'single'}`,
        source: 'sillytavern',
        format_version: 2,
        type,
        pair_source: pairSource ?? null,
        created_at: chosenPreference?.ratedAt ?? rejectedPreference?.ratedAt ?? new Date().toISOString(),
        chat_id: meta.chat_id,
        chat_key: meta.chat_key,
        message_id: messageId,
        character: meta.character,
        group: meta.group,
        user: meta.user,
        model: chosenPreference?.model ?? rejectedPreference?.model ?? null,
        api: chosenPreference?.api ?? rejectedPreference?.api ?? null,
        persona: chosenPreference?.persona ?? rejectedPreference?.persona ?? null,
        persona_name: chosenPreference?.persona_name ?? rejectedPreference?.persona_name ?? null,
        context,
        prompt: settings.includePrompt && capturedPrompt ? capturedPrompt : context,
        prompt_source: settings.includePrompt && capturedPrompt ? 'captured' : 'reconstructed',
        prompt_text: settings.includePrompt && capturedPrompt
            ? flattenPrompt(capturedPrompt)
            : formatContext(context),
        chosen: chosen?.text ?? null,
        rejected: rejected?.text ?? null,
        chosen_meta: preferenceMeta(chosenPreference),
        rejected_meta: preferenceMeta(rejectedPreference),
        tags: tags.length > 0 ? tags : null,
        notes: [chosenPreference?.note, rejectedPreference?.note].filter(Boolean).join(' | ') || null,
    };

    if (settings.includeCharacterCard) {
        record.character_card = meta.character_card;
    }

    if (settings.includeReasoning) {
        record.reasoning = chosenPreference?.reasoning ?? rejectedPreference?.reasoning ?? null;
    }

    return record;
}

function collectRecords(messages, meta) {
    const settings = getSettings();
    const records = [];
    const seen = new Set();

    for (let messageId = 0; messageId < messages.length; messageId++) {
        const message = messages[messageId];
        if (!message || message.is_user || message.is_system) {
            continue;
        }

        const swipeCount = Math.max(Array.isArray(message.swipes) ? message.swipes.length : 1, 1);
        const preferences = [];

        for (let swipeId = 0; swipeId < swipeCount; swipeId++) {
            const preference = getPreference(message, swipeId);
            if (!preference?.rating) {
                continue;
            }

            const storedText = typeof preference.text === 'string' ? preference.text : null;
            const text = storedText !== null ? storedText : swipeText(message, swipeId);
            const empty = text.trim().length === 0;

            // An empty swipe is a real failure sample (reasoning used the whole
            // budget). Keep it only when it was explicitly rated.
            if (empty && (!settings.includeEmptySamples || preference.rating !== 'dislike')) {
                continue;
            }

            preferences.push({ ...preference, swipeId, text, empty });
        }

        if (preferences.length === 0) {
            continue;
        }

        const context = getContextMessages(messages, messageId, meta);
        const likes = preferences.filter(preference => preference.rating === 'like');
        const dislikes = preferences.filter(preference => preference.rating === 'dislike');

        const add = (type, pairSource, chosen, rejected) => {
            if (!chosen && !rejected) {
                return;
            }

            if (chosen?.text && rejected?.text && chosen.text === rejected.text) {
                return;
            }

            const record = makeRecord({ meta, messageId, context, type, pairSource, chosen, rejected });
            if (seen.has(record.id)) {
                return;
            }

            seen.add(record.id);
            records.push(record);
        };

        if (settings.includeEditedPairs) {
            for (const like of likes) {
                if (like.editedFrom && like.editedFrom !== like.text) {
                    add('pair', 'edit', { preference: like, swipeId: like.swipeId, text: like.text }, {
                        preference: {
                            ...like,
                            rating: null,
                            note: 'pre-edit version',
                            tags: [],
                            edited: false,
                            editedFrom: null,
                        },
                        swipeId: like.swipeId,
                        text: like.editedFrom,
                    });
                }
            }
        }

        for (const like of likes) {
            for (const dislike of dislikes) {
                add('pair', 'swipe', { preference: like, swipeId: like.swipeId, text: like.text }, {
                    preference: dislike,
                    swipeId: dislike.swipeId,
                    text: dislike.text,
                });
            }
        }

        // Empty generations are only useful as failures, never as chosen.
        if (settings.includeEmptySamples) {
            for (const empty of preferences.filter(preference => preference.empty)) {
                const partner = likes[0] ?? null;
                if (partner) {
                    add('pair', 'empty', { preference: partner, swipeId: partner.swipeId, text: partner.text }, {
                        preference: empty,
                        swipeId: empty.swipeId,
                        text: '',
                    });
                }

                add('empty', null, null, { preference: empty, swipeId: empty.swipeId, text: '' });
            }
        }

        if (settings.includeLikedSingles) {
            for (const like of likes) {
                add('like', null, { preference: like, swipeId: like.swipeId, text: like.text }, null);
            }
        }

        if (settings.includeDislikedSingles) {
            for (const dislike of dislikes.filter(preference => !preference.empty)) {
                add('dislike', null, null, { preference: dislike, swipeId: dislike.swipeId, text: dislike.text });
            }
        }
    }

    return records;
}

function countStats(messages) {
    const stats = {
        ratings: 0,
        likes: 0,
        dislikes: 0,
        edited: 0,
        empty: 0,
        tagged: 0,
        pairedMessages: 0,
    };

    if (!Array.isArray(messages)) {
        return stats;
    }

    for (const message of messages) {
        if (!message || message.is_user || message.is_system) {
            continue;
        }

        const swipeCount = Math.max(Array.isArray(message.swipes) ? message.swipes.length : 1, 1);
        let likes = 0;
        let dislikes = 0;

        for (let swipeId = 0; swipeId < swipeCount; swipeId++) {
            const preference = getPreference(message, swipeId);
            if (!preference?.rating) {
                continue;
            }

            stats.ratings++;

            if (preference.rating === 'like') {
                stats.likes++;
                likes++;
            } else if (preference.rating === 'dislike') {
                stats.dislikes++;
                dislikes++;
            }

            if (preference.edited || preference.editedFrom) {
                stats.edited++;
            }

            if (preference.empty || (typeof preference.text === 'string' && preference.text.trim().length === 0)) {
                stats.empty++;
            }

            if (Array.isArray(preference.tags) && preference.tags.length > 0) {
                stats.tagged++;
            }
        }

        if (likes > 0 && dislikes > 0) {
            stats.pairedMessages++;
        }
    }

    return stats;
}

function statsText(stats) {
    if (stats.ratings === 0) {
        return 'No ratings yet in this chat.';
    }

    const extras = [
        `${stats.edited} edited`,
        `${stats.tagged} tagged`,
        `${stats.empty} empty`,
        `${stats.pairedMessages} message${stats.pairedMessages === 1 ? '' : 's'} with like/dislike pairs`,
    ];

    return `${stats.ratings} rated swipe${stats.ratings === 1 ? '' : 's'} — ${stats.likes} liked, ${stats.dislikes} disliked, ${extras.join(', ')}.`;
}

function updateStats() {
    const text = statsText(countStats(ctx().chat ?? []));
    $('#pc_stats').text(text);
    $('#pc_panel_stats').text(text);
}

function sanitizeFileName(value) {
    return String(value ?? 'preferences')
        .replace(/\.jsonl$/i, '')
        .replace(/[\\/:*?"<>|]+/g, '_')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 120) || 'preferences';
}

function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
}

function downloadRecords(records, baseName) {
    const jsonl = records.map(record => JSON.stringify(record)).join('\n') + '\n';
    const blob = new Blob([jsonl], { type: 'application/x-jsonlines;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${sanitizeFileName(baseName)}_${timestamp()}.jsonl`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function exportCurrentChat() {
    const context = ctx();

    if (!Array.isArray(context.chat) || context.chat.length === 0) {
        notify('warning', 'No chat is currently loaded.');
        return;
    }

    const meta = currentChatMeta();
    const records = collectRecords(context.chat, meta);

    if (records.length === 0) {
        notify('warning', 'No liked/disliked replies found in this chat.');
        return;
    }

    const name = meta.character?.name ?? meta.group?.name ?? 'chat';
    downloadRecords(records, `preferences_${name}_${meta.chat_id ?? 'current'}`);
    notify('success', `Exported ${records.length} record${records.length === 1 ? '' : 's'} from the current chat.`);
}

function stripChatMetadata(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }

    const messages = raw.filter(item => item && typeof item === 'object');

    if (messages.length > 0 && (messages[0].chat_metadata || messages[0].user_name === 'unused')) {
        messages.shift();
    }

    return messages;
}

async function collectAllChatRecords() {
    const context = ctx();
    const headers = context.getRequestHeaders();
    const records = [];
    let scanned = 0;
    let failed = 0;

    const loaderHandle = context.loader?.show?.({
        message: 'Scanning chats for preference data...',
        blocking: true,
        toastMode: 'static',
        slug: 'preference-collector-export',
    });

    try {
        for (const character of context.characters ?? []) {
            if (!character?.avatar) {
                continue;
            }

            try {
                const response = await fetch('/api/characters/chats', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ avatar_url: character.avatar, simple: true }),
                });

                if (!response.ok) {
                    failed++;
                    continue;
                }

                const data = await response.json();
                if (!data || data.error === true) {
                    continue;
                }

                for (const info of Object.values(data)) {
                    const fileName = String(info?.file_name ?? '').replace(/\.jsonl$/i, '');
                    if (!fileName) {
                        continue;
                    }

                    try {
                        const chatResponse = await fetch('/api/chats/get', {
                            method: 'POST',
                            headers,
                            body: JSON.stringify({
                                ch_name: character.name,
                                file_name: fileName,
                                avatar_url: character.avatar,
                            }),
                        });

                        if (!chatResponse.ok) {
                            failed++;
                            continue;
                        }

                        const messages = stripChatMetadata(await chatResponse.json());
                        if (messages.length === 0) {
                            continue;
                        }

                        records.push(...collectRecords(messages, characterChatMeta(character, fileName)));
                        scanned++;
                    } catch (error) {
                        failed++;
                        console.error(MODULE_NAME, 'Failed to read chat', character.name, fileName, error);
                    }
                }
            } catch (error) {
                failed++;
                console.error(MODULE_NAME, 'Failed to list chats for', character.name, error);
            }
        }

        for (const group of context.groups ?? []) {
            for (const chatId of group.chats ?? []) {
                try {
                    const response = await fetch('/api/chats/group/get', {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({ id: chatId }),
                    });

                    if (!response.ok) {
                        failed++;
                        continue;
                    }

                    const messages = stripChatMetadata(await response.json());
                    if (messages.length === 0) {
                        continue;
                    }

                    records.push(...collectRecords(messages, groupChatMeta(group, chatId)));
                    scanned++;
                } catch (error) {
                    failed++;
                    console.error(MODULE_NAME, 'Failed to read group chat', group.name, chatId, error);
                }
            }
        }
    } finally {
        await loaderHandle?.hide?.();
    }

    return { records, scanned, failed };
}

async function exportAllChats() {
    const { records, scanned, failed } = await collectAllChatRecords();

    if (records.length === 0) {
        notify('warning', `No rated replies found (${scanned} chat${scanned === 1 ? '' : 's'} scanned${failed > 0 ? `, ${failed} failed` : ''}).`);
        return;
    }

    downloadRecords(records, `preferences_all_${sanitizeFileName(ctx().name1 || 'user')}`);
    notify('success', `Exported ${records.length} record${records.length === 1 ? '' : 's'} from ${scanned} chat${scanned === 1 ? '' : 's'}${failed > 0 ? ` (${failed} failed)` : ''}.`);
}

/* ------------------------------------------------------------------ *
 * Server-side dataset folder
 *
 * Writes one cumulative, model-agnostic JSONL file into the user's
 * `files` directory (the Data Bank folder):
 *
 *     data/<user>/files/preference-dataset.jsonl
 *     data/<user>/files/preference-dataset.manifest.json
 *
 * `/api/files/upload` only accepts flat names, so the dataset lives as a
 * single file plus a manifest next to it. Records keep role/content
 * messages with no model-specific template tokens, so the same file can
 * be trained with Qwen, Gemma, DeepSeek, Llama, ... (the trainer applies
 * that model's chat template).
 * ------------------------------------------------------------------ */

function datasetFileName() {
    return getSettings().datasetFileName || defaultSettings.datasetFileName;
}

function manifestFileName() {
    return datasetFileName().replace(/\.jsonl$/i, '.manifest.json');
}

function toBase64Utf8(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = '';

    for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }

    return btoa(binary);
}

function recordId(record) {
    return typeof record?.id === 'string' && record.id.length > 0 ? record.id : null;
}

/**
 * Reads the current aggregate dataset from the server. A missing file is normal.
 * @returns {Promise<object[]>}
 */
async function readDatasetRecords() {
    try {
        const response = await fetch(`/user/files/${encodeURIComponent(datasetFileName())}`, {
            cache: 'no-store',
            headers: ctx().getRequestHeaders(),
        });

        if (!response.ok) {
            return [];
        }

        const text = await response.text();
        return text
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean)
            .map(line => {
                try {
                    return JSON.parse(line);
                } catch {
                    return null;
                }
            })
            .filter(Boolean);
    } catch (error) {
        console.debug(MODULE_NAME, 'Could not read dataset file', error);
        return [];
    }
}

function mergeRecords(existing, incoming) {
    const byId = new Map();
    let replaced = 0;
    let added = 0;

    for (const record of existing) {
        const id = recordId(record);
        if (id) {
            byId.set(id, record);
        }
    }

    for (const record of incoming) {
        const id = recordId(record);
        if (!id) {
            continue;
        }

        if (byId.has(id)) {
            replaced++;
        } else {
            added++;
        }

        byId.set(id, record);
    }

    const records = [...byId.values()].sort((left, right) => {
        const leftKey = `${left.created_at ?? ''}|${left.chat_key ?? ''}|${String(left.message_id ?? 0).padStart(6, '0')}|${left.id ?? ''}`;
        const rightKey = `${right.created_at ?? ''}|${right.chat_key ?? ''}|${String(right.message_id ?? 0).padStart(6, '0')}|${right.id ?? ''}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });

    return { records, added, replaced };
}

function datasetSummary(records) {
    const summary = {
        records: records.length,
        types: {},
        pair_sources: {},
        likes: 0,
        dislikes: 0,
        empty: 0,
        edited: 0,
        tagged: 0,
        chats: new Set(),
        characters: new Set(),
        models: new Set(),
        tags: {},
    };

    for (const record of records) {
        summary.types[record.type ?? 'unknown'] = (summary.types[record.type ?? 'unknown'] ?? 0) + 1;

        if (record.pair_source) {
            summary.pair_sources[record.pair_source] = (summary.pair_sources[record.pair_source] ?? 0) + 1;
        }

        if (record.type === 'like') summary.likes++;
        if (record.type === 'dislike') summary.dislikes++;
        if (record.type === 'empty') summary.empty++;
        if (record.chosen_meta?.edited || record.rejected_meta?.edited) summary.edited++;
        if (Array.isArray(record.tags) && record.tags.length > 0) summary.tagged++;

        if (record.chat_key) summary.chats.add(record.chat_key);
        if (record.character?.name) summary.characters.add(record.character.name);
        if (record.group?.name) summary.characters.add(record.group.name);
        if (record.model) summary.models.add(record.model);

        for (const tag of record.tags ?? []) {
            summary.tags[tag] = (summary.tags[tag] ?? 0) + 1;
        }
    }

    return {
        records: summary.records,
        types: summary.types,
        pair_sources: summary.pair_sources,
        likes: summary.likes,
        dislikes: summary.dislikes,
        empty: summary.empty,
        edited: summary.edited,
        tagged: summary.tagged,
        chats: summary.chats.size,
        characters: [...summary.characters].sort(),
        models: [...summary.models].sort(),
        tags: Object.fromEntries(Object.entries(summary.tags).sort((a, b) => b[1] - a[1])),
    };
}

async function uploadDatasetFile(name, text) {
    const response = await fetch('/api/files/upload', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ name, data: toBase64Utf8(text) }),
    });

    if (!response.ok) {
        throw new Error(`Upload failed (${response.status}): ${await response.text()}`);
    }

    return response.json();
}

async function writeDataset(records) {
    const jsonl = records.map(record => JSON.stringify(record)).join('\n') + '\n';
    const summary = datasetSummary(records);
    const manifest = {
        format_version: 2,
        model_agnostic: true,
        prompt_shape: 'chat-messages (role/content, no model chat-template tokens)',
        updated_at: new Date().toISOString(),
        file: datasetFileName(),
        user: ctx().name1 ?? null,
        ...summary,
    };

    await uploadDatasetFile(datasetFileName(), jsonl);
    await uploadDatasetFile(manifestFileName(), JSON.stringify(manifest, null, 2) + '\n');

    return manifest;
}

/**
 * Merges ratings into the server-side dataset file.
 * @param {'chat'|'all'} scope
 * @param {{replace?: boolean, silent?: boolean}} options
 */
async function syncDataset(scope = 'chat', { replace = false, silent = false } = {}) {
    const settings = getSettings();

    if (!settings.enabled) {
        return null;
    }

    let incoming = [];

    if (scope === 'all') {
        const collected = await collectAllChatRecords();
        incoming = collected.records;

        if (incoming.length === 0 && !replace) {
            if (!silent) {
                notify('warning', 'No rated replies found to sync.');
            }
            return null;
        }

        if (incoming.length === 0 && replace) {
            const confirmed = await Popup.show.confirm(
                'Rebuild dataset',
                'No rated replies were found. Rebuild the dataset file as empty?',
                { okButton: 'Rebuild', cancelButton: 'Cancel' },
            );

            if (confirmed !== POPUP_RESULT.AFFIRMATIVE) {
                return null;
            }
        }
    } else {
        if (!Array.isArray(ctx().chat) || ctx().chat.length === 0) {
            return null;
        }

        incoming = collectRecords(ctx().chat, currentChatMeta());
    }

    const existing = replace ? [] : await readDatasetRecords();
    const merged = mergeRecords(existing, incoming);

    if (!replace && merged.records.length === 0) {
        if (!silent) {
            notify('warning', 'Nothing to sync yet. Rate some replies first.');
        }
        return null;
    }

    try {
        const manifest = await writeDataset(merged.records);
        lastDatasetState = { manifest, at: Date.now() };

        try {
            renderDatasetState();
        } catch (error) {
            console.debug(MODULE_NAME, 'Could not update the dataset UI', error);
        }

        if (!silent) {
            notify('success', `Dataset synced: ${manifest.records} record${manifest.records === 1 ? '' : 's'} (+${merged.added}, ~${merged.replaced} updated) → files/${datasetFileName()}`);
        } else {
            console.debug(MODULE_NAME, `Dataset synced: ${manifest.records} records (+${merged.added}, ~${merged.replaced})`);
        }

        return manifest;
    } catch (error) {
        console.error(MODULE_NAME, 'Dataset sync failed', error);
        notify('error', `Could not write the dataset file: ${error.message ?? error}`);
        return null;
    }
}

let lastDatasetState = null;

function renderDatasetState() {
    const settings = getSettings();
    const file = datasetFileName();
    const summary = lastDatasetState?.manifest ?? null;

    $('#pc_dataset_file').text(`files/${file}`);

    if (!summary) {
        $('#pc_dataset_stats').text('Not synced in this session yet.');
        return;
    }

    const parts = [
        `${summary.records} records`,
        `${summary.likes} likes`,
        `${summary.dislikes} dislikes`,
        `${summary.empty} empty`,
        `${summary.edited} edited`,
        `${summary.chats} chat${summary.chats === 1 ? '' : 's'}`,
    ];

    if (summary.characters?.length) {
        parts.push(`${summary.characters.length} character${summary.characters.length === 1 ? '' : 's'}`);
    }

    $('#pc_dataset_stats').text(parts.join(' · '));
    $('.pc_dataset_models').toggle((summary.models?.length ?? 0) > 0).text(`Models: ${(summary.models ?? []).join(', ')}`);
    $('.pc_dataset_tags').toggle(Object.keys(summary.tags ?? {}).length > 0).text(`Tags: ${Object.entries(summary.tags ?? {}).map(([tag, count]) => `${tag} (${count})`).join(', ')}`);
}

async function refreshDatasetState() {
    const records = await readDatasetRecords();
    lastDatasetState = records.length > 0 ? { manifest: datasetSummary(records), at: Date.now() } : null;
    renderDatasetState();
}

async function clearCurrentChatRatings() {
    const context = ctx();

    if (!Array.isArray(context.chat) || context.chat.length === 0) {
        notify('warning', 'No chat is currently loaded.');
        return;
    }

    const result = await Popup.show.confirm(
        'Clear ratings',
        'Remove all preference ratings from the current chat? This cannot be undone.',
        { okButton: 'Clear ratings', cancelButton: 'Cancel' },
    );

    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    let cleared = 0;

    for (const message of context.chat) {
        if (!message || message.is_user || message.is_system) {
            continue;
        }

        if (message.extra?.[PREF_KEY]) {
            delete message.extra[PREF_KEY];
            cleared++;
        }

        if (Array.isArray(message.swipe_info)) {
            for (const info of message.swipe_info) {
                if (info?.extra?.[PREF_KEY]) {
                    delete info.extra[PREF_KEY];
                    cleared++;
                }
            }
        }
    }

    await saveChat();
    refreshAllMessageButtons();
    updateStats();
    notify('info', `Cleared ${cleared} rating${cleared === 1 ? '' : 's'} from this chat.`);
}

function applySettingsToUi() {
    const settings = getSettings();

    $('#pc_enabled').prop('checked', settings.enabled);
    $('#pc_show_buttons').prop('checked', settings.showButtons);
    $('#pc_context_messages').val(settings.contextMessages);
    $('#pc_include_character_card').prop('checked', settings.includeCharacterCard);
    $('#pc_include_reasoning').prop('checked', settings.includeReasoning);
    $('#pc_include_edited_pairs').prop('checked', settings.includeEditedPairs);
    $('#pc_include_liked_singles').prop('checked', settings.includeLikedSingles);
    $('#pc_include_disliked_singles').prop('checked', settings.includeDislikedSingles);
    $('#pc_include_empty_samples').prop('checked', settings.includeEmptySamples);
    $('#pc_capture_prompt').prop('checked', settings.capturePrompt);
    $('#pc_include_prompt').prop('checked', settings.includePrompt);
    $('#pc_auto_sync_dataset').prop('checked', settings.autoSyncDataset);
    $('#pc_dataset_scope').val(settings.datasetScope || 'chat');
    $('#pc_dataset_filename').val(settings.datasetFileName);
    $('#pc_failure_tags').val(settings.failureTags);
}

function bindSettingsUi() {
    const settings = getSettings();

    $('#pc_enabled').on('change', () => {
        settings.enabled = $('#pc_enabled').prop('checked');
        saveSettings();
        refreshAllMessageButtons();
    });

    $('#pc_show_buttons').on('change', () => {
        settings.showButtons = $('#pc_show_buttons').prop('checked');
        saveSettings();
        refreshAllMessageButtons();
    });

    $('#pc_context_messages').on('change input', () => {
        const value = Number($('#pc_context_messages').val());
        settings.contextMessages = Number.isFinite(value) ? Math.max(0, Math.min(100, Math.trunc(value))) : defaultSettings.contextMessages;
        saveSettings();
    });

    $('#pc_include_character_card').on('change', () => {
        settings.includeCharacterCard = $('#pc_include_character_card').prop('checked');
        saveSettings();
    });

    $('#pc_include_reasoning').on('change', () => {
        settings.includeReasoning = $('#pc_include_reasoning').prop('checked');
        saveSettings();
    });

    $('#pc_include_edited_pairs').on('change', () => {
        settings.includeEditedPairs = $('#pc_include_edited_pairs').prop('checked');
        saveSettings();
    });

    $('#pc_include_liked_singles').on('change', () => {
        settings.includeLikedSingles = $('#pc_include_liked_singles').prop('checked');
        saveSettings();
    });

    $('#pc_include_disliked_singles').on('change', () => {
        settings.includeDislikedSingles = $('#pc_include_disliked_singles').prop('checked');
        saveSettings();
    });

    $('#pc_include_empty_samples').on('change', () => {
        settings.includeEmptySamples = $('#pc_include_empty_samples').prop('checked');
        saveSettings();
    });

    $('#pc_capture_prompt').on('change', () => {
        settings.capturePrompt = $('#pc_capture_prompt').prop('checked');
        saveSettings();
    });

    $('#pc_include_prompt').on('change', () => {
        settings.includePrompt = $('#pc_include_prompt').prop('checked');
        saveSettings();
    });

    $('#pc_failure_tags').on('change input', () => {
        settings.failureTags = String($('#pc_failure_tags').val() ?? '');
        saveSettings();
    });

    $('#pc_auto_sync_dataset').on('change', () => {
        settings.autoSyncDataset = $('#pc_auto_sync_dataset').prop('checked');
        saveSettings();
    });

    $('#pc_dataset_scope').on('change', () => {
        settings.datasetScope = String($('#pc_dataset_scope').val() ?? 'chat');
        saveSettings();
    });

    $('#pc_dataset_filename').on('change input', () => {
        const value = String($('#pc_dataset_filename').val() ?? '').trim();
        const safe = value.replace(/[^a-zA-Z0-9_.-]+/g, '_');
        const withExtension = /\.jsonl$/i.test(safe) ? safe : `${safe}.jsonl`;
        settings.datasetFileName = withExtension || defaultSettings.datasetFileName;
        saveSettings();
        renderDatasetState();
    });

    $('#pc_sync_current').on('click', () => syncDataset('chat'));
    $('#pc_sync_all').on('click', () => syncDataset('all'));
    $('#pc_rebuild_dataset').on('click', async () => {
        const confirmed = await Popup.show.confirm(
            'Rebuild dataset file',
            `Replace files/${datasetFileName()} with only the ratings currently saved in your chats? Records whose chat was deleted will disappear.`,
            { okButton: 'Rebuild', cancelButton: 'Cancel' },
        );

        if (confirmed !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }

        await syncDataset('all', { replace: true });
    });

    $('#pc_export_current').on('click', exportCurrentChat);
    $('#pc_export_all').on('click', exportAllChats);
    $('#pc_clear_current').on('click', clearCurrentChatRatings);
}

function openPanel() {
    const panelStats = statsText(countStats(ctx().chat ?? []));

    const content = $(`
        <div class="pc_settings pc_panel">
            <div class="pc_hint">
                Use the thumbs on assistant messages. Edit then like for an edited pair, or swipe and like for a swipe pair.
                Shift-click a thumb for tags/notes; Alt-click clears a rating.
            </div>
            <div class="pc_stats" id="pc_panel_stats"></div>
            <div class="pc_hint pc_small">
                Dataset file: <code id="pc_panel_dataset_file">files/${datasetFileName()}</code>
            </div>
            <div class="pc_stats" id="pc_panel_dataset_stats">Not synced in this session yet.</div>
            <div class="flex-container flexGap5 pc_actions">
                <div id="pc_panel_sync" class="menu_button">Sync dataset</div>
                <div id="pc_panel_sync_all" class="menu_button">Sync all chats</div>
            </div>
            <div class="flex-container flexGap5 pc_actions">
                <div id="pc_panel_export_current" class="menu_button">Export current chat</div>
                <div id="pc_panel_export_all" class="menu_button">Export all chats</div>
            </div>
            <div class="pc_hint pc_small">
                The dataset file is cumulative: every rating is merged by record id, so re-rating or editing a note
                replaces the old line instead of adding a duplicate. Downloads stay available as a portable copy.
            </div>
            <div class="pc_hint pc_small">
                To change context length, cards, singles and other options, open the Preference Collector section in the Extensions panel.
            </div>
        </div>
    `);

    content.find('#pc_panel_stats').text(panelStats);
    content.find('#pc_panel_export_current').on('click', () => {
        exportCurrentChat();
    });
    content.find('#pc_panel_export_all').on('click', () => {
        exportAllChats();
    });
    content.find('#pc_panel_sync').on('click', () => syncDataset('chat'));
    content.find('#pc_panel_sync_all').on('click', () => syncDataset('all'));

    if (lastDatasetState?.manifest) {
        const summary = lastDatasetState.manifest;
        content.find('#pc_panel_dataset_stats').text(
            `${summary.records} records · ${summary.likes} likes · ${summary.dislikes} dislikes · ${summary.empty} empty · ${summary.chats} chats`,
        );
    }

    new Popup(content, POPUP_TYPE.TEXT, '', { okButton: 'Close', wide: false }).show();
}

function addMenuEntry() {
    if ($('#pc_menu_entry').length > 0) {
        return;
    }

    const menu = $('#extensionsMenu');
    if (menu.length === 0) {
        return;
    }

    const entry = $(`
        <div id="pc_menu_entry" class="list-group-item flex-container flexGap5" title="Preference Collector">
            <div class="fa-solid fa-scale-balanced extensionsMenuExtensionButton"></div>
            <span>Preference Collector</span>
        </div>
    `);

    entry.on('click', event => {
        event.preventDefault();
        event.stopPropagation();
        openPanel();
    });

    menu.append(entry);
}

async function addSettingsPanel() {
    if ($('#preference_collector_container').length > 0) {
        return;
    }

    const html = await renderExtensionTemplateAsync(`third-party/${EXTENSION_FOLDER}`, 'settings');
    const container = $('<div id="preference_collector_container" class="extension_container"></div>').append(html);
    const parent = $('#extensions_settings2').length > 0 ? $('#extensions_settings2') : $('#extensions_settings');

    parent.append(container);
}

function registerEvents() {
    const context = ctx();
    const { eventSource, eventTypes } = context;

    // Capture the exact prompt that a generation sends. Chat-completion APIs
    // emit it as an array on CHAT_COMPLETION_PROMPT_READY, text-completion APIs
    // as a string on GENERATE_AFTER_COMBINE_PROMPTS. Whichever fires last wins.
    eventSource.on(eventTypes.GENERATION_STARTED, () => {
        pendingPrompt = null;
    });

    eventSource.on(eventTypes.CHAT_COMPLETION_PROMPT_READY, data => {
        if (Array.isArray(data?.chat)) {
            capturePromptEvent('chat', data.chat);
        }
    });

    eventSource.on(eventTypes.GENERATE_AFTER_COMBINE_PROMPTS, data => {
        if (typeof data?.prompt === 'string' && data.prompt.length > 0) {
            capturePromptEvent('text', data.prompt);
        }
    });

    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, messageId => {
        attachPendingPrompt(messageId);
        captureOriginal(messageId);
        refreshMessageButtons(messageId);
        updateStats();
    });

    eventSource.on(eventTypes.MESSAGE_SWIPED, messageId => {
        attachPendingPrompt(messageId);
        captureOriginal(messageId);
        refreshMessageButtons(messageId);
        updateStats();
    });

    eventSource.on(eventTypes.MESSAGE_UPDATED, messageId => {
        refreshMessageButtons(messageId);
        updateStats();
    });

    eventSource.on(eventTypes.MESSAGE_EDITED, async messageId => {
        await onMessageEdited(messageId);
        updateStats();
    });

    eventSource.on(eventTypes.MESSAGE_DELETED, () => {
        originalTextCache.clear();
        promptCache.clear();
        updateStats();
    });

    eventSource.on(eventTypes.MESSAGE_SWIPE_DELETED, () => {
        originalTextCache.clear();
        promptCache.clear();
        refreshAllMessageButtons();
    });

    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        originalTextCache.clear();
        promptCache.clear();
        pendingPrompt = null;
        setTimeout(() => {
            refreshAllMessageButtons();
            updateStats();
        }, 100);
    });

    eventSource.on(eventTypes.CHAT_LOADED, () => {
        originalTextCache.clear();
        promptCache.clear();
        pendingPrompt = null;
        setTimeout(() => {
            refreshAllMessageButtons();
            updateStats();
        }, 100);
    });

    eventSource.on(eventTypes.MORE_MESSAGES_LOADED, () => {
        refreshAllMessageButtons();
        updateStats();
    });

    $(document).on('click', '.pc_rating_button', async event => {
        event.preventDefault();
        event.stopPropagation();

        const target = event.currentTarget;
        const messageElement = target.closest('.mes');
        if (!messageElement) {
            return;
        }

        const messageId = Number(messageElement.getAttribute('mesid'));
        if (!Number.isInteger(messageId)) {
            return;
        }

        const rating = target.classList.contains('pc_like') ? 'like' : 'dislike';
        await rateMessage(messageId, rating, event.shiftKey, event.altKey);
    });
}

export function lastAssistantMessageId() {
    const chat = ctx().chat ?? [];

    for (let messageId = chat.length - 1; messageId >= 0; messageId--) {
        const message = chat[messageId];
        if (message && !message.is_user && !message.is_system) {
            return messageId;
        }
    }

    return -1;
}

function registerSlashCommands() {
    const context = ctx();
    const SlashCommand = context.SlashCommand;
    const SlashCommandParser = context.SlashCommandParser;

    if (!SlashCommand?.fromProps || !SlashCommandParser?.addCommandObject) {
        return;
    }

    const makeCallback = rating => async () => {
        const messageId = lastAssistantMessageId();
        if (messageId < 0) {
            notify('warning', 'There is no assistant reply to rate.');
            return '';
        }

        await rateMessage(messageId, rating, false, false);
        return '';
    };

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'pc-like',
        callback: makeCallback('like'),
        helpString: 'Marks the last assistant reply as chosen (liked).',
        returns: '',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'pc-dislike',
        callback: makeCallback('dislike'),
        helpString: 'Marks the last assistant reply as rejected (disliked). Empty replies are allowed.',
        returns: '',
    }));
}

async function init() {
    getSettings();
    await addSettingsPanel();
    bindSettingsUi();
    applySettingsToUi();
    addMenuEntry();
    registerEvents();
    registerSlashCommands();
    refreshAllMessageButtons();
    updateStats();
    renderDatasetState();
    void refreshDatasetState();
    console.log(`[${MODULE_NAME}] Ready.`);
}
