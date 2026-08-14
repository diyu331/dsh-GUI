// 从 whale-mark.svg(黑鲸)生成:
//   assets/icon.png   (256, 白底圆角 + 黑鲸)
//   assets/icon.ico   (16/24/32/48/64/128/256 多尺寸)
//   assets/tray.png   (32, 白底圆角 + 黑鲸, 用于系统托盘)
//   build/icon.ico / build/icon.png (electron-builder 用)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { PNG } from "pngjs";
import pngToIco from "png-to-ico";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const assets = path.join(root, "assets");
const build = path.join(root, "build");

const WHALE_SVG = fs.readFileSync(path.join(assets, "whale-mark.svg"), "utf8");
const WHALE_FILL = "#070A10";
const DISC_FILL = "#F6F8FB";

function renderSvg(svg, size) {
  const r = new Resvg(svg, { fitTo: { mode: "width", value: size } });
  const png = r.render();
  return PNG.sync.read(png.asPng());
}

function svgDisc(size, radiusRatio = 0.24) {
  const r = Math.round(size * radiusRatio);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">
    <rect x="2" y="2" width="${size - 4}" height="${size - 4}" rx="${r}" fill="${DISC_FILL}"/>
  </svg>`;
}

// 鲸鱼缩放至 disc 的 66%;居中合成
function composite(whale, disc, whaleRatio = 0.66) {
  const out = new PNG({ width: disc.width, height: disc.height });
  PNG.bitblt(disc, out, 0, 0, disc.width, disc.height, 0, 0);
  const w = Math.round(disc.width * whaleRatio);
  const h = Math.round(disc.height * whaleRatio);
  const scale = w / whale.width;
  const ox = Math.round((disc.width - w) / 2);
  const oy = Math.round((disc.height - h) / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(whale.width - 1, Math.floor(x / scale));
      const sy = Math.min(whale.height - 1, Math.floor(y / scale));
      const si = (sy * whale.width + sx) << 2;
      const a = whale.data[si + 3] / 255;
      if (a <= 0) continue;
      const di = ((oy + y) * out.width + (ox + x)) << 2;
      out.data[di] = Math.round(whale.data[si] * a + out.data[di] * (1 - a));
      out.data[di + 1] = Math.round(whale.data[si + 1] * a + out.data[di + 1] * (1 - a));
      out.data[di + 2] = Math.round(whale.data[si + 2] * a + out.data[di + 2] * (1 - a));
      out.data[di + 3] = 255;
    }
  }
  return out;
}

function savePng(png, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(png));
  console.log("wrote", file, png.width + "x" + png.height);
}

// 大尺寸鲸鱼 (1024) 作为缩放源,保证小尺寸质量
const whaleBig = renderSvg(WHALE_SVG, 1024);
const iconSizes = [16, 24, 32, 48, 64, 128, 256];

const iconPngs = iconSizes.map((s) => composite(whaleBig, renderSvg(svgDisc(s)), 0.66));
// assets/icon.png = 256
savePng(iconPngs[iconSizes.length - 1], path.join(assets, "icon.png"));
// assets/tray.png = 32
savePng(iconPngs[2], path.join(assets, "tray.png"));
// icon.ico 多尺寸
const ico = await pngToIco(iconPngs.map((p) => PNG.sync.write(p)));
fs.mkdirSync(build, { recursive: true });
fs.writeFileSync(path.join(build, "icon.ico"), ico);
console.log("wrote build/icon.ico");
fs.copyFileSync(path.join(assets, "icon.png"), path.join(build, "icon.png"));
console.log("wrote build/icon.png");
