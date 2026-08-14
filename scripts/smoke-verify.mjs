// 烟雾测试结果校验:读取 smoke.json,采样 splash.png / main.png 像素,
// 验证:主流程 ok、启动画面出现黑鲸(深色像素)+ 白色极简背景、
// 主窗口标题正确、引擎版本已知。
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

const dir = process.argv[2] || path.join(process.env.TEMP || "/tmp", "dsh-desktop-smoke");
const jsonPath = path.join(dir, "smoke.json");
if (!fs.existsSync(jsonPath)) { console.error("FAIL: 找不到 " + jsonPath); process.exit(1); }
const smoke = JSON.parse(fs.readFileSync(jsonPath, "utf8"));

let failed = 0;
function check(name, cond, detail) {
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (detail ? "  (" + detail + ")" : ""));
  if (!cond) failed++;
}

check("smoke.ok", smoke.ok === true, smoke.error || "");
check("mainTitle 含 DeepSeek Harness", /DeepSeek Harness/.test(smoke.mainTitle || ""), smoke.mainTitle || "");
check("服务端口已记录", !!smoke.port, "port=" + smoke.port + " reused=" + smoke.reused);
check("DSH 引擎版本已知", !!smoke.installedDsh, "v" + smoke.installedDsh);

// ---- splash.png 像素采样(DeepSeek 简约浅色风) ----
const splashPath = path.join(dir, "splash.png");
if (fs.existsSync(splashPath)) {
  const png = PNG.sync.read(fs.readFileSync(splashPath));
  const px = (x, y) => {
    const i = (y * png.width + x) << 2;
    return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
  };
  const dark = (p) => p[0] < 60 && p[1] < 60 && p[2] < 60;      // 黑鲸/文字
  const light = (p) => p[0] > 235 && p[1] > 235 && p[2] > 235;  // 白色背景
  // 角落应为白色背景
  const corner = px(24, 24);
  check("启动画面背景为白色(极简风)", light(corner), `rgb(${corner.slice(0, 3)})`);
  // 中央区域应出现黑鲸像素
  const cx = Math.floor(png.width / 2);
  let hasDark = false;
  for (let dy = -60; dy <= 60; dy += 8) {
    for (let dx = -60; dx <= 60; dx += 8) {
      if (dark(px(cx + dx, Math.floor(png.height * 0.34) + dy))) hasDark = true;
    }
  }
  check("启动画面出现黑鲸像素", hasDark, "尺寸 " + png.width + "x" + png.height);
  console.log("   splash 截图:", splashPath, png.width + "x" + png.height);
} else {
  check("splash.png 已生成", false, "文件缺失");
}

const mainPath = path.join(dir, "main.png");
if (fs.existsSync(mainPath)) {
  const st = fs.statSync(mainPath);
  check("主窗口截图已生成且非空白", st.size > 20000, Math.round(st.size / 1024) + " KB");
} else {
  check("main.png 已生成", false, "文件缺失");
}

if (smoke.splashAnimations != null) {
  check("启动画面动画正在运行", smoke.splashAnimations > 0, smoke.splashAnimations + " 个动画");
}

// ---- 中文菜单 ----
if (Array.isArray(smoke.menuLabels)) {
  const expect = ["文件", "编辑", "视图", "窗口", "帮助"];
  const okMenu = expect.every((l) => smoke.menuLabels.includes(l));
  check("菜单栏为中文(文件/编辑/视图/窗口/帮助)", okMenu, smoke.menuLabels.join("/"));
} else {
  check("菜单栏为中文(文件/编辑/视图/窗口/帮助)", false, "menuLabels 缺失");
}

// ---- 引擎更新检测 ----
if (smoke.engineUpdate) {
  check("引擎更新检测可用", smoke.engineUpdate.ok === true,
    "current=" + smoke.engineUpdate.current + " latest=" + smoke.engineUpdate.latest + " 有新版本=" + smoke.engineUpdate.updateAvailable);
} else {
  check("引擎更新检测可用", false, "engineUpdate 缺失");
}

// ---- 引擎更新弹窗(自动触发检查后应显示"已是最新版本") ----
if (smoke.engineDialogView) {
  check("引擎更新弹窗显示最新状态", smoke.engineDialogView === "view-uptodate", "视图=" + smoke.engineDialogView);
  const dlgPath = path.join(dir, "engine-dialog.png");
  if (fs.existsSync(dlgPath)) {
    const st = fs.statSync(dlgPath);
    check("引擎更新弹窗截图已生成", st.size > 5000, Math.round(st.size / 1024) + " KB");
  }
} else {
  check("引擎更新弹窗显示最新状态", false, smoke.engineDialogError || "engineDialogView 缺失");
}

console.log(failed === 0 ? "\n全部通过 ✓" : `\n${failed} 项失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
