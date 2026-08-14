// 打包前准备:把系统 node.exe 与 npm 复制到 build/runtime,
// 使桌面版在无 Node 环境的机器上也能安装/更新 DSH 引擎。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const nodeDir = path.dirname(process.execPath); // 本脚本用系统 node 运行
const npmDir = path.join(nodeDir, "node_modules", "npm");
const out = path.join(root, "build", "runtime");

if (!fs.existsSync(path.join(nodeDir, "node.exe"))) {
  console.error("找不到 node.exe:", nodeDir);
  process.exit(1);
}
if (!fs.existsSync(path.join(npmDir, "bin", "npm-cli.js"))) {
  console.error("找不到 npm-cli.js:", npmDir);
  process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(path.join(nodeDir, "node.exe"), path.join(out, "node.exe"));
fs.cpSync(npmDir, path.join(out, "npm"), { recursive: true });
console.log("runtime 就绪:", out);
console.log("node.exe:", fs.statSync(path.join(out, "node.exe")).size, "bytes");
console.log("npm:", fs.statSync(path.join(out, "npm")).size, "bytes");
