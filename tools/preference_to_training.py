#!/usr/bin/env python3
"""Convert Preference Collector JSONL exports into DPO / SFT / KTO files.

Stdlib only. The exported dataset is deliberately model-agnostic: prompts are stored as plain
role/content chat messages with no chat-template tokens, so the same file works for Qwen, Gemma,
DeepSeek, Llama, Mistral, ... This script can either keep that shape or render a specific chat
template for trainers that want one long text string.

Usage:
    python preference_to_training.py preference-dataset.jsonl --out ./dataset
    python preference_to_training.py preference-dataset.jsonl --out ./dataset --format chatml
    python preference_to_training.py preference-dataset.jsonl --out ./dataset --format gemma --formats dpo,sft
    python preference_to_training.py preference-dataset.jsonl --out ./dataset --tags "ignored user action"

Output files depend on --format:

    messages (default, model-agnostic)
        dpo.jsonl  {"prompt": [messages], "chosen": [messages], "rejected": [messages], "meta": {...}}
        sft.jsonl  {"messages": [messages], "meta": {...}}
        kto.jsonl  {"prompt": [messages], "completion": message, "label": bool, "meta": {...}}

    sharegpt
        dpo.jsonl  {"conversations": [...], "rejected_conversations": [...], "meta": {...}}
        sft.jsonl  {"conversations": [...], "meta": {...}}

    chatml | gemma | llama3 | mistral
        dpo.jsonl  {"prompt": "<rendered>", "chosen": "reply", "rejected": "reply", "meta": {...}}
        sft.jsonl  {"text": "<rendered prompt + reply>", "meta": {...}}
        kto.jsonl  {"prompt": "<rendered>", "completion": "reply", "label": bool, "meta": {...}}
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter

ROLES = {"user", "assistant", "system", "tool", "developer"}
MESSAGE_FORMATS = {"messages", "sharegpt"}
TEXT_FORMATS = {"chatml", "gemma", "llama3", "mistral"}
ALL_FORMATS = MESSAGE_FORMATS | TEXT_FORMATS

END_OF_TURN = {
    "chatml": "<|im_end|>\n",
    "gemma": "<end_of_turn>\n",
    "llama3": "<|eot_id|>",
    "mistral": "</s>",
}


def as_messages(prompt, context):
    """Return a normalized list of {role, content} messages."""
    source = prompt if prompt else context
    messages = []

    if isinstance(source, str):
        return [{"role": "user", "content": source}] if source.strip() else []

    if not isinstance(source, list):
        return []

    for entry in source:
        if not isinstance(entry, dict):
            continue

        content = entry.get("content")
        if isinstance(content, list):
            content = "\n".join(
                part if isinstance(part, str) else str(part.get("text", ""))
                for part in content
            )

        if content is None:
            continue

        role = entry.get("role") if entry.get("role") in ROLES else "user"
        message = {"role": role, "content": str(content)}
        if entry.get("name"):
            message["name"] = str(entry["name"])
        messages.append(message)

    return messages


def render_text(messages, template, add_generation_prompt=False):
    """Render chat messages into one string using a known chat template."""
    if template == "chatml":
        text = "".join(
            f"<|im_start|>{message['role']}\n{message['content']}<|im_end|>\n"
            for message in messages
        )
        return text + ("<|im_start|>assistant\n" if add_generation_prompt else "")

    if template == "gemma":
        system = "\n\n".join(message["content"] for message in messages if message["role"] == "system")
        parts = []

        for message in messages:
            if message["role"] == "system":
                continue

            role = "model" if message["role"] == "assistant" else "user"
            content = message["content"]

            # Gemma has no system role: fold it into the first user turn.
            if role == "user" and system:
                content = f"{system}\n\n{content}"
                system = ""

            parts.append(f"<start_of_turn>{role}\n{content}<end_of_turn>\n")

        if system:
            parts.insert(0, f"<start_of_turn>user\n{system}<end_of_turn>\n")

        return "".join(parts) + ("<start_of_turn>model\n" if add_generation_prompt else "")

    if template == "llama3":
        text = "".join(
            f"<|start_header_id|>{message['role']}<|end_header_id|>\n\n{message['content']}<|eot_id|>"
            for message in messages
        )
        return text + ("<|start_header_id|>assistant<|end_header_id|>\n\n" if add_generation_prompt else "")

    if template == "mistral":
        system = "\n\n".join(message["content"] for message in messages if message["role"] == "system")
        parts = []
        pending_user = []

        def flush():
            if not pending_user:
                return
            joined = "\n\n".join(pending_user)
            if system:
                joined = f"{system}\n\n{joined}"
            parts.append(f"[INST] {joined} [/INST]")
            pending_user.clear()

        for message in messages:
            if message["role"] == "system":
                continue
            if message["role"] == "user":
                pending_user.append(message["content"])
            else:
                flush()
                parts.append(f" {message['content']}</s>")

        flush()
        return "".join(parts) + (" " if add_generation_prompt else "")

    raise ValueError(f"unknown chat template: {template}")


def assistant(text, name=None):
    message = {"role": "assistant", "content": text}
    if name:
        message["name"] = name
    return message


def to_sharegpt(messages):
    mapping = {"user": "human", "assistant": "gpt", "system": "system", "tool": "tool", "developer": "system"}
    return [
        {"from": mapping.get(message["role"], "human"), "value": message["content"]}
        for message in messages
    ]


def record_meta(record):
    meta = {
        "id": record.get("id"),
        "type": record.get("type"),
        "pair_source": record.get("pair_source"),
        "message_id": record.get("message_id"),
        "chat_id": record.get("chat_id"),
        "character": (record.get("character") or {}).get("name"),
        "model": record.get("model"),
        "tags": record.get("tags"),
    }
    return {key: value for key, value in meta.items() if value not in (None, [], "")}


def build(records, args):
    dpo, sft, kto = [], [], []
    skipped = Counter()
    seen = {"dpo": set(), "sft": set(), "kto": set()}

    for record in records:
        if not isinstance(record, dict):
            skipped["not-an-object"] += 1
            continue

        tags = record.get("tags") or []
        if args.tags and not (set(tags) & set(args.tags)):
            skipped["tag-filter"] += 1
            continue

        prompt = as_messages(record.get("prompt"), record.get("context"))
        if len(prompt) < args.min_context:
            skipped["short-context"] += 1
            continue

        if not any(message["role"] != "system" for message in prompt):
            skipped["no-user-turn"] += 1
            continue

        chosen = record.get("chosen")
        rejected = record.get("rejected")
        rtype = record.get("type")
        name = (record.get("character") or {}).get("name")
        meta = record_meta(record)

        chosen_ok = isinstance(chosen, str) and chosen.strip() and len(chosen) <= args.max_chars
        rejected_ok = isinstance(rejected, str) and rejected.strip() and len(rejected) <= args.max_chars

        text_mode = args.format in TEXT_FORMATS

        if text_mode:
            prompt_out = render_text(prompt, args.format, add_generation_prompt=True)
            eot = END_OF_TURN[args.format]
        elif args.format == "sharegpt":
            prompt_out = to_sharegpt(prompt)
        else:
            prompt_out = prompt

        if "dpo" in args.formats and rtype == "pair" and chosen_ok and rejected_ok and chosen != rejected:
            key = (json.dumps(prompt, sort_keys=True), chosen, rejected)
            if key in seen["dpo"]:
                skipped["duplicate-pair"] += 1
            else:
                seen["dpo"].add(key)
                if text_mode:
                    row = {"prompt": prompt_out, "chosen": chosen, "rejected": rejected}
                elif args.format == "sharegpt":
                    row = {
                        "conversations": prompt_out + to_sharegpt([assistant(chosen)]),
                        "rejected_conversations": prompt_out + to_sharegpt([assistant(rejected)]),
                    }
                else:
                    row = {
                        "prompt": prompt_out,
                        "chosen": [assistant(chosen, name)],
                        "rejected": [assistant(rejected, name)],
                    }
                row["meta"] = meta
                dpo.append(row)

        if "sft" in args.formats and chosen_ok and rtype in ("pair", "like"):
            key = (json.dumps(prompt, sort_keys=True), chosen)
            if key in seen["sft"]:
                skipped["duplicate-sft"] += 1
            else:
                seen["sft"].add(key)
                if text_mode:
                    row = {"text": prompt_out + chosen + eot}
                elif args.format == "sharegpt":
                    row = {"conversations": prompt_out + to_sharegpt([assistant(chosen)])}
                else:
                    row = {"messages": prompt + [assistant(chosen, name)]}
                row["meta"] = meta
                sft.append(row)

        if "kto" in args.formats:
            def add_kto(text, label):
                key = (json.dumps(prompt, sort_keys=True), text, label)
                if key in seen["kto"]:
                    skipped["duplicate-kto"] += 1
                    return
                seen["kto"].add(key)

                if args.format == "sharegpt":
                    row = {
                        "conversations": prompt_out + to_sharegpt([assistant(text)]),
                        "label": label,
                    }
                else:
                    row = {"prompt": prompt_out, "completion": text, "label": label}
                row["meta"] = meta
                kto.append(row)

            if chosen_ok and rtype in ("pair", "like"):
                add_kto(chosen, True)
            if rejected_ok and rtype in ("pair", "dislike", "empty"):
                add_kto(rejected, False)
            elif rtype == "empty" and not rejected_ok and args.keep_empty:
                # An empty generation is a real negative, but carries no text.
                # Keep it only when the caller explicitly wants prompt-only negatives.
                add_kto("", False)

    return dpo, sft, kto, skipped


def write_jsonl(path, rows):
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("input", help="Preference Collector JSONL (download or data/<user>/files/preference-dataset.jsonl)")
    parser.add_argument("--out", default="preference-dataset", help="output directory")
    parser.add_argument("--formats", default="dpo,sft,kto", help="comma separated: dpo,sft,kto")
    parser.add_argument(
        "--format",
        default="messages",
        choices=sorted(ALL_FORMATS),
        help="output shape: messages (model-agnostic, default), sharegpt, or a rendered chat template",
    )
    parser.add_argument("--tags", default="", help="only keep records with any of these tags (comma separated)")
    parser.add_argument("--min-context", type=int, default=1, help="drop records with fewer prompt/context messages")
    parser.add_argument("--max-chars", type=int, default=20000, help="drop replies longer than this")
    parser.add_argument("--keep-empty", action="store_true", help="emit empty generations as empty-string KTO negatives")
    args = parser.parse_args(argv)

    args.formats = {item.strip().lower() for item in args.formats.split(",") if item.strip()}
    args.tags = [item.strip() for item in args.tags.split(",") if item.strip()]

    unknown = args.formats - {"dpo", "sft", "kto"}
    if unknown:
        parser.error(f"unknown formats: {', '.join(sorted(unknown))}")

    records = []
    with open(args.input, "r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError as error:
                print(f"skipping line {line_number}: {error}", file=sys.stderr)

    os.makedirs(args.out, exist_ok=True)
    dpo, sft, kto, skipped = build(records, args)

    manifest = {
        "input": os.path.abspath(args.input),
        "records_in": len(records),
        "shape": args.format,
        "formats": sorted(args.formats),
        "tags": args.tags,
        "counts": {},
        "skipped": dict(skipped),
    }

    if dpo:
        write_jsonl(os.path.join(args.out, "dpo.jsonl"), dpo)
        manifest["counts"]["dpo"] = len(dpo)
    if sft:
        write_jsonl(os.path.join(args.out, "sft.jsonl"), sft)
        manifest["counts"]["sft"] = len(sft)
    if kto:
        write_jsonl(os.path.join(args.out, "kto.jsonl"), kto)
        manifest["counts"]["kto"] = len(kto)
        manifest["counts"]["kto_positive"] = sum(1 for row in kto if row["label"])
        manifest["counts"]["kto_negative"] = sum(1 for row in kto if not row["label"])

    with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2, ensure_ascii=False)
        handle.write("\n")

    print(json.dumps(manifest["counts"], indent=2))
    if skipped:
        print("skipped:", json.dumps(dict(skipped)), file=sys.stderr)

    if not any(manifest["counts"].values()):
        print("No training rows were produced. Rate some replies first.", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
