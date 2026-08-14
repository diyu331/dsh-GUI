# DeepSeek Harness Desktop —— 开发交接文档

> 给未来对话的 agent 与维护者:先读本文件,即可无缝接手本项目。
> 项目位置:`D:\develop\College_dev\dsH_UI_dev\dsh-desktop`
> 仓库:`https://github.com/diyu331/dsh-GUI`(main 分支)
> 当前版本:**v1.1.3**(改版本号在 `package.json` 的 `version`)

## 1. 项目是什么

把 DSH(`dsh web`)封装成 Windows 桌面应用(Electron):双击 EXE → 白底黑鲸启动画面 → 自动准备/启动 DSH 引擎 → 打开桌面窗口加载 Web UI。含中文菜单、系统托盘、一键更新引擎。**不含**任何自动更新检测/更新提示功能(用户已明确要求去掉)。

## 2. 目录结构

| 文件 | 职责 |
|---|---|
| `main.js` | Electron 主进程:单实例锁 → 启动画面 → 引导引擎 → 主窗口;托盘;中文菜单;引擎更新;--smoke 测试模式 |
| `splash.html` | 启动画面(白底、黑鲸、浮动/呼吸/声呐动画、进度条、重试按钮) |
| `server-manager.js` | 引擎生命周期:托管目录、install(缓存复用/内置npm)、start、waitHealthy、stop |
| `engine-updater.js` | 一键更新引擎:查 npm latest、版本比较 |
| `engine-update.html` | 更新弹窗(当前→新版本 + 立即更新 + 进度) |
| `preload.js` | contextBridge:onStatus / getBootstrap / retryBoot / quit / 更新事件 |
| `assets/` | whale-mark.svg(黑鲸)、icon、tray、favicon-original.svg |
| `build/` | icon.ico / icon.png(构建必需,已入库)、runtime/(node.exe+npm,gitignore) |
| `scripts/` | make-whale-mark / make-icons / prepare-runtime / smoke-verify / test-engine-update |

## 3. 架构与关键路径

- 引擎托管目录:`%APPDATA%\DeepSeek Harness Desktop\server`(node_modules 里装 `@deepseek-ai/dsh`)
- 端口策略:从 3080 开始;已被 DSH 占用→复用(外部服务),被其他程序占用→顺延;空闲→自启引擎
- 引擎日志(诊断首选):`%APPDATA%\DeepSeek Harness Desktop\dsh-desktop.log`
- 启动流程:`boot()`:detectPort → (复用外部 | 安装引擎→start→waitHealthy)→ ready → 主窗口
- `waitHealthy` 必须检查 `child.exitCode`(引擎会"先起 HTTP 后崩插件树",否则误报成功)
- 引擎启动失败时错误信息含引擎最近输出(`outputTail`),便于定位崩溃原因

## 4. 构建打包流程(完整,照抄即可)

环境变量:`ELECTRON_MIRROR` 和 `ELECTRON_BUILDER_BINARIES_MIRROR` 用 npmmirror(本机 GitHub 直连超时);`CSC_IDENTITY_AUTO_DISCOVERY=false`。

```powershell
# 1) 升版本号 package.json → 2) 生成鲸鱼/图标(assets 已有可跳过)
node scripts/make-whale-mark.mjs
node scripts/make-icons.mjs
# 3) 打包运行时(node.exe + npm → build/runtime,约 190MB,必须先生成)
node scripts/prepare-runtime.mjs
# 4) 打 unpacked(输出到 dist/vX.Y.Z/,output 宏已配置)
node node_modules/electron-builder/out/cli/cli.js --win dir
# 5) 手动 rcedit 注入图标+版本(必须,见坑#2)
rcedit-x64.exe "dist\vX.Y.Z\win-unpacked\DeepSeek Harness Desktop.exe" --set-icon build\icon.ico --set-version-string FileDescription "DeepSeek Harness Desktop" --set-version-string ProductName "DeepSeek Harness Desktop" --set-version-string CompanyName deepseek-ai --set-file-version X.Y.Z --set-product-version X.Y.Z
# 6) 打安装版
node node_modules/electron-builder/out/cli/cli.js --win nsis --prepackaged "dist\vX.Y.Z\win-unpacked"
```

rcedit 位置:`%TEMP%\wincodesign-extract\rcedit-x64.exe`(缺失时用 7za 从 `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\*.7z` 解压,`node_modules\7zip-bin\win\x64\7za.exe x <zip> -o<dir> -y -bd`)。

## 5. 版本归档规则(用户明确要求,必须遵守)

- 每个版本的安装包放独立目录 `dist\vX.Y.Z\`,`directories.output` 已配 `dist/v${version}` 自动归档
- **旧版本目录永远保留,不删除**
- 发布:git commit + push,然后用户去 GitHub Releases 上传对应 exe

## 6. 关键技术点与坑(血泪史)

1. **winCodeSign 解压失败**:包内含 macOS 符号链接,非管理员解压报"没有所需特权"。所以 `win.signAndEditExecutable: false`,图标/版本靠手动 rcedit;NSIS 安装包图标用 `nsis.installerIcon` 编译期嵌入。
2. **rcedit 会截断 NSIS 生成的 exe(变成 0.4MB)**!只对 win-unpacked 的主 exe 用 rcedit,**绝不要 rcedit 安装包/portable 桩**。
3. **ZHIPU_API_KEY 崩溃**:`~/.dsh/profiles/web/cordis.patch.yml` 里 mcp-vision 的 env 必须 `!!js process.env.ZHIPU_API_KEY ?? ''`——桌面版(双击)环境没有 shell 变量,裸写会导致引擎启动校验崩溃。**此修复不能删**。
4. **npm exports 限制**:不能 `require.resolve("npm/bin/npm-cli.js")`,直接拼 `node目录\node_modules\npm\bin\npm-cli.js`。
5. **单实例锁**:第二个实例静默退出(无任何输出)。测试前先关掉运行中的桌面版进程(`Stop-Process -Name "DeepSeek Harness*"`)。
6. **--user-data-dir 在 dev Electron 下被忽略**(开关必须位于 app 路径之前);打包版正常。测试用 `--dsh-port 3099` 避免占用 3080。
7. **不要杀 3080 进程**:用户正通过它使用 DSH(agent 也跑在上面)。需要自启引擎测试时用 `--dsh-port` 指定空闲端口。
8. **pnpm**:装在 `D:\develop\DevelopmentTool\pnpm-global`(node_global 不可写)。`dsh plugin` 需要 pnpm 在 PATH,用前临时 `$env:PATH = 'D:\develop\DevelopmentTool\pnpm-global;' + $env:PATH`。
9. **引擎/插件问题先看日志**:`%APPDATA%\DeepSeek Harness Desktop\dsh-desktop.log`。
10. **DSH 设置面板白名单**:Web 设置面板只显示硬编码 `WEB_SETTINGS_NAMESPACES` + 模型提供商(在 `dsh-host-apiproxy/lib/types/api-proxy.js`),第三方插件注册的 namespace **不显示**(官方 deferred work)。曾做过 vision-settings 插件,已按用户要求卸载。

## 7. 验证

```powershell
# 开发冒烟测试(先关桌面版释放单实例锁)
node_modules\electron\dist\electron.exe <项目路径> --smoke --smoke-out <输出目录>
node scripts/smoke-verify.mjs <输出目录>
# 全量断言:启动画面(白底+黑鲸+动画)、主窗口、中文菜单、引擎检测、更新弹窗
```

## 8. 本机环境事实

- node:`D:\develop\DevelopmentTool\nodejs\node.exe`(v24),npm.cmd 同目录
- npm 全局 prefix `D:\develop\DevelopmentTool\nodejs\node_global`(**不可写**,别往这装)
- GitHub 认证已配置(credential manager,可直接 push)
- 安装版位置:`D:\apps\DeepSeek Harness Desktop\`
- EXE 未签名:SmartScreen 首次运行提示"更多信息→仍要运行"属正常
- 用户对话习惯:中文;对"往 C 盘装东西"敏感(工具类优先 D 盘);操作前先说明、可回滚

## 9. 发布流程(每次新版本)

1. 改 `package.json` version → 按第 4 节打包 → 冒烟测试
2. `git add -A && git commit -m "vX.Y.Z: 说明" && git push origin main`
3. 提醒用户:去 GitHub Releases 上传 `dist\vX.Y.Z\DSH-Desktop-Setup-X.Y.Z.exe`(网页操作,用户自己做)
