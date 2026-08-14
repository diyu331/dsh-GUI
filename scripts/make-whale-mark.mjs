// 从 DSH 官方 favicon.svg 派生"黑色小鲸鱼"标记:
// 官方 favicon 的 path 自带 fill="#000"(黑色鲸鱼),这里只需:
//  1) 去掉 prefers-color-scheme 的 <style>(避免深色系统主题下鲸鱼变白)
//  2) 归一化 fill 为 #070A10(近黑,避免重复定义 fill 属性)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

function loadFavicon() {
  // 1) 环境变量显式指定;2) 仓库自带的官方 favicon 副本
  const candidates = [
    process.env.DSH_FAVICON,
    path.join(root, "assets", "favicon-original.svg"),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return fs.readFileSync(c, "utf8");
  }
  throw new Error("找不到 DSH 官方 favicon.svg,请检查路径或设置 DSH_FAVICON");
}

let svg = loadFavicon();
// 去掉 <style>…</style>(其中的 dark-mode media query 会让鲸鱼变白)
svg = svg.replace(/<style[\s\S]*?<\/style>/g, "");
// 替换 path 上已有的 fill(若无则补上),统一为近黑
svg = svg.replace(/<path\b([^>]*?)\bfill="[^"]*"/, '<path$1 fill="#070A10"');
if (!/<path[^>]*fill=/.test(svg)) {
  svg = svg.replace(/<path\b/, '<path fill="#070A10"');
}
const out = path.join(root, "assets", "whale-mark.svg");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, svg);
const fills = svg.match(/fill=/g) || [];
console.log("whale-mark.svg written:", svg.length, "bytes, fill 出现次数 =", fills.length);
