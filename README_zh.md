# Resume Workbench / 简历工作台

[English](README.md) · [本地编辑器详细说明](docs/local-editor.md)

> [!IMPORTANT]
> **启动网页编辑器前，必须先在本机安装 Node.js 22 或以上版本，推荐 Node.js 24 LTS。**
> **Node.js 20 及更低版本不受支持，启动脚本会拒绝运行；下载或克隆本项目不会自动安装 Node.js。**
> Windows 用户请选择 **Windows Installer（`.msi`）** 安装包。本项目无需 Docker，**不要复制 Node 官网的 `docker pull` / `docker run` 命令来安装本机 Node**。

Resume Workbench（简历工作台）保留原来的 XeLaTeX 简历模板，并提供本机网页编辑器。你可以分模块编辑中文或英文简历、调整版式、替换校徽，再通过 XeLaTeX 更新 PDF 预览与下载。中文与英文独立保存，切换模板不会自动翻译文字。

第一版是可修改的源码，尚未打包运行环境。需要 **Node.js 22+**；生成 PDF 另需 **XeLaTeX 和模板所需宏包**（MiKTeX 或 TeX Live）。项目内含 Lato 和**思源宋体（Source Han Serif）**字体，不需要额外安装这些字体。网页服务只用 Node 标准库，不需要 npm 安装、前端构建、Docker 或付费服务器。

## 首次使用：先安装 Node.js（必读）

### Windows 安装与检查

1. 打开 [Node.js 官方下载页](https://nodejs.org/en/download)，选择 **Node.js 24 LTS 和 Windows**，在页面的预编译下载区域点击 **Windows Installer（`.msi`）**。普通 Intel / AMD 64 位电脑选 **x64**；Windows ARM 电脑选 **ARM64**。已经安装 Node.js 20 的用户也需要升级。
2. 双击 `.msi` 安装包，按默认选项完成安装，保留 **Add to PATH** 选项。**安装后关闭原来的 PowerShell / CMD，再打开新终端**，让新版本生效。
3. 在新终端中检查版本：

   ```powershell
   node -v
   ```

   **应显示 `v24.x.x`（或其他 22 及以上版本）。** 如果仍显示 `v20.x.x`，说明终端还在使用旧版；运行 `where.exe node` 查看实际执行路径，确认安装完成且 PATH 中没有优先使用旧版 Node。若提示找不到 `node`，请检查是否安装成功并启用了 Add to PATH。
4. 进入包含 `server/` 和 `start.cmd` 的项目根目录，再运行：

   ```powershell
   .\start.cmd
   ```

> [!WARNING]
> 如果启动时出现 **`Node.js 22 or newer is required.`**，请先完成上面的版本检查和本机安装。Docker 容器里的 Node 与 Windows 本机 Node 是两套环境，拉取 Node Docker 镜像不会升级本机的 `node` 命令。

> [!NOTE]
> **生成 PDF 还需要 XeLaTeX（MiKTeX 或 TeX Live）和模板所需宏包。** 仅安装 Node.js 可以启动编辑、保存和备份功能；PDF 环境准备见[详细说明](docs/local-editor.md)。无需运行 `npm install`。

## 本机启动（完成上述准备后）

进入包含 `server/` 和 `start.cmd` 的项目根目录：

- Windows：双击 `start.cmd`，或在终端运行 `.\start.cmd`。
- Linux/macOS：运行 `sh ./start.sh`。
- 直接运行：`node server/index.mjs`；加 `--no-open` 可关闭自动打开浏览器。

默认访问 [http://127.0.0.1:3000](http://127.0.0.1:3000)。终端保持运行；关闭时按 Ctrl+C。首次空数据目录会建立中英两份虚构示例，示例可直接修改。私有内容不会成为其他用户的默认数据。

同一数据目录只允许一个服务实例，使用不同网页端口也不能同时打开。重启或更新前先停止已有服务；独占保护及少见的系统占用冲突见[详细说明](docs/local-editor.md)。

服务启动时检测 PATH 与常见安装目录中的 XeLaTeX。已安装却检测失败时，将 `config.example.json` 复制为 `config.local.json`，设置 `xelatexPath` 为完整可执行文件路径，然后重启。Windows 的 JSON 路径可使用正斜杠。缺少编译器仍可编辑、保存和备份；缺少宏包时需通过发行版管理工具手动安装，本程序不会自动安装宏包。准备、配置与故障排查见[详细说明](docs/local-editor.md)。

当前优先验证 Windows；提供 Linux/macOS 源码入口，尚未宣称在这些系统完成运行验证。

## 编辑与携带

- 内容停止输入约 800ms 后自动保存。PDF 需手动点击“更新预览”，按钮会等待最新保存完成；下载与预览使用同一构建。失败时保留上次成功 PDF，请检查修订提示。
- 预览区显示成功 PDF 页数、多页建议及编译警告；日志链接始终指向本次尝试。失败时旧 PDF 下载链接仍保留，并与本次失败日志区分。
- 新建中文或英文简历，或复制当前内容后手动翻译。界面默认中文，内容语言与界面语言是两个概念。
- 自动纸张：中文 A4、英文 Letter；也可明确选择 A4/Letter。正文 10/11/12pt、标准/紧凑间距、边距 8–20mm。
- 校徽支持默认、隐藏或自定义 PNG/JPG（最大 5MiB）。宽度 1.2–3.2cm，默认 2.4cm，高度最多 3.2cm。
- “导出备份”保存内容、版式和自定义校徽；换机后“导入备份”创建新记录（最大 10MiB）。PDF 是成品，不能用于恢复编辑数据。
- 默认个人存储 `.purecv/` 与本地配置 `config.local.json` 已被 Git 忽略。备份含个人信息，应自行妥善保存；自定义到其他数据目录时需自行配置 Git 忽略。

一次性迁入明确准备好的私有结构化 JSON：

```powershell
node scripts/import-personal-data.mjs ".purecv/private-resume.zh.json"
```

输入必须为 `{name:string,data:ResumeData}`（字段见 `web/shared/model.mjs`）。每次导入新建 UUID，不覆盖现有简历；终端只打印简历名称与 ID。此入口不解析任意 TeX，不导入图片引用；带校徽的跨机器迁移请使用网页备份。不要将真实资料放入 `examples/`。

## 原 LaTeX 手工使用方式

网页模板位于 `templates/`；原始 `resume/` 与 `resume_zh/` 的源码仍可手工修改，公开内容模块均为虚构示例。手工方式只需要 XeLaTeX（不需要 Node）；使用 Makefile 另需 make，文件监控另需 Bash、fswatch、realpath 与 find。

从项目根目录进入对应子目录，不能直接在根目录运行 make：

```sh
# 英文：输出 resume/resume.pdf
cd resume
make
# 或直接运行
xelatex resume.tex
```

```sh
# 中文：输出 resume_zh/resume_zh.pdf
cd resume_zh
make
# 或直接运行
xelatex resume_zh.tex
```

在对应子目录运行 `make clean` 会删除中间文件及该目录生成的 PDF。Windows 未安装 make 时可直接执行 XeLaTeX。若使用 MiKTeX 并希望禁止自动安装，请手工命令加 `--disable-installer`。

英文入口为 `resume/resume.tex`，模块在 `resume/src/`；中文入口为 `resume_zh/resume_zh.tex`，模块在 `resume_zh/src/`。修改姓名、联系方式、教育、项目和技能等对应模块。标题样式由实际入口的 `input`/`insertHeading` 设置控制，切换时检查正在编译的入口；网页数据不会反向修改这些原文件。

如需监控，在相应子目录执行 `bash ./watch_tex.sh`，脚本使用当前目录，需要先安装其依赖。

## 许可与来源

本项目基于 Wick Dynex 的 PureCV 模板，保留原始 Copyright (c) 2024 及 [MIT License](LICENSE)。PureCV 受 [Resume Template](https://github.com/aserador/resume-template) 启发。Lato 和思源宋体许可分别保留在 `font/Lato/OFL.txt` 与 `font/Simsun/LICENSE.txt`。

`resume_zh/build_copy_friendly_pdf.py` 是可选的 PDF 检查与复制工具，需要 Python 和 pypdf；网页编辑器及手工 XeLaTeX 编译均不依赖它。
