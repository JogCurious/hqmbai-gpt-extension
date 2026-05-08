'use strict';

const DB_NAME = 'haoqi-chatgpt-backup-db';
const DB_VERSION = 1;
const HANDLE_STORE = 'handles';
const DIRECTORY_HANDLE_KEY = 'save-directory-handle';

const globalToggleEl = document.getElementById('global-enabled');
const autoToggleEl = document.getElementById('auto-enabled');
const noticeToggleEl = document.getElementById('notice-enabled');
const privacyToggleEl = document.getElementById('privacy-enabled');
const rememberPositionToggleEl = document.getElementById('remember-position-enabled');
const currentConversationEl = document.getElementById('current-conversation');
const currentFileEl = document.getElementById('current-file');
const currentMdFileEl = document.getElementById('current-md-file');
const currentModeEl = document.getElementById('current-mode');
const currentStatusEl = document.getElementById('current-status');
const folderNameEl = document.getElementById('folder-name');
const folderPathsEl = document.getElementById('folder-paths');
const logsEl = document.getElementById('logs');

const pickFolderEl = document.getElementById('pick-folder');
const saveNowEl = document.getElementById('save-now');
const archiveNowEl = document.getElementById('archive-now');
const pauseTabEl = document.getElementById('pause-tab');
const manualSplitEl = document.getElementById('manual-split');
const renameSessionEl = document.getElementById('rename-session');
const exportMdEl = document.getElementById('export-md');
const exportJsonEl = document.getElementById('export-json');
const copyLocationEl = document.getElementById('copy-location');

let activeTabId = null;
let pollTimer = null;
let runtimeState = null;

init().catch(console.error);

async function init() {
  bindEvents();
  await refreshState(true);
  pollTimer = setInterval(() => {
    void refreshState(false);
  }, 1500);
  window.addEventListener('unload', () => clearInterval(pollTimer));
}

function bindEvents() {
  pickFolderEl.addEventListener('click', async () => {
    try {
      if (typeof window.showDirectoryPicker !== 'function') {
        throw new Error('当前浏览器不支持目录选择器');
      }
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      const permission = await handle.requestPermission({ mode: 'readwrite' });
      if (permission !== 'granted') {
        throw new Error('目录读写权限未授予');
      }
      await setDbValue(DIRECTORY_HANDLE_KEY, handle);
      await chrome.runtime.sendMessage({
        type: 'SET_DIRECTORY_META',
        name: handle.name || '未命名目录'
      });
      await refreshState(true);
    } catch (error) {
      if (error?.name === 'AbortError') return;
      currentStatusEl.textContent = `选择目录失败：${error?.message || '未知错误'}`;
    }
  });

  globalToggleEl.addEventListener('change', () => toggleSetting('TOGGLE_GLOBAL', globalToggleEl.checked));
  autoToggleEl.addEventListener('change', () => toggleSetting('TOGGLE_AUTO_SAVE', autoToggleEl.checked));
  noticeToggleEl.addEventListener('change', () => toggleSetting('TOGGLE_TEMP_NOTICE', noticeToggleEl.checked));
  privacyToggleEl.addEventListener('change', () => toggleSetting('TOGGLE_PRIVACY_WARNING', privacyToggleEl.checked));
  rememberPositionToggleEl.addEventListener('change', () => toggleSetting('TOGGLE_REMEMBER_NOTICE_POSITION', rememberPositionToggleEl.checked));

  saveNowEl.addEventListener('click', () => simpleAction({ type: 'SAVE_NOW', tabId: activeTabId }));
  archiveNowEl.addEventListener('click', () => simpleAction({ type: 'ARCHIVE_NOW', tabId: activeTabId }));
  pauseTabEl.addEventListener('click', () => simpleAction({ type: 'TOGGLE_PAUSE_TAB', tabId: activeTabId }));
  manualSplitEl.addEventListener('click', () => simpleAction({ type: 'MANUAL_SPLIT', tabId: activeTabId }));
  exportMdEl.addEventListener('click', () => simpleAction({ type: 'EXPORT_MD', tabId: activeTabId }));
  exportJsonEl.addEventListener('click', () => simpleAction({ type: 'EXPORT_JSON', tabId: activeTabId }));

  renameSessionEl.addEventListener('click', async () => {
    const currentName = currentFileEl.textContent || '';
    const stem = currentName.replace(/\.mhtml$/i, '').replace(/^\d{8}_\d{6}_/, '');
    const nextName = window.prompt('请输入新的基础名称（会同时重命名网页和 MD）', stem);
    if (nextName === null) return;
    await simpleAction({
      type: 'RENAME_SESSION',
      baseName: nextName,
      tabId: activeTabId
    });
  });

  copyLocationEl.addEventListener('click', async () => {
    if (!runtimeState?.folder) return;
    const text = buildLocationText(runtimeState.folder);
    try {
      await navigator.clipboard.writeText(text);
      currentStatusEl.textContent = '已复制保存位置说明';
    } catch {
      currentStatusEl.textContent = text;
    }
  });
}

async function toggleSetting(type, enabled) {
  await simpleAction({ type, enabled, tabId: activeTabId });
}

async function simpleAction(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.ok === false) {
    currentStatusEl.textContent = response.error || '操作失败';
    return;
  }
  await refreshState(true);
}

async function refreshState(requestFresh) {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });
  activeTabId = activeTab?.id ?? null;

  let response = await chrome.runtime.sendMessage({
    type: 'GET_RUNTIME_STATE',
    tabId: activeTabId
  });

  if (requestFresh && activeTabId) {
    response = await chrome.runtime.sendMessage({
      type: 'REQUEST_PAGE_STATE',
      tabId: activeTabId
    });
  }

  if (!response?.ok) return;
  runtimeState = response;
  render(response);
}

function render(response) {
  const settings = response.settings || {};
  const tabState = response.tabState || {};
  const folder = response.folder || {};
  const routeEnabled = !!tabState.routeEnabled;
  const canOperate = routeEnabled && !!settings.enabled;

  globalToggleEl.checked = !!settings.enabled;
  autoToggleEl.checked = !!settings.autoSaveEnabled;
  noticeToggleEl.checked = !!settings.tempNoticeEnabled;
  privacyToggleEl.checked = !!settings.privacyWarningEnabled;
  rememberPositionToggleEl.checked = !!settings.rememberNoticePosition;

  folderNameEl.textContent = folder.configured ? folder.name : '尚未选择';
  folderPathsEl.innerHTML = [
    folder.currentWebDir,
    folder.historyWebDir,
    folder.currentMarkdownDir,
    folder.historyMarkdownDir,
    folder.exportsDir
  ].map((dir) => `<div>${escapeHtml(dir || '-')} /</div>`).join('');

  currentConversationEl.textContent = tabState.currentConversationLabel || '当前页面不是聊天界面';
  currentFileEl.textContent = tabState.currentFileName || '未生成';
  currentMdFileEl.textContent = tabState.currentMarkdownFileName || '未生成';
  currentModeEl.textContent = tabState.modeLabel || '检测中';
  currentStatusEl.textContent = tabState.statusText || '准备中';
  pauseTabEl.textContent = tabState.autoPaused ? '恢复自动' : '暂停自动';

  autoToggleEl.disabled = !settings.enabled;
  noticeToggleEl.disabled = !settings.enabled;
  privacyToggleEl.disabled = !settings.enabled;
  rememberPositionToggleEl.disabled = !settings.enabled;
  saveNowEl.disabled = !canOperate || !tabState.canSave || !folder.configured;
  archiveNowEl.disabled = !canOperate || !tabState.canSave || !folder.configured;
  pauseTabEl.disabled = !routeEnabled;
  manualSplitEl.disabled = !routeEnabled;
  renameSessionEl.disabled = !canOperate || !tabState.canSave || !folder.configured;
  exportMdEl.disabled = !canOperate || !tabState.canSave || !folder.configured;
  exportJsonEl.disabled = !canOperate || !tabState.canSave || !folder.configured;
  copyLocationEl.disabled = !folder.configured;

  renderLogs(response.logs || []);
}

function renderLogs(logs) {
  if (!Array.isArray(logs) || !logs.length) {
    logsEl.textContent = '暂时还没有日志。';
    return;
  }

  logsEl.innerHTML = logs.map((log) => `
    <div class="log-item">
      <span class="log-time">${formatDisplayDateTime(log.at)}</span>
      <div>${escapeHtml(log.message || '')}</div>
    </div>
  `).join('');
}

function buildLocationText(folder) {
  return [
    `当前目录：${folder.name || '未设置'}`,
    `${folder.currentWebDir}/`,
    `${folder.historyWebDir}/`,
    `${folder.currentMarkdownDir}/`,
    `${folder.historyMarkdownDir}/`,
    `${folder.exportsDir}/`
  ].join('\n');
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

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE)) {
        db.createObjectStore(HANDLE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('打开本地数据库失败'));
  });
}

async function setDbValue(key, value) {
  const db = await openDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, 'readwrite');
    const store = tx.objectStore(HANDLE_STORE);
    const request = store.put(value, key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error || new Error('保存目录句柄失败'));
  });
}
