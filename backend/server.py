from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
import os
import shutil
from pathlib import Path
from typing import Any

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import google.antigravity as ag
from google.antigravity import (
    Agent,
    BuiltinTools,
    CapabilitiesConfig,
    CustomSystemInstructions,
    LocalAgentConfig,
)
from google.antigravity.hooks import policy

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("obsidian-antigravity")

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "local_settings.json"
USAGE_PATH = BASE_DIR / "usage_stats.json"
DEFAULT_VAULT = ""
DEFAULT_MODEL = "gemini-4-hydrogen"
DEFAULT_CONTEXT_LIMIT = 1_048_576

ANTIGRAVITY_MODELS: list[dict[str, str]] = [
    {"id": "gemini-4-hydrogen", "label": "Gemini 4 Hydrogen (Antigravity SDK default)"},
    {"id": "gemini-3.5-flash", "label": "Gemini 3.5 Flash"},
    {"id": "gemini-3.5-flash-lite", "label": "Gemini 3.5 Flash-Lite"},
    {"id": "gemini-3.1-pro-preview", "label": "Gemini 3.1 Pro (Preview)"},
    {"id": "gemini-3-flash-preview", "label": "Gemini 3 Flash (Preview)"},
    {"id": "gemini-2.5-pro", "label": "Gemini 2.5 Pro"},
    {"id": "gemini-2.5-flash", "label": "Gemini 2.5 Flash"},
    {"id": "gemini-2.5-flash-lite", "label": "Gemini 2.5 Flash-Lite"},
]


def load_local_settings() -> dict[str, Any]:
    data: dict[str, Any] = {
        "vault_path": os.environ.get("OBSIDIAN_VAULT_PATH", DEFAULT_VAULT),
        "model": os.environ.get("ANTIGRAVITY_MODEL", DEFAULT_MODEL),
        "api_key": os.environ.get("GEMINI_API_KEY", ""),
    }
    if CONFIG_PATH.exists():
        try:
            saved = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            for k in ("vault_path", "model", "api_key"):
                if saved.get(k):
                    data[k] = saved[k]
        except Exception as exc:
            logger.warning("Could not read local_settings.json: %s", exc)
    return data


def save_local_settings(settings: dict[str, Any]) -> None:
    CONFIG_PATH.write_text(
        json.dumps(settings, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def resolve_vault_file(vault_root: Path, rel_or_abs: str) -> Path:
    """Resolves a path strictly inside vault_root to prevent escaping the Vault."""
    root = vault_root.resolve()
    candidate = Path(rel_or_abs)
    target = (candidate if candidate.is_absolute() else (root / candidate)).resolve()
    if target != root and root not in target.parents:
        raise ValueError(f"Доступ разрешён только внутри хранилища Obsidian: {root}")
    return target


def make_vault_tools(vault_root: Path) -> list[Any]:
    """Creates Obsidian-specific file management tools bound to vault_root."""

    def move_or_rename_note(source_path: str, destination_path: str) -> str:
        """Перемещает или переименовывает заметку (.md) или папку внутри Obsidian Vault.

        Args:
            source_path: Относительный путь от корня Vault (например 'Без названия.md').
            destination_path: Новый относительный путь от корня Vault (например 'Задачи/Новая заметка.md').
        """
        src = resolve_vault_file(vault_root, source_path)
        dst = resolve_vault_file(vault_root, destination_path)
        if not src.exists():
            return f"Ошибка: исходный путь не найден: {source_path}"
        if dst.exists():
            return f"Ошибка: целевой файл уже существует: {destination_path}"
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dst))
        return f"Успешно перемещено: '{src.relative_to(vault_root)}' -> '{dst.relative_to(vault_root)}'"

    def move_note_to_trash(note_path: str) -> str:
        """Безопасно удаляет заметку, перемещая её в корзину Obsidian (.trash/).

        Args:
            note_path: Относительный путь к заметке внутри Vault.
        """
        src = resolve_vault_file(vault_root, note_path)
        if not src.exists():
            return f"Ошибка: файл не найден: {note_path}"
        trash_dir = vault_root / ".trash"
        trash_dir.mkdir(parents=True, exist_ok=True)
        stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
        dst = trash_dir / f"{src.stem}_{stamp}{src.suffix}"
        shutil.move(str(src), str(dst))
        return f"Заметка перемещена в корзину Obsidian (.trash/{dst.name})"

    def list_vault_notes_by_date(date_iso: str) -> str:
        """Возвращает список заметок (.md), созданных или изменённых в указанную дату YYYY-MM-DD.

        Args:
            date_iso: Дата в формате YYYY-MM-DD (например '2026-11-25').
        """
        target_date = dt.date.fromisoformat(date_iso)
        created_list: list[str] = []
        modified_list: list[str] = []
        for md in vault_root.rglob("*.md"):
            rel_parts = md.relative_to(vault_root).parts
            if any(p.startswith(".") for p in rel_parts):
                continue
            stat = md.stat()
            c_date = dt.datetime.fromtimestamp(stat.st_ctime).date()
            m_date = dt.datetime.fromtimestamp(stat.st_mtime).date()
            rel_str = md.relative_to(vault_root).as_posix()
            if c_date == target_date:
                created_list.append(rel_str)
            if m_date == target_date and c_date != target_date:
                modified_list.append(rel_str)
        return json.dumps(
            {
                "date": date_iso,
                "created": sorted(created_list),
                "modified": sorted(modified_list),
            },
            ensure_ascii=False,
            indent=2,
        )

    return [move_or_rename_note, move_note_to_trash, list_vault_notes_by_date]


def build_system_instructions(vault_path: str) -> CustomSystemInstructions:
    text = f"""Ты — встроенный ассистент Antigravity внутри правой боковой панели Obsidian.
Твоя рабочая папка (Obsidian Vault): {vault_path}

Правила работы:
1. Отвечай кратко, по делу, на русском языке, используя чистый Markdown.
2. При упоминании заметок используй внутренние ссылки Obsidian в формате [[Название заметки]] (или [[Путь/к/заметке|Название]]), чтобы пользователь мог кликнуть по ним прямо в чате.
3. Ты можешь читать, создавать, редактировать, перемещать, переименовывать и сортировать заметки внутри Vault ({vault_path}).
4. Для перемещения/переименования используй инструмент `move_or_rename_note`, для безопасного удаления — `move_note_to_trash` (перемещает в `.trash`). Никогда не трогай скрытую системную папку `.obsidian/`.
5. КРИТИЧЕСКИ ЗАПРЕЩЕНО обращаться к файлам или изменять любые файлы за пределами папки Vault ({vault_path}), включая любые внешние репозитории (например raysharp_autotests) или внешние трекеры задач.
"""
    return CustomSystemInstructions(text=text)


class AgentSessionManager:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._agent: Agent | None = None
        self._active_signature: tuple[str, str, str] | None = None
        self.active_response: Any = None
        self.session_used_tokens: int = 0
        self.model_context_limit: int = DEFAULT_CONTEXT_LIMIT
        self._limit_cache: dict[str, int] = {}

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

    def add_turn_usage(self, usage: Any) -> dict[str, Any]:
        if usage is not None:
            prompt_t = getattr(usage, "prompt_token_count", None) or 0
            cand_t = getattr(usage, "candidates_token_count", None) or 0
            thoughts_t = getattr(usage, "thoughts_token_count", None) or 0
            total_t = getattr(usage, "total_token_count", None) or (prompt_t + cand_t + thoughts_t)

            # Context window occupancy is prompt + output of the latest turn
            if prompt_t + cand_t > 0:
                self.session_used_tokens = prompt_t + cand_t
            elif total_t > 0:
                self.session_used_tokens += total_t

            if total_t > 0:
                daily = self._get_daily_usage()
                daily["tokens"] = int(daily.get("tokens", 0)) + int(total_t)
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

    def _resolve_context_limit(self, model: str, api_key: str) -> int:
        if model in self._limit_cache:
            return self._limit_cache[model]
        limit = DEFAULT_CONTEXT_LIMIT
        if api_key:
            try:
                from google import genai

                client = genai.Client(api_key=api_key)
                info = client.models.get(model=model)
                inp_lim = getattr(info, "input_token_limit", None)
                if isinstance(inp_lim, int) and inp_lim > 0:
                    limit = inp_lim
            except Exception:
                pass
        self._limit_cache[model] = limit
        return limit

    async def stop(self) -> None:
        if self._agent is not None:
            try:
                await self._agent.__aexit__(None, None, None)
            except Exception as exc:
                logger.warning("Error closing agent session: %s", exc)
            finally:
                self._agent = None
                self._active_signature = None
        self.session_used_tokens = 0

    async def ensure_agent(self, vault_path: str, model: str, api_key: str) -> Agent:
        sig = (vault_path, model, api_key)
        if self._agent is not None and self._active_signature == sig:
            return self._agent

        await self.stop()

        vault_root = Path(vault_path).resolve()
        if not vault_root.exists():
            raise ValueError(f"Папка Vault не найдена: {vault_path}")

        def is_outside_vault(args: dict[str, Any]) -> bool:
            for key in ("Path", "DirectoryPath", "SearchPath"):
                val = args.get(key)
                if isinstance(val, str) and val.strip():
                    try:
                        resolve_vault_file(vault_root, val)
                    except ValueError:
                        return True
            return False

        cfg = LocalAgentConfig(
            api_key=api_key,
            model=model or DEFAULT_MODEL,
            workspaces=[str(vault_root)],
            system_instructions=build_system_instructions(str(vault_root)),
            tools=make_vault_tools(vault_root),
            capabilities=CapabilitiesConfig(
                enable_subagents=False,
                disabled_tools=[
                    BuiltinTools.RUN_COMMAND,
                    BuiltinTools.ASK_QUESTION,
                    BuiltinTools.INVOKE_SUBAGENT,
                    BuiltinTools.RUN_WORKFLOW,
                    BuiltinTools.SCHEDULE,
                ],
            ),
            policies=[
                policy.deny(
                    "*",
                    when=is_outside_vault,
                    reason="Доступ разрешён только к файлам внутри Obsidian Vault.",
                ),
                policy.allow_all(),
            ],
        )
        agent = Agent(cfg)
        await agent.__aenter__()
        self._agent = agent
        self._active_signature = sig
        self.session_used_tokens = 0
        self.model_context_limit = await asyncio.to_thread(self._resolve_context_limit, model or DEFAULT_MODEL, api_key)
        logger.info("Started Antigravity Agent session for vault=%s model=%s limit=%s", vault_root, model, self.model_context_limit)
        return agent


@asynccontextmanager
async def lifespan(_app: FastAPI):
    yield
    await session_mgr.stop()


session_mgr = AgentSessionManager()
app = FastAPI(title="Obsidian Antigravity Backend", lifespan=lifespan)

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
    return {
        "status": "ok",
        "sdk_version": getattr(ag, "__version__", "installed"),
        "agent_started": session_mgr._agent is not None,
        "has_api_key": bool(cfg.get("api_key")),
        "vault_path": cfg.get("vault_path"),
        "model": cfg.get("model"),
        "usage": session_mgr.get_usage_summary(),
    }


@app.post("/config")
async def update_config(payload: ConfigPayload) -> dict[str, Any]:
    cfg = load_local_settings()
    if payload.vault_path is not None and payload.vault_path.strip():
        cfg["vault_path"] = payload.vault_path.strip()
    if payload.model is not None and payload.model.strip():
        cfg["model"] = payload.model.strip()
    if payload.api_key is not None:
        cfg["api_key"] = payload.api_key.strip()
    save_local_settings(cfg)
    await session_mgr.stop()
    return {"status": "saved", "has_api_key": bool(cfg.get("api_key")), "model": cfg.get("model")}


@app.post("/reset")
async def reset_session() -> dict[str, Any]:
    await session_mgr.stop()
    return {"status": "reset", "usage": session_mgr.get_usage_summary()}


def _fetch_live_gemini_models(api_key: str) -> list[dict[str, str]]:
    from google import genai

    client = genai.Client(api_key=api_key)
    out: list[dict[str, str]] = []
    for m in client.models.list():
        name = getattr(m, "name", "") or ""
        if name.startswith("models/"):
            name = name[len("models/"):]
        if not name.startswith("gemini-"):
            continue
        if any(skip in name for skip in ("-image", "embedding", "tts", "robotics", "live")):
            continue
        actions = getattr(m, "supported_actions", None) or []
        if actions and "generateContent" not in actions:
            continue
        display = getattr(m, "display_name", None) or name
        out.append({"id": name, "label": f"{display} ({name})" if display != name else name})
    return out


@app.post("/models")
@app.get("/models")
async def list_models(payload: ModelsPayload | None = None) -> dict[str, Any]:
    cfg = load_local_settings()
    api_key = ((payload.api_key if payload else None) or cfg.get("api_key") or "").strip()

    merged: dict[str, str] = {m["id"]: m["label"] for m in ANTIGRAVITY_MODELS}
    source = "sdk_builtin"
    if api_key:
        try:
            live = await asyncio.wait_for(asyncio.to_thread(_fetch_live_gemini_models, api_key), timeout=6.0)
            for m in live:
                if m["id"] not in merged:
                    merged[m["id"]] = m["label"]
            source = "sdk_and_api"
        except Exception as exc:
            logger.warning("Could not fetch live Gemini models: %s", exc)

    return {
        "source": source,
        "models": [{"id": k, "label": v} for k, v in merged.items()],
    }


@app.post("/cancel")
async def cancel_turn() -> dict[str, str]:
    resp = session_mgr.active_response
    if resp is not None:
        try:
            await resp.cancel()
        except Exception as exc:
            logger.warning("Cancel error: %s", exc)
    return {"status": "cancelled"}


def format_prompt_with_context(payload: ChatPayload) -> str:
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

    if not ctx_blocks:
        return payload.message

    joined_ctx = "\n\n".join(ctx_blocks)
    return f"<obsidian_context>\n{joined_ctx}\n</obsidian_context>\n\nЗапрос пользователя:\n{payload.message}"


def sse_event(data: dict[str, Any]) -> str:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


@app.post("/chat")
async def chat_stream(payload: ChatPayload) -> StreamingResponse:
    async def event_generator():
        cfg = load_local_settings()
        api_key = (payload.api_key or cfg.get("api_key") or "").strip()
        model = (payload.model or cfg.get("model") or DEFAULT_MODEL).strip()
        vault_path = (payload.vault_path or cfg.get("vault_path") or DEFAULT_VAULT).strip()

        if payload.api_key and payload.api_key.strip() != cfg.get("api_key"):
            cfg["api_key"] = api_key
            cfg["model"] = model
            cfg["vault_path"] = vault_path
            save_local_settings(cfg)

        if not api_key:
            yield sse_event(
                {
                    "type": "error",
                    "code": "MISSING_API_KEY",
                    "message": (
                        "Не указан Gemini API Key для запуска Antigravity SDK.\n"
                        "Откройте Settings → Antigravity Assistant & Calendar в Obsidian "
                        "(или нажмите «Ключ API» в шапке чата) и вставьте ключ из Google AI Studio."
                    ),
                }
            )
            return

        async with session_mgr._lock:
            try:
                agent = await session_mgr.ensure_agent(vault_path, model, api_key)
                full_prompt = format_prompt_with_context(payload)
                response = await agent.chat(full_prompt)
                session_mgr.active_response = response

                async for chunk in response.chunks:
                    if isinstance(chunk, ag.types.Thought):
                        if chunk.text:
                            yield sse_event({"type": "thought", "text": chunk.text})
                    elif isinstance(chunk, ag.types.ToolCall):
                        yield sse_event(
                            {
                                "type": "tool_call",
                                "name": chunk.name,
                                "args": chunk.args if isinstance(chunk.args, dict) else str(chunk.args),
                            }
                        )
                    elif isinstance(chunk, ag.types.Text):
                        if chunk.text:
                            yield sse_event({"type": "token", "text": chunk.text})

                usage_summary = session_mgr.add_turn_usage(getattr(response, "usage_metadata", None))
                yield sse_event({"type": "usage", "usage": usage_summary})
                yield sse_event({"type": "done"})
            except asyncio.CancelledError:
                yield sse_event({"type": "done", "cancelled": True})
            except Exception as exc:
                logger.exception("Chat error")
                yield sse_event({"type": "error", "message": str(exc)})
            finally:
                session_mgr.active_response = None

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
