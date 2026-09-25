$ErrorActionPreference = 'Stop'
$deskUrl = 'http://127.0.0.1:43129'
try {
    $deskReady = $false
    try { $deskReady = (Invoke-RestMethod "$deskUrl/api/progress" -TimeoutSec 2).app -eq 'pcquote-progress' } catch {}
    if (-not $deskReady) {
        $deskNode = (Get-Command node -ErrorAction SilentlyContinue).Source
        if (-not $deskNode) { $deskNode = 'C:\Users\wuerl\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
        Start-Process -FilePath $deskNode -ArgumentList ('"' + (Join-Path $PSScriptRoot 'server.cjs') + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
        for ($deskAttempt = 0; $deskAttempt -lt 20; $deskAttempt++) {
            Start-Sleep -Milliseconds 250
            try { if ((Invoke-RestMethod "$deskUrl/api/progress" -TimeoutSec 1).app -eq 'pcquote-progress') { $deskReady = $true; break } } catch {}
        }
    }
    if (-not $deskReady) { throw '进度台未能启动，可能是端口被占用或 Node 不可用。请让 AI 检查本地启动器。' }
    Start-Process $deskUrl
} catch {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show($_.Exception.Message, 'PC Quote 进度台') | Out-Null
}
