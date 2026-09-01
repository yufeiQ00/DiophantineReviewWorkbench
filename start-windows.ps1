param(
  [string]$Repo = ""
)

$ErrorActionPreference = "Stop"

function Invoke-WslProbe {
  param(
    [string]$Distro = ""
  )

  $probe = @'
set -e

if command -v sage >/dev/null 2>&1; then
  command -v sage
  exit 0
fi

if command -v conda >/dev/null 2>&1; then
  CONDA_BASE="$(conda info --base 2>/dev/null || true)"
else
  CONDA_BASE=""
fi

if [ -z "$CONDA_BASE" ]; then
  for candidate in "$HOME/miniforge3" "$HOME/mambaforge" "$HOME/miniconda3" "$HOME/anaconda3" /opt/conda; do
    if [ -x "$candidate/bin/conda" ]; then
      CONDA_BASE="$candidate"
      break
    fi
  done
fi

if [ -n "$CONDA_BASE" ] && [ -f "$CONDA_BASE/etc/profile.d/conda.sh" ]; then
  . "$CONDA_BASE/etc/profile.d/conda.sh"
  if conda activate sage >/dev/null 2>&1 && command -v sage >/dev/null 2>&1; then
    command -v sage
    exit 0
  fi
fi

for candidate in \
  "$HOME/miniforge3/envs/sage/bin/sage" \
  "$HOME/mambaforge/envs/sage/bin/sage" \
  "$HOME/miniconda3/envs/sage/bin/sage" \
  "$HOME/anaconda3/envs/sage/bin/sage" \
  "/opt/conda/envs/sage/bin/sage"; do
  if [ -x "$candidate" ]; then
    printf '%s\n' "$candidate"
    exit 0
  fi
done

exit 1
'@

  $arguments = @()
  if ($Distro) {
    $arguments += @('-d', $Distro)
  }
  $arguments += @('-e', 'bash', '-lc', $probe)

  $output = & wsl.exe @arguments 2>$null
  if ($LASTEXITCODE -ne 0) {
    return $null
  }

  $path = ($output | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ -like '/*' } | Select-Object -Last 1)
  if (-not $path) {
    return $null
  }
  return $path
}

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
  throw "WSL was not found. Install/enable WSL, or run the workbench from an environment where Sage is available on PATH."
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js was not found on PATH. Install Node.js 18 or newer first."
}

$sagePath = $null

if ($env:WSL_SAGE_EXECUTABLE) {
  & wsl.exe -e $env:WSL_SAGE_EXECUTABLE --version *> $null
  if ($LASTEXITCODE -eq 0) {
    $sagePath = $env:WSL_SAGE_EXECUTABLE
  }
}

if (-not $sagePath) {
  $sagePath = Invoke-WslProbe
}

if (-not $sagePath) {
  $distros = @(& wsl.exe -l -q 2>$null | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ })
  foreach ($distro in $distros) {
    $candidate = Invoke-WslProbe -Distro $distro
    if ($candidate) {
      Write-Host "Sage was found in WSL distribution '$distro' at $candidate." -ForegroundColor Yellow
      Write-Host "The current workbench server uses the default WSL distribution." -ForegroundColor Yellow
      $answer = Read-Host "Set '$distro' as the default WSL distribution so the workbench can use Sage? [Y/n]"
      if ([string]::IsNullOrWhiteSpace($answer) -or $answer -match '^[Yy]') {
        & wsl.exe --set-default $distro
        if ($LASTEXITCODE -ne 0) {
          throw "Failed to set '$distro' as the default WSL distribution."
        }
        $sagePath = Invoke-WslProbe
        break
      }
    }
  }
}

if (-not $sagePath) {
  throw @"
No Sage executable could be found in WSL.

Try this manually:
  wsl.exe -e bash -lc "command -v sage; conda info --base"

If your Sage environment has a different name, activate it and set:
  `$env:WSL_SAGE_EXECUTABLE = "/absolute/path/to/sage"
"@
}

$env:WSL_SAGE_EXECUTABLE = $sagePath

$versionOutput = & wsl.exe -e $sagePath --version 2>&1
if ($LASTEXITCODE -ne 0) {
  throw "Sage was found at '$sagePath', but '$sagePath --version' failed: $versionOutput"
}

Write-Host "Using Sage: $sagePath" -ForegroundColor Green
Write-Host ($versionOutput | Select-Object -First 1) -ForegroundColor Green

if (-not $Repo) {
  if ($env:REVIEW_REPOSITORY_ROOT) {
    $Repo = $env:REVIEW_REPOSITORY_ROOT
  } else {
    $Repo = Read-Host "Path to the local DiophantineClassifier checkout"
  }
}

if (-not $Repo) {
  throw "A DiophantineClassifier checkout path is required."
}

$serverPath = Join-Path $PSScriptRoot 'server.mjs'
& node $serverPath --repo $Repo
exit $LASTEXITCODE
