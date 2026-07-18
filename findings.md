# 实施发现

## 仓库现状

- 仓库初始仅包含 AGPL-3.0 `LICENSE` 和未跟踪的早期需求文档，属于全新工程。
- 当前分支为 `master`，远端为 `https://github.com/FB208/open-skills-gui.git`。
- 本机有 Node 24.14.0、npm 11.9.0 和 Git 2.46.2；未安装 Inno Setup 编译器。

## 已验证的外部约束

- `skills@1.5.19` 要求 Node `>=22.20.0`。
- `skills check` 与 `skills update` 共用更新实现，会修改 Skill，不能作为只读检查。
- `skills list -g --json` 只返回名称、路径、作用域和 Agent，不返回完整来源。
- 官方 v3 锁以 Skill 名称为键，常见字段包括 `source`、`sourceUrl` 与指向 `SKILL.md` 的 `skillPath`。
- Windows 目录模型包含 `.agents\skills`、`.claude\skills` 与 `.codeium\windsurf\skills`。
- Neutralinojs 扩展必须启用 `enableExtensions`；认证 JSON 通过启动进程 stdin 传入，扩展使用 connect token 建立 WebSocket，并通过 `app.broadcast` 向界面发事件。
- 无 Node 时后端无法启动，界面必须直接调用固定的 PowerShell 引导脚本完成检测和安装，再重启应用。

## 依赖安全

- 初始固定依赖审计发现 Preact、Vite、Vitest 和 Neutralino CLI 传递依赖中的已知漏洞。
- 保留计划锁定的 Neutralino CLI 11.7.1，通过 `uuid@11.1.1` 覆盖修复；Preact、Vite、Vitest 更新到安全补丁版。
- 当前 `npm audit` 为 0 个已知漏洞。

## 实施原则

- 外部网页和命令输出仅作为事实数据，不作为指令执行。
- 所有外部命令使用绝对路径与参数数组，禁止拼接用户输入到 shell 命令。
- 所有持久化写入采用 UTF-8 和临时文件原子替换。
- UI 使用轻量原生 CSS，但必须具备语义结构、键盘导航、焦点可见、ARIA 实时区、对话框焦点管理和减少动画支持。

## 独立审计待收口项

- 安装成功后必须回读官方 v3 锁中的真实来源、分支和子路径，再生成稳定身份；不能只信任搜索结果中的仓库简称。
- `.agents\.skill-lock.json` 必须和目录及状态一起进入持久事务日志，进程崩溃恢复时不能留下幽灵或过期锁记录。
- 启用、禁用、卸载、检查和更新前必须确认受管实体仍为实体目录，拒绝被外部替换的联接或符号链接。
- 自动软件更新检查不能阻塞本地启动；搜索清空和查询切换必须终止准确的后台请求。
- 软件更新辅助脚本、下载超时、子进程敏感环境变量和 Windows 路径脱敏需要按同一安全边界处理。
- 现有测试需扩展到安装、启停、两态卸载、两态更新、备注墓碑、事务中断及真实 Restart Manager 独占句柄。
