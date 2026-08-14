'use strict';
/**
 * 极简引擎更新:只做一件事 —— 对比 npm 上 @deepseek-ai/dsh 最新版本,
 * 有新版本则提示,一键安装并重启服务。不自动检查、不涉及 GitHub。
 */
const NPM_PKG = '@deepseek-ai/dsh';
const NPM_LATEST_URL = 'https://registry.npmjs.org/@deepseek-ai/dsh/latest';

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v || '').trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}

/** a > b 返回正数;a < b 返回负数;相等返回 0(含 pre-release 语义) */
function cmpSemver(a, b) {
  const A = parseSemver(a), B = parseSemver(b);
  if (!A || !B) return String(a).localeCompare(String(b));
  for (const k of ['major', 'minor', 'patch']) if (A[k] !== B[k]) return A[k] - B[k];
  if (A.pre.length === 0 && B.pre.length === 0) return 0;
  if (A.pre.length === 0) return 1;
  if (B.pre.length === 0) return -1;
  const n = Math.max(A.pre.length, B.pre.length);
  for (let i = 0; i < n; i++) {
    const x = A.pre[i] ?? '0', y = B.pre[i] ?? '0';
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { if (+x !== +y) return +x - +y; }
    else { const c = String(x).localeCompare(String(y)); if (c !== 0) return c; }
  }
  return 0;
}

/**
 * @returns {Promise<{ok:boolean, current:string|null, latest:string|null,
 *   updateAvailable:boolean, error?:string}>}
 */
async function checkEngineUpdate(installedVersion, { timeoutMs = 15000 } = {}) {
  let latest = null;
  try {
    const res = await fetch(NPM_LATEST_URL, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    latest = (await res.json()).version;
  } catch (e) {
    return { ok: false, current: installedVersion || null, latest: null, updateAvailable: false, error: '无法连接 npm 获取最新版本:' + e.message };
  }
  const updateAvailable = !!installedVersion && cmpSemver(latest, installedVersion) > 0;
  return { ok: true, current: installedVersion || null, latest, updateAvailable };
}

module.exports = { checkEngineUpdate, cmpSemver, parseSemver, NPM_PKG };
