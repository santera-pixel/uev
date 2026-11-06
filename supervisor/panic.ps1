$ErrorActionPreference = "Continue"

$controlSent = $false
$descriptorPath = Join-Path $env:LOCALAPPDATA "UEV\control.json"
if (Test-Path $descriptorPath) {
    try {
        $descriptor = Get-Content $descriptorPath -Raw | ConvertFrom-Json
        if ($descriptor.pid -and $descriptor.port -and $descriptor.token) {
            $headers = @{ Authorization = "Bearer $($descriptor.token)" }
            $body = @{ reason = "panic button" } | ConvertTo-Json -Compress
            $response = Invoke-RestMethod -Uri "http://127.0.0.1:$($descriptor.port)/api/panic" -Method Post -Headers $headers -ContentType "application/json" -Body $body -TimeoutSec 5
            if ($response.ok) {
                $controlSent = $true
            }
        }
    } catch {
        $controlSent = $false
    }
}

if ($controlSent) {
    Write-Host "Panic sent through the control API."
    exit 0
}

$sent = $false

try {
    $pipe = New-Object System.IO.Pipes.NamedPipeClientStream(".", "uev-supervisor", [System.IO.Pipes.PipeDirection]::InOut)
    $pipe.Connect(500)
    $writer = New-Object System.IO.StreamWriter($pipe)
    $writer.AutoFlush = $true
    $writer.WriteLine('{"type":"panic","reason":"panic button"}')
    Start-Sleep -Milliseconds 200
    $writer.Dispose()
    $pipe.Dispose()
    $sent = $true
} catch {
    $sent = $false
}

if ($sent) {
    Write-Host "Panic sent to the supervisor."
} else {
    Write-Host "Supervisor pipe unavailable; terminating the supervisor. KILL_ON_JOB_CLOSE will kill the editor."
    taskkill /F /IM UEVSupervisor.exe 2>$null | Out-Null
}
