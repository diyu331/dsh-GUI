'use strict';
/**
 * DSH 服务引擎生命周期管理。
 * - 托管目录: <userData>/server,内部通过 npm 安装 @deepseek-ai/dsh
 * - 启动: node <serverDir>/node_modules/@deepseek-ai/dsh/lib/bin.js web --port N
 * - 端口策略: 从 3080 开始;若已被 DSH 服务占用则复用(外部服务),被其他程序占用则顺延
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const DSH_PACKAGE = '@deepseek-ai/dsh';
const FALLBACK_REGISTRIES = ['https://registry.npmjs.org', 'https://registry.npmmirror.com'];

function httpGet(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode, body }));
      res.on('error', () => resolve({ status: 0, body: '' }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
    req.on('error', () => resolve({ status: 0, body: '' }));
  });
}

function isDshResponse(r) {
  return r.status === 200 && /DeepSeek Harness|favicon\.svg/.test(r.body);
}

class ServerManager {
  /**
   * @param {object} opts
   * @param {string} opts.userDataDir  %APPDATA%/<product> 目录
   * @param {boolean} opts.isPackaged  打包后使用内置 node/npm
   * @param {string}  opts.resourcesPath process.resourcesPath
   * @param {(msg:string)=>void} [opts.onLog]
   */
  constructor({ userDataDir, isPackaged = false, resourcesPath = '', onLog = () => {} }) {
    this.userDataDir = userDataDir;
    this.serverDir = path.join(userDataDir, 'server');
    this.isPackaged = isPackaged;
    this.resourcesPath = resourcesPath;
    this.onLog = onLog;
    this.child = null;
    this.reused = false;
    this.port = null;
    this._nodeExe = null;
    this._npmCli = null;
    this._output = ''; // 引擎输出滚动缓冲(诊断用)
  }

  log(msg) {
    try { this.onLog(String(msg)); } catch { /* ignore */ }
  }

  resolveNodeExe() {
    if (this._nodeExe) return this._nodeExe;
    if (this.isPackaged) {
      const bundled = path.join(this.resourcesPath, 'runtime', 'node.exe');
      if (fs.existsSync(bundled)) {
        this._nodeExe = bundled;
      } else {
        // 绿色版未内置运行时:回退到系统 Node(安装引擎时使用)
        const probe = spawnSync('node', ['-p', 'process.execPath'],
          { encoding: 'utf8', timeout: 30000, windowsHide: true });
        this._nodeExe = (probe.status === 0 && probe.stdout.trim()) ? probe.stdout.trim() : null;
        if (!this._nodeExe) throw new Error('未找到可用的 Node.js(内置运行时缺失且系统未安装 Node)');
      }
    } else if (process.env.DSH_DESKTOP_NODE && fs.existsSync(process.env.DSH_DESKTOP_NODE)) {
      this._nodeExe = process.env.DSH_DESKTOP_NODE;
    } else {
      // 开发模式:解析 PATH 上系统 node 的真实路径
      const probe = spawnSync('node', ['-p', 'process.execPath'],
        { encoding: 'utf8', timeout: 30000, windowsHide: true });
      this._nodeExe = (probe.status === 0 && probe.stdout.trim()) ? probe.stdout.trim() : 'node';
    }
    return this._nodeExe;
  }

  resolveNpmCli() {
    if (this._npmCli) return this._npmCli;
    if (this.isPackaged) {
      const bundled = path.join(this.resourcesPath, 'runtime', 'npm', 'bin', 'npm-cli.js');
      this._npmCli = fs.existsSync(bundled)
        ? bundled
        : path.join(path.dirname(this.resolveNodeExe()), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    } else {
      // 开发模式:npm-cli.js 位于系统 node 目录的 node_modules/npm 下
      // (注意:npm 包的 exports 字段不允许 require.resolve 其 bin 子路径,故直接拼路径)
      this._npmCli = path.join(path.dirname(this.resolveNodeExe()), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    }
    if (!this._npmCli || !fs.existsSync(this._npmCli)) {
      throw new Error('找不到 npm-cli.js(请确认已安装 Node.js): ' + this._npmCli);
    }
    return this._npmCli;
  }

  dshEntry() { return path.join(this.serverDir, 'node_modules', DSH_PACKAGE, 'lib', 'bin.js'); }

  installedVersion() {
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(this.serverDir, 'node_modules', DSH_PACKAGE, 'package.json'), 'utf8'));
      return pkg.version || null;
    } catch { return null; }
  }

  isInstalled() { return fs.existsSync(this.dshEntry()); }

  /** 安装(或升级到)指定版本;优先复用本机 npx/npm 缓存(免下载),失败时依次回退国内镜像重试 */
  async install({ version = 'latest', onProgress }) {
    if (!this.isInstalled()) {
      try {
        if (await this.seedFromCache({ version, onProgress })) {
          return { version: this.installedVersion(), seeded: true };
        }
      } catch (e) {
        this.log('本机引擎缓存复用失败: ' + e.message);
      }
    }
    const node = this.resolveNodeExe();
    const npmCli = this.resolveNpmCli();
    let lastErr = null;
    for (const registry of [null, ...FALLBACK_REGISTRIES]) {
      try {
        await this._npmInstall(node, npmCli, version, registry, onProgress);
        return { version: this.installedVersion(), seeded: false };
      } catch (err) {
        lastErr = err;
        this.log('npm install 失败(' + (registry || '默认源') + '): ' + err.message);
      }
    }
    throw lastErr;
  }

  /** 扫描本机 npm 缓存中的 npx 安装目录,找到完整的 DSH 引擎后直接复制(免网络下载) */
  findSeedNodeModulesDirs() {
    if (process.env.DSH_SEED_DIR === 'none') return []; // 逃生舱:跳过缓存复用(用于测试/强制全新安装)
    const roots = [];
    if (process.env.DSH_SEED_DIR) roots.push(process.env.DSH_SEED_DIR);
    if (process.env.NPM_CONFIG_CACHE) roots.push(process.env.NPM_CONFIG_CACHE);
    roots.push(path.join(os.homedir(), 'AppData', 'Local', 'npm-cache'));
    const found = [];
    for (const root of roots) {
      const npxRoot = path.join(root, '_npx');
      let entries = [];
      try { entries = fs.readdirSync(npxRoot); } catch { continue; }
      for (const entry of entries) {
        const nm = path.join(npxRoot, entry, 'node_modules');
        if (fs.existsSync(path.join(nm, DSH_PACKAGE, 'package.json'))) found.push(nm);
      }
    }
    return found;
  }

  async seedFromCache({ version = 'latest', onProgress } = {}) {
    const want = version === 'latest' ? null : version;
    for (const nmDir of this.findSeedNodeModulesDirs()) {
      const pkgPath = path.join(nmDir, DSH_PACKAGE, 'package.json');
      let pkg = null;
      try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { continue; }
      if (want && pkg.version !== want) continue;
      this.log(`发现本机引擎缓存 v${pkg.version},直接复制(免下载)…`);
      if (onProgress) onProgress(`发现本机缓存 v${pkg.version},正在复制…`);
      fs.mkdirSync(this.serverDir, { recursive: true });
      await this._copyDir(nmDir, path.join(this.serverDir, 'node_modules'));
      fs.writeFileSync(path.join(this.serverDir, 'package.json'),
        JSON.stringify({ name: 'dsh-server', private: true, version: '1.0.0' }, null, 2));
      const installed = this.installedVersion();
      if (installed) {
        this.log(`引擎就绪 v${installed}(来自本机缓存)`);
        if (onProgress) onProgress(`引擎 v${installed} 就绪`);
        return true;
      }
    }
    return false;
  }

  _copyDir(src, dest) {
    return new Promise((resolve, reject) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      // Windows 上用 robocopy 多线程复制大量小文件,远快于 Node 递归拷贝
      const r = spawnSync('robocopy', [src, dest, '/E', '/MT:24', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1'],
        { windowsHide: true, stdio: 'ignore', timeout: 900000 });
      // robocopy 退出码 0~7 均为成功(1=已复制文件)
      if (r.error) reject(new Error('robocopy 失败: ' + r.error.message));
      else if (r.status > 7) reject(new Error('robocopy 退出码 ' + r.status));
      else resolve();
    });
  }

  _npmInstall(node, npmCli, version, registry, onProgress) {
    return new Promise((resolve, reject) => {
      const args = [npmCli, 'install', '--prefix', this.serverDir,
        `${DSH_PACKAGE}@${version}`, '--no-audit', '--no-fund', '--no-update-notifier', '--loglevel=warn'];
      if (registry) args.push('--registry', registry);
      this.log('npm install ' + DSH_PACKAGE + '@' + version + ' -> ' + this.serverDir);
      const child = spawn(node, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let buf = '';
      const onData = (d) => {
        const t = d.toString();
        buf += t; if (buf.length > 300000) buf = buf.slice(-300000);
        const line = t.trim();
        if (line) { this.log('[npm] ' + line); if (onProgress) onProgress(line); }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`exit ${code}: ${buf.slice(-1500)}`));
      });
    });
  }

  /** 在 3080 起依次探测:返回 {port, reused} 或 {port:null} */
  async detectPort(startPort = 3080, maxTry = 6) {
    for (let i = 0; i < maxTry; i++) {
      const p = startPort + i;
      const r = await httpGet(`http://127.0.0.1:${p}/`, 2500);
      if (isDshResponse(r)) {
        this.log(`端口 ${p} 已有 DSH 服务在运行,直接复用`);
        return { port: p, reused: true };
      }
      if (r.status === 0) return { port: p, reused: false }; // 空闲
      this.log(`端口 ${p} 被其他程序占用(status ${r.status}),尝试下一个`);
    }
    return { port: null, reused: false };
  }

  /** 启动服务(仅当端口空闲时由外部调用) */
  start({ port }) {
    const node = this.resolveNodeExe();
    const entry = this.dshEntry();
    if (!fs.existsSync(entry)) throw new Error('DSH 引擎未安装: ' + entry);
    this.log(`启动 DSH 服务: ${node} ${entry} web --port ${port}`);
    const child = spawn(node, [entry, 'web', '--port', String(port)], {
      cwd: this.serverDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    this.child = child;
    const onData = (d) => {
      const t = d.toString();
      this._output += t;
      if (this._output.length > 65536) this._output = this._output.slice(-65536);
      const line = t.trim();
      if (line) this.log('[dsh] ' + line);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => this.log('[dsh] 进程错误: ' + err.message));
    child.on('exit', (code, sig) => {
      this.log(`[dsh] 服务进程退出 (code=${code} signal=${sig})`);
      if (this.child === child) this.child = null;
    });
    return child;
  }

  /** 引擎最近输出(诊断错误时附加,便于定位崩溃原因) */
  outputTail(n = 800) {
    const t = this._output.trim();
    return t ? '…' + t.slice(-n) : '(无输出)';
  }

  async waitHealthy(port, { timeoutMs = 150000, intervalMs = 800 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = { status: 0, body: '' };
    while (Date.now() < deadline) {
      last = await httpGet(`http://127.0.0.1:${port}/`, 3000);
      if (isDshResponse(last)) {
        // 防止"先起 HTTP 后崩插件树"的误报:确认进程仍然存活
        if (this.child && this.child.exitCode !== null) {
          throw new Error(`DSH 服务进程提前退出(退出码 ${this.child.exitCode}),最近输出:\n${this.outputTail(1200)}`);
        }
        return true;
      }
      if (this.child && this.child.exitCode !== null) {
        throw new Error(`DSH 服务进程提前退出(退出码 ${this.child.exitCode}),最近输出:\n${this.outputTail(1200)}`);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`DSH 服务在 ${timeoutMs / 1000}s 内未就绪 (最近响应: HTTP ${last.status}),最近输出:\n${this.outputTail(1200)}`);
  }

  async waitPortFree(port, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = await httpGet(`http://127.0.0.1:${port}/`, 1200);
      if (r.status === 0) return true;
      await new Promise((r2) => setTimeout(r2, 400));
    }
    return false;
  }

  /** 停止我们启动的服务(外部服务不动) */
  async stop({ force = false } = {}) {
    if (this.reused || !this.child) return;
    const pid = this.child.pid;
    this.log('停止 DSH 服务 (pid ' + pid + ')');
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } catch (err) {
      this.log('taskkill 失败: ' + err.message);
    }
    this.child = null;
    if (force && this.port) await this.waitPortFree(this.port, 8000);
  }

  /** 同步停止(退出前使用) */
  killSync() {
    if (this.reused || !this.child) return;
    try { spawnSync('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], { windowsHide: true }); } catch { /* ignore */ }
    this.child = null;
  }
}

module.exports = { ServerManager, httpGet, isDshResponse };
