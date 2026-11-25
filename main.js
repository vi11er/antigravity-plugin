'use strict';

const {
  Plugin,
  ItemView,
  MarkdownRenderer,
  Component,
  Modal,
  Notice,
  PluginSettingTab,
  Setting,
} = require('obsidian');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const VIEW_TYPE_ANTIGRAVITY = 'antigravity-assistant-view';

const MONTHS_RU = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];
const MONTHS_SHORT_RU = [
  'янв', 'фев', 'мар', 'апр', 'мая', 'июн',
  'июл', 'авг', 'сен', 'окт', 'ноя', 'дек',
];
const DAYS_SHORT_RU = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

const DEFAULT_MODELS = [
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash (Быстрая, высокий лимит)' },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash (Стабильная, высокий лимит)' },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' },
  { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen (Free Tier: 20 зап/день)' },
  { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite' },
];

function detectDefaultUvPath() {
  const scoopUv = path.join(os.homedir(), 'scoop', 'shims', 'uv.exe');
  if (fs.existsSync(scoopUv)) return scoopUv;
  return 'uv';
}

const DEFAULT_SETTINGS = {
  port: 8765,
  uvPath: detectDefaultUvPath(),
  backendDir: path.join(os.homedir(), '.gemini', 'antigravity', 'scratch', 'obsidian-antigravity', 'backend'),
  apiKey: '',
  model: 'gemini-3.6-flash',
  autoStartBackend: true,
  excludeFreshCreateFromModified: true,
  includeActiveNote: true,
  includeSelectedDay: true,
};

function toLocalIsoDate(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseFrontmatterDate(fm) {
  if (!fm) return null;
  const raw = fm.date || fm.created;
  if (!raw) return null;
  const str = String(raw).trim();
  const match = str.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function cleanExcerpt(markdownText, fm) {
  if (fm) {
    const desc = fm.description || fm.summary;
    if (desc && String(desc).trim()) {
      return String(desc).trim().slice(0, 160);
    }
  }
  const withoutFm = markdownText.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const lines = withoutFm.split(/\r?\n/);
  const picked = [];
  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line) continue;
    if (/^#{1,6}\s/.test(line)) continue;
    if (/^\|?[\s:-]+\|[\s|:-]*$/.test(line)) continue;
    if (/^```/.test(line)) continue;
    line = line
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
      .replace(/\[\[([^\]]+)\]\]/g, '$1')
      .replace(/[*_~`>#]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (line.length > 2) {
      picked.push(line);
      if (picked.join(' ').length >= 120 || picked.length >= 2) break;
    }
  }
  return picked.length ? picked.join(' — ').slice(0, 160) : 'Пустая заметка или без текстового описания';
}

class ApiKeyModal extends Modal {
  constructor(app, plugin, onSaved) {
    super(app);
    this.plugin = plugin;
    this.onSaved = onSaved;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'Настройка Antigravity SDK' });
    contentEl.createEl('p', {
      text: 'Укажите Gemini API Key (из Google AI Studio) для работы локального агента Antigravity в вашем Vault.',
      cls: 'setting-item-description',
    });

    let keyValue = this.plugin.settings.apiKey || '';
    let modelValue = this.plugin.settings.model || 'gemini-4-hydrogen';
    let modelDropdown = null;

    const populateDropdown = (modelsList) => {
      if (!modelDropdown) return;
      const selectEl = modelDropdown.selectEl;
      selectEl.empty();
      const ids = new Set();
      for (const m of modelsList) {
        ids.add(m.id);
        modelDropdown.addOption(m.id, m.label || m.id);
      }
      if (modelValue && !ids.has(modelValue)) {
        modelDropdown.addOption(modelValue, modelValue);
      }
      modelDropdown.setValue(modelValue);
    };

    new Setting(contentEl)
      .setName('Gemini API Key')
      .setDesc('Ключ сохраняется локально на вашем компьютере')
      .addText((text) => {
        text.inputEl.type = 'password';
        text.inputEl.style.width = '260px';
        text
          .setPlaceholder('AIzaSy...')
          .setValue(keyValue)
          .onChange((v) => {
            keyValue = v.trim();
          });
      });

    new Setting(contentEl)
      .setName('Модель Antigravity')
      .setDesc('Список моделей из Antigravity SDK и вашего API-ключа')
      .addDropdown((dd) => {
        modelDropdown = dd;
        populateDropdown(DEFAULT_MODELS);
        dd.onChange((v) => {
          modelValue = v;
        });
      })
      .addExtraButton((btn) =>
        btn
          .setIcon('refresh-cw')
          .setTooltip('Обновить список доступных моделей')
          .onClick(async () => {
            const models = await this.plugin.fetchAvailableModels(keyValue);
            populateDropdown(models);
            new Notice(`Загружено моделей: ${models.length}`);
          })
      );

    this.plugin.fetchAvailableModels(keyValue).then((models) => {
      populateDropdown(models);
    });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText('Сохранить и подключить')
          .setCta()
          .onClick(async () => {
            this.plugin.settings.apiKey = keyValue;
            this.plugin.settings.model = modelValue;
            await this.plugin.saveSettings();
            await this.plugin.pushBackendConfig();
            new Notice('Настройки Antigravity сохранены');
            if (this.onSaved) this.onSaved();
            this.close();
          })
      );
  }

  onClose() {
    this.contentEl.empty();
  }
}

class AntigravityAssistantView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.clockTimer = null;
    this.healthTimer = null;
    this.renderComp = new Component();

    const now = new Date();
    this.viewYear = now.getFullYear();
    this.viewMonth = now.getMonth();
    this.selectedDateIso = toLocalIsoDate(now.getTime());

    this.dayStats = new Map();
    this.selectedDayNotes = [];
    this.isStreaming = false;
    this.abortController = null;
  }

  getViewType() {
    return VIEW_TYPE_ANTIGRAVITY;
  }

  getDisplayText() {
    return 'Antigravity';
  }

  getIcon() {
    return 'sparkles';
  }

  async onOpen() {
    this.renderComp.load();
    const container = this.containerEl.children[1];
    container.empty();

    const root = container.createDiv({ cls: 'ag-root' });

    // 1. Clock Bar
    const clockBar = root.createDiv({ cls: 'ag-clock-bar' });
    const clockLeft = clockBar.createDiv({ cls: 'ag-clock-left' });
    const clockIcon = clockLeft.createSpan({ cls: 'ag-clock-icon' });
    clockIcon.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
    this.clockTimeEl = clockLeft.createSpan({ cls: 'ag-clock-time', text: '--:--:--' });
    this.clockDateEl = clockBar.createSpan({ cls: 'ag-clock-date', text: '' });

    // 2. Compact Calendar Section
    const calSection = root.createDiv({ cls: 'ag-calendar-section' });
    const calHeader = calSection.createDiv({ cls: 'ag-cal-header' });
    this.calTitleBtn = calHeader.createEl('button', { cls: 'ag-cal-title-btn', text: '' });
    this.calTitleBtn.title = 'Вернуться к сегодняшнему дню';
    this.calTitleBtn.addEventListener('click', () => {
      const now = new Date();
      this.viewYear = now.getFullYear();
      this.viewMonth = now.getMonth();
      this.selectedDateIso = toLocalIsoDate(now.getTime());
      this.refreshCalendarAndPreview();
    });

    const legend = calHeader.createDiv({ cls: 'ag-cal-legend' });
    legend.createSpan({ cls: 'ag-legend-created', text: '● созд.' });
    legend.createSpan({ cls: 'ag-legend-modified', text: '● изм.' });

    const calNav = calHeader.createDiv({ cls: 'ag-cal-nav' });
    const prevBtn = calNav.createEl('button', { cls: 'ag-cal-nav-btn', text: '‹' });
    const nextBtn = calNav.createEl('button', { cls: 'ag-cal-nav-btn', text: '›' });
    prevBtn.addEventListener('click', () => this.shiftMonth(-1));
    nextBtn.addEventListener('click', () => this.shiftMonth(1));

    const weekdays = calSection.createDiv({ cls: 'ag-cal-weekdays' });
    ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].forEach((w) => weekdays.createSpan({ text: w }));

    this.calGridEl = calSection.createDiv({ cls: 'ag-cal-grid' });

    // 3. Day Notes Preview Section
    this.previewSectionEl = root.createDiv({ cls: 'ag-preview-section' });
    const previewHeader = this.previewSectionEl.createDiv({ cls: 'ag-preview-header' });
    this.previewTitleEl = previewHeader.createSpan({ cls: 'ag-preview-title', text: 'Заметки за день' });
    this.previewBadgesEl = previewHeader.createDiv({ cls: 'ag-preview-badges' });
    previewHeader.title = 'Нажмите, чтобы свернуть / развернуть список';
    previewHeader.addEventListener('click', () => {
      this.previewSectionEl.classList.toggle('is-collapsed');
    });
    this.previewListEl = this.previewSectionEl.createDiv({ cls: 'ag-preview-list' });

    // 4. Antigravity Chat Section
    const chatSection = root.createDiv({ cls: 'ag-chat-section' });
    const chatHeader = chatSection.createDiv({ cls: 'ag-chat-header' });
    const brand = chatHeader.createDiv({ cls: 'ag-chat-brand' });
    this.statusDotEl = brand.createSpan({ cls: 'ag-status-dot' });
    this.statusDotEl.title = 'Проверка локального сервера Antigravity...';
    this.statusDotEl.style.cursor = 'pointer';
    this.statusDotEl.addEventListener('click', async () => {
      new Notice('Перезапуск бэкенда Antigravity...');
      await this.plugin.ensureBackendRunning(true);
      await this.checkBackendHealth();
    });
    brand.createSpan({ text: 'Antigravity' });

    const headerActions = chatHeader.createDiv({ cls: 'ag-chat-header-actions' });
    this.tokenPillEl = headerActions.createSpan({ cls: 'ag-token-pill', text: '100%' });
    this.tokenPillEl.title = 'Остаток контекста сессии: 100%';
    const keyBtn = headerActions.createEl('button', { cls: 'ag-icon-btn', text: 'Ключ API' });
    keyBtn.addEventListener('click', () => {
      new ApiKeyModal(this.app, this.plugin, () => this.checkBackendHealth()).open();
    });
    const resetBtn = headerActions.createEl('button', { cls: 'ag-icon-btn', text: '↻ Новый' });
    resetBtn.title = 'Начать новый диалог';
    resetBtn.addEventListener('click', () => this.resetChat());

    this.messagesEl = chatSection.createDiv({ cls: 'ag-chat-messages' });
    this.renderWelcomeMessage();

    // Delegated click handler for [[wikilinks]] inside assistant replies
    this.messagesEl.addEventListener('click', (evt) => {
      const linkEl = evt.target.closest('a.internal-link');
      if (linkEl) {
        evt.preventDefault();
        const href = linkEl.getAttribute('data-href') || linkEl.textContent;
        const activeFile = this.app.workspace.getActiveFile();
        this.app.workspace.openLinkText(href, activeFile ? activeFile.path : '', evt.ctrlKey || evt.metaKey);
      }
    });

    // Footer: Prominent Input Box FIRST (where user marked ЧАТ), then Context chips & Quick buttons
    const footer = chatSection.createDiv({ cls: 'ag-chat-footer' });

    const inputRow = footer.createDiv({ cls: 'ag-input-row' });
    this.inputEl = inputRow.createEl('textarea', {
      cls: 'ag-chat-input',
      attr: {
        placeholder: 'Напишите сообщение Antigravity... (Enter — отправить, Shift+Enter — новая строка)',
        rows: '2',
      },
    });
    this.inputEl.addEventListener('input', () => {
      this.inputEl.style.height = 'auto';
      this.inputEl.style.height = Math.max(48, Math.min(this.inputEl.scrollHeight, 110)) + 'px';
    });
    this.inputEl.addEventListener('keydown', (evt) => {
      evt.stopPropagation();
      if (evt.key === 'Enter' && !evt.shiftKey) {
        evt.preventDefault();
        this.handleSendOrStop();
      }
    });

    this.sendBtn = inputRow.createEl('button', { cls: 'ag-send-btn', text: '→' });
    this.sendBtn.title = 'Отправить сообщение';
    this.sendBtn.addEventListener('click', () => this.handleSendOrStop());

    const ctxRow = footer.createDiv({ cls: 'ag-context-row' });
    this.noteChipBtn = ctxRow.createEl('button', { cls: 'ag-ctx-chip', text: '📄 Нет заметки' });
    this.noteChipBtn.title = 'Передавать открытую заметку в контекст запроса (клик — вкл/выкл)';
    this.noteChipBtn.addEventListener('click', async () => {
      this.plugin.settings.includeActiveNote = !this.plugin.settings.includeActiveNote;
      await this.plugin.saveSettings();
      this.updateContextChips();
    });

    this.dayChipBtn = ctxRow.createEl('button', { cls: 'ag-ctx-chip', text: '📅 День' });
    this.dayChipBtn.title = 'Передавать список заметок выбранного дня (клик — вкл/выкл)';
    this.dayChipBtn.addEventListener('click', async () => {
      this.plugin.settings.includeSelectedDay = !this.plugin.settings.includeSelectedDay;
      await this.plugin.saveSettings();
      this.updateContextChips();
    });

    const quickRow = footer.createDiv({ cls: 'ag-quick-row' });
    const quickItems = [
      { label: 'Рассортировать день', prompt: 'Посмотри заметки за выбранный день и предложи или выполни аккуратную сортировку по подходящим папкам.' },
      { label: 'Описать заметку', prompt: 'Сделай краткое описание (summary) открытой заметки и при необходимости улучши её структуру.' },
      { label: '+ Заметка', prompt: 'Создай новую структурированную заметку по моей теме (сейчас уточню или на основе текущей открытой заметки).' },
    ];
    for (const q of quickItems) {
      const b = quickRow.createEl('button', { cls: 'ag-quick-btn', text: q.label });
      b.addEventListener('click', () => {
        this.inputEl.value = q.prompt;
        this.inputEl.focus();
      });
    }

    // Timers & Obsidian Vault/Workspace listeners
    this.updateClock();
    this.clockTimer = window.setInterval(() => this.updateClock(), 1000);
    this.healthTimer = window.setInterval(() => this.checkBackendHealth(), 8000);

    const refreshDebounced = this.debounce(() => this.refreshCalendarAndPreview(), 350);
    this.registerEvent(this.app.vault.on('create', refreshDebounced));
    this.registerEvent(this.app.vault.on('modify', refreshDebounced));
    this.registerEvent(this.app.vault.on('delete', refreshDebounced));
    this.registerEvent(this.app.vault.on('rename', refreshDebounced));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.updateContextChips()));

    this.app.workspace.onLayoutReady(async () => {
      await this.refreshCalendarAndPreview();
      this.updateContextChips();
      await this.checkBackendHealth();
    });
  }

  async onClose() {
    if (this.clockTimer) window.clearInterval(this.clockTimer);
    if (this.healthTimer) window.clearInterval(this.healthTimer);
    this.renderComp.unload();
  }

  debounce(fn, delayMs) {
    let t = null;
    return (...args) => {
      if (t) window.clearTimeout(t);
      t = window.setTimeout(() => fn(...args), delayMs);
    };
  }

  updateClock() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    if (this.clockTimeEl) {
      this.clockTimeEl.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    }
    if (this.clockDateEl) {
      this.clockDateEl.textContent = `${now.getDate()} ${MONTHS_SHORT_RU[now.getMonth()]} ${now.getFullYear()}, ${DAYS_SHORT_RU[now.getDay()]}`;
    }
  }

  shiftMonth(delta) {
    let m = this.viewMonth + delta;
    let y = this.viewYear;
    if (m < 0) {
      m = 11;
      y -= 1;
    } else if (m > 11) {
      m = 0;
      y += 1;
    }
    this.viewMonth = m;
    this.viewYear = y;
    this.renderCalendarGrid();
  }

  computeVaultDayStats() {
    const map = new Map();
    const files = this.app.vault.getMarkdownFiles();
    const excludeFresh = this.plugin.settings.excludeFreshCreateFromModified;

    const ensureEntry = (iso) => {
      if (!map.has(iso)) {
        map.set(iso, { created: [], modified: [] });
      }
      return map.get(iso);
    };

    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      const fmDate = parseFrontmatterDate(cache && cache.frontmatter);
      const createdIso = fmDate || toLocalIsoDate(file.stat.ctime);
      const modifiedIso = toLocalIsoDate(file.stat.mtime);

      ensureEntry(createdIso).created.push(file);

      const isModifiedLater = !excludeFresh
        || modifiedIso !== createdIso
        || Math.abs(file.stat.mtime - file.stat.ctime) > 60000;

      if (isModifiedLater) {
        ensureEntry(modifiedIso).modified.push(file);
      }
    }
    this.dayStats = map;
  }

  async refreshCalendarAndPreview() {
    this.computeVaultDayStats();
    this.renderCalendarGrid();
    await this.renderSelectedDayPreview();
    this.updateContextChips();
  }

  renderCalendarGrid() {
    if (!this.calGridEl) return;
    this.calTitleBtn.textContent = `${MONTHS_RU[this.viewMonth]} ${this.viewYear}`;
    this.calGridEl.empty();

    const firstDay = new Date(this.viewYear, this.viewMonth, 1);
    const startOffset = (firstDay.getDay() + 6) % 7; // Monday = 0
    const daysInMonth = new Date(this.viewYear, this.viewMonth + 1, 0).getDate();
    const todayIso = toLocalIsoDate(Date.now());

    for (let i = 0; i < startOffset; i++) {
      this.calGridEl.createDiv({ cls: 'ag-cal-empty' });
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const iso = `${this.viewYear}-${String(this.viewMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const stat = this.dayStats.get(iso);
      const cCount = stat ? stat.created.length : 0;
      const mCount = stat ? stat.modified.length : 0;

      const btn = this.calGridEl.createEl('button', { cls: 'ag-cal-day' });
      if (iso === todayIso) btn.classList.add('is-today');
      if (iso === this.selectedDateIso) btn.classList.add('is-selected');

      btn.title = `${d} ${MONTHS_SHORT_RU[this.viewMonth]}: создано ${cCount}, изменено ${mCount}`;
      btn.createSpan({ cls: 'ag-cal-day-num', text: String(d) });

      const countsRow = btn.createDiv({ cls: 'ag-cal-counts' });
      countsRow.createSpan({
        cls: cCount > 0 ? 'ag-cnt-created' : 'ag-cnt-zero',
        text: String(cCount),
      });
      countsRow.createSpan({
        cls: mCount > 0 ? 'ag-cnt-modified' : 'ag-cnt-zero',
        text: String(mCount),
      });

      btn.addEventListener('click', async () => {
        this.selectedDateIso = iso;
        this.previewSectionEl.classList.remove('is-collapsed');
        this.renderCalendarGrid();
        await this.renderSelectedDayPreview();
        this.updateContextChips();
      });
    }
  }

  async renderSelectedDayPreview() {
    if (!this.previewListEl) return;
    const [y, m, d] = this.selectedDateIso.split('-').map(Number);
    this.previewTitleEl.textContent = `Заметки за ${d} ${MONTHS_SHORT_RU[m - 1]}`;

    const stat = this.dayStats.get(this.selectedDateIso) || { created: [], modified: [] };
    this.previewBadgesEl.empty();
    this.previewBadgesEl.createSpan({ cls: 'ag-badge-created', text: `+${stat.created.length}` });
    this.previewBadgesEl.createSpan({ cls: 'ag-badge-modified', text: `✎${stat.modified.length}` });

    const createdSet = new Set(stat.created.map((f) => f.path));
    const modifiedSet = new Set(stat.modified.map((f) => f.path));
    const combinedMap = new Map();
    for (const f of stat.created) combinedMap.set(f.path, f);
    for (const f of stat.modified) combinedMap.set(f.path, f);

    const files = Array.from(combinedMap.values()).sort((a, b) => b.stat.mtime - a.stat.mtime);
    this.previewListEl.empty();
    this.selectedDayNotes = [];

    if (files.length === 0) {
      this.previewListEl.createDiv({ cls: 'ag-preview-empty', text: 'За этот день заметок нет' });
      return;
    }

    for (const file of files) {
      const isCreated = createdSet.has(file.path);
      const isModified = modifiedSet.has(file.path);
      const statusLabel = isCreated && isModified ? 'создана и изменена' : isCreated ? 'создана' : 'изменена';
      this.selectedDayNotes.push({ path: file.path, status: statusLabel });

      const card = this.previewListEl.createDiv({ cls: 'ag-note-card' });
      card.title = file.path;
      const top = card.createDiv({ cls: 'ag-note-card-top' });
      top.createSpan({ cls: 'ag-note-card-title', text: file.basename });

      const tags = top.createDiv({ cls: 'ag-note-card-tags' });
      if (isCreated) tags.createSpan({ cls: 'ag-mini-tag is-created', text: 'созд.' });
      if (isModified) tags.createSpan({ cls: 'ag-mini-tag is-modified', text: 'изм.' });

      const descEl = card.createDiv({ cls: 'ag-note-card-desc', text: 'Загрузка...' });
      this.loadNoteDescription(file, descEl);

      card.addEventListener('click', (evt) => {
        const leaf = this.app.workspace.getLeaf(evt.ctrlKey || evt.metaKey ? 'tab' : false);
        leaf.openFile(file);
      });
    }
  }

  async loadNoteDescription(file, descEl) {
    try {
      const cache = this.app.metadataCache.getFileCache(file);
      const text = await this.app.vault.cachedRead(file);
      descEl.textContent = cleanExcerpt(text, cache && cache.frontmatter);
    } catch {
      descEl.textContent = file.path;
    }
  }

  updateContextChips() {
    if (!this.noteChipBtn || !this.dayChipBtn) return;
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile) {
      this.noteChipBtn.textContent = `📄 ${activeFile.basename}`;
    } else {
      this.noteChipBtn.textContent = '📄 Нет активной заметки';
    }
    this.noteChipBtn.classList.toggle('is-active', Boolean(this.plugin.settings.includeActiveNote && activeFile));

    const [, m, d] = this.selectedDateIso.split('-').map(Number);
    this.dayChipBtn.textContent = `📅 ${d} ${MONTHS_SHORT_RU[m - 1]} (${this.selectedDayNotes.length})`;
    this.dayChipBtn.classList.toggle('is-active', Boolean(this.plugin.settings.includeSelectedDay));
  }

  renderWelcomeMessage() {
    this.messagesEl.empty();
    const box = this.messagesEl.createDiv({ cls: 'ag-msg-welcome' });
    box.setText(
      'Привет! Я могу создавать, редактировать, переименовывать и раскладывать заметки в вашем Vault. Выберите день в календаре или откройте заметку и напишите задачу.'
    );
  }

  updateTokenBadge(usage) {
    if (!this.tokenPillEl || !usage) return;
    const pct = typeof usage.remaining_pct === 'number' ? usage.remaining_pct : 100;
    const pctText = Number.isInteger(pct) ? `${pct}%` : `${pct.toFixed(1)}%`;
    this.tokenPillEl.textContent = pctText;
    this.tokenPillEl.classList.toggle('is-low', pct < 25);
    const used = Number(usage.session_used || 0).toLocaleString('ru-RU');
    const limit = Number(usage.context_limit || 0).toLocaleString('ru-RU');
    const daily = Number(usage.daily_tokens || 0).toLocaleString('ru-RU');
    this.tokenPillEl.title = `Остаток контекста сессии: ${pctText}\nИспользовано в сессии: ${used} / ${limit} токенов\nВсего потрачено сегодня: ${daily} токенов`;
  }

  async checkBackendHealth() {
    if (this.isStreaming) return;
    try {
      const res = await fetch(`http://127.0.0.1:${this.plugin.settings.port}/health`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (data.usage) this.updateTokenBadge(data.usage);
      this.statusDotEl.className = 'ag-status-dot is-online';
      this.statusDotEl.title = data.has_api_key
        ? `Онлайн (${data.model}) — нажмите для перезапуска`
        : 'Сервер запущен, требуется Gemini API Key (нажмите «Ключ API»)';
    } catch {
      this.statusDotEl.className = 'ag-status-dot is-offline';
      this.statusDotEl.title = 'Бэкенд не запущен — нажмите для запуска';
    }
  }

  async resetChat() {
    try {
      const res = await fetch(`http://127.0.0.1:${this.plugin.settings.port}/reset`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        if (data.usage) this.updateTokenBadge(data.usage);
      }
    } catch {
      // ignore if offline
    }
    this.renderWelcomeMessage();
    new Notice('Начат новый диалог Antigravity');
  }

  async handleSendOrStop() {
    if (this.isStreaming) {
      if (this.abortController) this.abortController.abort();
      try {
        await fetch(`http://127.0.0.1:${this.plugin.settings.port}/cancel`, { method: 'POST' });
      } catch {
        // ignore
      }
      return;
    }

    const message = this.inputEl.value.trim();
    if (!message) return;

    this.inputEl.value = '';
    this.inputEl.style.height = 'auto';

    const welcome = this.messagesEl.querySelector('.ag-msg-welcome');
    if (welcome) welcome.remove();

    this.messagesEl.createDiv({ cls: 'ag-msg-user', text: message });

    const assistantBox = this.messagesEl.createDiv({ cls: 'ag-msg-assistant' });
    const toolsListEl = assistantBox.createDiv({ cls: 'ag-tools-list' });
    toolsListEl.style.display = 'none';

    const thoughtsDetails = assistantBox.createEl('details', { cls: 'ag-thoughts' });
    thoughtsDetails.style.display = 'none';
    thoughtsDetails.createEl('summary', { text: 'Ход мыслей агента' });
    const thoughtsBody = thoughtsDetails.createDiv({ cls: 'ag-thoughts-body' });

    const mdContainer = assistantBox.createDiv({ cls: 'ag-msg-markdown', text: 'Думаю...' });
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;

    await this.streamChatRequest(message, { toolsListEl, thoughtsDetails, thoughtsBody, mdContainer });
  }

  async streamChatRequest(message, ui) {
    this.isStreaming = true;
    this.sendBtn.textContent = '■';
    this.statusDotEl.className = 'ag-status-dot is-busy';
    this.abortController = new AbortController();

    try {
      await this.plugin.ensureBackendRunning(false);

      const activeFile = this.app.workspace.getActiveFile();
      let activeNotePath = null;
      let activeNoteExcerpt = null;
      if (this.plugin.settings.includeActiveNote && activeFile) {
        activeNotePath = activeFile.path;
        try {
          activeNoteExcerpt = (await this.app.vault.cachedRead(activeFile)).slice(0, 2500);
        } catch {
          activeNoteExcerpt = null;
        }
      }

      const payload = {
        message,
        active_note_path: activeNotePath,
        active_note_excerpt: activeNoteExcerpt,
        selected_day: this.plugin.settings.includeSelectedDay ? this.selectedDateIso : null,
        day_notes: this.plugin.settings.includeSelectedDay ? this.selectedDayNotes : null,
        api_key: this.plugin.settings.apiKey || undefined,
        model: this.plugin.settings.model || undefined,
        vault_path: this.plugin.getVaultBasePath(),
      };

      const res = await fetch(`http://127.0.0.1:${this.plugin.settings.port}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: this.abortController.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`Ошибка ответа сервера: HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let fullMarkdown = '';
      let fullThoughts = '';
      let lastRenderTs = 0;

      const renderMarkdownNow = async () => {
        ui.mdContainer.empty();
        const srcPath = activeFile ? activeFile.path : '';
        await MarkdownRenderer.render(this.app, fullMarkdown || '...', ui.mdContainer, srcPath, this.renderComp);
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const block of parts) {
          const line = block.trim();
          if (!line.startsWith('data:')) continue;
          const jsonStr = line.slice(5).trim();
          if (!jsonStr) continue;

          let evt;
          try {
            evt = JSON.parse(jsonStr);
          } catch {
            continue;
          }

          if (evt.type === 'thought') {
            fullThoughts += evt.text;
            ui.thoughtsDetails.style.display = 'block';
            ui.thoughtsBody.textContent = fullThoughts;
          } else if (evt.type === 'tool_call') {
            ui.toolsListEl.style.display = 'flex';
            ui.toolsListEl.createSpan({ cls: 'ag-tool-pill', text: `🛠 ${evt.name}` });
          } else if (evt.type === 'token') {
            fullMarkdown += evt.text;
            const now = Date.now();
            if (now - lastRenderTs > 90) {
              lastRenderTs = now;
              await renderMarkdownNow();
            }
          } else if (evt.type === 'error') {
            ui.mdContainer.empty();
            ui.mdContainer.createDiv({ cls: 'ag-msg-error', text: evt.message });
            if (evt.code === 'MISSING_API_KEY') {
              const btn = ui.mdContainer.createEl('button', {
                cls: 'ag-quick-btn',
                text: 'Указать Gemini API Key',
              });
              btn.style.marginTop = '6px';
              btn.addEventListener('click', () => {
                new ApiKeyModal(this.app, this.plugin, () => this.checkBackendHealth()).open();
              });
            }
          } else if (evt.type === 'usage' && evt.usage) {
            this.updateTokenBadge(evt.usage);
          } else if (evt.type === 'done') {
            if (fullMarkdown) {
              await renderMarkdownNow();
            } else if (!ui.mdContainer.querySelector('.ag-msg-error')) {
              ui.mdContainer.textContent = evt.cancelled ? 'Остановлено.' : 'Выполнено.';
            }
          }
        }
      }

      if (fullMarkdown) {
        await renderMarkdownNow();
      }
      await this.refreshCalendarAndPreview();
    } catch (err) {
      if (err && err.name === 'AbortError') {
        ui.mdContainer.createDiv({ cls: 'ag-msg-error', text: 'Запрос отменён.' });
      } else {
        ui.mdContainer.empty();
        ui.mdContainer.createDiv({
          cls: 'ag-msg-error',
          text: `Не удалось связаться с локальным сервером Antigravity: ${err.message}`,
        });
      }
    } finally {
      this.isStreaming = false;
      this.abortController = null;
      this.sendBtn.textContent = '→';
      await this.checkBackendHealth();
    }
  }
}

class AntigravitySettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Antigravity Assistant & Calendar' });

    new Setting(containerEl)
      .setName('Gemini API Key')
      .setDesc('Ключ из Google AI Studio для запуска google-antigravity SDK')
      .addText((text) => {
        text.inputEl.type = 'password';
        text
          .setPlaceholder('AIzaSy...')
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.saveSettings();
            await this.plugin.pushBackendConfig();
          });
      });

    let modelDropdown = null;
    const populateSettingsDropdown = (modelsList) => {
      if (!modelDropdown) return;
      modelDropdown.selectEl.empty();
      const cur = this.plugin.settings.model || 'gemini-4-hydrogen';
      const ids = new Set();
      for (const m of modelsList) {
        ids.add(m.id);
        modelDropdown.addOption(m.id, m.label || m.id);
      }
      if (cur && !ids.has(cur)) {
        modelDropdown.addOption(cur, cur);
      }
      modelDropdown.setValue(cur);
    };

    new Setting(containerEl)
      .setName('Модель Antigravity')
      .setDesc('Выбор из моделей, доступных в Antigravity SDK и вашем API-ключе')
      .addDropdown((dd) => {
        modelDropdown = dd;
        populateSettingsDropdown(DEFAULT_MODELS);
        dd.onChange(async (value) => {
          this.plugin.settings.model = value;
          await this.plugin.saveSettings();
          await this.plugin.pushBackendConfig();
        });
      })
      .addExtraButton((btn) =>
        btn
          .setIcon('refresh-cw')
          .setTooltip('Обновить список моделей')
          .onClick(async () => {
            const models = await this.plugin.fetchAvailableModels(this.plugin.settings.apiKey);
            populateSettingsDropdown(models);
            new Notice(`Доступно моделей: ${models.length}`);
          })
      );

    this.plugin.fetchAvailableModels(this.plugin.settings.apiKey).then((models) => {
      populateSettingsDropdown(models);
    });

    new Setting(containerEl)
      .setName('Считать изменёнными только повторные правки')
      .setDesc('Если включено, только что созданная заметка не увеличивает сразу розовый счётчик изменений (порог 60 сек)')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.excludeFreshCreateFromModified)
          .onChange(async (value) => {
            this.plugin.settings.excludeFreshCreateFromModified = value;
            await this.plugin.saveSettings();
            this.plugin.refreshAllViews();
          })
      );

    new Setting(containerEl)
      .setName('Порт локального бэкенда')
      .setDesc('По умолчанию 8765')
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.port))
          .onChange(async (value) => {
            const p = parseInt(value, 10);
            if (!Number.isNaN(p) && p > 1024 && p < 65535) {
              this.plugin.settings.port = p;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName('Путь к uv.exe')
      .addText((text) =>
        text
          .setValue(this.plugin.settings.uvPath)
          .onChange(async (value) => {
            this.plugin.settings.uvPath = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Папка Python-бэкенда')
      .addText((text) =>
        text
          .setValue(this.plugin.settings.backendDir)
          .onChange(async (value) => {
            this.plugin.settings.backendDir = value.trim();
            await this.plugin.saveSettings();
          })
      );
  }
}

module.exports = class ObsidianAntigravityPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.backendProcess = null;

    this.registerView(
      VIEW_TYPE_ANTIGRAVITY,
      (leaf) => new AntigravityAssistantView(leaf, this)
    );

    this.addRibbonIcon('sparkles', 'Открыть панель Antigravity', () => {
      this.activateView();
    });

    this.addCommand({
      id: 'open-antigravity-panel',
      name: 'Открыть панель Antigravity справа',
      callback: () => this.activateView(),
    });

    this.addSettingTab(new AntigravitySettingTab(this.app, this));

    this.app.workspace.onLayoutReady(async () => {
      if (this.settings.autoStartBackend) {
        this.ensureBackendRunning(false);
      }
      if (this.app.workspace.getLeavesOfType(VIEW_TYPE_ANTIGRAVITY).length === 0) {
        await this.activateView();
      }
    });
  }

  onunload() {
    this.stopBackendProcess();
  }

  getVaultBasePath() {
    const adapter = this.app.vault.adapter;
    if (adapter && typeof adapter.getBasePath === 'function') {
      return adapter.getBasePath();
    }
    return '';
  }

  async ensureBackendRunning(forceRestart) {
    if (forceRestart) {
      try {
        await fetch(`http://127.0.0.1:${this.settings.port}/shutdown`, { method: 'POST' });
        await new Promise((r) => setTimeout(r, 400));
      } catch {
        // ignore if already stopped
      }
      this.stopBackendProcess();
    } else {
      try {
        const res = await fetch(`http://127.0.0.1:${this.settings.port}/health`);
        if (res.ok) return true;
      } catch {
        // Need to spawn backend
      }
    }

    const serverScript = path.join(this.settings.backendDir, 'server.py');
    if (!fs.existsSync(serverScript)) {
      console.error('Antigravity backend server.py not found:', serverScript);
      return false;
    }

    try {
      this.backendProcess = spawn(
        this.settings.uvPath,
        ['run', 'python', 'server.py'],
        {
          cwd: this.settings.backendDir,
          windowsHide: true,
          env: {
            ...process.env,
            PYTHONIOENCODING: 'utf-8',
            ANTIGRAVITY_PORT: String(this.settings.port),
            OBSIDIAN_VAULT_PATH: this.getVaultBasePath(),
          },
        }
      );

      this.backendProcess.on('exit', () => {
        this.backendProcess = null;
      });

      // Wait up to 5 seconds for server readiness
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 350));
        try {
          const res = await fetch(`http://127.0.0.1:${this.settings.port}/health`);
          if (res.ok) return true;
        } catch {
          // still starting
        }
      }
    } catch (err) {
      console.error('Failed to spawn Antigravity backend:', err);
    }
    return false;
  }

  stopBackendProcess() {
    if (this.backendProcess) {
      try {
        this.backendProcess.kill();
      } catch {
        // ignore
      }
      this.backendProcess = null;
    }
  }

  async fetchAvailableModels(apiKey) {
    try {
      const res = await fetch(`http://127.0.0.1:${this.settings.port}/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey || this.settings.apiKey || '' }),
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.models) && data.models.length > 0) {
          return data.models;
        }
      }
    } catch {
      // fallback to built-in SDK models
    }
    return DEFAULT_MODELS;
  }

  async pushBackendConfig() {
    try {
      await fetch(`http://127.0.0.1:${this.settings.port}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: this.settings.apiKey,
          model: this.settings.model,
          vault_path: this.getVaultBasePath(),
        }),
      });
    } catch {
      // backend might not be started yet
    }
  }

  refreshAllViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_ANTIGRAVITY)) {
      if (leaf.view && typeof leaf.view.refreshCalendarAndPreview === 'function') {
        leaf.view.refreshCalendarAndPreview();
      }
    }
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_ANTIGRAVITY)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE_ANTIGRAVITY, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
};
