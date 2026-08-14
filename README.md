# DeepSeek Harness Desktop(DSH 桌面版)

把 `dsh web` 封装成 Windows 桌面应用:双击 EXE 即用,独立的桌面窗口,不再需要浏览器。

## 功能

- 🐋 **DeepSeek 风格启动画面**:官方黑鲸 Logo,简约大气(白底、克制的浮动/呼吸动效),启动后自动打开桌面窗口
- 🚀 **DSH 服务自管理**:首次启动自动准备引擎(优先复用本机缓存,免下载),自动探测端口(3080 起),服务可在托盘一键重启
- 🖥️ **系统托盘常驻**:打开主界面 / 重启服务 / 开机自启 / 关于 / 退出
- 📦 单文件 EXE(portable)或安装版(NSIS)

## 开发

```bash
npm install          # 安装 electron / electron-builder 等
npm run whale        # 从官方 favicon 生成黑色鲸鱼标记
npm run icons        # 生成应用图标(icon.ico / tray.png)
npm run smoke        # 开发模式烟雾测试(输出截图与 smoke.json 后退出)
npm run runtime      # 打包前:复制 node.exe + npm 到 build/runtime
npm run dist         # 打包 portable + nsis 到 dist/
```

## 烟雾测试

```bash
npx electron . --smoke --smoke-out=smoke-out
node scripts/smoke-verify.mjs smoke-out
```

## 打包产物

- `dist/v<version>/DSH-Desktop-Setup-<version>.exe` — 安装版(唯一交付形态)
- 版本归档规则:每个版本的安装包放在独立的 `dist/vX.Y.Z/` 目录,旧版本保留不删除(构建配置 `directories.output: "dist/v${version}"` 自动归档)

## 说明

- 首次启动若本机 npm 缓存中已有 DSH 引擎(`_npx` 目录),会直接复制免下载;否则通过内置的 node+npm 安装(一次性)。
- 引擎托管在 `%APPDATA%\DeepSeek Harness Desktop\server`。
- 引擎升级:托盘右键 →「检查引擎更新」→ 一键更新并自动重启服务。
