// 引擎更新流程端到端测试(不依赖 Electron,用系统 node 直接跑):
//   node scripts/test-engine-update.cjs
// 验证: 安装旧版 rc.3 → 检测到新版本 rc.6 → 一键升级 → 再次检测已是最新 → 启停服务
'use strict';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert');
const { ServerManager } = require('../server-manager.js');
const { checkEngineUpdate } = require('../engine-updater.js');

const OLD = '0.1.0-rc.3';
const NEW = '0.1.0-rc.6';

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-engine-test-'));
  const sm = new ServerManager({ userDataDir: dir, isPackaged: false, onLog: (l) => console.log('  [sm]', l) });
  console.log('测试目录:', dir);

  console.log('\n[1] 安装旧版 ' + OLD + ' …');
  await sm.install({ version: OLD });
  assert.strictEqual(sm.installedVersion(), OLD);
  console.log('  ✓ 已安装 v' + sm.installedVersion());

  console.log('\n[2] 检查引擎更新(当前 v' + OLD + ')…');
  const r = await checkEngineUpdate(OLD);
  console.log('  结果:', JSON.stringify(r));
  assert.strictEqual(r.ok, true, '检测应成功');
  assert.strictEqual(r.updateAvailable, true, '应提示有更新');
  assert.strictEqual(r.latest, NEW, '最新版应为 ' + NEW);
  console.log('  ✓ 提示 v' + r.current + ' → v' + r.latest);

  console.log('\n[3] 一键更新到 ' + NEW + ' …');
  await sm.install({ version: NEW });
  assert.strictEqual(sm.installedVersion(), NEW);
  console.log('  ✓ 已升级到 v' + sm.installedVersion());

  console.log('\n[4] 再次检查(当前 v' + NEW + ')…');
  const r2 = await checkEngineUpdate(NEW);
  assert.strictEqual(r2.updateAvailable, false, '应提示已是最新');
  console.log('  ✓ 已是最新版本');

  console.log('\n[5] 启动/停止服务(端口 3099)…');
  sm.start({ port: 3099 });
  assert.strictEqual(await sm.waitHealthy(3099, { timeoutMs: 150000 }), true);
  console.log('  ✓ 服务健康检查通过');
  await sm.stop({ force: true });
  console.log('  ✓ 已停止');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\n引擎更新流程端到端测试全部通过 ✓');
  process.exit(0);
})().catch((e) => {
  console.error('测试失败:', e);
  process.exit(1);
});
