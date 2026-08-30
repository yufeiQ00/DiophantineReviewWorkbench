# Diophantine Review Workbench

A standalone local review interface for examining a Diophantine equation
family in one window: linked papers and Wikipedia previews, complete repository
files, real Sage execution, review checks, browser-local notes, and a read-only
snapshot of the target repository's development context.

The workbench does not modify DiophantineClassifier. Point it at any local
DiophantineClassifier checkout with `--repo`; refreshing the page reloads that
checkout's current families, code, documentation, and Git metadata.

## Requirements

- Node.js 18 or newer.
- A local DiophantineClassifier checkout.
- SageMath, either on `PATH`, in a Conda environment named `sage`, or inside
  WSL on Windows.

The workbench has no npm runtime dependencies.

## Start the workbench

From this repository, keep the server process running and provide the target
classifier checkout.

Windows PowerShell:

```powershell
$targetRepository = Read-Host "Path to the local DiophantineClassifier checkout"
node server.mjs --repo $targetRepository
```

Linux or macOS:

```bash
read -r -p "Path to the local DiophantineClassifier checkout: " target_repository
node server.mjs --repo "$target_repository"
```

Alternatively, set `REVIEW_REPOSITORY_ROOT` and omit `--repo`. Then open:

```text
http://127.0.0.1:4173/
```

Any local browser works for manual review. For AI-assisted review, the same
page can be opened in Codex's in-app browser or with Claude Code's browser
integration. The webpage contains no embedded AI assistant and makes no model
API calls.

## Sage setup and detection

The server tries the following, without any hard-coded username or home path:

1. `SAGE_EXECUTABLE`, for an explicitly configured native Sage executable.
2. `sage` on the server process `PATH`.
3. On Windows, `WSL_SAGE_EXECUTABLE`, for an explicit Sage path inside WSL.
4. On Windows, an interactive WSL Bash shell running `conda activate sage`.
5. On Linux and macOS, an interactive Bash shell running
   `conda activate sage`.

Failed detection is not cached permanently; a later status check or execution
request retries it.

### Windows with WSL and Conda

Verify the environment from the same ordinary PowerShell account that will
start the workbench:

```powershell
wsl.exe -e bash -ic "conda activate sage; command -v sage; sage --version"
```

For a nonstandard environment, discover and configure its WSL path without
putting a username or home-directory layout in the configuration:

```powershell
$targetRepository = Read-Host "Path to the local DiophantineClassifier checkout"
$env:WSL_SAGE_EXECUTABLE = (wsl.exe -e bash -ic "conda activate sage; command -v sage").Trim()
node server.mjs --repo $targetRepository
```

Do not launch the server under a different Windows account or detached service
identity: that account may not have permission to start your WSL distribution.

### Linux and macOS

If Sage is already on `PATH`, start the workbench normally. Otherwise activate
the environment first or provide its executable explicitly:

```bash
read -r -p "Path to the local DiophantineClassifier checkout: " target_repository
conda activate sage
node server.mjs --repo "$target_repository"
```

```bash
SAGE_EXECUTABLE="$(command -v sage)" node server.mjs --repo "$target_repository"
```

The Sage pane reports the detected environment and version. Results come only
from the local Sage process; there are no simulated mathematical answers.

## Review workflow

1. Select or filter a family.
2. Read its registry metadata and linked sources.
3. Inspect highlighted locations in the complete matcher, solver, tests,
   documentation, and bibliography files.
4. Run independent Sage checks and record conclusions in Review notes.
5. Open **Development context** to inspect the current branch, HEAD commit,
   tracked working-tree changes, project guidance, design documents, and
   family-related pull-request and issue searches against the canonical
   upstream repository.
6. Refresh after target-repository changes to rebuild the index.

Development context is deliberately read-only. It runs only Git inspection
commands and previews an explicit allowlist of guidance files. Untracked
filenames are never requested or displayed, and the preview allowlist contains
only shared project documentation. The panel cannot stage, commit, switch
branches, push, edit files, or run the displayed verification commands.
Personal fork remotes are never requested or displayed.
Candidate guidance paths that do not exist in the target checkout are omitted
instead of being reported as local state.

When the classifier raises `SolverUnavailable`, the Sage pane presents it as
an expected amber **automatic solver not implemented** result. The workbench
does not change or suppress unexpected exceptions.

## Local notes

Review notes are stored directly in browser `localStorage`, keyed by family.
There is no notes API, export request, repository file, or model call. Notes
therefore remain in that browser profile unless the reviewer deliberately
copies them elsewhere. Clearing the browser's site data removes them.

## Security

**The Sage pane intentionally executes arbitrary local Sage/Python code with
the permissions of the user running the server.** The 45-second timeout is not
a security sandbox.

- The server is hard-bound to `127.0.0.1`; do not change this or expose it to a
  LAN, tunnel, container ingress, or public hosting service.
- Start it only for local review and stop it when finished.
- Execution accepts same-origin requests carrying a workbench-only header, but
  this is defense in depth, not a multi-user security boundary.
- Review commands before running them, including commands suggested by an AI.

PDF previews are fetched only from open-access URLs declared in the target
repository bibliography. Wikipedia cards use Wikipedia's public summary API.
The web integrations remain separate from the classifier package, preserving
its no-web-dependencies contract.
