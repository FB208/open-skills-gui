# Open Skills GUI

面向 Windows 的全局 Skill 管理工具，基于 Neutralinojs、Preact 和 TypeScript 开发。

## 环境要求

- Windows 10/11 x64
- Node.js 22.20.0 或更高版本
- Git 2.40 或更高版本
- 打包安装程序时需要 Inno Setup 6.7.3

## 调试

首次运行先安装依赖并下载 Neutralinojs 运行文件：

```powershell
npm ci
npx neu update
```

构建并启动完整应用：

```powershell
npm run build
npx neu run
```

修改代码后需要重新执行 `npm run build`。如果只调试前端界面，可使用热更新模式：

```powershell
npm run dev
```

提交前可执行检查：

```powershell
npm run typecheck
npm test
```

## 打包

```powershell
npm ci
npx neu update
npm run build
npm run package:installer
```

安装程序生成在 `installer\output\OpenSkillsGUI-Setup-x64.exe`。

## 许可证

[GNU Affero General Public License v3.0](LICENSE)
