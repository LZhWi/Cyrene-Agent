$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$venvPath = Join-Path $repoRoot ".venv-asr"
$pythonPath = Join-Path $venvPath "Scripts\python.exe"
$pipPath = Join-Path $venvPath "Scripts\pip.exe"
$requirementsPath = Join-Path $repoRoot "local_asr\requirements.txt"

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string[]]$CommandArgs
  )
  & $Executable @CommandArgs
  if ($LASTEXITCODE -ne 0) {
    throw "$Executable failed with exit code $LASTEXITCODE"
  }
}

$venvReady = (Test-Path -LiteralPath $pythonPath) -and (Test-Path -LiteralPath $pipPath)

if (-not $venvReady) {
  if (Get-Command uv -ErrorAction SilentlyContinue) {
    Invoke-Checked -Executable "uv" -CommandArgs @("venv", "--clear", "--seed", "--python", "3.12", $venvPath)
  } elseif (Get-Command py -ErrorAction SilentlyContinue) {
    Invoke-Checked -Executable "py" -CommandArgs @("-3.12", "-m", "venv", "--clear", $venvPath)
  } else {
    throw "uv or Python 3.12 was not found. Install Python 3.12 and retry."
  }
}

Invoke-Checked -Executable $pythonPath -CommandArgs @("-m", "pip", "install", "--upgrade", "pip")
Invoke-Checked -Executable $pythonPath -CommandArgs @("-m", "pip", "install", "torch", "torchaudio", "--index-url", "https://download.pytorch.org/whl/cu130")
Invoke-Checked -Executable $pythonPath -CommandArgs @("-m", "pip", "install", "-r", $requirementsPath)

Invoke-Checked -Executable $pythonPath -CommandArgs @("-c", "import torch; assert torch.cuda.is_available(), 'CUDA is not available'; print('CUDA available:', torch.cuda.is_available()); print('GPU:', torch.cuda.get_device_name(0))")
Invoke-Checked -Executable $pythonPath -CommandArgs @("-c", "import qwen_asr, funasr; print('qwen_asr and funasr imports: OK')")
Write-Host "Local ASR environment is ready. Model weights download on first use."
