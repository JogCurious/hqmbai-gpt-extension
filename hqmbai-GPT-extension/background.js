'use strict';

const APP_NAME = '好奇漫步GPT网页实时备份器';
const DISPLAY_VERSION = 'v2.6';
const SETTINGS_KEY = 'appSettings';
const LOGS_KEY = 'recentLogs';
const FOLDER_META_KEY = 'folderMeta';
const NOTICE_POS_KEY = 'tempNoticePosition';
const MAX_LOGS = 30;
const SAVE_DEBOUNCE_MS = 10000;

const DB_NAME = 'haoqi-chatgpt-backup-db';
const DB_VERSION = 1;
const HANDLE_STORE = 'handles';
const DIRECTORY_HANDLE_KEY = 'save-directory-handle';

const DIR_CURRENT_WEB = '当前网页';
const DIR_HISTORY_WEB = '历史网页';
const DIR_CURRENT_MD = '当前Markdown';
const DIR_HISTORY_MD = '历史Markdown';
const DIR_EXPORTS = '导出';

const DEFAULT_SETTINGS = {
  enabled: true,
  autoSaveEnabled: false,
  tempNoticeEnabled: true,
  privacyWarningEnabled: true,
  rememberNoticePosition: true
};

const tabStates = new Map();
const saveTimers = new Map();
const tabQueues = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  const current = await loadSettings();
  const folderMeta = await loadFolderMeta();
  await chrome.storage.local.set({
    [SETTINGS_KEY]: { ...DEFAULT_SETTINGS, ...current },
    [FOLDER_META_KEY]: folderMeta || null
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearScheduledSave(tabId);
  tabStates.delete(tabId);
  tabQueues.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  clearScheduledSave(tabId);
  const state = getTabState(tabId);
  state.currentSession = null;
  state.statusText = '页面加载中';
  void broadcastTabState(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch(async (error) => {
      const text = error?.message || '未知错误';
      console.error(error);
      await appendLog({ level: 'error', message: text });
      sendResponse({ ok: false, error: text });
    });
  return true;
});

async function handleMessage(message, sender) {
  const type = String(message?.type || '');
  const tabId = sender.tab?.id ?? message?.tabId ?? null;

  switch (type) {
    case 'PAGE_STATE':
      return await handlePageState(tabId, message.payload || {});
    case 'REQUEST_PAGE_STATE':
      return await requestFreshPageState(tabId);
    case 'ROUTE_WILL_CHANGE':
      return await handleRouteWillChange(tabId, message.payload || {});
    case 'LIFECYCLE_EVENT':
      return await handleLifecycleEvent(tabId, message.payload || {});
    case 'TOGGLE_GLOBAL':
      return await updateSettings({ enabled: !!message.enabled }, tabId);
    case 'TOGGLE_AUTO_SAVE':
      return await updateSettings({ autoSaveEnabled: !!message.enabled }, tabId);
    case 'TOGGLE_TEMP_NOTICE':
      return await updateSettings({ tempNoticeEnabled: !!message.enabled }, tabId);
    case 'TOGGLE_PRIVACY_WARNING':
      return await updateSettings({ privacyWarningEnabled: !!message.enabled }, tabId);
    case 'TOGGLE_REMEMBER_NOTICE_POSITION':
      return await updateSettings({ rememberNoticePosition: !!message.enabled }, tabId);
    case 'TOGGLE_PAUSE_TAB':
      return await togglePauseForTab(tabId);
    case 'SAVE_NOW':
      return await queueImmediateCapture(tabId, { archive: false, reason: 'manual-save' });
    case 'ARCHIVE_NOW':
      return await queueImmediateCapture(tabId, { archive: true, reason: 'manual-archive' });
    case 'EXPORT_MD':
      return await exportSessionFile(tabId, 'md');
    case 'EXPORT_JSON':
      return await exportSessionFile(tabId, 'json');
    case 'RENAME_SESSION':
      return await renameSessionFiles(tabId, message.baseName);
    case 'MANUAL_SPLIT':
      return await manualSplitConversation(tabId);
    case 'GET_RUNTIME_STATE':
      return await getRuntimeState(message.tabId ?? tabId);
    case 'SET_DIRECTORY_META':
      return await setDirectoryMeta(message.name);
    case 'OPEN_SETTINGS_WINDOW':
      return await openSettingsWindow();
    default:
      return {};
  }
}

async function handlePageState(tabId, payload) {
  if (!Number.isInteger(tabId)) return {};

  const state = getTabState(tabId);
  const settings = await loadSettings();
  state.routeEnabled = !!payload.routeEnabled;
  state.pageTitle = String(payload.title || '');
  state.lastPageUrl = String(payload.url || '');

  if (!state.routeEnabled) {
    clearScheduledSave(tabId);
    state.currentSession = null;
    state.statusText = '当前页面不是聊天界面';
    await broadcastTabState(tabId);
    return await getRuntimeState(tabId);
  }

  const session = normalizeSessionPayload(payload.session);
  const previousKey = state.currentSession?.key || '';
  state.currentSession = session;

  if (session?.key) {
    const meta = ensureSessionMeta(state, session);
    state.currentFileName = buildCurrentMhtmlName(meta);
    state.currentFilePath = buildCurrentMhtmlPath(meta);
  } else {
    state.currentFileName = '';
    state.currentFilePath = '';
  }

  if (!session) {
    state.statusText = '等待识别聊天内容';
  } else if (session.blank) {
    state.statusText = session.temporary ? '当前为临时聊天，等待输入内容' : '当前为空白对话';
  } else if (session.canSave) {
    state.statusText = '已检测到聊天内容';
  } else {
    state.statusText = '等待聊天内容稳定';
  }

  if (previousKey && session?.key && previousKey !== session.key) {
    state.statusText = '已切换到新的聊天段';
  }

  if (shouldAutoSave(settings, state, session)) {
    scheduleAutoSave(tabId, 'content-change');
  } else {
    clearScheduledSave(tabId);
  }

  await broadcastTabState(tabId);
  return await getRuntimeState(tabId);
}

async function requestFreshPageState(tabId) {
  if (!Number.isInteger(tabId)) return {};
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'REQUEST_PAGE_STATE' });
  } catch {}
  return await getRuntimeState(tabId);
}

async function handleRouteWillChange(tabId, payload) {
  if (!Number.isInteger(tabId)) return {};
  const settings = await loadSettings();
  const session = normalizeSessionPayload(payload.session);
  if (!settings.enabled || !session?.canSave) {
    return await getRuntimeState(tabId);
  }

  const state = getTabState(tabId);
  clearScheduledSave(tabId);
  state.statusText = '切换聊天前，正在归档当前网页';
  await broadcastTabState(tabId);

  await queueTabJob(tabId, async () => {
    await captureAndPersist(tabId, {
      sessionOverride: session,
      archive: true,
      reason: 'route-change'
    });
  });

  return await getRuntimeState(tabId);
}

async function handleLifecycleEvent(tabId, payload) {
  if (!Number.isInteger(tabId)) return {};
  const state = getTabState(tabId);
  const settings = await loadSettings();
  if (!shouldAutoSave(settings, state, state.currentSession)) {
    return await getRuntimeState(tabId);
  }

  const kind = String(payload.kind || '');
  if (kind === 'hidden' || kind === 'beforeunload') {
    clearScheduledSave(tabId);
    await queueTabJob(tabId, async () => {
      await captureAndPersist(tabId, { archive: false, reason: `lifecycle-${kind}` });
    });
  }

  if (kind === 'pagehide') {
    clearScheduledSave(tabId);
    await queueTabJob(tabId, async () => {
      await captureAndPersist(tabId, { archive: true, reason: 'pagehide' });
    });
  }

  return await getRuntimeState(tabId);
}

async function updateSettings(patch, tabId) {
  const settings = await loadSettings();
  const next = { ...settings, ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });

  if (patch.rememberNoticePosition === false) {
    await chrome.storage.local.remove(NOTICE_POS_KEY);
  }

  if (Number.isInteger(tabId)) {
    const state = getTabState(tabId);
    if (!next.enabled) {
      state.statusText = '扩展总开关已关闭';
    } else if (next.autoSaveEnabled) {
      state.statusText = state.autoPaused ? '自动保存已暂停' : '原生 MHTML 自动保存已开启';
    } else {
      state.statusText = '当前为手动保存模式';
    }

    if (!shouldAutoSave(next, state, state.currentSession)) {
      clearScheduledSave(tabId);
    } else if (state.currentSession?.canSave) {
      scheduleAutoSave(tabId, 'settings-change');
    }
  }

  await broadcastAllStates();
  return await getRuntimeState(tabId);
}

async function togglePauseForTab(tabId) {
  if (!Number.isInteger(tabId)) return {};
  const state = getTabState(tabId);
  const settings = await loadSettings();
  state.autoPaused = !state.autoPaused;
  state.statusText = state.autoPaused ? '当前标签页自动保存已暂停' : '当前标签页自动保存已恢复';

  if (!shouldAutoSave(settings, state, state.currentSession)) {
    clearScheduledSave(tabId);
  } else if (state.currentSession?.canSave) {
    scheduleAutoSave(tabId, 'resume');
  }

  await appendLog({ level: 'info', message: state.statusText });
  await broadcastTabState(tabId);
  return await getRuntimeState(tabId);
}

async function queueImmediateCapture(tabId, options) {
  if (!Number.isInteger(tabId)) return {};
  const state = getTabState(tabId);
  clearScheduledSave(tabId);

  if (!state.routeEnabled) {
    state.statusText = '当前页面不是聊天界面';
    await broadcastTabState(tabId);
    return await getRuntimeState(tabId);
  }

  await queueTabJob(tabId, async () => {
    await captureAndPersist(tabId, options);
  });

  return await getRuntimeState(tabId);
}

function scheduleAutoSave(tabId, reason) {
  clearScheduledSave(tabId);
  const state = getTabState(tabId);
  state.statusText = `内容已变化，将在 ${Math.round(SAVE_DEBOUNCE_MS / 1000)} 秒后保存`;
  void broadcastTabState(tabId);

  const timer = setTimeout(() => {
    saveTimers.delete(tabId);
    void queueTabJob(tabId, async () => {
      await captureAndPersist(tabId, { archive: false, reason });
    });
  }, SAVE_DEBOUNCE_MS);

  saveTimers.set(tabId, timer);
}

function clearScheduledSave(tabId) {
  const timer = saveTimers.get(tabId);
  if (!timer) return;
  clearTimeout(timer);
  saveTimers.delete(tabId);
}

function queueTabJob(tabId, task) {
  const previous = tabQueues.get(tabId) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(task)
    .catch((error) => console.error(error));

  tabQueues.set(tabId, next.finally(() => {
    if (tabQueues.get(tabId) === next) {
      tabQueues.delete(tabId);
    }
  }));
  return next;
}

async function captureAndPersist(tabId, options = {}) {
  const settings = await loadSettings();
  const state = getTabState(tabId);
  if (!settings.enabled) {
    state.statusText = '扩展总开关已关闭';
    await broadcastTabState(tabId);
    return;
  }

  const session = normalizeSessionPayload(options.sessionOverride || state.currentSession);
  if (!session?.canSave) {
    state.statusText = '当前聊天暂无可保存内容';
    await broadcastTabState(tabId);
    return;
  }

  const rootHandle = await getUsableRootHandle();
  const meta = ensureSessionMeta(state, session);
  const now = Date.now();
  const shouldArchive = !!options.archive || !meta.initialArchived;
  const currentMhtmlPath = buildCurrentMhtmlPath(meta);
  const currentMarkdownPath = buildCurrentMarkdownPath(meta);

  state.currentSession = session;
  state.currentFileName = buildCurrentMhtmlName(meta);
  state.currentFilePath = currentMhtmlPath;
  state.statusText = shouldArchive ? '正在保存并归档网页…' : '正在保存网页…';
  await broadcastTabState(tabId);

  try {
    const mhtmlBlob = await saveTabAsMhtml(tabId);
    const markdown = buildMarkdownContent(session);

    await writeBlobFile(rootHandle, currentMhtmlPath, mhtmlBlob);
    await writeTextFile(rootHandle, currentMarkdownPath, markdown);

    if (shouldArchive) {
      await writeBlobFile(rootHandle, buildHistoryMhtmlPath(meta, now), mhtmlBlob);
      await writeTextFile(rootHandle, buildHistoryMarkdownPath(meta, now), markdown);
      meta.initialArchived = true;
      meta.lastArchivedAtMs = now;
      state.lastArchivedAt = new Date(now).toISOString();
    }

    meta.lastSavedAtMs = now;
    state.lastSavedAt = new Date(now).toISOString();
    state.statusText = shouldArchive
      ? `已保存并归档：${buildCurrentMhtmlName(meta)}`
      : `已更新：${buildCurrentMhtmlName(meta)}`;
    await appendLog({ level: 'info', message: state.statusText });
  } catch (error) {
    state.statusText = `保存失败：${error?.message || '未知错误'}`;
    await appendLog({ level: 'error', message: state.statusText });
  }

  await broadcastTabState(tabId);
}

async function exportSessionFile(tabId, kind) {
  if (!Number.isInteger(tabId)) return {};
  const state = getTabState(tabId);
  const session = state.currentSession;
  if (!session?.canSave) {
    state.statusText = '当前没有可导出的聊天内容';
    await broadcastTabState(tabId);
    return await getRuntimeState(tabId);
  }

  const rootHandle = await getUsableRootHandle();
  const meta = ensureSessionMeta(state, session);
  const nowStamp = formatTimeForFileName(Date.now());
  const exportStem = `${meta.timestamp}_${meta.baseStem}_${nowStamp}`;

  if (kind === 'md') {
    await writeTextFile(rootHandle, `${DIR_EXPORTS}/${exportStem}.md`, buildMarkdownContent(session));
    state.statusText = `已导出 MD：${exportStem}.md`;
  } else {
    await writeTextFile(rootHandle, `${DIR_EXPORTS}/${exportStem}.json`, JSON.stringify(session, null, 2));
    state.statusText = `已导出 JSON：${exportStem}.json`;
  }

  await appendLog({ level: 'info', message: state.statusText });
  await broadcastTabState(tabId);
  return await getRuntimeState(tabId);
}

async function renameSessionFiles(tabId, rawBaseName) {
  if (!Number.isInteger(tabId)) return {};
  const state = getTabState(tabId);
  const session = state.currentSession;
  if (!session?.canSave) {
    state.statusText = '当前没有可重命名的文件';
    await broadcastTabState(tabId);
    return await getRuntimeState(tabId);
  }

  const rootHandle = await getUsableRootHandle();
  const meta = ensureSessionMeta(state, session);
  const nextBaseStem = sanitizeFileName(String(rawBaseName || '').trim());
  if (!nextBaseStem) {
    state.statusText = '重命名不能为空';
    await broadcastTabState(tabId);
    return await getRuntimeState(tabId);
  }

  const oldMhtmlPath = buildCurrentMhtmlPath(meta);
  const oldMarkdownPath = buildCurrentMarkdownPath(meta);
  meta.baseStem = nextBaseStem;
  state.currentFileName = buildCurrentMhtmlName(meta);
  state.currentFilePath = buildCurrentMhtmlPath(meta);

  if (oldMhtmlPath !== buildCurrentMhtmlPath(meta)) {
    await deleteRelativeFile(rootHandle, oldMhtmlPath);
  }
  if (oldMarkdownPath !== buildCurrentMarkdownPath(meta)) {
    await deleteRelativeFile(rootHandle, oldMarkdownPath);
  }

  await captureAndPersist(tabId, { archive: false, reason: 'rename' });
  state.statusText = `已重命名当前网页与 MD：${meta.baseStem}`;
  await appendLog({ level: 'info', message: state.statusText });
  await broadcastTabState(tabId);
  return await getRuntimeState(tabId);
}

async function manualSplitConversation(tabId) {
  if (!Number.isInteger(tabId)) return {};
  const state = getTabState(tabId);
  if (state.currentSession?.canSave) {
    await queueTabJob(tabId, async () => {
      await captureAndPersist(tabId, { archive: true, reason: 'manual-split' });
    });
  }
  state.statusText = '已手动切分，等待新的聊天段';
  await appendLog({ level: 'info', message: state.statusText });
  await broadcastTabState(tabId);
  return await getRuntimeState(tabId);
}

async function setDirectoryMeta(name) {
  const handle = await getDbValue(DIRECTORY_HANDLE_KEY);
  if (!handle || typeof handle.queryPermission !== 'function') {
    throw new Error('目录句柄未成功写入本地存储，请重新选择目录');
  }
  const folderMeta = {
    name: String(name || handle.name || '未命名目录'),
    selectedAt: new Date().toISOString()
  };
  await chrome.storage.local.set({ [FOLDER_META_KEY]: folderMeta });
  await appendLog({ level: 'info', message: `已绑定保存目录：${folderMeta.name}` });
  await broadcastAllStates();
  return await getRuntimeState(null);
}

async function openSettingsWindow() {
  await chrome.windows.create({
    url: chrome.runtime.getURL('popup.html'),
    type: 'popup',
    width: 460,
    height: 760
  });
  return {};
}

function getTabState(tabId) {
  if (!tabStates.has(tabId)) {
    tabStates.set(tabId, {
      tabId,
      routeEnabled: false,
      autoPaused: false,
      pageTitle: '',
      lastPageUrl: '',
      currentSession: null,
      currentFileName: '',
      currentFilePath: '',
      lastSavedAt: '',
      lastArchivedAt: '',
      statusText: '等待聊天页面',
      sessions: {}
    });
  }
  return tabStates.get(tabId);
}

function normalizeSessionPayload(session) {
  if (!session || !session.key) return null;
  return {
    key: String(session.key),
    label: String(session.label || '进行中对话'),
    chatId: String(session.chatId || ''),
    titleHint: String(session.titleHint || ''),
    firstUserText: String(session.firstUserText || ''),
    canSave: !!session.canSave,
    blank: !!session.blank,
    temporary: !!session.temporary,
    segmentId: String(session.segmentId || ''),
    messages: Array.isArray(session.messages)
      ? session.messages.map((message, index) => ({
          index,
          role: String(message.role || 'unknown'),
          text: String(message.text || '')
        }))
      : [],
    updatedAt: String(session.updatedAt || new Date().toISOString())
  };
}

function ensureSessionMeta(tabState, session) {
  if (!tabState.sessions[session.key]) {
    tabState.sessions[session.key] = {
      key: session.key,
      timestamp: formatTimeForFileName(Date.now()),
      baseStem: deriveBaseStem(session),
      initialArchived: false,
      lastSavedAtMs: 0,
      lastArchivedAtMs: 0
    };
  }
  return tabState.sessions[session.key];
}

function deriveBaseStem(session) {
  const source = session.firstUserText || session.titleHint || session.label || 'chatgpt_chat';
  const safe = sanitizeFileName(source).slice(0, 60);
  return safe || 'chatgpt_chat';
}

function sanitizeFileName(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^\.+|\.+$/g, '')
    .trim()
    .slice(0, 100);
}

function buildCurrentStem(meta) {
  return `${meta.timestamp}_${meta.baseStem}`;
}

function buildCurrentMhtmlName(meta) {
  return `${buildCurrentStem(meta)}.mhtml`;
}

function buildCurrentMarkdownName(meta) {
  return `${buildCurrentStem(meta)}.md`;
}

function buildCurrentMhtmlPath(meta) {
  return `${DIR_CURRENT_WEB}/${buildCurrentMhtmlName(meta)}`;
}

function buildCurrentMarkdownPath(meta) {
  return `${DIR_CURRENT_MD}/${buildCurrentMarkdownName(meta)}`;
}

function buildHistoryMhtmlPath(meta, archivedAtMs) {
  return `${DIR_HISTORY_WEB}/${buildCurrentStem(meta)}__${formatTimeForFileName(archivedAtMs)}.mhtml`;
}

function buildHistoryMarkdownPath(meta, archivedAtMs) {
  return `${DIR_HISTORY_MD}/${buildCurrentStem(meta)}__${formatTimeForFileName(archivedAtMs)}.md`;
}

function shouldAutoSave(settings, tabState, session) {
  return !!(
    settings?.enabled &&
    settings?.autoSaveEnabled &&
    !tabState?.autoPaused &&
    session?.canSave
  );
}

function saveTabAsMhtml(tabId) {
  return new Promise((resolve, reject) => {
    chrome.pageCapture.saveAsMHTML({ tabId }, (blob) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message || '原生 MHTML 捕获失败'));
        return;
      }
      if (!blob) {
        reject(new Error('未获得 MHTML 数据'));
        return;
      }
      resolve(blob);
    });
  });
}

async function getUsableRootHandle() {
  const handle = await getDbValue(DIRECTORY_HANDLE_KEY);
  if (!handle) {
    throw new Error('请先在设置中选择自定义保存目录');
  }
  const permission = await handle.queryPermission({ mode: 'readwrite' });
  if (permission !== 'granted') {
    throw new Error('目录授权已失效，请重新选择保存目录');
  }
  return handle;
}

async function writeBlobFile(rootHandle, relativePath, blob) {
  const { dirHandle, fileName } = await resolveParentDirectory(rootHandle, relativePath, true);
  const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

async function writeTextFile(rootHandle, relativePath, text) {
  const { dirHandle, fileName } = await resolveParentDirectory(rootHandle, relativePath, true);
  const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(String(text || ''));
  await writable.close();
}

async function deleteRelativeFile(rootHandle, relativePath) {
  const { dirHandle, fileName } = await resolveParentDirectory(rootHandle, relativePath, false);
  if (!dirHandle || !fileName) return;
  try {
    await dirHandle.removeEntry(fileName);
  } catch {}
}

async function resolveParentDirectory(rootHandle, relativePath, create) {
  const parts = String(relativePath || '')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
  const fileName = parts.pop();
  let dirHandle = rootHandle;

  for (const part of parts) {
    dirHandle = await dirHandle.getDirectoryHandle(part, { create });
  }

  return { dirHandle, fileName };
}

function buildMarkdownContent(session) {
  const lines = [
    '# ChatGPT 对话备份',
    '',
    `- 对话键：${session.key}`,
    `- 聊天类型：${session.temporary ? '临时聊天' : '正式聊天'}`,
    `- 消息数：${session.messages.length}`,
    `- 更新时间：${session.updatedAt}`,
    '',
    '---',
    ''
  ];

  for (const message of session.messages) {
    lines.push(`## ${formatRole(message.role)}`);
    lines.push('');
    lines.push(String(message.text || '').trim() || '（空）');
    lines.push('');
  }

  return `${lines.join('\n').trim()}\n`;
}

function formatRole(role) {
  if (role === 'user') return '用户';
  if (role === 'assistant') return 'ChatGPT';
  if (role === 'system') return '系统';
  return role || '未知';
}

function formatTimeForFileName(timestampMs = Date.now()) {
  const date = new Date(timestampMs);
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate())
  ].join('') + '_' + [
    pad2(date.getHours()),
    pad2(date.getMinutes()),
    pad2(date.getSeconds())
  ].join('');
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

async function appendLog(entry) {
  const current = await chrome.storage.local.get(LOGS_KEY);
  const logs = Array.isArray(current[LOGS_KEY]) ? current[LOGS_KEY] : [];
  logs.unshift({
    level: entry.level || 'info',
    message: entry.message || '',
    at: entry.at || new Date().toISOString()
  });
  await chrome.storage.local.set({ [LOGS_KEY]: logs.slice(0, MAX_LOGS) });
}

async function loadSettings() {
  const values = await chrome.storage.local.get(SETTINGS_KEY);
  return {
    ...DEFAULT_SETTINGS,
    ...(values[SETTINGS_KEY] || {})
  };
}

async function loadFolderMeta() {
  const values = await chrome.storage.local.get(FOLDER_META_KEY);
  return values[FOLDER_META_KEY] || null;
}

async function getRuntimeState(tabId) {
  const settings = await loadSettings();
  const folderMeta = await loadFolderMeta();
  const hasHandle = !!(await getDbValue(DIRECTORY_HANDLE_KEY).catch(() => null));
  const logsValue = await chrome.storage.local.get(LOGS_KEY);
  const logs = Array.isArray(logsValue[LOGS_KEY]) ? logsValue[LOGS_KEY] : [];
  const state = Number.isInteger(tabId) ? getTabState(tabId) : null;

  return {
    app: {
      name: APP_NAME,
      version: '2.6.0',
      displayVersion: DISPLAY_VERSION
    },
    settings,
    folder: {
      configured: hasHandle,
      name: folderMeta?.name || '',
      selectedAt: folderMeta?.selectedAt || '',
      currentWebDir: DIR_CURRENT_WEB,
      historyWebDir: DIR_HISTORY_WEB,
      currentMarkdownDir: DIR_CURRENT_MD,
      historyMarkdownDir: DIR_HISTORY_MD,
      exportsDir: DIR_EXPORTS
    },
    logs,
    tabState: state ? buildPublicTabState(state, settings, folderMeta, hasHandle) : null
  };
}

function buildPublicTabState(state, settings, folderMeta, hasHandle) {
  const session = state.currentSession;
  const meta = session?.key ? ensureSessionMeta(state, session) : null;
  return {
    routeEnabled: state.routeEnabled,
    currentConversationLabel: session?.label || (state.routeEnabled ? '等待识别' : '当前页面不是聊天界面'),
    currentFileName: meta ? buildCurrentMhtmlName(meta) : '未生成',
    currentFilePath: meta ? buildCurrentMhtmlPath(meta) : `${DIR_CURRENT_WEB}/未生成`,
    currentMarkdownFileName: meta ? buildCurrentMarkdownName(meta) : '未生成',
    currentMarkdownFilePath: meta ? buildCurrentMarkdownPath(meta) : `${DIR_CURRENT_MD}/未生成`,
    lastSavedAt: state.lastSavedAt || '',
    lastArchivedAt: state.lastArchivedAt || '',
    statusText: state.statusText || '等待聊天页面',
    autoPaused: !!state.autoPaused,
    modeLabel: !settings.enabled ? '已关闭' : state.autoPaused ? '已暂停' : settings.autoSaveEnabled ? '自动' : '手动',
    mhtmlStatus: !settings.enabled
      ? '扩展总开关已关闭'
      : settings.autoSaveEnabled
        ? (state.autoPaused ? '自动保存已暂停' : '原生 MHTML 自动保存已开启')
        : '原生 MHTML 自动保存未开启',
    saveLocationText: hasHandle
      ? `${folderMeta?.name || '已选目录'} / ${DIR_CURRENT_WEB} / ${DIR_CURRENT_MD}`
      : '尚未选择自定义保存目录',
    canSave: !!session?.canSave,
    title: state.pageTitle || '',
    tempNoticeEnabled: !!settings.tempNoticeEnabled,
    privacyWarningEnabled: !!settings.privacyWarningEnabled
  };
}

async function broadcastTabState(tabId) {
  if (!Number.isInteger(tabId)) return;
  const runtime = await getRuntimeState(tabId);
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'STATE_UPDATE',
      payload: runtime
    });
  } catch {}
}

async function broadcastAllStates() {
  for (const tabId of tabStates.keys()) {
    await broadcastTabState(tabId);
  }
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

async function getDbValue(key) {
  const db = await openDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, 'readonly');
    const store = tx.objectStore(HANDLE_STORE);
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('读取目录句柄失败'));
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
