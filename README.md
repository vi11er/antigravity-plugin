# Obsidian Antigravity Assistant & Calendar

Плагин для правой боковой панели **Obsidian** с часами, компактным календарём заметок (отдельные счётчики созданных и изменённых заметок), быстрым превью за выбранный день и встроенным чатом **Antigravity** (`google-antigravity` SDK).

## Возможности
- **Часы и дата** в реальном времени.
- **Компактный календарь** с двумя счётчиками под каждым числом (созданные и изменённые заметки).
- **Список заметок за выбранный день** с кратким описанием и переходом по клику (`Ctrl + клик` — в новой вкладке).
- **Чат Antigravity** со стримингом мыслей, вызовов инструментов и Markdown-ответов (включая кликабельные `[[wikilinks]]`), умеющий создавать, редактировать, переименовывать и перемещать заметки внутри Vault.

## Установка на новом компьютере

### 1. Установите плагин через BRAT (или вручную)
- **Через BRAT:** установите плагин **BRAT** в Obsidian → **Add Beta plugin** → вставьте URL этого репозитория.
- **Вручную:** скопируйте `manifest.json`, `main.js` и `styles.css` в `<Ваш Vault>/.obsidian/plugins/obsidian-antigravity/` и включите плагин в настройках Obsidian.

### 2. Запустите локальный Python-бэкенд (1 раз)
Требуется установленный [`uv`](https://docs.astral.sh/uv/):
```powershell
git clone https://github.com/<ваш_логин>/obsidian-antigravity.git
cd obsidian-antigravity/backend
uv sync
```
В настройках плагина в Obsidian (**Settings → Antigravity Assistant & Calendar**) проверьте:
- **Папка Python-бэкенда** — путь к папке `backend` из клонированного репозитория;
- **Gemini API Key** — ваш ключ из [Google AI Studio](https://aistudio.google.com/apikey).
