# 安装与最终发布 ZIP 验证矩阵

记录日期：2026-10-12。代码和本机资源测试能够证明发布包的组装、校验与首启行为；**尚未执行无预装 Node/TeX 的 Windows 11 x64 普通用户干净 VM 安装**。本记录不把已有 MiKTeX 的开发机或 GitHub 托管 runner 当作干净环境证据。

本任务最新单文件回归：`.runtime\node\node.exe --test tests/release-package.test.mjs`，29 项通过、0 失败、0 跳过，24.89 秒。初始打包入口不存在、侧车竞争误删、样例 JSON 未验证与未提升管理员账户误通过均先观察到失败，再实现后通过。Node 脚本与 PowerShell helper / workflow 脚本块已通过语法检查。完整仓库与真实 PDF 回归由本轮总验收另行记录。

## 本轮证据与未执行项

| 场景 | 执行环境与制品 | 已观测结果 | 边界 |
| --- | --- | --- | --- |
| ZIP 组装、独立解码、摘要及确定性 | 本机项目 Node 24.21.0；只复制公共源码的临时 fixture | 固定排序和 ZIP 时间；两次输出逐字节相同；独立 ZIP 读取器核对所有文件 SHA256 | 未运行 setup；制品来自 fixture |
| 六份字体、中英模板、共享宏、默认图片、许可及两份样例分别缺失 | 临时源目录，每次仅删除一个必需资源 | 打包非零退出，不产生最终 ZIP | 不修改产品资源 |
| TTF 损坏、模板新增未登记宏包、缺发行版包 ID 映射、样例 JSON / 语言不合规 | 临时源目录 | 分别拒绝发布；字体检查含 sfnt 表范围、表校验和、整字体校验和 | 字体结构校验不能替代 XeLaTeX 的实际字形与嵌入验证 |
| 个人数据、私有文档、缓存与本地配置排除 | 私有目录与保留文件名内放置 canary | ZIP 中没有 canary 或被禁止路径 | allowlist 管理公共源目录；不会从任意文件内容自动识别所有敏感数据 |
| 源 junction / symlink、输出 junction、覆盖源码或配置 | Windows 原生路径 API 和真实临时 junction | 拒绝越界或覆盖；配置摘要不变 | 沙盒会拒绝 realpath / junction，故本机这些单测使用原生测试权限；没有运行安装 |
| 并发打包与侧车文件竞争 | 两个真实 Node 打包进程；第三方在 ZIP 临时文件写入期间创建侧车 | 只有一个完整候选成功；失败清理只删除本次成功发布的文件，保留竞争者侧车 | 不覆盖既有 ZIP；重打包须使用新输出名 |
| 最终 ZIP 首次启动及重启 | 真实 ZIP 解压到中文、空格目录，显式缺失编译器的临时配置 | 首页与简历 API 返回成功；中英虚构样例各一份；重启保持相同 ID | 该测试仅证明编辑器首启，未下载 Node/TeX，未生成 PDF |
| 普通用户清洁环境 gate | PowerShell 5.1 的字面 profile fixture | 允许合格 Windows 11 x64 普通用户；拒绝旧系统、ARM64、提升权限、管理员组成员、预装工具、缓存和缺 snapshot ID | fixture 验证判定逻辑；不是 VM 安装实测 |
| 最终 ZIP 的真实双语、字体、图片、链接和多页 native text | Windows 11 build 26200；ZIP 安装目录中的 Node 24.21.0；已有 MiKTeX 24.1；明确指定的独立 PDF QA Python | 两项实际 PDF QA 通过，无跳过；中英样例各一页，多页样例各两页；末行文字、六份嵌入字体、图片及链接均通过，制品摘要见[总验收记录](installation-p1p2.md) | 已有 TeX 主机上的最终 ZIP QA；没有运行 setup 或升级主机 TeX，不能替代干净安装 |
| 全新 Windows 11 x64 普通用户，在线 setup → doctor → 重跑复用 | 手动 CI 的 reset VM snapshot，最终发布 ZIP | **未执行** | workflow 已准备；需要真实空白 VM 和实际运行工件 |
| 干净 VM 故意缺 geometry，自动修复并双语编译 | 独立基础 MiKTeX VM | **未执行** | 既有故障 fixture 不替代真实缺包 VM |
| 真正断网失败 / 恢复、无写权限、两个同时 setup | 每个场景从 reset VM 的最终 ZIP 开始 | **未执行** | 自动化单测已有相应故障输入；这些真实系统 / 网络矩阵仍需独立执行 |
| Windows 10、原生 ARM64、Linux/macOS 自动安装、离线镜像 | 各自独立兼容性环境 | **未执行，不在首轮自动部署验收范围** | Node 可运行不等于 MiKTeX 可自动部署 |

## 可重复的发布候选

使用项目 Node，不需要 npm、Python 或 TeX 来打包。输出必须是新的 `.zip` 文件；只收集公共 `samples/`、`web/`、`server/`、`scripts/`、`templates/`、`licenses/`、清单指定字体与许可，以及明确列举的公共入口 / 文档。不递归收集 `docs/`，不读取 Git 历史。

```powershell
& .runtime\node\node.exe --test tests/release-package.test.mjs
& .runtime\node\node.exe scripts/package-release.mjs --output .runtime\releases\purecv-candidate.zip
& .runtime\node\node.exe scripts/release-verify.mjs --zip .runtime\releases\purecv-candidate.zip
```

内部 `RELEASE-MANIFEST.json` 记录资源清单、TeX 依赖、发行版包 ID 与所有源码 / 资源的长度和 SHA256。外部 `purecv-candidate.zip.sha256` 核对整个 ZIP，`.manifest.json` 与内部清单相同。摘要用于识别与对比制品；不提供发布者签名认证。

只有网页适配器进入该候选包。原手工 `resume/`、`resume_zh/` 的模板、真实内容、构建产物与额外宏包依赖不进入包；手工模板例如 `fontawesome5` 的独立依赖不属于网页安装合同。公共虚构样例位于 `samples/`，默认图片位于 `templates/default-logo.png`。

## 干净 Windows CI 的执行合同

工作流为 `.github/workflows/windows-release-check.yml`。PR 自动执行打包检查；真实安装仅在 `workflow_dispatch` 勾选 `clean_install` 后执行，避免普通 push 意外触发长时间下载。

准备 label 为 `self-hosted, Windows, X64, clean-win11-x64` 的一次性 VM runner。执行前真正恢复无 Node/TeX 的 Windows 11 x64 snapshot，由不属于 Administrators 的普通账户运行，并填写可追溯 snapshot ID。GitHub Actions 自带的内部 action runtime 不属于产品 Node；产品 Node 必须由候选的 `setup.cmd` 下载并校验，QA 后续也使用该项目 runtime。

预检在修改 PATH、安装 QA 工具前运行 `where.exe`，要求 Node、XeLaTeX、包管理 / 查询工具、Python、Poppler 与 make 不可从 PATH 找到；检查常见 MiKTeX / TeX Live 用户目录、缓存与 MiKTeX registry。预检不通过会保留失败记录。**PATH 和常见目录检查无法排除任意自定义安装目录，所以 snapshot 的真实恢复是前提。** 不得把清空 PATH 或删除项目 `.runtime` 当作干净 VM。

从最终 ZIP 解压到含中文与空格的目录，先比较外部 SHA256，然后依次执行：

```text
setup.cmd --no-pause
doctor.cmd --no-pause
setup.cmd --no-pause
```

要求每次退出 0，Node 版本 / 架构符合固定清单，托管 TeX generation 和指纹在重跑后复用。完成这些产品步骤以后才引入开发 QA 的 Python / pypdf / pdfplumber，独立解析真实双语和多页 PDF；缺 QA 工具直接失败，不跳过。产品安装仍不依赖 Python、Poppler、make 或 npm。

CI 保存候选及 SHA256、`clean-preflight.json`、`installation.json`、`release-pdf-summary.json`、实际包版本、Node / 引擎信息、公开样例 PDF、解析记录及脱敏日志。只上传指定公共文件，不上传 `.purecv/`、完整 `.runtime/`、registry 或原始安装日志。独立 QA 包信息使用 [MiKTeX packages info 的官方模板字段](https://docs.miktex.org/manual/miktex-packages.html)；bootstrap SHA256 固定引导工具，宏包仓库内容仍会变化，不能声称完整仓库版本已经锁定。

在线失败恢复、受限目录与并发真实安装仍在上表标为未执行。此 workflow 的首轮在线通过也不能自动替代这些故障场景。

## 已有 MiKTeX 主机上的最终 ZIP QA

可在已安装 MiKTeX 的主机验证最终 ZIP 的真实 PDF，明确记录为“已有环境 QA”。以下操作只解压候选和复制现有项目 Node，不调用 setup、repair 或 TeX bootstrap。保持源目录和 QA 独立，使用新的测试目录；填写真实候选 ZIP 与现有 Python 的绝对路径。

```powershell
$qaProject = 'D:\Projects\PureCV-local-editor\PureCV-main'
$qaZip = Join-Path $qaProject '.runtime\releases\purecv-candidate.zip'
$qaRoot = Join-Path $qaProject ('.runtime\release-qa\最终ZIP 中文 空格-' + [guid]::NewGuid().ToString('N'))
$qaEvidence = Join-Path $qaRoot '.runtime\public-qa-evidence'
Expand-Archive -LiteralPath $qaZip -DestinationPath $qaRoot
New-Item -ItemType Directory -Path (Join-Path $qaRoot '.runtime\node') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $qaProject '.runtime\node\node.exe') -Destination (Join-Path $qaRoot '.runtime\node\node.exe')
$env:PURECV_INSTALL_ROOT = $qaRoot
$env:PURECV_RELEASE_ZIP = $qaZip
$env:PURECV_RELEASE_EVIDENCE = $qaEvidence
$env:PURECV_PDF_INSPECTOR = Join-Path $qaProject 'tests\integration\inspect_pdf.py'
# PURECV_PYTHON must already point to the explicit developer QA Python.
# Optional PURECV_XELATEX selects an existing supported compiler.
Remove-Item Env:PURECV_REQUIRE_CLEAN_VM -ErrorAction SilentlyContinue
& (Join-Path $qaRoot '.runtime\node\node.exe') --test --test-name-pattern='final release ZIP' (Join-Path $qaProject 'tests\integration\fresh-install.test.mjs')
```

这个命令只选择两个 PDF QA 测试；完整 `fresh-install.test.mjs` 还要求清洁 VM 预检与真实 setup 记录，缺记录必须失败。宿主 QA 的摘要中 `cleanVm` 为 false。测试不读取个人简历；产物均由产品的公开验收样例或固定虚构多页内容生成。

通过后的环境记录仍会因模板、字体、样例、依赖文件或引擎变化而失效。用户修改源码后须重新运行 doctor / 网页重新检测，不因为发布候选的摘要而禁止可编辑源码。
