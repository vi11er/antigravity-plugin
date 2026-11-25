from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
import os
import shutil
import subprocess
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("obsidian-antigravity")

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "local_settings.json"
USAGE_PATH = BASE_DIR / "usage_stats.json"
DEFAULT_MODEL = "gemini-4-hydrogen-low"
DEFAULT_CONTEXT_LIMIT = 1_048_576

FALLBACK_MODELS: list[dict[str, str]] = [
    {"id": "gemini-4-hydrogen-low", "label": "Gemini 4 Hydrogen (Low — быстрая)"},
    {"id": "gemini-4-hydrogen-medium", "label": "Gemini 4 Hydrogen (Medium)"},
    {"id": "gemini-4-argon-low", "label": "Gemini 4 Argon (Low)"},
    {"id": "gemini-4-carbon-low", "label": "Gemini 4 Carbon (Low)"},
    {"id": "gemini-4-neon-low", "label": "Gemini 4 Neon (Low)"},
    {"id": "gemini-3.8-flash-low", "label": "Gemini 3.8 Flash (Low — сверхбыстрая)"},
    {"id": "gemini-3.8-flash-medium", "label": "Gemini 3.8 Flash (Medium)"},
]

CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def find_agy_binary() -> str:
    local_app = os.environ.get("LOCALAPPDATA", "")
    if local_app:
        candidate = Path(local_app) / "agy" / "bin" / "agy.exe"
        if candidate.exists():
            return str(candidate)
    found = shutil.which("agy")
    if found:
        return found
    return "agy"


def load_local_settings() -> dict[str, Any]:
    data: dict[str, Any] = {
        "vault_path": os.environ.get("OBSIDIAN_VAULT_PATH", ""),
        "model": os.environ.get("ANTIGRAVITY_MODEL", DEFAULT_MODEL),
    }
    if CONFIG_PATH.exists():
        try:
            saved = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            if saved.get("vault_path"):
                data["vault_path"] = saved["vault_path"]
            if saved.get("model"):
                data["model"] = saved["model"]
        except Exception as exc:
            logger.warning("Could not read local_settings.json: %s", exc)
    return data


def save_local_settings(settings: dict[str, Any]) -> None:
    CONFIG_PATH.write_text(
        json.dumps(settings, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


class AgyCliSessionManager:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self.conversation_id: str | None = None
        self.active_proc: asyncio.subprocess.Process | None = None
        self.session_used_tokens: int = 0
        self.model_context_limit: int = DEFAULT_CONTEXT_LIMIT
        self._cached_models: list[dict[str, str]] | None = None

    def _get_daily_usage(self) -> dict[str, Any]:
        today = dt.date.today().isoformat()
        if USAGE_PATH.exists():
            try:
                data = json.loads(USAGE_PATH.read_text(encoding="utf-8"))
                if data.get("date") == today:
                    return data
            except Exception:
                pass
        return {"date": today, "tokens": 0}

    def record_usage(self, usage_dict: dict[str, Any] | None) -> dict[str, Any]:
        if isinstance(usage_dict, dict):
            inp = int(usage_dict.get("input_tokens") or 0)
            out = int(usage_dict.get("output_tokens") or 0)
            total = int(usage_dict.get("total_tokens") or (inp + out))
            if inp + out > 0:
                self.session_used_tokens = inp + out
            elif total > 0:
                self.session_used_tokens += total

            if total > 0:
                daily = self._get_daily_usage()
                daily["tokens"] = int(daily.get("tokens", 0)) + total
                try:
                    USAGE_PATH.write_text(json.dumps(daily, ensure_ascii=False), encoding="utf-8")
                except Exception:
                    pass
        return self.get_usage_summary()

    def get_usage_summary(self) -> dict[str, Any]:
        limit = max(1, self.model_context_limit)
        used = max(0, self.session_used_tokens)
        remaining = max(0, limit - used)
        remaining_pct = round((remaining / limit) * 100, 1)
        daily = self._get_daily_usage()
        return {
            "session_used": used,
            "context_limit": limit,
            "remaining_pct": remaining_pct,
            "daily_tokens": int(daily.get("tokens", 0)),
        }

    async def cancel_active(self) -> None:
        proc = self.active_proc
        if proc is not None and proc.returncode is None:
            try:
                proc.terminate()
            except Exception:
                pass

    async def reset(self) -> None:
        await self.cancel_active()
        self.conversation_id = None
        self.session_used_tokens = 0

    def fetch_models_sync(self, force: bool = False) -> list[dict[str, str]]:
        if self._cached_models and not force:
            return self._cached_models
        agy_bin = find_agy_binary()
        try:
            res = subprocess.run(
                [agy_bin, "models"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=15,
                creationflags=CREATE_NO_WINDOW,
            )
            models: list[dict[str, str]] = []
            for line in res.stdout.splitlines():
                line = line.strip()
                if not line or "\t" not in line:
                    continue
                m_id, m_label = line.split("\t", 1)
                m_id = m_id.strip()
                m_label = m_label.strip()
                if m_id and not m_id.startswith("gemini-pro-orchestrator"):
                    models.append({"id": m_id, "label": m_label})
            if models:
                self._cached_models = models
                return models
        except Exception as exc:
            logger.warning("Could not fetch agy models: %s", exc)
        return FALLBACK_MODELS


session_mgr = AgyCliSessionManager()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    yield
    await session_mgr.cancel_active()


app = FastAPI(title="Obsidian Antigravity CLI Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class ConfigPayload(BaseModel):
    vault_path: str | None = None
    model: str | None = None
    api_key: str | None = None


class ModelsPayload(BaseModel):
    api_key: str | None = None
    force: bool = False


class ChatPayload(BaseModel):
    message: str
    active_note_path: str | None = None
    active_note_excerpt: str | None = None
    selected_day: str | None = None
    day_notes: list[dict[str, Any]] | None = None
    api_key: str | None = None
    model: str | None = None
    vault_path: str | None = None


@app.get("/health")
async def health() -> dict[str, Any]:
    cfg = load_local_settings()
    agy_bin = find_agy_binary()
    return {
        "status": "ok",
        "engine": "agy_cli",
        "agy_path": agy_bin,
        "agy_found": Path(agy_bin).exists() or shutil.which(agy_bin) is not None,
        "has_api_key": True,  # Authenticated via Antigravity CLI (Google AI Pro)
        "vault_path": cfg.get("vault_path"),
        "model": cfg.get("model") or DEFAULT_MODEL,
        "conversation_id": session_mgr.conversation_id,
        "usage": session_mgr.get_usage_summary(),
    }


@app.post("/config")
async def update_config(payload: ConfigPayload) -> dict[str, Any]:
    cfg = load_local_settings()
    if payload.vault_path is not None and payload.vault_path.strip():
        cfg["vault_path"] = payload.vault_path.strip()
    if payload.model is not None and payload.model.strip():
        cfg["model"] = payload.model.strip()
    save_local_settings(cfg)
    return {"status": "saved", "has_api_key": True, "model": cfg.get("model")}


@app.post("/reset")
async def reset_session() -> dict[str, Any]:
    await session_mgr.reset()
    return {"status": "reset", "usage": session_mgr.get_usage_summary()}


@app.post("/shutdown")
async def shutdown_server() -> dict[str, str]:
    await session_mgr.reset()
    loop = asyncio.get_running_loop()
    loop.call_later(0.15, lambda: os._exit(0))
    return {"status": "shutting_down"}


@app.post("/cancel")
async def cancel_turn() -> dict[str, str]:
    await session_mgr.cancel_active()
    return {"status": "cancelled"}


@app.post("/models")
@app.get("/models")
async def list_models(payload: ModelsPayload | None = None) -> dict[str, Any]:
    force = bool(payload.force) if payload else False
    models = await asyncio.to_thread(session_mgr.fetch_models_sync, force)
    return {"source": "agy_cli", "models": models}


def get_vault_file_tree_summary(vault_path: str, max_files: int = 250) -> str:
    root = Path(vault_path)
    if not root.exists():
        return ""
    files: list[str] = []
    for md in root.rglob("*.md"):
        rel_parts = md.relative_to(root).parts
        if any(p.startswith(".") for p in rel_parts):
            continue
        files.append(md.relative_to(root).as_posix())
        if len(files) >= max_files:
            break
    files.sort()
    if not files:
        return ""
    header = f"Список заметок в Vault ({len(files)} шт.):\n"
    return header + "\n".join(f"- {f}" for f in files)


def format_prompt_with_context(payload: ChatPayload, is_first_turn: bool, vault_path: str) -> str:
    parts: list[str] = []
    if is_first_turn:
        parts.append(
            "Системная инструкция: ты встроенный ассистент внутри Obsidian. "
            "Отвечай кратко, по-русски, используя чистый Markdown и внутренние ссылки Obsidian [[Название заметки]]. "
            "Работай строго с заметками внутри текущей папки Vault. Не трогай скрытую папку .obsidian/."
        )
        tree_summary = get_vault_file_tree_summary(vault_path)
        if tree_summary:
            parts.append("<vault_files>\n" + tree_summary + "\n</vault_files>")

    ctx_blocks: list[str] = []
    if payload.active_note_path:
        note_info = f"Открытая заметка в редакторе: `{payload.active_note_path}`"
        if payload.active_note_excerpt:
            note_info += f"\nФрагмент содержимого:\n```markdown\n{payload.active_note_excerpt[:2500]}\n```"
        ctx_blocks.append(note_info)

    if payload.selected_day:
        day_info = f"Выбранный день в календаре: `{payload.selected_day}`"
        if payload.day_notes is not None:
            if payload.day_notes:
                items = "\n".join(
                    f"- `{n.get('path')}` ({n.get('status', '')})"
                    for n in payload.day_notes[:40]
                )
                day_info += f"\nЗаметки за этот день:\n{items}"
            else:
                day_info += "\nЗаметок за этот день пока нет."
        ctx_blocks.append(day_info)

    if ctx_blocks:
        parts.append("<obsidian_context>\n" + "\n\n".join(ctx_blocks) + "\n</obsidian_context>")

    parts.append("Запрос пользователя:\n" + payload.message)
    return "\n\n".join(parts)


def sse_event(data: dict[str, Any]) -> str:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


@app.post("/chat")
async def chat_stream(payload: ChatPayload) -> StreamingResponse:
    async def event_generator():
        cfg = load_local_settings()
        model = (payload.model or cfg.get("model") or DEFAULT_MODEL).strip()
        vault_path = (payload.vault_path or cfg.get("vault_path") or "").strip()

        if not vault_path or not Path(vault_path).exists():
            yield sse_event({"type": "error", "message": f"Папка Vault не найдена: {vault_path}"})
            return

        agy_bin = find_agy_binary()
        if not (Path(agy_bin).exists() or shutil.which(agy_bin)):
            yield sse_event(
                {
                    "type": "error",
                    "message": "Antigravity CLI (agy.exe) не найден. Установите его командой: irm https://antigravity.google/cli/install.ps1 | iex",
                }
            )
            return

        async with session_mgr._lock:
            is_first = session_mgr.conversation_id is None
            full_prompt = format_prompt_with_context(payload, is_first_turn=is_first, vault_path=vault_path)

            cmd = [
                agy_bin,
                "-p",
                full_prompt,
                "--output-format",
                "stream-json",
                "--mode",
                "auto",
                "--sandbox",
                "--model",
                model,
            ]
            if session_mgr.conversation_id:
                cmd.extend(["--conversation", session_mgr.conversation_id])

            logger.info("Running agy CLI: model=%s conv=%s cwd=%s", model, session_mgr.conversation_id, vault_path)

            proc = await asyncio.create_subprocess_exec(
                *cmd,
                cwd=vault_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                creationflags=CREATE_NO_WINDOW,
            )
            session_mgr.active_proc = proc

            seen_tool_steps: set[int] = set()
            streamed_any_text = False
            got_result = False

            try:
                assert proc.stdout is not None
                while True:
                    raw_line = await proc.stdout.readline()
                    if not raw_line:
                        break
                    line = raw_line.decode("utf-8", errors="replace").strip()
                    if not line:
                        continue
                    try:
                        evt = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    ev_type = evt.get("event")
                    if ev_type == "init":
                        cid = evt.get("conversation_id")
                        if cid:
                            session_mgr.conversation_id = cid
                    elif ev_type == "step_update":
                        su = evt.get("step_update") or {}
                        cid = su.get("conversation_id")
                        if cid:
                            session_mgr.conversation_id = cid
                        st = su.get("step_type")
                        idx = su.get("step_index")
                        if st == "tool":
                            tname = su.get("tool_name")
                            if tname and idx not in seen_tool_steps:
                                seen_tool_steps.add(idx)
                                yield sse_event({"type": "tool_call", "name": tname, "args": su.get("tool_info") or {}})
                        elif st == "agent_response":
                            delta = su.get("text_delta")
                            if delta:
                                streamed_any_text = True
                                yield sse_event({"type": "token", "text": delta})
                    elif ev_type == "result":
                        got_result = True
                        res = evt.get("result") or {}
                        cid = res.get("conversation_id")
                        if cid:
                            session_mgr.conversation_id = cid
                        status = res.get("status")
                        if status != "SUCCESS" and res.get("error"):
                            yield sse_event({"type": "error", "message": res["error"]})
                        else:
                            if not streamed_any_text and res.get("response"):
                                streamed_any_text = True
                                yield sse_event({"type": "token", "text": res["response"]})
                            usage_summary = session_mgr.record_usage(res.get("usage"))
                            yield sse_event({"type": "usage", "usage": usage_summary})
                            yield sse_event({"type": "done"})

                await proc.wait()

                if not got_result:
                    stderr_text = ""
                    if proc.stderr:
                        stderr_text = (await proc.stderr.read()).decode("utf-8", errors="replace").strip()
                    if proc.returncode != 0:
                        msg = stderr_text or f"agy завершился с кодом {proc.returncode}"
                        yield sse_event({"type": "error", "message": msg})
                    else:
                        yield sse_event({"type": "done"})
            except asyncio.CancelledError:
                await session_mgr.cancel_active()
                yield sse_event({"type": "done", "cancelled": True})
            except Exception as exc:
                logger.exception("agy CLI execution error")
                yield sse_event({"type": "error", "message": str(exc)})
            finally:
                session_mgr.active_proc = None

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("ANTIGRAVITY_PORT", "8765"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
