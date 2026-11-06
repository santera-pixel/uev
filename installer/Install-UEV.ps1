[CmdletBinding()]
param(
    [string]$Project = "",
    [string]$Engine = "",
    [string]$InstallRoot = "",
    [ValidateSet("unattended", "supervised")]
    [string]$Profile = "supervised",
    [string[]]$Components = @(),
    [switch]$EnablePython,
    [switch]$NoPython,
    [switch]$EnableLiveCoding,
    [switch]$NoLiveCoding,
    [switch]$ContinueWithoutPython,
    [switch]$WithPanel,
    [switch]$NoPanel,
    [switch]$WithSupervisor,
    [switch]$NoSupervisor,
    [switch]$NoBuild,
    [switch]$NoClientConfig,
    [switch]$RegisterCommandCode,
    [switch]$DryRun,
    [switch]$Force,
    [switch]$Update,
    [switch]$NonInteractive,
    [switch]$Yes,
    [string]$ClientConfig = "",
    [string]$Client = "",
    [ValidateSet("user", "project")]
    [string]$ClientScope = "user",
    [switch]$ClientMenu,
    [switch]$ListClients,
    [switch]$Json,
    [string]$LogPath = "",
    [switch]$AllowUnsupportedEngine,
    [switch]$Extras,
    [switch]$NoExtras,
    [string]$DebloatRoot = "",
    [switch]$Uninstall,
    [switch]$PurgeUserState,
    [switch]$Verify
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $base = $env:LOCALAPPDATA
    if ([string]::IsNullOrWhiteSpace($base)) { $base = $env:TEMP }
    $InstallRoot = Join-Path $base "UEV"
}

$modulePath = Join-Path $PSScriptRoot "installer\UEV.Installer.psm1"
if (-not (Test-Path -LiteralPath $modulePath)) {
    $modulePath = Join-Path $PSScriptRoot "UEV.Installer.psm1"
}
if (-not (Test-Path -LiteralPath $modulePath)) {
    throw "Installer module not found. Expected installer\UEV.Installer.psm1 under $PSScriptRoot."
}
Import-Module $modulePath -Force

if ($ListClients) {
    Get-UevClientTable | Format-Table id, label, format, scope, writable -AutoSize | Out-String -Width 200 | Write-Host
    exit 0
}

if ($Uninstall -and $Verify) { throw "Use either -Uninstall or -Verify, not both." }
if ($PurgeUserState -and -not $Uninstall) { throw "-PurgeUserState only applies together with -Uninstall." }

try {
    if ($Uninstall) {
        if ([string]::IsNullOrWhiteSpace($Project)) {
            $Project = Read-Host "Path to the installed .uproject file or project folder"
        }
        Invoke-UEVUninstall -Project $Project -InstallRoot $InstallRoot -Force:$Force -NonInteractive:$NonInteractive -Yes:$Yes -PurgeUserState:$PurgeUserState -LogPath $LogPath
        exit 0
    }
    if ($Verify) {
        if ([string]::IsNullOrWhiteSpace($Project)) {
            $Project = Read-Host "Path to the installed .uproject file or project folder"
        }
        $checks = Test-UEVInstall -Project $Project -InstallRoot $InstallRoot
        if ($Json) { $checks | ConvertTo-Json -Depth 20 }
        exit 0
    }

    $result = Invoke-UEVInstall `
        -Project $Project `
        -Engine $Engine `
        -InstallRoot $InstallRoot `
        -Profile $Profile `
        -Components $Components `
        -EnablePython:$EnablePython `
        -NoPython:$NoPython `
        -EnableLiveCoding:$EnableLiveCoding `
        -NoLiveCoding:$NoLiveCoding `
        -ContinueWithoutPython:$ContinueWithoutPython `
        -WithPanel:$WithPanel `
        -NoPanel:$NoPanel `
        -WithSupervisor:$WithSupervisor `
        -NoSupervisor:$NoSupervisor `
        -NoBuild:$NoBuild `
        -NoClientConfig:$NoClientConfig `
        -RegisterCommandCode:$RegisterCommandCode `
        -DryRun:$DryRun `
        -Force:$Force `
        -Update:$Update `
        -NonInteractive:$NonInteractive `
        -Yes:$Yes `
        -ClientConfig $ClientConfig `
        -Json:$Json `
        -LogPath $LogPath `
        -AllowUnsupportedEngine:$AllowUnsupportedEngine `
        -Extras:$Extras `
        -NoExtras:$NoExtras `
        -DebloatRoot $DebloatRoot

    $clientOutcome = $null
    if (-not [string]::IsNullOrWhiteSpace($Client)) {
        $clientOutcome = Set-UevMcpClientEntry -Client $Client -Scope $ClientScope -Project $Project -InstallRoot $InstallRoot -Force:$Force
    } elseif ($ClientMenu -and -not $NonInteractive -and -not $Json) {
        $clientOutcome = Invoke-UevClientMenuPrompt -Project $Project -InstallRoot $InstallRoot
    }

    if ($Json) {
        $result | ConvertTo-Json -Depth 20
    }
    exit 0
} catch {
    # -Json promises pure JSON on stdout, so failures go to stderr like the progress log.
    if ($Json) { [Console]::Error.WriteLine("ERROR: " + $_.Exception.Message) }
    else { Write-Host ("ERROR: " + $_.Exception.Message) -ForegroundColor Red }
    if (-not [string]::IsNullOrWhiteSpace($LogPath)) {
        Write-Host ("Log: " + $LogPath) -ForegroundColor DarkGray
    }
    exit 1
}