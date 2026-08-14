'use strict';
/**
 * DeepSeek Harness Desktop —— Electron 主进程
 * 职责:
 *  - 简约启动画面(黑鲸 Logo,DeepSeek 风格) → DSH 服务引导 → 主窗口加载 Web UI
 *  - 系统托盘(打开/重启服务/开机自启/关于/退出)
 *  - --smoke 烟雾测试模式:自动截屏 + 输出 smoke.json 后退出
 */
const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, shell, dialog, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { ServerManager } = require('./server-manager');
const { checkEngineUpdate } = require('./engine-updater');

const PRODUCT = 'DeepSeek Harness Desktop';
const APP_ID = 'com.deepseek.dsh-desktop';
const PORT_START = parseInt(argvValue('--dsh-port') || '3080', 10) || 3080;

const SMOKE = process.argv.includes('--smoke');
const smokeOut = SMOKE
  ? path.resolve(argvValue('--smoke-out') || path.join(os.tmpdir(), 'dsh-desktop-smoke'))
  : null;

function argvValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

let splashWin = null;
let mainWin = null;
let tray = null;
let engineWin = null;
let quitting = false;
let server = null;
let booting = false;

const smoke = { startedAt: Date.now(), logs: [] };
function log(msg) {
  const line = `[dsh-desktop ${new Date().toISOString()}] ${msg}`;
  console.log(line);
  if (smoke.logs) smoke.logs.push(msg);
}

// ---------------- 单实例 ----------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
  app.whenReady().then(main).catch((err) => {
    log('启动失败: ' + err);
    finishSmoke(false, String(err));
  });
}

// ---------------- 主流程 ----------------
async function main() {
  app.setAppUserModelId(APP_ID);
  buildApplicationMenu();
  const logFile = path.join(app.getPath('userData'), 'dsh-desktop.log');
  server = new ServerManager({
    userDataDir: app.getPath('userData'),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    onLog: (msg) => {
      log(msg);
      try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`); } catch { /* ignore */ }
    },
  });
  createSplash();
  createTray();
  registerIpc();
  if (SMOKE) setupSmoke();
  boot();
}

// ---------------- 中文菜单 ----------------
function buildApplicationMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        { label: '重新启动服务', click: () => restartServer() },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', role: 'reload' },
        { label: '强制重新加载', role: 'forceReload' },
        { type: 'separator' },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' },
        { label: '开发者工具', role: 'toggleDevTools' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { label: '最小化', role: 'minimize' },
        { label: '关闭', role: 'close' },
        { label: '前置全部窗口', role: 'front' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '关于 DeepSeek Harness Desktop', click: showAbout },
        { label: 'DeepSeek Harness GitHub', click: () => shell.openExternal('https://github.com/deepseek-ai/deepseek-harness') },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

// ---------------- 启动画面 ----------------
function createSplash() {
  splashWin = new BrowserWindow({
    width: 480, height: 560, show: false, frame: false, transparent: true,
    resizable: false, maximizable: false, minimizable: false, skipTaskbar: true,
    alwaysOnTop: true, center: true, title: PRODUCT,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  splashWin.loadFile('splash.html');
  splashWin.once('ready-to-show', () => splashWin.show());
  splashWin.on('closed', () => { splashWin = null; });
}

function sendStatus(stage, extra) {
  if (splashWin && !splashWin.isDestroyed()) {
    splashWin.webContents.send('dsh:status', Object.assign({ stage }, extra || {}));
  }
}

function fadeSplash() {
  sendStatus('hide');
  setTimeout(() => { if (splashWin && !splashWin.isDestroyed()) splashWin.destroy(); }, 450);
}

// ---------------- 引导 DSH 服务 ----------------
async function boot() {
  if (booting) return;
  booting = true;
  if (smoke) smoke.bootStart = Date.now();
  try {
    sendStatus('detect');
    const portInfo = await server.detectPort(PORT_START);

    if (portInfo.reused) {
      server.port = portInfo.port;
      server.reused = true;
      // 确保托管目录里也有引擎(供"关于"显示版本与后续独立使用),失败不阻塞连接
      if (!server.isInstalled()) {
        sendStatus('install', { detail: '正在准备引擎(一次性,优先复用本机缓存)' });
        try { await server.install({ version: 'latest' }); } catch (e) { log('托管引擎安装失败(不影响复用外部服务): ' + e.message); }
      }
      sendStatus('wait', { detail: `发现已在运行的 DSH 服务(端口 ${portInfo.port}),正在连接` });
      await server.waitHealthy(portInfo.port, { timeoutMs: 25000 });
      await ready(portInfo.port);
    } else if (portInfo.port) {
      server.port = portInfo.port;
      if (!server.isInstalled()) {
        sendStatus('install', { detail: '首次启动,正在准备引擎(仅此一次;本机有缓存则免下载)' });
        await server.install({ version: 'latest' });
      }
      const installed = server.installedVersion() || '?';
      sendStatus('start', { detail: `正在启动服务 v${installed}` });
      server.start({ port: server.port });
      await server.waitHealthy(server.port);
      await ready(server.port);
    } else {
      throw new Error(`端口 ${PORT_START}–${PORT_START + 5} 全部被占用且未发现 DSH 服务,请关闭占用程序后重试。`);
    }
  } catch (err) {
    log('boot 失败: ' + (err && err.stack || err));
    sendStatus('error', { detail: String((err && err.message) || err) });
    finishSmoke(false, String((err && err.message) || err));
  } finally {
    booting = false;
  }
}

let engineDialogTask = null;

async function ready(port) {
  sendStatus('ready', { detail: `已就绪(端口 ${port})` });
  openMainWindow(port);
  if (!SMOKE) setTimeout(fadeSplash, 500);
  if (SMOKE) {
    // 烟雾模式:自动触发"检查引擎更新",验证弹窗状态
    engineDialogTask = (async () => {
      try {
        await new Promise((r) => setTimeout(r, 800));
        const r = await runEngineUpdateCheck();
        smoke.engineCheck = r ? { ok: r.ok, current: r.current, latest: r.latest, updateAvailable: r.updateAvailable } : null;
        await new Promise((r2) => setTimeout(r2, 1800));
        if (engineWin && !engineWin.isDestroyed()) {
          smoke.engineDialogView = await engineWin.webContents.executeJavaScript(
            '[].slice.call(document.querySelectorAll(".body > div")).filter(function (d) { return !d.classList.contains("hidden"); }).map(function (d) { return d.id; }).join()'
          );
          const img = await engineWin.webContents.capturePage();
          fs.writeFileSync(path.join(smokeOut, 'engine-dialog.png'), img.toPNG());
        }
      } catch (e) { smoke.engineDialogError = String(e); }
    })();
  }
}

// ---------------- 主窗口 ----------------
function openMainWindow(port) {
  if (mainWin && !mainWin.isDestroyed()) { mainWin.show(); mainWin.focus(); return; }
  const url = `http://127.0.0.1:${port}`;
  mainWin = new BrowserWindow({
    width: 1440, height: 920, show: false, title: PRODUCT, icon: path.join(__dirname, 'assets', 'icon.png'),
    backgroundColor: '#FFFFFF',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  mainWin.loadURL(url);
  mainWin.once('ready-to-show', () => mainWin.show());
  mainWin.webContents.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:/i.test(u)) shell.openExternal(u);
    return { action: 'deny' };
  });
  mainWin.webContents.on('will-navigate', (e, u) => {
    try {
      const allowed = new URL(u);
      const same = ['127.0.0.1', 'localhost'].includes(allowed.hostname) && allowed.port === String(port);
      if (!same) { e.preventDefault(); if (/^https?:/i.test(u)) shell.openExternal(u); }
    } catch { e.preventDefault(); }
  });
  mainWin.webContents.on('did-finish-load', () => {
    if (SMOKE) setTimeout(() => finishSmoke(true), 1600);
  });
  mainWin.on('closed', () => { mainWin = null; });
}

function showMainWindow() {
  if (mainWin && !mainWin.isDestroyed()) { mainWin.show(); mainWin.focus(); return; }
  if (server && server.port) openMainWindow(server.port);
  else if (!booting) boot();
}

// ---------------- 托盘 ----------------
function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  tray = new Tray(img);
  tray.setToolTip(PRODUCT);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开主界面', click: showMainWindow },
    { type: 'separator' },
    { label: '重新启动 DSH 服务', click: restartServer },
    { label: '检查引擎更新', click: runEngineUpdateCheck },
    { type: 'separator' },
    {
      label: '开机自启', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, path: process.execPath });
      },
    },
    { label: '关于 ' + PRODUCT, click: showAbout },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
  tray.on('click', showMainWindow);
}

function showAbout() {
  const dshVer = server ? (server.installedVersion() || '未安装') : '—';
  const port = server && server.port ? server.port : '—';
  dialog.showMessageBox({
    title: '关于 ' + PRODUCT,
    message: PRODUCT,
    detail:
      `桌面客户端版本: v${app.getVersion()}\n` +
      `DSH 服务引擎: v${dshVer}${server && server.reused ? '(外部服务,非本客户端托管)' : ''}\n` +
      `服务地址: http://127.0.0.1:${port}\n` +
      `数据目录: ${app.getPath('userData')}\n\n` +
      `DeepSeek Harness 官方仓库:\nhttps://github.com/deepseek-ai/deepseek-harness`,
    buttons: ['打开 GitHub', '确定'],
  }).then(({ response }) => {
    if (response === 0) shell.openExternal('https://github.com/deepseek-ai/deepseek-harness');
  });
}

async function restartServer() {
  if (!server) return;
  if (server.reused) {
    notify(PRODUCT, '当前连接的是外部启动的 dsh 服务,请在原终端中自行重启。');
    return;
  }
  if (!server.port) { boot(); return; }
  notify(PRODUCT, '正在重启 DSH 服务…');
  try {
    await server.stop({ force: true });
    await new Promise((r) => setTimeout(r, 600));
    server.start({ port: server.port });
    await server.waitHealthy(server.port);
    if (mainWin && !mainWin.isDestroyed()) mainWin.loadURL(`http://127.0.0.1:${server.port}`);
    notify(PRODUCT, 'DSH 服务已重启。');
  } catch (err) {
    notify(PRODUCT, '服务重启失败:' + String((err && err.message) || err).slice(0, 400));
  }
}

function notify(title, body) {
  try { new Notification({ title, body }).show(); } catch (e) { log('通知失败: ' + e.message); }
}

// ---------------- 引擎更新(极简版) ----------------
async function runEngineUpdateCheck() {
  if (!server) return null;
  const installed = server.installedVersion();
  if (!installed) { notify(PRODUCT, '引擎尚未安装,无法检查。'); return null; }
  const r = await checkEngineUpdate(installed);
  if (!r.ok) { notify(PRODUCT, r.error); return r; }
  openEngineUpdateWindow(r); // 无论是否有新版,都弹窗明确说明
  return r;
}

function openEngineUpdateWindow(state) {
  if (engineWin && !engineWin.isDestroyed()) { engineWin.focus(); return; }
  engineWin = new BrowserWindow({
    width: 460, height: 420, show: false, frame: false, transparent: true,
    resizable: false, maximizable: false, minimizable: false, center: true, title: '引擎更新',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  engineWin.webContents.once('did-finish-load', () => {
    engineWin.webContents.send('dsh:update-event', {
      type: 'state', state: { current: state.current, latest: state.latest },
    });
  });
  engineWin.loadFile('engine-update.html');
  engineWin.once('ready-to-show', () => engineWin.show());
  engineWin.on('closed', () => { engineWin = null; });
}

async function applyEngineUpdate(toVersion) {
  const send = (e) => { if (engineWin && !engineWin.isDestroyed()) engineWin.webContents.send('dsh:update-event', e); };
  try {
    send({ type: 'phase', phase: 'stopping' });
    if (!server.reused) await server.stop({ force: true });
    else await new Promise((r) => setTimeout(r, 500));

    send({ type: 'phase', phase: 'installing', version: toVersion });
    await server.install({ version: toVersion, onProgress: (line) => send({ type: 'npm', line }) });

    if (!server.reused) {
      send({ type: 'phase', phase: 'restarting' });
      await new Promise((r) => setTimeout(r, 600));
      server.start({ port: server.port });
      await server.waitHealthy(server.port);
    }
    send({ type: 'phase', phase: 'done', version: toVersion });
    notify(PRODUCT, `DSH 引擎已更新到 v${toVersion},服务已重启。`);
    if (mainWin && !mainWin.isDestroyed() && !server.reused) {
      mainWin.loadURL(`http://127.0.0.1:${server.port}`);
    }
    return { ok: true, version: toVersion };
  } catch (err) {
    send({ type: 'phase', phase: 'error', message: String((err && err.message) || err) });
    notify(PRODUCT, '引擎更新失败:' + String((err && err.message) || err));
    return { ok: false, error: String((err && err.message) || err) };
  }
}

// ---------------- IPC ----------------
function registerIpc() {
  ipcMain.handle('dsh:bootstrap', () => ({
    appVersion: app.getVersion(),
    dshVersion: server ? server.installedVersion() : null,
  }));
  ipcMain.handle('dsh:retry-boot', () => boot());
  ipcMain.handle('dsh:quit', () => app.quit());
  ipcMain.handle('dsh:engine-apply', (_e, v) => applyEngineUpdate(String(v || '')));
}

// ---------------- 烟雾测试 ----------------
function setupSmoke() {
  fs.mkdirSync(smokeOut, { recursive: true });
  setTimeout(async () => {
    if (splashWin && !splashWin.isDestroyed()) {
      try {
        smoke.splashAnimations = await splashWin.webContents.executeJavaScript(
          'document.getAnimations().filter(a => a.playState === "running").length'
        );
        smoke.splashStage = await splashWin.webContents.executeJavaScript(
          'document.getElementById("status").textContent'
        );
        const img = await splashWin.webContents.capturePage();
        fs.writeFileSync(path.join(smokeOut, 'splash.png'), img.toPNG());
        log('splash 截图已保存');
      } catch (e) { smoke.splashCaptureError = String(e); }
    }
  }, 2500);
}

async function finishSmoke(ok, errText) {
  if (smoke.finished) return;
  smoke.finished = true;
  try {
    if (mainWin && !mainWin.isDestroyed()) {
      const img = await mainWin.webContents.capturePage();
      fs.writeFileSync(path.join(smokeOut, 'main.png'), img.toPNG());
      smoke.mainTitle = await mainWin.webContents.executeJavaScript('document.title');
      smoke.mainUrl = mainWin.webContents.getURL();
    }
  } catch (e) { smoke.mainCaptureError = String(e); }
  smoke.ok = ok;
  smoke.error = errText || null;
  smoke.port = server ? server.port : null;
  smoke.reused = server ? server.reused : null;
  smoke.installedDsh = server ? server.installedVersion() : null;
  try {
    smoke.menuLabels = Menu.getApplicationMenu().items.map((i) => i.label);
    if (server && server.installedVersion()) {
      smoke.engineUpdate = await checkEngineUpdate(server.installedVersion(), { timeoutMs: 12000 });
    }
    if (engineDialogTask) await engineDialogTask;
  } catch (e) { smoke.smokeExtraError = String(e); }
  smoke.finishedAt = Date.now();
  try { fs.writeFileSync(path.join(smokeOut, 'smoke.json'), JSON.stringify(smoke, null, 2)); } catch (e) { console.error(e); }
  setTimeout(() => app.quit(), 300);
}

// ---------------- 退出清理 ----------------
app.on('before-quit', () => {
  quitting = true;
  if (server) server.killSync();
});
app.on('window-all-closed', () => {
  // 托盘常驻:不自动退出
  if (quitting) app.quit();
});
