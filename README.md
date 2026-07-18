# Open Skills GUI

Open Skills GUI 是面向 Windows 的轻量级全局 Skill 管理客户端，使用 Neutralinojs、Preact 和固定版本的 `npx skills` 构建。界面仅提供简体中文，不采集遥测或崩溃信息。

## 系统要求

- Windows 10 22H2（19045）或 Windows 11，原生 x64。
- Microsoft Edge WebView2 Runtime。安装程序会检测；缺失时先征得同意，再从微软官方下载并安装。
- Node.js ≥22.20.0、npx 和 Git ≥2.40。缺失时应用会询问是否下载固定的 Node 24.18.0 与 MinGit 2.55.0.2 到私有目录，不修改系统 PATH。

发行版仅提供 `OpenSkillsGUI-Setup-x64.exe`。首版没有代码签名证书，因此 Windows SmartScreen 可能显示“未知发布者”；请只从本仓库的 GitHub Releases 下载。

## 主要功能

- 查询、筛选、安装和卸载全局 Skill。
- 管理 `%USERPROFILE%\.agents\skills`，并为 Claude Code 与 Windsurf 管理专用目录联接。
- 启用或禁用 Skill；禁用内容保存在本工具工作区，可快速恢复。
- 单个或批量检查、更新 Skill，并保护本地修改和冲突内容。
- 为 Skill 保存本地备注；Skill 卸载后备注仍保留。
- 每次启动检查正式 GitHub Release，经用户确认后校验 SHA-256、静默覆盖升级并重启。

## 数据与卸载

程序默认安装到 `%LOCALAPPDATA%\Programs\OpenSkillsGUI`，数据根目录为 `%LOCALAPPDATA%\OpenSkillsGUI`。

| 路径                 | 内容                 | 卸载时处理 |
| -------------------- | -------------------- | ---------- |
| `data`               | 配置、托管记录和备注 | 保留       |
| `workspace\disabled` | 已禁用 Skill         | 保留       |
| `logs`               | 仅本地日志           | 保留       |
| `runtime`            | 私有 Node 与 MinGit  | 删除       |
| `cache`              | npm 与临时缓存       | 删除       |
| `updates`            | 软件更新临时文件     | 删除       |

卸载不会删除 `.agents`、`.claude`、`.codeium` 中的 Skill 或本工具创建的目录联接。重新安装后可以继续使用原数据。

## 隐私与网络访问

应用不集成分析、遥测或主动崩溃上报，并为 `skills` 命令设置 `DISABLE_TELEMETRY=1` 与 `DO_NOT_TRACK=1`。以下网络请求只在对应功能需要时发生：

- Skill 搜索、安装和更新访问 npm、skills.sh 与相关 GitHub 仓库。
- 首次环境安装访问 Node.js 和 Git for Windows 官方发行地址。
- 软件更新检查访问 `FB208/open-skills-gui` 的 GitHub Release API。
- WebView2 缺失时，经确认后访问微软官方下载地址。

日志只保存在本机，并对用户主目录做隐藏处理。

## 本地开发

```powershell
npm ci
npx neu update
npm run validate:powershell
npm run verify:version
npm run typecheck
npm test
npm run build
```

生成安装程序需要 Inno Setup 6.7.3：

```powershell
npm run package:installer
```

安装程序输出为 `installer\output\OpenSkillsGUI-Setup-x64.exe`。PowerShell 脚本必须保持 UTF-8 BOM；修改后可依次执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\ensure-powershell-utf8bom.ps1
npm run validate:powershell
```

## 自动发布

GitHub Actions 会在拉取请求以及 `main`、`master` 分支推送时执行依赖审计、格式检查、类型检查、测试、Windows x64 构建和安装/卸载冒烟测试，并上传安装程序工件。

推送与应用版本一致的标签（例如 `v1.0.0`）后，工作流会创建正式 GitHub Release，且只上传 `OpenSkillsGUI-Setup-x64.exe`。

## 许可证

本项目使用 [GNU Affero General Public License v3.0](LICENSE)。第三方组件及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
