# QuickLook LaTeX 预览插件（TeXViewer）

给 Windows [QuickLook](https://github.com/QL-Win/QuickLook) 的 `.tex` 预览：选中文件按**空格**，直接看排版效果——不装 TeX、不联网、不写你的文件。

> 四要素：**空格**（QuickLook 原生交互，不新开窗口）· **秒开**（常见文档 20–150 ms）· **免装 TeX**（自带解析器 + 离线 MathJax）· **只读**（预览器，不是编辑器/编译器）。

![QuickLook](docs/badges/quicklook.svg) ![dotnet](docs/badges/dotnet.svg) ![WebView2](docs/badges/webview2.svg) ![version](docs/badges/version.svg) ![tests](docs/badges/tests.svg) ![dependencies](docs/badges/deps.svg) ![license](docs/badges/license.svg)

## 痛点

写 LaTeX 的人都有这几件事：

- 只想**看一眼**别人发来的 `.tex`，却要打开 TeXstudio / VS Code，再等编译；
- 没装 TeX Live 的电脑上，`.tex` 只能当纯文本看，公式、表格、章节全靠脑补；
- 装了 TeX 的机器，第一次编译模板可能几十秒，冷启动体验比“快速预览”还慢；
- 有些插件把 PDF 渲染、编辑器、源码视图全塞进来，重且偏离“瞟一眼”的场景。

## 它怎么解决

| 能力 | 说明 |
|---|---|
| **空格即预览** | 复用 QuickLook 的 `IViewer` + 官方 `WebpagePanel`，与系统预览行为一致 |
| **免装 TeX** | 自研 LaTeX 结构解析器（标题/列表/表格/定理/引用/宏）+ 离线 MathJax |
| **排版接近 PDF** | 两端对齐、首行缩进、标题层级、脚注线、booktabs 表格；tufte 类的独立页边栏 |
| **图片与 PDF 插图** | PNG/JPG/SVG 内联；`\includegraphics{fig.pdf}` 用系统 API 转首页 PNG |
| **中文** | UTF-8/GB18030 自动识别；ctex 文档按中文缩进（2em） |
| **宏** | `\newcommand`/`\def`/`\DeclareMathOperator`、可选参数、同目录 `.sty/.cls` 定义抽取（不执行包代码） |
| **缓存** | 排版完成的 HTML（含 SVG 公式）落盘，同文档二次预览通常 <50 ms |
| **零外部依赖** | 包内自带 WebView2 加载器与 MathJax；不需要 TeX Live / MiKTeX / Python / 联网 |

## 它不管什么

| 不做 | 原因 |
|---|---|
| 不做**分页/分栏/浮动体定位** | 预览是连续滚动，双栏文档按单栏排；页面宽度随窗口 |
| 不做 **TeX 解释器** | 条件分支、`\csname`、catcode、`\let` 别名、`\expandafter` 不执行 |
| 不绘制 **TikZ/PSTricks/xypic** | 显示源码占位；PDF 图片只内联首页 |
| 不读 **`.aux`** | 交叉引用按解析顺序编号，可能与真实编译有细微差别 |
| 不解析**外部 `.bib`** | 文档内 `thebibliography` 正常；类文件内部改写的名称按 LaTeX 默认 |
| 不打开 **>4 MB** 文件 | 提示超出预览范围，避免卡顿 |

## 给谁用

- 经常收/发 `.tex`，只想**快速确认内容与结构**；
- 机器上**没有 TeX**，或不想为看一眼装一套 TeX；
- 用 **tufte / ctex / beamer / 学位论文模板**，需要看大致排版而不是逐像素还原；
- 需要一个**不联网、不写文件、只读**的预览器。

## 安装（给使用者）

### 环境要求

| 环境 | 要求 |
|---|---|
| 系统 | Windows 10 / 11 |
| QuickLook | 4.5+（Store 版或安装版均可） |
| 运行时 | .NET Framework 4.7.2、WebView2 Runtime（随 Edge/系统提供） |
| 外部依赖 | **无**：不需要 TeX / Python / 联网 |
| 许可 | MIT（MathJax 为 Apache-2.0，构建时提取） |

### 安装步骤

1. 到 [Releases](https://github.com/Knot-chord/quicklook-tex-viewer/releases) 下载 `QuickLook.Plugin.TeXViewer.qlplugin`（或直接用仓库 `release/` 里已构建的包）。
2. 确保 QuickLook 在后台运行，选中 `.qlplugin` 按 **空格**。
3. 在弹出面板点 **Install**。
4. 托盘图标 → 退出 QuickLook → 重新启动。

> Store 版 QuickLook 同样可用：`.qlplugin` 会安装到用户可写的插件目录，不需要动 `C:\Program Files\WindowsApps`。

### 装完先验三件事

- 任意 `.tex` 按空格能出预览（不是纯文本）；
- `T` 能切换亮/暗主题（跟随系统 → 浅色 → 深色）；
- `Tab` 能显示/隐藏左侧目录。

## 使用

| 操作 | 效果 |
|---|---|
| 选中 `.tex` 按 **空格** | 渲染预览 |
| `T` | 主题：跟随系统 → 浅色 → 深色 |
| `Tab` | 显示/隐藏左侧目录 |

认领：`.tex` `.latex` `.ltx` `.xtex` 渲染；`.sty` `.cls` `.bib` 纯文本预览。不认领其它格式，不与 TextViewer/MarkdownViewer 冲突。

## 排版细节

- **正文**：两端对齐 + 自动断词；首行缩进（article 1.5em、ctex 2em）；段距 0（LaTeX 语义）
- **标题**：`\part` 罗马数字居中；chapter/section/subsection 层级字号与间距；`\appendix` 后字母编号
- **定理**：`\newtheorem` 共享计数器与 `[section]` 父计数器（Theorem 2.1）；proof 自动补 `□`
- **脚注**：短横线分隔 + 小字号；tufte 类自动转页边注
- **表格**：booktabs 观感（上下边线 + 表头线，无竖线）
- **tufte 页边注**：渲染器输出「正文锚点 + 独立页边栏」结构，页边栏固定右侧列，边注按引用位置垂直对齐，正文不绕排
- **引用**：数字编号与 natbib 作者-年（`\citep` → (Knuth, 1984)、`\citet` → Knuth (1984)）

## 性能与缓存

- 面板复用：连续预览复用同一个 WebView2（`<ReuseWebView>False</ReuseWebView>` 可关）
- MathJax 按需：纯文本文档不加载 2 MB 离线包；超过 3 秒才显示进度条
- 成品缓存：`<数据目录>\TeXViewer.Cache\<源码哈希>-h<页面哈希>.html.gz`，命中直接回放，不加载 MathJax、不重排；上限 120 个 / 64 MB / 14 天（`<EnableCache>False</EnableCache>` 可关）
- 实测：`sample2e` 28 ms；tufte 88 块 128 ms；lshort 章节 435 块约 148 ms；二次预览常见 <50 ms

## 开发（给开发者）

### 从源码构建

```powershell
.\build.ps1 -Install   # 前端 → net472 DLL → 发布目录 + .qlplugin，并安装到 QuickLook
```

依赖：Windows 10/11、.NET Framework 4.7.2、已安装的 QuickLook 4.5+（构建时从它提取离线 MathJax 与 WebView2 加载器）。

### 仓库结构

```
仓库根
├─ build.ps1                        一键构建：前端 → net472 DLL → release/ + .qlplugin，可 -Install
├─ README.md                        本文件：定位、能力、边界、安装、验证
├─ LICENSE                          MIT 许可
├─ .gitignore                       忽略 .build/、解包目录、第三方样例
├─ release/
│  └─ QuickLook.Plugin.TeXViewer.qlplugin   已构建的安装包（选中按空格安装）
├─ docs/badges/                     自托管 badge（SVG，不依赖 shields.io）
│  ├─ quicklook.svg / dotnet.svg / webview2.svg / version.svg
│  └─ tests.svg / deps.svg / license.svg
└─ src/
   ├─ host/                         插件宿主（C# / net472 / WebView2）
   │  ├─ Plugin.cs                  QuickLook IViewer：认领扩展名、准备尺寸、主题
   │  ├─ TeXPanel.cs               WebView2 面板：虚拟主机、资源服务、消息分派、缓存写入
   │  ├─ TeXPanel.Cache.cs         页面资源哈希（缓存版本键，升级自动失效）
   │  ├─ TeXPanel.Packages.cs      同目录 .sty/.cls 宏定义抽取（不执行包代码）
   │  ├─ PdfPageRenderer.cs        PDF → PNG（插件插图与测试工具共用同一实现）
   │  ├─ QuickLook.Plugin.TeXViewer.csproj  插件工程（含嵌入资源）
   │  └─ Translations.config       插件面板的多语言文案
   ├─ web/                          前端（构建时内联进 DLL）
   │  ├─ tex-renderer.js           LaTeX → HTML 解析器（纯函数，可 Node 单测）
   │  ├─ tex-vocab.js              环境/宏/符号词表（数据表）
   │  ├─ app.js                    协议、主题、目录、页边注定位、缓存回放
   │  ├─ plugin.html               页面骨架 + MathJax 配置
   │  ├─ style.css                 主题与排版（按 data-profile 参数化）
   │  └─ vendor/                   离线 MathJax（构建时从 MarkdownViewer 提取）
   ├─ host-test/                    测试宿主（不随插件发布）
   │  ├─ Program.cs                模式：panel / --raw / --pdf / --pdf2png
   │  └─ Harness.csproj            引用插件 DLL 的测试工程
   └─ tools/                        测试与开发工具
      ├─ test-all.js                一键 5 项测试（单元/语料/真实/报告/语义）
      ├─ test-render.js             渲染器单元断言（45 条）
      ├─ corpus-audit.js            27 份构造语料的断言
      ├─ real-samples-audit.js      真实长文档不变量检查
      ├─ report-samples.js          样例渲染报告（Markdown 表格）
      ├─ oracle-audit.js            以 TeX 的 .toc/.aux/.log 为基准的语义核对
      ├─ realtime-preview.ps1       真实 QuickLook 空格自动化（UIA 读预览文本）
      ├─ fetch-web-tex.ps1 / 2      从 GitHub 抓取多样化真实样例
      ├─ fetch-samples.ps1          抓取 samples/real 的 CTAN/仓库样例
      ├─ run-harness.ps1            运行测试宿主
      ├─ verify-plugin.ps1          DLL 静态验收（接口/资源/依赖/目标框架）
      ├─ make-badges.ps1            生成 docs/badges/*.svg
      └─ new-test-page.ps1          生成浏览器测试页（调试渲染）
```

> 仓库只包含源码与构建好的 `.qlplugin`；测试样例未入库，可用 `src\tools\fetch-web-tex*.ps1` 抓取或自备文档。

### 测试与验证

```powershell
node src\tools\test-all.js          # 单元 / 语料 / 真实文档 / 报告 / 语义核对
pwsh -File src\tools\realtime-preview.ps1 -Dir <样例目录>   # 真实空格自动化
```

- 单元：45 条渲染器断言
- 语料：27 份构造样本（结构/列表/表格/数学/定理/引用/宏/中文/坏输入）
- 真实文档：lshort 中文书、revtex、tufte、elsarticle、IEEEtran、lyx 导出等
- 语义核对：以 TeX 自身 `.toc/.aux/.log` 为基准，40 份文档 **0 渲染差异**
- 真实预览：两批共 38 份网络真实文档，用 QuickLook 空格自动化逐份打开并读取预览文本，全部可打开、无错误提示

## 许可

MIT（见 [LICENSE](LICENSE)）。离线 MathJax 为 Apache-2.0，构建时从 QuickLook 自带 MarkdownViewer 提取。
