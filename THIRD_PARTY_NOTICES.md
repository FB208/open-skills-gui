# 第三方组件声明

Open Skills GUI 使用或在构建过程中调用以下第三方项目。各项目仍归原作者所有，并遵循各自许可证。

## 运行时组件

| 组件                     | 固定版本                    | 许可证                                  | 项目地址                                      |
| ------------------------ | --------------------------- | --------------------------------------- | --------------------------------------------- |
| Neutralinojs Framework   | 6.7.0                       | MIT                                     | https://github.com/neutralinojs/neutralinojs  |
| `@neutralinojs/lib`      | 6.5.0                       | MIT                                     | https://github.com/neutralinojs/neutralino.js |
| Preact                   | 由 `package-lock.json` 固定 | MIT                                     | https://github.com/preactjs/preact            |
| Vercel Skills CLI        | 1.5.19                      | MIT                                     | https://github.com/vercel-labs/skills         |
| Node.js                  | 24.18.0                     | MIT 及随发行包提供的第三方许可证        | https://github.com/nodejs/node                |
| Git for Windows / MinGit | 2.55.0.2                    | GNU GPL v2 及随发行包提供的第三方许可证 | https://github.com/git-for-windows/git        |
| semver                   | 由 `package-lock.json` 固定 | ISC                                     | https://github.com/npm/node-semver            |

Node.js 与 MinGit 由用户确认后从官方发行地址下载，原始发行包中的许可证文件会随私有运行环境保留。Microsoft Edge WebView2 Runtime 由微软官方安装程序安装，受 Microsoft 软件许可条款约束。

## 构建与测试组件

| 组件                                                | 许可证             |
| --------------------------------------------------- | ------------------ |
| Neutralinojs CLI (`@neutralinojs/neu`)              | MIT                |
| Vite、Vitest、esbuild、Prettier、Preact Vite preset | MIT                |
| TypeScript                                          | Apache License 2.0 |
| Inno Setup                                          | Inno Setup License |

构建工具不会作为独立工具重新分发；Inno Setup 生成的安装程序包含其许可允许的运行代码。

## MIT License

The MIT-licensed components above are provided under the following terms:

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

ISC、Apache-2.0、GPL-2.0、Node.js 第三方组件和 Inno Setup 的完整条款请参阅对应项目发行包或上表中的官方项目地址。
