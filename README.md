# Resume Workbench / 简历工作台

[中文](README_zh.md) · [Detailed local editor guide](docs/local-editor.md)

> [!IMPORTANT]
> **Windows: run `setup.cmd` first, then `start.cmd`. No preinstalled Node or administrator rights are needed.**
> **The first setup needs internet access to download pinned portable Node.js 24.21.0 from nodejs.org; it verifies SHA256 before use and stores it in `.runtime/node/`.** A healthy runtime is reused offline. Setup leaves the system Node, registry and global PATH alone.
> **Linux/macOS: install Node.js 22+ manually. PDF generation on every platform additionally needs XeLaTeX and the template packages (MiKTeX or TeX Live).** This project requires neither npm install nor Docker.

Resume Workbench combines the original XeLaTeX resume templates with a local browser editor. Edit Chinese or English resumes by section, adjust layout, replace the logo, and generate a PDF preview and download. Each language has independent content; choosing a template does not translate your text.

The project ships editable source. Windows setup downloads a project-local runtime; Node is not vendored in Git. The editor requires **Node.js 22+**; PDF generation additionally requires **XeLaTeX and the template packages** from MiKTeX or TeX Live. Lato and **Source Han Serif** fonts are included and do not need separate font installation. The local server uses Node's standard library: no npm install, frontend build, Docker, or paid server is needed.

## First-time Windows setup

1. Clone or download the complete project into a writable folder and double-click **`setup.cmd`** (or run `.\setup.cmd` in PowerShell). It uses Windows PowerShell 5.1 to download official portable Node for native x64 or ARM64 Windows and validate its checksum, version and architecture. Other architectures are unsupported.
2. Read the result, then double-click **`start.cmd`** (or run `.\start.cmd`). Setup does not start the server. `setup.cmd --no-pause` is available for automation; otherwise its window remains readable until a key is pressed.
3. Setup checks your existing XeLaTeX using the same configuration/discovery as the editor. If missing, Node/editor features still work; install [MiKTeX](https://miktex.org/download) or TeX Live for PDF generation and follow the [guide](docs/local-editor.md). **Finding XeLaTeX confirms compiler identity; the first PDF compilation verifies package availability.** Setup installs no compiler/packages and writes no local configuration.

`start.cmd` prefers this project's `.runtime/node/node.exe` even when an older system Node is present. Its PATH change applies only to the launched process and its children. `.runtime/` is Git ignored; it contains downloaded runtimes and temporary files, and must not be committed. Rerun setup to repair an incorrect/broken runtime; download or validation failures preserve an existing runtime. Setup needs neither system Node nor administrator rights and makes no global installation changes.

### Alternative: manually install system Node

1. Open the [official Node.js download page](https://nodejs.org/en/download), select **Node.js 24 LTS and Windows**, and click **Windows Installer (`.msi`)** in the prebuilt downloads area. Choose **x64** for Intel / AMD 64-bit PCs or **ARM64** for Windows ARM PCs. If you already have Node.js 20, upgrade it first.
2. Run the `.msi` installer with its default options, keeping **Add to PATH** enabled. **Close your existing PowerShell / CMD window and open a new terminal after installation** so it can find the new version.
3. Check the version in the new terminal:

   ```powershell
   node -v
   ```

   **Expect `v24.x.x` (or another version numbered 22 or higher).** If it still shows `v20.x.x`, the terminal is using the older installation. Run `where.exe node` to inspect the executable paths and check that installation finished and PATH does not prioritize an older Node. If `node` is not found, check that installation succeeded with Add to PATH enabled.
4. Enter the project root containing `server/` and `start.cmd`, then run:

   ```powershell
   .\start.cmd
   ```

> [!WARNING]
> If startup reports **`Node.js 22 or newer is required.`**, run `setup.cmd` to prepare or repair the local runtime, or complete the manual installation above. Without a local runtime, `start.cmd` accepts system Node 22+. Node inside a Docker container is separate from Node on Windows; pulling a Node Docker image does not upgrade your computer's `node` command.

> [!NOTE]
> **PDF generation also requires XeLaTeX (MiKTeX or TeX Live) and the template packages.** Node.js alone enables editing, saving, and backups. See the [detailed guide](docs/local-editor.md) for PDF environment setup. No `npm install` is needed.

## Start locally (after completing setup)

Use the project root containing `server/` and the launchers:

- Windows: double-click `start.cmd` or run `.\start.cmd` in a terminal.
- Linux/macOS: run `sh ./start.sh`.
- Direct entry with manual Node: `node server/index.mjs`; append `--no-open` to skip opening the browser. With portable Windows Node, use `.runtime\node\node.exe server/index.mjs` or `start.cmd --no-open`.

The default address is [http://127.0.0.1:3000](http://127.0.0.1:3000). Keep the terminal running; press Ctrl+C to stop. An empty data directory is initialized with two fictional examples. Personal imports are separate and never become the public defaults.

Only one service may own a data directory, even with different HTTP ports. Stop the existing service before restarting or updating. Ownership and rare local reservation conflicts are explained in the [guide](docs/local-editor.md).

Startup checks PATH and common installation directories for XeLaTeX. If an existing installation is not found, copy `config.example.json` to `config.local.json`, set `xelatexPath` to the full executable path, and restart. Forward slashes are convenient in Windows JSON paths. Editing, saving, and backups work without a compiler. Missing packages must be installed manually through your distribution's manager; this app does not install packages automatically. See the [setup and troubleshooting guide](docs/local-editor.md) and the workspace's environment-help button.

Windows is the current validation priority. Linux/macOS source launchers are provided; runtime validation on those systems is not claimed.

## Edit and move between machines

- Changes save automatically after about 800ms without input. Click “更新预览” (Update preview) manually to compile; it waits for the latest save. Preview and download use the same build. A failed build keeps the last successful PDF; check its revision before downloading.
- The preview shows successful PDF page count, multipage guidance, and warnings. Its log link always identifies the current attempted build; after failure, the older PDF links stay available.
- Create a Chinese or English resume, or copy an existing one and translate the content manually. The interface defaults to Chinese; interface language and resume content language are separate.
- Automatic paper is A4 for Chinese and Letter for English. Explicit A4/Letter, 10/11/12pt body text, standard/compact spacing, and 8–20mm margins are available.
- Use the default logo, hide it, or upload PNG/JPG (up to 5MiB). Width is 1.2–3.2cm (default 2.4cm); height is capped at 3.2cm.
- “导出备份” (Export backup) includes content, layout, and custom logo. “导入备份” (Import backup) creates a new record on another machine (up to 10MiB). A PDF cannot restore editable data.
- Default personal storage `.purecv/` and `config.local.json` are Git ignored. Protect backups as personal files. If you choose another data directory, configure your own ignore rules.

For a one-time import of explicitly prepared private structured JSON, stop the service first. Windows users following `setup.cmd` should use the project-local runtime from the project root:

```powershell
.\.runtime\node\node.exe scripts/import-personal-data.mjs ".purecv/private-resume.zh.json"
```

Linux/macOS, or users who manually installed system Node 22+, can use:

```sh
node scripts/import-personal-data.mjs ".purecv/private-resume.zh.json"
```

Input must be `{name:string,data:ResumeData}`; see `web/shared/model.mjs`. Each run creates a new UUID and never replaces another document. Standard output contains only the resume name and ID. This entry does not parse arbitrary TeX or import image references; use browser backups to move a resume with its custom logo. Never put real personal information in `examples/`.

## Original manual LaTeX workflow

The editor uses `templates/`. The original `resume/` and `resume_zh/` sources remain editable by hand, with fictional content in all public modules. This workflow needs XeLaTeX, not Node. Makefile usage additionally requires make; watch scripts require Bash, fswatch, realpath, and find.

Enter the appropriate subdirectory from the project root; the root has no resume Makefile:

```sh
# English: creates resume/resume.pdf
cd resume
make
# Or use XeLaTeX directly:
xelatex resume.tex
```

```sh
# Chinese: creates resume_zh/resume_zh.pdf
cd resume_zh
make
# Or use XeLaTeX directly:
xelatex resume_zh.tex
```

Run `make clean` in that same directory to remove intermediates and its generated PDF. Windows users without make can use XeLaTeX directly. For manual MiKTeX compilation without automatic package installation, append `--disable-installer`.

English starts at `resume/resume.tex` with modules in `resume/src/`; Chinese starts at `resume_zh/resume_zh.tex` with modules in `resume_zh/src/`. Edit the corresponding heading and content modules. Heading selection follows the active entry's `input`/`insertHeading` setup; confirm which entry you compile. Editor data does not modify these original sources.

To watch changes, install the watch dependencies and run `bash ./watch_tex.sh` from the corresponding subdirectory; the scripts watch the current directory.

## License and inspiration

Derived from the PureCV templates by Wick Dynex, whose original copyright (c) 2024 and [MIT License](LICENSE) are preserved. PureCV was inspired by [Resume Template](https://github.com/aserador/resume-template). Lato and Source Han Serif font licenses remain in `font/Lato/OFL.txt` and `font/Simsun/LICENSE.txt`.

`resume_zh/build_copy_friendly_pdf.py` is an optional PDF validation/copy helper requiring Python and pypdf; it is not needed by the editor or manual XeLaTeX workflow.
