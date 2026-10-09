"""Build the prototype's data: one JSONL per dataset in prototype/data/.

    python prototype/build_data.py
    python -m http.server 8765 -d prototype      # then open http://localhost:8765

Every row is reduced to the same shape (turns, answer, calls, tools, what the label
expects) plus a few rough automatic hints the viewer can filter on.

Needs `huggingface_hub` and a Hugging Face login for the gated xLAM dataset. The BFCL
datasets are read from a local BFCL checkout (BFCL_DATA env var); they are skipped if
it is missing.
"""

import json
import os
import re
import sys
from pathlib import Path

from huggingface_hub import hf_hub_download

OUT = Path(__file__).resolve().parent / "data"
BFCL_DATA = Path(os.environ.get(
    "BFCL_DATA",
    Path.home() / "tool-calling-slm-ibm/bfcl/gorilla/berkeley-function-call-leaderboard/bfcl_eval/data",
))

TOOLCALL_RE = re.compile(r"<TOOLCALL>(.*?)</TOOLCALL>", re.DOTALL)
REFUSE_RE = re.compile(
    r"\b(unable|can't|cannot|can not|not able|don't have|do not have|beyond|outside|"
    r"not possible|isn't possible|not available|limited to|only (?:able|designed|capable))\b",
    re.I,
)
STOP = set(
    "the a an and or of to for in on at by with from is are be can you me my your i it this "
    "that what how please get find give tell about show which who when where would like want "
    "need".split()
)


def _words(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z]{4,}", text.lower()) if w not in STOP}


def _tool_words(tool: dict) -> set[str]:
    name = re.sub(r"([a-z])([A-Z])", r"\1 \2", tool["name"]).replace("_", " ").replace(".", " ")
    return _words(name + " " + tool["description"])


def _params(params) -> list[dict]:
    """Parameters as a flat list, from JSON Schema / BFCL or xLAM's flat shape."""
    if not isinstance(params, dict):
        return []
    if isinstance(params.get("properties"), dict):
        required = set(params.get("required") or [])
        items = params["properties"].items()
        return [{
            "name": k, "type": str(v.get("type", "")), "required": k in required,
            "default": json.dumps(v["default"]) if "default" in v else None,
            "desc": v.get("description", ""),
        } for k, v in items if isinstance(v, dict)]
    out = []
    for k, v in params.items():  # xLAM: {"city": {"type": "str, optional", "default": ...}}
        if not isinstance(v, dict):
            continue
        typ = str(v.get("type", ""))
        has_default = "default" in v and v["default"] not in (None, "")
        out.append({
            "name": k, "type": typ, "required": "optional" not in typ.lower() and not has_default,
            "default": json.dumps(v["default"]) if "default" in v else None,
            "desc": v.get("description", ""),
        })
    return out


def _tool(t) -> dict | None:
    if isinstance(t, str):
        try:
            t = json.loads(t)
        except json.JSONDecodeError:
            return None
    if not isinstance(t, dict):
        return None
    return {"name": str(t.get("name", "")), "description": t.get("description", "") or "",
            "params": _params(t.get("parameters"))}


def _row(rid, turns, answer, calls, tools, expect) -> dict:
    tools = [t for t in (_tool(t) for t in tools) if t]
    user_text = " ".join(m["content"] for m in turns if m["role"] == "user")
    if calls:
        kind = "call"
    elif answer is None:
        kind = "none"
    elif "?" in answer:
        kind = "asks"
    elif REFUSE_RE.search(answer):
        kind = "refuses"
    else:
        kind = "other"
    overlap = max((len(_words(user_text) & _tool_words(t)) for t in tools), default=0)
    return {
        "id": str(rid), "turns": turns, "answer": answer, "calls": calls, "tools": tools,
        "expect": expect, "kind": kind, "n_tools": len(tools), "overlap": overlap,
        "multi": sum(m["role"] == "user" for m in turns) > 1 or any(m["role"] == "system" for m in turns),
    }


def when2call():
    path = hf_hub_download("nvidia/When2Call", "train/when2call_train_sft.jsonl", repo_type="dataset")
    for i, line in enumerate(open(path)):
        r = json.loads(line)
        turns, answer = [], ""
        for m in r["messages"]:
            if m["role"] == "assistant":
                answer = m["content"]
                break
            turns.append({"role": m["role"], "content": m["content"]})
        match = TOOLCALL_RE.search(answer)
        calls = []
        if match:
            try:
                calls = json.loads(match.group(1))
                calls = calls if isinstance(calls, list) else [calls]
            except json.JSONDecodeError:
                pass
        yield _row(i, turns, answer, calls, r["tools"], "call" if calls else "no_call")


def xlam():
    path = hf_hub_download("Salesforce/xlam-function-calling-60k", "xlam_function_calling_60k.json",
                           repo_type="dataset")
    for r in json.load(open(path)):
        calls = json.loads(r["answers"]) if isinstance(r["answers"], str) else r["answers"]
        tools = json.loads(r["tools"]) if isinstance(r["tools"], str) else r["tools"]
        yield _row(r["id"], [{"role": "user", "content": r["query"]}], None, calls, tools, "call")


def bfcl(category, expect):
    def gen():
        for line in open(BFCL_DATA / f"BFCL_v4_{category}.json"):
            r = json.loads(line)
            turns = [{"role": m["role"], "content": m["content"]} for t in r["question"] for m in t]
            yield _row(r["id"], turns, None, [], r["function"], expect)
    return gen


DATASETS = {
    "when2call_sft": ("When2Call train_sft", when2call),
    "xlam": ("xLAM 60k", xlam),
    "bfcl_irrelevance": ("BFCL irrelevance", bfcl("irrelevance", "no_call")),
    "bfcl_live_irrelevance": ("BFCL live_irrelevance", bfcl("live_irrelevance", "no_call")),
    "bfcl_live_relevance": ("BFCL live_relevance", bfcl("live_relevance", "any_call")),
}


def main():
    OUT.mkdir(exist_ok=True)
    index = []
    for key, (title, gen) in DATASETS.items():
        try:
            rows = list(gen())
        except Exception as exc:  # e.g. no access to a gated dataset
            print(f"skipped {key}: {exc}", file=sys.stderr)
            continue
        with open(OUT / f"{key}.jsonl", "w") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        index.append({"key": key, "title": title, "rows": len(rows)})
        print(f"{key}: {len(rows)} rows")
    (OUT / "index.json").write_text(json.dumps(index, indent=1))


if __name__ == "__main__":
    main()
