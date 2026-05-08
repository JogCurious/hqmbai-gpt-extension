'use strict';

const APP_NAME = '好奇漫步GPT网页实时备份器';
const DISPLAY_VERSION = 'v2.6';
const PANEL_MODE_KEY = 'contentPanelMode';
const NOTICE_MODE_KEY = 'tempNoticeDisplayMode';
const NOTICE_POS_KEY = 'tempNoticePosition';
const REFRESH_DEBOUNCE_MS = 160;
const POLL_MS = 1200;

let refreshTimer = null;
let pollTimer = null;
let chatObserver = null;
let runtimeSnapshot = null;
let lastStateSignature = '';
let routeSessionSeed = generateId();
let currentIdentity = null;

let panelMode = 'open';
let noticeMode = 'open';
let noticePosition = null;
let noticeDragState = null;
let noticePositionTouched = false;

let panel = null;
let panelLauncher = null;
let panelElements = {};

let noticeBadge = null;
let noticeLauncher = null;
let noticeStateEl = null;

let typedWarningShown = false;
let submittedWarningShown = false;

init().catch(console.error);

async function init() {
  installHistoryHooks();
  installRuntimeListeners();
  installLifecycleListeners();
  installPrivacyGuards();
  await loadLocalUiState();
  refreshState('init', true);
  ensurePollTimer();
}

async function loadLocalUiState() {
  try {
    const values = await chrome.storage.local.get([PANEL_MODE_KEY, NOTICE_MODE_KEY, NOTICE_POS_KEY]);
    panelMode = normalizeMode(values[PANEL_MODE_KEY], 'open');
    noticeMode = normalizeMode(values[NOTICE_MODE_KEY], 'open');
    noticePosition = values[NOTICE_POS_KEY] || null;
  } catch {
    panelMode = 'open';
    noticeMode = 'open';
    noticePosition = null;
  }
}

function normalizeMode(value, fallback) {
  return ['open', 'minimized', 'closed'].includes(value) ? value : fallback;
}

function installHistoryHooks() {
  const wrap = (method) => {
    const original = history[method];
    history[method] = function (...args) {
      notifyRouteWillChange();
      routeSessionSeed = generateId();
      const result = original.apply(this, args);
      setTimeout(() => refreshState('route-change', true), 0);
      return result;
    };
  };

  wrap('pushState');
  wrap('replaceState');

  window.addEventListener('popstate', () => {
    notifyRouteWillChange();
    routeSessionSeed = generateId();
    setTimeout(() => refreshState('popstate', true), 0);
  });
}

function installRuntimeListeners() {
  chrome.runtime.onMessage.addListener((message) => {
    const type = String(message?.type || '');
    if (type === 'STATE_UPDATE') {
      runtimeSnapshot = message.payload || null;
      applyRuntimeToUi();
    }
    if (type === 'REQUEST_PAGE_STATE') {
      refreshState('runtime-request', true);
    }
  });
}

function installLifecycleListeners() {
  document.addEventListener('visibilitychange', () => {
    if (!isChatRoute() || document.hidden !== true) return;
    void chrome.runtime.sendMessage({
      type: 'LIFECYCLE_EVENT',
      payload: { kind: 'hidden' }
    });
  });

  window.addEventListener('pagehide', () => {
    if (!isChatRoute()) return;
    void chrome.runtime.sendMessage({
      type: 'LIFECYCLE_EVENT',
      payload: { kind: 'pagehide' }
    });
  });

  window.addEventListener('beforeunload', () => {
    if (!isChatRoute()) return;
    void chrome.runtime.sendMessage({
      type: 'LIFECYCLE_EVENT',
      payload: { kind: 'beforeunload' }
    });
  });
}

function installPrivacyGuards() {
  document.addEventListener('input', (event) => {
    handleComposerInput(event.target);
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    if (!isComposerElement(event.target)) return;
    handleComposerSubmit(event.target);
  }, true);
}

function refreshState(reason = 'change', force = false) {
  ensurePollTimer();
  const routeEnabled = isChatRoute();
  if (!routeEnabled) {
    teardownUi();
    runtimeSnapshot = null;
    currentIdentity = null;
    lastStateSignature = '';
    typedWarningShown = false;
    submittedWarningShown = false;
    return;
  }

  ensureUi();
  observeChatArea();

  const messages = extractMessages();
  const identity = buildConversationIdentity(messages);
  const signature = JSON.stringify({
    key: identity.key,
    temporary: identity.temporary,
    blank: identity.blank,
    label: identity.label,
    title: document.title,
    href: location.href,
    messages
  });

  if (!force && signature === lastStateSignature) {
    applyRuntimeToUi();
    return;
  }

  currentIdentity = identity;
  lastStateSignature = signature;
  resetPrivacyWarningFlags(identity.temporary || identity.blank);
  updatePanelLocal(identity, messages);
  updateNoticeLocal(identity);

  void chrome.runtime.sendMessage({
    type: 'PAGE_STATE',
    payload: {
      routeEnabled: true,
      url: location.href,
      title: normalizeText(document.title || 'ChatGPT'),
      reason,
      session: {
        ...identity,
        titleHint: normalizeText(document.title || 'ChatGPT'),
        firstUserText: getFirstUserText(messages),
        canSave: messages.length > 0 && !identity.blank,
        messages,
        updatedAt: new Date().toISOString()
      }
    }
  }).then((response) => {
    if (response?.ok) {
      runtimeSnapshot = response;
      applyRuntimeToUi();
    }
  }).catch(() => {});
}

function notifyRouteWillChange() {
  if (!isChatRoute()) return;
  const messages = extractMessages();
  const identity = buildConversationIdentity(messages);
  if (!identity.key || identity.blank || !messages.length) return;

  void chrome.runtime.sendMessage({
    type: 'ROUTE_WILL_CHANGE',
    payload: {
      url: location.href,
      session: {
        ...identity,
        titleHint: normalizeText(document.title || 'ChatGPT'),
        firstUserText: getFirstUserText(messages),
        canSave: true,
        messages,
        updatedAt: new Date().toISOString()
      }
    }
  }).catch(() => {});
}

function scheduleRefresh(reason) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refreshState(reason), REFRESH_DEBOUNCE_MS);
}

function observeChatArea() {
  if (chatObserver) return;
  if (!document.body) return;

  chatObserver = new MutationObserver(() => {
    scheduleRefresh('mutation');
  });

  chatObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true
  });
}

function ensureUi() {
  injectStyles();
  createPanel();
  createNotice();
}

function teardownUi() {
  if (chatObserver) {
    chatObserver.disconnect();
    chatObserver = null;
  }
  [panel, panelLauncher, noticeBadge, noticeLauncher].forEach((node) => node?.remove());
  panel = null;
  panelLauncher = null;
  noticeBadge = null;
  noticeLauncher = null;
  panelElements = {};
  noticeStateEl = null;
}

function injectStyles() {
  if (document.getElementById('haoqi-gpt-backup-style')) return;
  const style = document.createElement('style');
  style.id = 'haoqi-gpt-backup-style';
  style.textContent = `
    #haoqi-gpt-panel {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 999999;
      width: 314px;
      padding: 8px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(19,20,23,0.96);
      color: #fff;
      box-shadow: 0 10px 28px rgba(0,0,0,0.28);
      backdrop-filter: blur(8px);
      font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    #haoqi-gpt-panel button,
    #haoqi-gpt-panel-launcher,
    #haoqi-gpt-notice-launcher,
    #haoqi-gpt-notice .icon-btn {
      font: inherit;
    }
    #haoqi-gpt-panel-launcher,
    #haoqi-gpt-notice-launcher {
      position: fixed;
      z-index: 999999;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 10px 14px;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 10px;
      background: rgba(19,20,23,0.94);
      color: #fff;
      cursor: pointer;
      box-shadow: 0 10px 24px rgba(0,0,0,0.24);
    }
    #haoqi-gpt-panel-launcher {
      right: 16px;
      bottom: 16px;
    }
    #haoqi-gpt-notice,
    #haoqi-gpt-notice-launcher {
      top: 8px;
      left: 50%;
      transform: translateX(-50%);
    }
    #haoqi-gpt-notice {
      position: fixed;
      z-index: 999999;
      min-width: 260px;
      max-width: min(520px, calc(100vw - 20px));
      padding: 11px 78px 11px 18px;
      border-radius: 12px;
      box-shadow: 0 10px 28px rgba(0,0,0,0.24);
      color: #fff;
      font-size: 15px;
      font-weight: 700;
      user-select: none;
      backdrop-filter: blur(8px);
    }
    #haoqi-gpt-notice.temp { background: rgba(34,197,94,0.94); }
    #haoqi-gpt-notice.normal { background: rgba(245,158,11,0.94); }
    #haoqi-gpt-notice.blank { background: rgba(100,116,139,0.94); }
    #haoqi-gpt-notice .actions {
      position: absolute;
      right: 8px;
      top: 8px;
      display: flex;
      gap: 6px;
    }
    #haoqi-gpt-notice .icon-btn,
    #haoqi-gpt-panel .icon-btn {
      width: 26px;
      height: 26px;
      padding: 0;
      border: 0;
      border-radius: 8px;
      background: rgba(255,255,255,0.1);
      color: #fff;
      cursor: pointer;
    }
    #haoqi-gpt-notice .state {
      cursor: move;
      line-height: 1.35;
    }
    #haoqi-gpt-panel .header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 8px;
    }
    #haoqi-gpt-panel .title {
      font-size: 13px;
      font-weight: 800;
      line-height: 1.35;
    }
    #haoqi-gpt-panel .version {
      margin-top: 2px;
      color: rgba(255,255,255,0.6);
      font-size: 11px;
      font-weight: 700;
    }
    #haoqi-gpt-panel .window-actions {
      display: flex;
      gap: 6px;
    }
    #haoqi-gpt-panel .stack {
      display: grid;
      gap: 6px;
    }
    #haoqi-gpt-panel .meta-box {
      display: grid;
      grid-template-columns: 58px minmax(0, 1fr);
      gap: 8px;
      padding: 8px 9px;
      border-radius: 9px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.05);
    }
    #haoqi-gpt-panel .meta-label {
      color: rgba(255,255,255,0.78);
      font-size: 11px;
      font-weight: 800;
    }
    #haoqi-gpt-panel .meta-value {
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      word-break: break-word;
      font-size: 12px;
      font-weight: 700;
      line-height: 1.35;
    }
    #haoqi-gpt-panel .toggle-row {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 8px 9px;
      border-radius: 9px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.05);
    }
    #haoqi-gpt-panel .toggle-row input {
      width: 16px;
      height: 16px;
      margin: 2px 0 0;
      accent-color: #18b981;
    }
    #haoqi-gpt-panel .toggle-copy {
      min-width: 0;
      flex: 1;
    }
    #haoqi-gpt-panel .toggle-title {
      font-size: 12px;
      font-weight: 800;
    }
    #haoqi-gpt-panel .toggle-status {
      margin-top: 2px;
      color: rgba(255,255,255,0.72);
      font-size: 11px;
    }
    #haoqi-gpt-panel .row-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
    }
    #haoqi-gpt-panel button {
      width: 100%;
      padding: 8px 9px;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.05);
      color: #fff;
      cursor: pointer;
      font-size: 12px;
      font-weight: 800;
    }
    #haoqi-gpt-panel button:hover,
    #haoqi-gpt-panel-launcher:hover,
    #haoqi-gpt-notice-launcher:hover {
      background: rgba(255,255,255,0.1);
    }
    #haoqi-gpt-panel button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    #haoqi-gpt-panel .status {
      padding: 8px 9px;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.06);
      font-size: 12px;
      font-weight: 700;
      word-break: break-word;
    }
    #haoqi-gpt-panel [data-tone="accent"] { background: rgba(16,185,129,0.12); border-color: rgba(16,185,129,0.24); }
    #haoqi-gpt-panel [data-tone="info"] { background: rgba(56,189,248,0.12); border-color: rgba(56,189,248,0.22); }
    #haoqi-gpt-panel [data-tone="warning"] { background: rgba(245,158,11,0.12); border-color: rgba(245,158,11,0.22); }
    #haoqi-gpt-panel [data-tone="danger"] { background: rgba(239,68,68,0.12); border-color: rgba(239,68,68,0.22); }
    #haoqi-gpt-panel .btn-sync { background: rgba(16,185,129,0.14); border-color: rgba(16,185,129,0.22); }
    #haoqi-gpt-panel .btn-file { background: rgba(56,189,248,0.12); border-color: rgba(56,189,248,0.22); }
    #haoqi-gpt-panel .btn-export { background: rgba(168,85,247,0.14); border-color: rgba(168,85,247,0.22); }
    #haoqi-gpt-panel .btn-danger { background: rgba(239,68,68,0.14); border-color: rgba(239,68,68,0.22); }
    #haoqi-gpt-privacy-wrap {
      position: fixed;
      left: 50%;
      bottom: 88px;
      transform: translateX(-50%);
      z-index: 999999;
      width: min(540px, calc(100vw - 24px));
      display: flex;
      flex-direction: column;
      gap: 8px;
      pointer-events: none;
    }
    .haoqi-gpt-privacy-toast {
      padding: 12px 14px;
      border-radius: 10px;
      color: #fff;
      font-size: 13px;
      font-weight: 700;
      box-shadow: 0 10px 26px rgba(0,0,0,0.28);
      backdrop-filter: blur(8px);
    }
    .haoqi-gpt-privacy-toast.warning { background: rgba(245,158,11,0.94); }
    .haoqi-gpt-privacy-toast.danger { background: rgba(239,68,68,0.94); }
  `;
  document.documentElement.appendChild(style);
}

function createPanel() {
  if (panel) return;
  panel = document.createElement('div');
  panel.id = 'haoqi-gpt-panel';
  panel.innerHTML = `
    <div class="header">
      <div>
        <div class="title">📦 ${APP_NAME}</div>
        <div class="version">${DISPLAY_VERSION}</div>
      </div>
      <div class="window-actions">
        <button class="icon-btn" id="haoqi-panel-min">-</button>
        <button class="icon-btn" id="haoqi-panel-close">x</button>
      </div>
    </div>
    <div class="stack">
      <div class="meta-box" id="haoqi-conv-box" data-tone="accent">
        <span class="meta-label">当前对话</span>
        <span class="meta-value" id="haoqi-conv-value">检测中</span>
      </div>
      <div class="meta-box" id="haoqi-web-box" data-tone="info">
        <span class="meta-label">网页文件</span>
        <span class="meta-value" id="haoqi-web-value">未生成</span>
      </div>
      <div class="meta-box" id="haoqi-md-box">
        <span class="meta-label">MD 文件</span>
        <span class="meta-value" id="haoqi-md-value">未生成</span>
      </div>
      <div class="meta-box" id="haoqi-mode-box">
        <span class="meta-label">保存模式</span>
        <span class="meta-value" id="haoqi-mode-value">检测中</span>
      </div>
      <div class="meta-box" id="haoqi-saved-box">
        <span class="meta-label">上次保存</span>
        <span class="meta-value" id="haoqi-saved-value">尚未保存</span>
      </div>
      <div class="toggle-row" id="haoqi-toggle-wrap" data-tone="warning">
        <input type="checkbox" id="haoqi-auto-toggle" />
        <label class="toggle-copy" for="haoqi-auto-toggle">
          <div class="toggle-title">原生 MHTML 自动保存</div>
          <div class="toggle-status" id="haoqi-auto-status">默认关闭</div>
        </label>
      </div>
      <div class="row-grid">
        <button class="btn-sync" id="haoqi-save-now">保存网页</button>
        <button class="btn-file" id="haoqi-archive-now">归档网页</button>
        <button class="btn-file" id="haoqi-show-location">保存位置</button>
      </div>
      <div class="row-grid">
        <button class="btn-danger" id="haoqi-contact-update">联系更新</button>
        <button class="btn-file" id="haoqi-manual-split">手动切分</button>
        <button class="btn-file" id="haoqi-settings">设置</button>
      </div>
      <div class="row-grid">
        <button class="btn-file" id="haoqi-rename">重命名</button>
        <button class="btn-export" id="haoqi-export-md">导出 MD</button>
        <button class="btn-export" id="haoqi-export-json">导出 JSON</button>
      </div>
      <div class="status" id="haoqi-status">准备中</div>
    </div>
  `;

  document.body.appendChild(panel);

  panelLauncher = document.createElement('button');
  panelLauncher.id = 'haoqi-gpt-panel-launcher';
  panelLauncher.type = 'button';
  panelLauncher.textContent = '恢复备份面板';
  document.body.appendChild(panelLauncher);

  panelElements = {
    convBox: panel.querySelector('#haoqi-conv-box'),
    webBox: panel.querySelector('#haoqi-web-box'),
    mdBox: panel.querySelector('#haoqi-md-box'),
    modeBox: panel.querySelector('#haoqi-mode-box'),
    savedBox: panel.querySelector('#haoqi-saved-box'),
    conv: panel.querySelector('#haoqi-conv-value'),
    web: panel.querySelector('#haoqi-web-value'),
    md: panel.querySelector('#haoqi-md-value'),
    mode: panel.querySelector('#haoqi-mode-value'),
    saved: panel.querySelector('#haoqi-saved-value'),
    status: panel.querySelector('#haoqi-status'),
    autoToggle: panel.querySelector('#haoqi-auto-toggle'),
    autoStatus: panel.querySelector('#haoqi-auto-status'),
    contactBtn: panel.querySelector('#haoqi-contact-update'),
    saveBtn: panel.querySelector('#haoqi-save-now'),
    archiveBtn: panel.querySelector('#haoqi-archive-now'),
    renameBtn: panel.querySelector('#haoqi-rename'),
    exportMdBtn: panel.querySelector('#haoqi-export-md'),
    exportJsonBtn: panel.querySelector('#haoqi-export-json'),
    splitBtn: panel.querySelector('#haoqi-manual-split')
  };

  panel.querySelector('#haoqi-panel-min').addEventListener('click', () => setPanelMode('minimized'));
  panel.querySelector('#haoqi-panel-close').addEventListener('click', () => setPanelMode('closed'));
  panelLauncher.addEventListener('click', () => setPanelMode('open'));

  panelElements.autoToggle.addEventListener('change', async (event) => {
    await chrome.runtime.sendMessage({ type: 'TOGGLE_AUTO_SAVE', enabled: !!event.target.checked });
    await refreshRemoteState();
  });

  panel.querySelector('#haoqi-save-now').addEventListener('click', () => handleRuntimeAction({ type: 'SAVE_NOW' }));
  panel.querySelector('#haoqi-archive-now').addEventListener('click', () => handleRuntimeAction({ type: 'ARCHIVE_NOW' }));
  panel.querySelector('#haoqi-show-location').addEventListener('click', () => showLocationAlert());
  panel.querySelector('#haoqi-contact-update').addEventListener('click', () => {
    window.open('https://dcnhigwbreiu.feishu.cn/wiki/VdXfwnaCViCYumkNb7oc4ZbxnKd', '_blank', 'noopener,noreferrer');
  });
  panel.querySelector('#haoqi-manual-split').addEventListener('click', async () => {
    await handleRuntimeAction({ type: 'MANUAL_SPLIT' });
    routeSessionSeed = generateId();
    lastStateSignature = '';
    refreshState('manual-split', true);
  });
  panel.querySelector('#haoqi-settings').addEventListener('click', () => {
    void chrome.runtime.sendMessage({ type: 'OPEN_SETTINGS_WINDOW' });
  });
  panel.querySelector('#haoqi-rename').addEventListener('click', async () => {
    const currentName = runtimeSnapshot?.tabState?.currentFileName || '';
    const stem = currentName.replace(/\.mhtml$/i, '').replace(/^\d{8}_\d{6}_/, '');
    const nextName = window.prompt('请输入新的基础名称（会同时重命名网页和 MD）', stem || '');
    if (nextName === null) return;
    await handleRuntimeAction({ type: 'RENAME_SESSION', baseName: nextName });
  });
  panel.querySelector('#haoqi-export-md').addEventListener('click', () => handleRuntimeAction({ type: 'EXPORT_MD' }));
  panel.querySelector('#haoqi-export-json').addEventListener('click', () => handleRuntimeAction({ type: 'EXPORT_JSON' }));

  applyPanelMode();
}

function createNotice() {
  if (noticeBadge) return;
  noticeBadge = document.createElement('div');
  noticeBadge.id = 'haoqi-gpt-notice';
  noticeBadge.className = 'blank';
  noticeBadge.innerHTML = `
    <div class="actions">
      <button class="icon-btn" id="haoqi-notice-min">-</button>
      <button class="icon-btn" id="haoqi-notice-close">x</button>
    </div>
    <div class="state" id="haoqi-notice-state">检测中…</div>
  `;
  document.body.appendChild(noticeBadge);

  noticeLauncher = document.createElement('button');
  noticeLauncher.id = 'haoqi-gpt-notice-launcher';
  noticeLauncher.type = 'button';
  noticeLauncher.textContent = '恢复提醒';
  document.body.appendChild(noticeLauncher);

  noticeStateEl = noticeBadge.querySelector('#haoqi-notice-state');
  noticeBadge.querySelector('#haoqi-notice-min').addEventListener('click', (event) => {
    event.stopPropagation();
    setNoticeMode('minimized');
  });
  noticeBadge.querySelector('#haoqi-notice-close').addEventListener('click', (event) => {
    event.stopPropagation();
    setNoticeMode('closed');
  });
  noticeLauncher.addEventListener('click', () => setNoticeMode('open'));

  installNoticeDragHandlers(noticeStateEl);
  applyNoticePosition();
}

async function handleRuntimeAction(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.ok === false) {
    updateStatus(response.error || '操作失败');
    return;
  }
  await refreshRemoteState();
}

async function refreshRemoteState() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_RUNTIME_STATE' });
    if (response?.ok) {
      runtimeSnapshot = response;
      applyRuntimeToUi();
    }
  } catch {}
}

function applyRuntimeToUi() {
  updatePanelFromRuntime();
  updateNoticeFromRuntime();
}

function updatePanelLocal(identity, messages) {
  if (!panel) return;
  panelElements.conv.textContent = identity.label;
  if (!runtimeSnapshot?.tabState?.currentFileName) {
    panelElements.web.textContent = messages.length ? '等待生成网页文件' : '未生成';
  }
  if (!runtimeSnapshot?.tabState?.currentMarkdownFileName) {
    panelElements.md.textContent = messages.length ? '等待生成 MD 文件' : '未生成';
  }
  updateStatus(messages.length ? `已检测到 ${messages.length} 条消息` : (identity.temporary ? '临时聊天已开启，等待内容' : '当前为空白对话'));
}

function updatePanelFromRuntime() {
  if (!panel || !runtimeSnapshot?.tabState) return;
  const { settings = {}, tabState = {}, folder = {} } = runtimeSnapshot;

  panelElements.conv.textContent = tabState.currentConversationLabel || '检测中';
  panelElements.web.textContent = tabState.currentFileName || '未生成';
  panelElements.md.textContent = tabState.currentMarkdownFileName || '未生成';
  panelElements.mode.textContent = tabState.modeLabel || '检测中';
  panelElements.saved.textContent = tabState.lastSavedAt ? formatDisplayDateTime(tabState.lastSavedAt) : '尚未保存';
  panelElements.status.textContent = tabState.statusText || '准备中';
  panelElements.autoToggle.checked = !!settings.autoSaveEnabled;
  panelElements.autoStatus.textContent = folder.configured
    ? (tabState.mhtmlStatus || '准备中')
    : '请先在设置中选择自定义保存目录';
  const canOperate = !!settings.enabled && !!tabState.routeEnabled && !!folder.configured && !!tabState.canSave;
  panelElements.saveBtn.disabled = !canOperate;
  panelElements.archiveBtn.disabled = !canOperate;
  panelElements.renameBtn.disabled = !canOperate;
  panelElements.exportMdBtn.disabled = !canOperate;
  panelElements.exportJsonBtn.disabled = !canOperate;
  panelElements.splitBtn.disabled = !tabState.routeEnabled;
  panelElements.contactBtn.disabled = false;

  panelElements.convBox.dataset.tone = currentIdentity?.temporary ? 'accent' : currentIdentity?.blank ? 'warning' : 'warning';
  panelElements.webBox.dataset.tone = folder.configured ? 'info' : 'warning';
  panelElements.mdBox.dataset.tone = folder.configured ? 'info' : 'warning';
  panelElements.modeBox.dataset.tone = tabState.autoPaused ? 'danger' : settings.autoSaveEnabled ? 'accent' : 'warning';
  panelElements.savedBox.dataset.tone = tabState.lastSavedAt ? 'info' : 'warning';
  panel.querySelector('#haoqi-toggle-wrap').dataset.tone = settings.autoSaveEnabled ? 'accent' : 'warning';
  panelElements.status.dataset.tone = /失败|错误/.test(tabState.statusText || '')
    ? 'danger'
    : /已更新|已保存|归档/.test(tabState.statusText || '')
      ? 'accent'
      : 'warning';
}

function updateNoticeLocal(identity) {
  if (!noticeBadge || !noticeStateEl) return;
  if (identity.temporary) {
    noticeBadge.className = 'temp';
    noticeStateEl.textContent = '当前：临时聊天，可以放心聊天！';
    return;
  }
  if (identity.blank) {
    noticeBadge.className = 'blank';
    noticeStateEl.textContent = '当前：等待聊天开始';
    return;
  }
  noticeBadge.className = 'normal';
  noticeStateEl.textContent = '当前：普通聊天，请注意隐私保护。';
}

function updateNoticeFromRuntime() {
  if (!noticeBadge || !noticeLauncher) return;
  const settings = runtimeSnapshot?.settings || {};
  const enabled = !!settings.tempNoticeEnabled;

  noticeBadge.style.display = enabled && noticeMode === 'open' ? 'block' : 'none';
  noticeLauncher.style.display = enabled && noticeMode !== 'open' ? 'flex' : 'none';
  noticeLauncher.textContent = noticeMode === 'minimized' ? '恢复提醒' : '打开提醒';

  if (!enabled || !currentIdentity) return;
  updateNoticeLocal(currentIdentity);
  applyNoticePosition();
}

async function setPanelMode(mode) {
  panelMode = normalizeMode(mode, 'open');
  applyPanelMode();
  await chrome.storage.local.set({ [PANEL_MODE_KEY]: panelMode });
}

function applyPanelMode() {
  if (!panel || !panelLauncher) return;
  panel.style.display = panelMode === 'open' ? 'block' : 'none';
  panelLauncher.style.display = panelMode === 'open' ? 'none' : 'inline-flex';
  panelLauncher.textContent = panelMode === 'minimized' ? '恢复备份面板' : '打开备份面板';
}

async function setNoticeMode(mode) {
  noticeMode = normalizeMode(mode, 'open');
  updateNoticeFromRuntime();
  await chrome.storage.local.set({ [NOTICE_MODE_KEY]: noticeMode });
}

function installNoticeDragHandlers(handleEl) {
  if (!handleEl) return;
  handleEl.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || event.target.closest('button')) return;
    const rect = noticeBadge.getBoundingClientRect();
    noticeDragState = {
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top
    };
    document.addEventListener('mousemove', handleNoticeDragMove);
    document.addEventListener('mouseup', handleNoticeDragEnd);
    event.preventDefault();
  });
}

function handleNoticeDragMove(event) {
  if (!noticeDragState) return;
  noticePositionTouched = true;
  noticePosition = {
    left: Math.max(8, event.clientX - noticeDragState.offsetX),
    top: Math.max(8, event.clientY - noticeDragState.offsetY)
  };
  applyNoticePosition();
}

function handleNoticeDragEnd() {
  if (!noticeDragState) return;
  noticeDragState = null;
  document.removeEventListener('mousemove', handleNoticeDragMove);
  document.removeEventListener('mouseup', handleNoticeDragEnd);
  if (runtimeSnapshot?.settings?.rememberNoticePosition) {
    void chrome.storage.local.set({ [NOTICE_POS_KEY]: noticePosition });
  }
}

function applyNoticePosition() {
  const remember = !!runtimeSnapshot?.settings?.rememberNoticePosition;
  const applied = remember || noticePositionTouched ? noticePosition : null;
  for (const el of [noticeBadge, noticeLauncher]) {
    if (!el) continue;
    if (!applied || !Number.isFinite(applied.left) || !Number.isFinite(applied.top)) {
      el.style.left = '50%';
      el.style.top = '8px';
      el.style.transform = 'translateX(-50%)';
    } else {
      el.style.left = `${applied.left}px`;
      el.style.top = `${applied.top}px`;
      el.style.transform = 'none';
    }
  }
}

function ensurePollTimer() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    refreshState('poll');
  }, POLL_MS);
}

function showLocationAlert() {
  const folder = runtimeSnapshot?.folder;
  const tabState = runtimeSnapshot?.tabState;
  if (!folder?.configured) {
    window.alert('还没有设置自定义保存目录，请先点“设置”选择目录。');
    return;
  }
  window.alert([
    `当前目录：${folder.name}`,
    `${folder.currentWebDir}/${tabState?.currentFileName || '未生成'}`,
    `${folder.currentMarkdownDir}/${tabState?.currentMarkdownFileName || '未生成'}`,
    `${folder.historyWebDir}/`,
    `${folder.historyMarkdownDir}/`,
    `${folder.exportsDir}/`
  ].join('\n'));
}

function updateStatus(text) {
  if (panelElements.status) {
    panelElements.status.textContent = text || '准备中';
  }
}

function getMessageNodes() {
  return [...document.querySelectorAll('[data-message-author-role]')];
}

function extractMessages() {
  return getMessageNodes()
    .map((node, index) => {
      const role = node.getAttribute('data-message-author-role') || 'unknown';
      const text = normalizeText(node.textContent || '');
      if (!text) return null;
      return { index, role, text };
    })
    .filter(Boolean);
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/\u200b/g, '')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function getFirstUserText(messages) {
  const firstUser = (messages || []).find((message) => message.role === 'user' && normalizeText(message.text));
  return firstUser ? normalizeText(firstUser.text) : '';
}

function buildConversationIdentity(messages) {
  const chatId = getUrlChatId();
  const temporary = detectTemporaryChatMode();
  const hasMessages = messages.length > 0;

  if (chatId) {
    return {
      key: `chat_${chatId}_${routeSessionSeed}`,
      stable: true,
      label: temporary ? '临时聊天' : '进行中对话',
      chatId,
      blank: !hasMessages,
      temporary,
      segmentId: routeSessionSeed
    };
  }

  if (!hasMessages) {
    return {
      key: `blank_${routeSessionSeed}`,
      stable: false,
      label: temporary ? '临时聊天' : '空白对话',
      chatId: '',
      blank: true,
      temporary,
      segmentId: routeSessionSeed
    };
  }

  return {
    key: `draft_${routeSessionSeed}`,
    stable: false,
    label: temporary ? '临时聊天' : '进行中对话',
    chatId: '',
    blank: false,
    temporary,
    segmentId: routeSessionSeed
  };
}

function handleComposerInput(target) {
  if (!runtimeSnapshot?.settings?.privacyWarningEnabled) return;
  if (!isChatRoute() || currentIdentity?.temporary) {
    resetPrivacyWarningFlags(true);
    return;
  }
  if (!isComposerElement(target)) return;

  const text = getComposerText(target);
  if (!text) {
    resetPrivacyWarningFlags(false);
    return;
  }
  if (!typedWarningShown) {
    typedWarningShown = true;
    showPrivacyToast('注意您已在非临时聊天框输入了内容，会有留痕，请注意隐私保护。', 'warning');
  }
}

function handleComposerSubmit(target) {
  if (!runtimeSnapshot?.settings?.privacyWarningEnabled) return;
  if (!isChatRoute() || currentIdentity?.temporary) return;
  if (!isComposerElement(target)) return;
  const text = getComposerText(target);
  if (!text || submittedWarningShown) return;
  submittedWarningShown = true;
  showPrivacyToast('请注意删除聊天记录。', 'danger');
}

function resetPrivacyWarningFlags(forceReset = false) {
  if (forceReset) {
    typedWarningShown = false;
    submittedWarningShown = false;
    return;
  }
  const composer = getActiveComposer();
  if (!composer || !getComposerText(composer)) {
    typedWarningShown = false;
    submittedWarningShown = false;
  }
}

function getActiveComposer() {
  return document.querySelector('textarea, [contenteditable="true"]');
}

function isComposerElement(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.matches('textarea')) return true;
  if (target.getAttribute('contenteditable') === 'true') return true;
  return !!target.closest('textarea, [contenteditable="true"]');
}

function getComposerText(target) {
  const el = target instanceof HTMLElement ? target.closest('textarea, [contenteditable="true"]') || target : null;
  if (!el) return '';
  if ('value' in el && typeof el.value === 'string') return normalizeText(el.value);
  return normalizeText(el.textContent || '');
}

function showPrivacyToast(message, tone = 'warning') {
  let wrap = document.getElementById('haoqi-gpt-privacy-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'haoqi-gpt-privacy-wrap';
    document.body.appendChild(wrap);
  }

  const toast = document.createElement('div');
  toast.className = `haoqi-gpt-privacy-toast ${tone}`;
  toast.textContent = message;
  wrap.appendChild(toast);

  setTimeout(() => {
    toast.remove();
    if (!wrap.childElementCount) {
      wrap.remove();
    }
  }, 4200);
}

function detectTemporaryChatMode() {
  const url = String(location.href || '').toLowerCase();
  const title = String(document.title || '').toLowerCase();
  if (/temporary-chat=true/.test(url)) return true;
  if (/temporary chat|临时聊天/.test(title)) return true;

  const nodes = [...document.querySelectorAll('button,[role="button"],a')];
  for (const node of nodes) {
    const text = normalizeText(
      node.innerText ||
      node.getAttribute('aria-label') ||
      node.getAttribute('title') ||
      ''
    );
    if (!/(temporary chat|临时聊天|临时对话|temporary)/i.test(text)) continue;
    const ariaPressed = node.getAttribute('aria-pressed');
    const ariaChecked = node.getAttribute('aria-checked');
    const dataState = node.getAttribute('data-state');
    const classes = String(node.className || '').toLowerCase();
    if (ariaPressed === 'true' || ariaChecked === 'true') return true;
    if (dataState === 'checked' || dataState === 'on' || dataState === 'active') return true;
    if (/\bactive\b|\bselected\b|\bcurrent\b/.test(classes)) return true;
  }
  return false;
}

function getChatRouteParts(url = location.href) {
  try {
    const target = new URL(url, location.origin);
    const parts = target.pathname
      .split('/')
      .map((part) => decodeURIComponent(part || '').trim())
      .filter(Boolean);
    if (parts.length && isLikelyLocaleSegment(parts[0])) {
      return parts.slice(1);
    }
    return parts;
  } catch {
    return [];
  }
}

function isLikelyLocaleSegment(segment) {
  return /^[a-z]{2}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(segment || '');
}

function isChatRoute(url = location.href) {
  try {
    const target = new URL(url, location.origin);
    if (!['chatgpt.com', 'chat.openai.com'].includes(target.hostname)) return false;
    const parts = getChatRouteParts(url);
    if (!parts.length) return true;
    if (parts[0] === 'c' && parts[1]) return true;
    if (parts[0] === 'g' && /^g-/.test(parts[1] || '')) return true;
    return false;
  } catch {
    return false;
  }
}

function getUrlChatId(url = location.href) {
  const parts = getChatRouteParts(url);
  return parts[0] === 'c' && parts[1] ? parts[1] : '';
}

function formatDisplayDateTime(isoString) {
  const date = isoString ? new Date(isoString) : new Date();
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate())
  ].join('-') + ' ' + [
    pad2(date.getHours()),
    pad2(date.getMinutes()),
    pad2(date.getSeconds())
  ].join(':');
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function generateId() {
  return `seg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
