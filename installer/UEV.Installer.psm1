$script:PackageRoot = Split-Path -Parent $PSScriptRoot
# The authoritative version comes from the package manifest.json that ships beside the
# installer. This constant is only a fallback for a loose module (no manifest); the
# release build keeps it in step with -Version.
$script:ProductVersionFallback = "1.7.0"
$script:ProductVersion = $null
$script:PackageManifestCache = $null
$script:JsonMode = $false
$script:ProductName = "UEV"
$script:DefaultSupervisorPipe = "uev-supervisor"
$script:ProjectDataDirName = "UEV"
$script:PythonIniSection = "[/Script/PythonScriptPlugin.PythonScriptPluginSettings]"
$script:LiveCodingIniSection = "[/Script/LiveCoding.LiveCodingSettings]"

function Get-McpInstallRootEntry {
    param([string]$Root)
    if ([string]::IsNullOrWhiteSpace($Root)) { return "" }
    return (Join-Path $Root "app\dist\bin.js")
}

function Test-McpInstallRoot {
    param([string]$Root)
    $entry = Get-McpInstallRootEntry -Root $Root
    return (-not [string]::IsNullOrWhiteSpace($entry)) -and (Test-Path -LiteralPath $entry)
}

function Get-McpDefaultInstallRoot {
    return (Join-Path $env:LOCALAPPDATA $script:ProductName)
}

function Write-McpMessage {
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [ValidateSet("Info", "Ok", "Warn", "Error", "Step")][string]$Level = "Info",
        [string]$LogPath = ""
    )

    $color = "Gray"
    switch ($Level) {
        "Ok" { $color = "Green" }
        "Warn" { $color = "Yellow" }
        "Error" { $color = "Red" }
        "Step" { $color = "Cyan" }
    }
    if ($script:JsonMode) {
        # Machine-readable runs must keep stdout clean for ConvertTo-Json output.
        [Console]::Error.WriteLine($Message)
    } else {
        Write-Host $Message -ForegroundColor $color
    }

    if (-not [string]::IsNullOrWhiteSpace($LogPath)) {
        $line = "[{0}] [{1}] {2}{3}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Message, [Environment]::NewLine
        try {
            $directory = Split-Path -Parent $LogPath
            if ($directory -and -not (Test-Path -LiteralPath $directory)) {
                New-Item -ItemType Directory -Force -Path $directory | Out-Null
            }
            $utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false
            [System.IO.File]::AppendAllText($LogPath, $line, $utf8)
        } catch {
        }
    }
}

function Get-McpStringHash {
    param([Parameter(Mandatory = $true)][string]$Text)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        return ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Get-McpFileHash {
    param([Parameter(Mandatory = $true)][string]$Path)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $stream = [System.IO.File]::OpenRead($Path)
        try {
            return ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
        } finally {
            $stream.Dispose()
        }
    } finally {
        $sha.Dispose()
    }
}

function Test-McpExcludedPath {
    param([string]$RelativePath, [string[]]$ExcludedNames)
    if ([string]::IsNullOrWhiteSpace($RelativePath)) { return $false }
    $parts = $RelativePath -split "[\\/]"
    foreach ($part in $parts) {
        if ($ExcludedNames -contains $part) { return $true }
    }
    return $false
}

function Get-McpTreeHash {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string[]]$ExcludedNames = @("Binaries", "Intermediate", "Saved", ".git")
    )
    if (-not (Test-Path -LiteralPath $Path)) { return "" }
    $root = (Resolve-Path -LiteralPath $Path).Path.TrimEnd("\", "/")
    $builder = New-Object System.Text.StringBuilder
    $files = @(Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue | Sort-Object FullName)
    foreach ($file in $files) {
        $relative = $file.FullName.Substring($root.Length).TrimStart("\", "/").Replace("\", "/")
        if (Test-McpExcludedPath -RelativePath $relative -ExcludedNames $ExcludedNames) { continue }
        [void]$builder.AppendLine($relative)
        [void]$builder.AppendLine((Get-McpFileHash -Path $file.FullName))
    }
    return (Get-McpStringHash -Text $builder.ToString())
}

function Resolve-McpProjectPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        if ([System.IO.Path]::GetExtension($Path) -ne ".uproject") {
            throw "Project must point to a .uproject file or a project folder: $Path"
        }
        return (Resolve-Path -LiteralPath $Path).Path
    }
    if (Test-Path -LiteralPath $Path -PathType Container) {
        $files = @(Get-ChildItem -LiteralPath $Path -Filter "*.uproject" -File -ErrorAction SilentlyContinue)
        if ($files.Count -eq 0) { throw "No .uproject found in $Path" }
        if ($files.Count -gt 1) { throw "Multiple .uproject files found in $Path; pass one explicitly." }
        return $files[0].FullName
    }
    throw "Project not found: $Path"
}

function Get-McpProjectInfo {
    param([Parameter(Mandatory = $true)][string]$Path)

    $projectFile = Resolve-McpProjectPath -Path $Path
    $projectDir = Split-Path -Parent $projectFile
    $projectName = [System.IO.Path]::GetFileNameWithoutExtension($projectFile)
    $raw = Get-Content -LiteralPath $projectFile -Raw
    try {
        $json = $raw | ConvertFrom-Json
    } catch {
        throw "Could not parse project JSON: $projectFile"
    }

    $plugins = @()
    if ($null -ne $json.Plugins) { $plugins = @($json.Plugins) }
    $engineAssociation = ""
    if ($null -ne $json.EngineAssociation) { $engineAssociation = [string]$json.EngineAssociation }

    $sourceDir = Join-Path $projectDir "Source"
    $targets = @()
    $builds = @()
    if (Test-Path -LiteralPath $sourceDir) {
        $targets = @(Get-ChildItem -LiteralPath $sourceDir -Filter "*.Target.cs" -File -Recurse -ErrorAction SilentlyContinue)
        $builds = @(Get-ChildItem -LiteralPath $sourceDir -Filter "*.Build.cs" -File -Recurse -ErrorAction SilentlyContinue)
    }
    $isCpp = ($targets.Count -gt 0 -and $builds.Count -gt 0)
    $normalizedPath = $projectFile.ToLowerInvariant()
    $hash = (Get-McpStringHash -Text $normalizedPath).Substring(0, 16)

    return [pscustomobject]@{
        File = $projectFile
        Directory = $projectDir
        Name = $projectName
        Hash = $hash
        Json = $json
        Plugins = $plugins
        EngineAssociation = $engineAssociation
        IsCpp = $isCpp
        ConfigDir = (Join-Path $projectDir "Config")
        SavedDir = (Join-Path $projectDir "Saved")
        PythonEntry = (@($plugins | Where-Object { $_.Name -eq "PythonScriptPlugin" }) | Select-Object -First 1)
    }
}

function Resolve-McpEnginePath {
    param([string]$EnginePath = "", [string]$EngineAssociation = "")

    $candidates = New-Object System.Collections.Generic.List[string]
    if (-not [string]::IsNullOrWhiteSpace($EnginePath)) {
        $candidates.Add($EnginePath)
    }
    if (-not [string]::IsNullOrWhiteSpace($env:UE4_ROOT)) {
        $candidates.Add($env:UE4_ROOT)
    }

    if (-not [string]::IsNullOrWhiteSpace($EngineAssociation)) {
        $registryRoots = @(
            "HKCU:\Software\Epic Games\Unreal Engine\Builds",
            "HKLM:\SOFTWARE\Epic Games\Unreal Engine\Builds",
            "HKLM:\SOFTWARE\WOW6432Node\Epic Games\Unreal Engine\Builds"
        )
        foreach ($registryRoot in $registryRoots) {
            if (-not (Test-Path -LiteralPath $registryRoot)) { continue }
            $values = Get-ItemProperty -LiteralPath $registryRoot -ErrorAction SilentlyContinue
            if ($null -eq $values) { continue }
            $property = $values.PSObject.Properties[$EngineAssociation]
            if ($null -ne $property -and -not [string]::IsNullOrWhiteSpace([string]$property.Value)) {
                $candidates.Add([string]$property.Value)
            }
        }

        if ($EngineAssociation -match "^\d+\.\d+$") {
            $candidates.Add((Join-Path $env:ProgramFiles ("Epic Games\UE_" + $EngineAssociation)))
            $candidates.Add((Join-Path "D:\" ("UE_" + $EngineAssociation)))
        }
    }

    foreach ($candidate in $candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        $resolved = $null
        try {
            if (Test-Path -LiteralPath $candidate) { $resolved = (Resolve-Path -LiteralPath $candidate).Path }
        } catch {
            continue
        }
        if ($null -eq $resolved) { continue }
        if (Test-Path -LiteralPath (Join-Path $resolved "Engine\Binaries\Win64\UE4Editor.exe")) {
            return $resolved
        }
        if (Test-Path -LiteralPath (Join-Path $resolved "Binaries\Win64\UE4Editor.exe")) {
            return (Split-Path -Parent $resolved)
        }
    }

    $associationText = ""
    if (-not [string]::IsNullOrWhiteSpace($EngineAssociation)) { $associationText = " (association '$EngineAssociation')" }
    throw "Could not locate Unreal Engine$associationText. Pass -Engine with the engine root, for example -Engine 'D:\UE-ViteFork'."
}

function Get-McpIniValue {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Section,
        [Parameter(Mandatory = $true)][string]$Key
    )
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $lines = @(Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue)
    $inSection = $false
    $value = $null
    $pattern = "^\s*" + [regex]::Escape($Key) + "\s*=\s*(.*)$"
    foreach ($line in $lines) {
        $trimmed = $line.Trim()
        if ($trimmed.StartsWith("[") -and $trimmed.EndsWith("]")) {
            $inSection = ($trimmed -ieq $Section)
            continue
        }
        if (-not $inSection) { continue }
        if ($line -match $pattern) {
            $value = $matches[1].Trim()
        }
    }
    return $value
}

function Set-McpIniValues {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Section,
        [Parameter(Mandatory = $true)][System.Collections.Specialized.OrderedDictionary]$Values
    )

    $before = [ordered]@{}
    foreach ($key in $Values.Keys) {
        $before[$key] = Get-McpIniValue -Path $Path -Section $Section -Key $key
    }

    $lines = New-Object System.Collections.Generic.List[string]
    if (Test-Path -LiteralPath $Path) {
        foreach ($line in (Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue)) { $lines.Add($line) }
    }

    $start = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i].Trim() -ieq $Section) { $start = $i; break }
    }

    if ($start -ge 0) {
        $end = $lines.Count
        for ($i = $start + 1; $i -lt $lines.Count; $i++) {
            $trimmed = $lines[$i].Trim()
            if ($trimmed.StartsWith("[") -and $trimmed.EndsWith("]")) { $end = $i; break }
        }
        $block = New-Object System.Collections.Generic.List[string]
        for ($i = $start; $i -lt $end; $i++) { $block.Add($lines[$i]) }
        foreach ($key in $Values.Keys) {
            $found = $false
            $pattern = "^\s*" + [regex]::Escape($key) + "\s*="
            for ($i = 1; $i -lt $block.Count; $i++) {
                if ($block[$i] -match $pattern) {
                    $block[$i] = "$key=$($Values[$key])"
                    $found = $true
                }
            }
            if (-not $found) { $block.Add("$key=$($Values[$key])") }
        }
        $lines.RemoveRange($start, $end - $start)
        $lines.InsertRange($start, $block)
    } else {
        if ($lines.Count -gt 0 -and $lines[$lines.Count - 1].Trim() -ne "") { $lines.Add("") }
        $lines.Add($Section)
        foreach ($key in $Values.Keys) { $lines.Add("$key=$($Values[$key])") }
    }

    $directory = Split-Path -Parent $Path
    if ($directory -and -not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Force -Path $directory | Out-Null
    }
    $utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false
    [System.IO.File]::WriteAllLines($Path, $lines, $utf8)
    return $before
}

function Restore-McpIniValues {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Section,
        [Parameter(Mandatory = $true)]$Before,
        [Parameter(Mandatory = $true)]$After
    )
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($line in (Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue)) { $lines.Add($line) }

    $start = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i].Trim() -ieq $Section) { $start = $i; break }
    }
    if ($start -lt 0) { return }

    $end = $lines.Count
    for ($i = $start + 1; $i -lt $lines.Count; $i++) {
        $trimmed = $lines[$i].Trim()
        if ($trimmed.StartsWith("[") -and $trimmed.EndsWith("]")) { $end = $i; break }
    }

    $removeIndices = New-Object System.Collections.Generic.List[int]
    $updates = @{}
    foreach ($key in $After.Keys) {
        $current = Get-McpIniValue -Path $Path -Section $Section -Key $key
        $afterValue = [string]$After[$key]
        if ($current -ne $afterValue) { continue }
        $beforeValue = $Before[$key]
        if ($null -eq $beforeValue) {
            for ($i = $start + 1; $i -lt $end; $i++) {
                if ($lines[$i] -match ("^\s*" + [regex]::Escape($key) + "\s*=")) { $removeIndices.Add($i) }
            }
        } else {
            $updates[$key] = [string]$beforeValue
        }
    }

    $removeIndicesSorted = @($removeIndices.ToArray() | Sort-Object -Descending)
    foreach ($i in $removeIndicesSorted) { $lines.RemoveAt($i) }
    foreach ($key in $updates.Keys) {
        $found = $false
        for ($i = $start + 1; $i -lt $lines.Count; $i++) {
            $trimmed = $lines[$i].Trim()
            if ($trimmed.StartsWith("[") -and $trimmed.EndsWith("]")) { break }
            if ($lines[$i] -match ("^\s*" + [regex]::Escape($key) + "\s*=")) {
                $lines[$i] = "$key=$($updates[$key])"
                $found = $true
            }
        }
        if (-not $found) { $lines.Insert($start + 1, "$key=$($updates[$key])") }
    }

    $start = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i].Trim() -ieq $Section) { $start = $i; break }
    }
    if ($start -ge 0) {
        $end = $lines.Count
        for ($i = $start + 1; $i -lt $lines.Count; $i++) {
            $trimmed = $lines[$i].Trim()
            if ($trimmed.StartsWith("[") -and $trimmed.EndsWith("]")) { $end = $i; break }
        }
        $hasContent = $false
        for ($i = $start + 1; $i -lt $end; $i++) {
            if ($lines[$i].Trim() -ne "") { $hasContent = $true; break }
        }
        if (-not $hasContent) {
            $lines.RemoveRange($start, $end - $start)
            if ($start -gt 0 -and $start -le $lines.Count -and $lines[$start - 1].Trim() -eq "") { $lines.RemoveAt($start - 1) }
        }
    }

    $utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false
    [System.IO.File]::WriteAllLines($Path, $lines, $utf8)
}

function Get-McpEngineInfo {
    param(
        [Parameter(Mandatory = $true)][string]$EnginePath,
        [string]$DebloatRoot = "",
        [string]$ProjectDir = ""
    )

    $engine = (Resolve-Path -LiteralPath $EnginePath).Path
    $editorExe = Join-Path $engine "Engine\Binaries\Win64\UE4Editor.exe"
    $buildBat = Join-Path $engine "Engine\Build\BatchFiles\Build.bat"
    $engineModules = Join-Path $engine "Engine\Binaries\Win64\UE4Editor.modules"
    if (-not (Test-Path -LiteralPath $editorExe)) { throw "UE4Editor.exe not found under $engine" }
    if (-not (Test-Path -LiteralPath $buildBat)) { throw "Build.bat not found under $engine" }

    $version = "unknown"
    $buildVersionPath = Join-Path $engine "Engine\Build\Build.version"
    if (Test-Path -LiteralPath $buildVersionPath) {
        try {
            $versionJson = Get-Content -LiteralPath $buildVersionPath -Raw | ConvertFrom-Json
            $version = "{0}.{1}.{2}" -f $versionJson.MajorVersion, $versionJson.MinorVersion, $versionJson.PatchVersion
        } catch {
        }
    }

    $buildId = ""
    if (Test-Path -LiteralPath $engineModules) {
        try {
            $modulesJson = Get-Content -LiteralPath $engineModules -Raw | ConvertFrom-Json
            $buildId = [string]$modulesJson.BuildId
        } catch {
        }
    }

    $pythonRoot = Join-Path $engine "Engine\Plugins\Experimental\PythonScriptPlugin"
    $pythonDescriptor = Join-Path $pythonRoot "PythonScriptPlugin.uplugin"
    $pythonModules = Join-Path $pythonRoot "Binaries\Win64\UE4Editor.modules"

    $esuCandidates = New-Object System.Collections.Generic.List[string]
    $esuCandidates.Add((Join-Path $engine "Engine\Plugins\Editor\EditorScriptingUtilities"))
    $esuCandidates.Add((Join-Path $engine "Engine\Plugins\Experimental\EditorScriptingUtilities"))
    if ([string]::IsNullOrWhiteSpace($DebloatRoot)) {
        $DebloatRoot = $env:UEV_DEBLOAT_ROOT
        if ([string]::IsNullOrWhiteSpace($DebloatRoot) -and (Test-Path -LiteralPath "D:\ViteDebloat_Moved")) {
            $DebloatRoot = "D:\ViteDebloat_Moved"
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($DebloatRoot)) {
        $esuCandidates.Add((Join-Path $DebloatRoot "Engine\Plugins\Editor\EditorScriptingUtilities"))
    }
    if (-not [string]::IsNullOrWhiteSpace($ProjectDir)) {
        $esuCandidates.Add((Join-Path $ProjectDir "Plugins\EditorScriptingUtilities"))
    }
    $esuSource = ""
    foreach ($candidate in $esuCandidates) {
        if (Test-Path -LiteralPath (Join-Path $candidate "EditorScriptingUtilities.uplugin")) {
            $esuSource = (Resolve-Path -LiteralPath $candidate).Path
            break
        }
    }

    $sequencer = Join-Path $engine "Engine\Plugins\MovieScene\SequencerScripting"
    $rtxgi = Join-Path $engine "Engine\Plugins\Runtime\Nvidia\RTXGI"
    $liveCodingDll = Join-Path $engine "Engine\Binaries\Win64\UE4Editor-LiveCoding.dll"
    $liveCodingConsole = Join-Path $engine "Engine\Binaries\Win64\LiveCodingConsole.exe"
    $liveCodingSource = Join-Path $engine "Engine\Source\Developer\Windows\LiveCoding"

    return [pscustomobject]@{
        Root = $engine
        Version = $version
        BuildId = $buildId
        EditorExe = $editorExe
        BuildBat = $buildBat
        EngineModules = $engineModules
        PythonPluginRoot = $pythonRoot
        PythonPluginDescriptor = $pythonDescriptor
        PythonPluginModules = $pythonModules
        EditorScriptingUtilitiesSource = $esuSource
        SequencerSource = $sequencer
        RtxgiSource = $rtxgi
        LiveCodingDll = $liveCodingDll
        LiveCodingConsole = $liveCodingConsole
        LiveCodingSource = $liveCodingSource
        LiveCodingAvailable = ((Test-Path -LiteralPath $liveCodingDll) -and (Test-Path -LiteralPath $liveCodingConsole))
    }
}

function Get-McpPythonStatus {
    param([Parameter(Mandatory = $true)]$ProjectInfo, [Parameter(Mandatory = $true)]$EngineInfo)
    $exists = Test-Path -LiteralPath $EngineInfo.PythonPluginDescriptor
    $entry = (@($ProjectInfo.Plugins | Where-Object { $_.Name -eq "PythonScriptPlugin" }) | Select-Object -First 1)
    $enabled = ($null -ne $entry -and [bool]$entry.Enabled)
    $iniPath = Join-Path $ProjectInfo.ConfigDir "DefaultEngine.ini"
    $remote = Get-McpIniValue -Path $iniPath -Section $script:PythonIniSection -Key "bRemoteExecution"
    $bind = Get-McpIniValue -Path $iniPath -Section $script:PythonIniSection -Key "RemoteExecutionMulticastBindAddress"
    $ttl = Get-McpIniValue -Path $iniPath -Section $script:PythonIniSection -Key "RemoteExecutionMulticastTtl"
    $configured = ($remote -ieq "True" -and $bind -eq "127.0.0.1" -and $ttl -eq "0")

    $status = "missing in engine"
    if ($exists -and $enabled -and $configured) { $status = "enabled and configured" }
    elseif ($exists -and $enabled) { $status = "enabled; remote execution incomplete" }
    elseif ($exists) { $status = "available but disabled" }

    return [pscustomobject]@{
        Exists = $exists
        Enabled = $enabled
        Configured = $configured
        Status = $status
        IniPath = $iniPath
        RemoteExecution = $remote
        BindAddress = $bind
        MulticastTtl = $ttl
    }
}

function Get-McpLiveCodingStatus {
    param([Parameter(Mandatory = $true)]$ProjectInfo, [Parameter(Mandatory = $true)]$EngineInfo)
    $projectIni = Join-Path $ProjectInfo.ConfigDir "DefaultEditorPerProjectUserSettings.ini"
    $userIni = Join-Path $ProjectInfo.SavedDir "Config\WindowsEditor\EditorPerProjectUserSettings.ini"
    $projectValue = Get-McpIniValue -Path $projectIni -Section $script:LiveCodingIniSection -Key "bEnabled"
    $userValue = Get-McpIniValue -Path $userIni -Section $script:LiveCodingIniSection -Key "bEnabled"
    $startup = Get-McpIniValue -Path $projectIni -Section $script:LiveCodingIniSection -Key "Startup"
    if ($null -eq $startup) { $startup = Get-McpIniValue -Path $userIni -Section $script:LiveCodingIniSection -Key "Startup" }
    $enabled = ($projectValue -ieq "True" -or $userValue -ieq "True")

    $status = "unavailable"
    if ($EngineInfo.LiveCodingAvailable -and $enabled) { $status = "enabled" }
    elseif ($EngineInfo.LiveCodingAvailable) { $status = "available but disabled" }

    return [pscustomobject]@{
        Available = [bool]$EngineInfo.LiveCodingAvailable
        Enabled = $enabled
        Status = $status
        ProjectIni = $projectIni
        UserIni = $userIni
        Startup = $startup
        ProjectValue = $projectValue
        UserValue = $userValue
    }
}

function Get-McpNodeStatus {
    param([string]$Path = "")
    $nodePath = $Path
    if ([string]::IsNullOrWhiteSpace($nodePath)) {
        $command = Get-Command node -ErrorAction SilentlyContinue
        if ($null -ne $command) { $nodePath = [string]$command.Source }
    }
    if ([string]::IsNullOrWhiteSpace($nodePath) -or -not (Test-Path -LiteralPath $nodePath)) {
        return [pscustomobject]@{ Found = $false; Path = $nodePath; Version = ""; Major = 0; Ok = $false }
    }
    $version = ""
    try {
        $version = (& $nodePath --version 2>$null | Select-Object -First 1)
    } catch {
    }
    $major = 0
    if (-not [string]::IsNullOrWhiteSpace($version) -and $version -match "^v?(\d+)") {
        $major = [int]$matches[1]
    }
    return [pscustomobject]@{ Found = $true; Path = $nodePath; Version = [string]$version; Major = $major; Ok = ($major -ge 18) }
}

function Get-McpDotnetStatus {
    $command = Get-Command dotnet -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        return [pscustomobject]@{ Found = $false; HasNet9 = $false; Runtimes = @() }
    }
    $runtimes = @()
    try {
        $runtimes = @(& $command.Source --list-runtimes 2>$null)
    } catch {
    }
    $hasNet9 = @($runtimes | Where-Object { $_ -match "^Microsoft\.NETCore\.App 9\." }).Count -gt 0
    return [pscustomobject]@{ Found = $true; HasNet9 = $hasNet9; Runtimes = $runtimes }
}

function Test-McpEditorRunning {
    $editors = @(Get-Process -Name "UE4Editor" -ErrorAction SilentlyContinue)
    return ($editors.Count -gt 0)
}

function Clear-McpStaleControlDescriptor {
    $descriptorPath = Join-Path $env:LOCALAPPDATA "UEV\control.json"
    if (-not (Test-Path -LiteralPath $descriptorPath)) { return }
    try {
        $descriptor = Get-Content -LiteralPath $descriptorPath -Raw | ConvertFrom-Json
        $pidValue = [int]$descriptor.pid
        if ($pidValue -gt 0) {
            $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
            if ($null -ne $process) { return }
        }
        Remove-Item -LiteralPath $descriptorPath -Force
    } catch {
    }
}

function Stop-McpInstalledProcesses {
    param([string]$InstallRoot)

    if ([string]::IsNullOrWhiteSpace($InstallRoot)) { return 0 }
    $root = $InstallRoot.TrimEnd('\')
    $stopped = 0

    try {
        Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($root, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 } |
            ForEach-Object {
                Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue
                $stopped += 1
            }
    } catch {
    }

    # 1.7.0 ships a single supervisor image: UEVSupervisor.
    foreach ($imageName in @("UEVSupervisor")) {
        Get-Process -Name $imageName -ErrorAction SilentlyContinue | ForEach-Object {
            $processPath = ""
            try { $processPath = $_.Path } catch {
            }
            if ([string]::IsNullOrWhiteSpace($processPath) -or $processPath.IndexOf($root, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
                Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
                $stopped += 1
            }
        }
    }

    return $stopped
}

function Get-McpSelectionDefaults {
    param(
        [Parameter(Mandatory = $true)]$ProjectInfo,
        [Parameter(Mandatory = $true)]$EngineInfo,
        [Parameter(Mandatory = $true)]$PythonStatus,
        [Parameter(Mandatory = $true)]$LiveCodingStatus,
        $Parameters
    )

    $history = $true
    $panel = $true
    $supervisor = $true
    $python = [bool]$PythonStatus.Exists
    $liveCoding = [bool]$LiveCodingStatus.Enabled
    $esu = (-not [string]::IsNullOrWhiteSpace($EngineInfo.EditorScriptingUtilitiesSource))
    $extras = $false
    $remote = $true
    $build = $true
    $client = $true

    if ($null -ne $Parameters) {
        if ($Parameters.NoPanel) { $panel = $false }
        if ($Parameters.WithPanel) { $panel = $true }
        if ($Parameters.NoSupervisor) { $supervisor = $false }
        if ($Parameters.WithSupervisor) { $supervisor = $true }
        if ($Parameters.NoPython) { $python = $false }
        if ($Parameters.EnablePython) { $python = $true }
        if ($Parameters.NoLiveCoding) { $liveCoding = $false }
        if ($Parameters.EnableLiveCoding) { $liveCoding = $true }
        if ($Parameters.NoExtras) { $extras = $false }
        if ($Parameters.Extras) { $extras = $true }
        if ($Parameters.NoBuild) { $build = $false }
        if ($Parameters.NoClientConfig) { $client = $false }
    }

    if (-not $PythonStatus.Exists) { $python = $false }
    if (-not $LiveCodingStatus.Available) { $liveCoding = $false }

    return [pscustomobject]@{
        Server = $true
        History = $history
        Panel = $panel
        Supervisor = $supervisor
        Python = $python
        LiveCoding = $liveCoding
        EditorScriptingUtilities = $esu
        Extras = $extras
        RemoteExecution = $remote
        Build = $build
        ClientConfig = $client
        Profile = $(if ($null -ne $Parameters -and -not [string]::IsNullOrWhiteSpace([string]$Parameters.Profile)) { [string]$Parameters.Profile } else { "supervised" })
        ContinueWithoutPython = $false
    }
}

function Set-McpSelectionComponent {
    param($Selection, [string]$Component, [bool]$Value)
    switch ($Component) {
        "Server" { $Selection.Server = $true }
        "History" { $Selection.History = $Value }
        "Panel" { $Selection.Panel = $Value; if ($Value) { $Selection.History = $true } }
        "Supervisor" { $Selection.Supervisor = $Value }
        "Python" { $Selection.Python = $Value }
        "LiveCoding" { $Selection.LiveCoding = $Value }
        "EditorScriptingUtilities" { $Selection.EditorScriptingUtilities = $Value }
        "Extras" { $Selection.Extras = $Value }
        "RemoteExecution" { $Selection.RemoteExecution = $Value }
        "Build" { $Selection.Build = $Value }
        "ClientConfig" { $Selection.ClientConfig = $Value }
    }
}

function Read-McpSelection {
    param(
        [Parameter(Mandatory = $true)]$ProjectInfo,
        [Parameter(Mandatory = $true)]$EngineInfo,
        [Parameter(Mandatory = $true)]$PythonStatus,
        [Parameter(Mandatory = $true)]$LiveCodingStatus,
        [Parameter(Mandatory = $true)]$Parameters
    )

    $selection = Get-McpSelectionDefaults -ProjectInfo $ProjectInfo -EngineInfo $EngineInfo -PythonStatus $PythonStatus -LiveCodingStatus $LiveCodingStatus -Parameters $Parameters

    $componentList = @()
    if ($null -ne $Parameters.Components -and $Parameters.Components.Count -gt 0) {
        $expanded = @()
        foreach ($component in $Parameters.Components) {
            foreach ($part in ([string]$component -split ",")) {
                $trimmed = $part.Trim()
                if (-not [string]::IsNullOrWhiteSpace($trimmed)) { $expanded += $trimmed }
            }
        }
        if ($expanded -contains "All" -or $expanded -contains "Recommended") {
            $componentList = @("Server", "History", "Panel", "Supervisor", "Python", "EditorScriptingUtilities", "RemoteExecution", "Build", "ClientConfig")
        } else {
            foreach ($name in $expanded) {
                switch -Regex ($name) {
                    "^(Server|History|Panel|Supervisor|Python|LiveCoding|EditorScriptingUtilities|ESU|Extras|RemoteExecution|Remote|Build|ClientConfig)$" {
                        $canonical = $name
                        if ($canonical -eq "ESU") { $canonical = "EditorScriptingUtilities" }
                        if ($canonical -eq "Remote") { $canonical = "RemoteExecution" }
                        $componentList += $canonical
                    }
                    default { throw "Unknown component '$name'. Valid components: Server, History, Panel, Supervisor, Python, LiveCoding, EditorScriptingUtilities, Extras, RemoteExecution, Build, ClientConfig." }
                }
            }
        }
        foreach ($name in @("Server", "History", "Panel", "Supervisor", "Python", "LiveCoding", "EditorScriptingUtilities", "Extras", "RemoteExecution", "Build", "ClientConfig")) {
            Set-McpSelectionComponent -Selection $selection -Component $name -Value $false
        }
        foreach ($name in $componentList) {
            Set-McpSelectionComponent -Selection $selection -Component $name -Value $true
        }
    }

    if ($selection.Python -and -not $PythonStatus.Exists) {
        if ($Parameters.NonInteractive) { throw "PythonScriptPlugin was not found in the engine. Pass -NoPython -ContinueWithoutPython for a degraded install, or restore the engine plugin." }
        Write-McpMessage -Message "PythonScriptPlugin is missing from the engine; Python cannot be enabled." -Level "Warn"
        $selection.Python = $false
    }
    if ($selection.LiveCoding -and -not $LiveCodingStatus.Available) {
        if ($Parameters.NonInteractive) { Write-McpMessage -Message "Live Coding is unavailable in this engine; continuing without it." -Level "Warn" }
        else { Write-McpMessage -Message "Live Coding is unavailable in this engine; continuing without it. Use full builds for C++ changes." -Level "Warn" }
        $selection.LiveCoding = $false
    }

    if ($Parameters.NonInteractive) {
        if (-not $selection.Python -and -not $Parameters.ContinueWithoutPython) {
            throw "PythonScriptPlugin will not be enabled. Pass -ContinueWithoutPython to install a degraded server-only setup."
        }
        return $selection
    }

    while ($true) {
        Write-Host ""
        Write-Host "UEV installer" -ForegroundColor Cyan
        Write-Host ("Project: {0}" -f $ProjectInfo.File)
        Write-Host ("Engine:  {0} ({1}, BuildId {2})" -f $EngineInfo.Root, $EngineInfo.Version, $EngineInfo.BuildId)
        Write-Host ("Profile: {0}" -f $selection.Profile)
        Write-Host ""
        Write-Host ("[1] MCP server / AI MCP endpoint          [on]")
        Write-Host ("[2] UEVNative native plugin + graph      [{0}]" -f $(if ($selection.History) { "on" } else { "off" }))
        Write-Host ("[3] UEVControlPanel native plugin         [{0}]" -f $(if ($selection.Panel) { "on" } else { "off" }))
        Write-Host ("[4] Supervisor + control API lifecycle    [{0}]" -f $(if ($selection.Supervisor) { "on" } else { "off" }))
        Write-Host ("[5] Python Editor Script Plugin           [{0}] {1}" -f $(if ($selection.Python) { "on" } else { "off" }), $PythonStatus.Status)
        Write-Host ("[6] Live Coding                           [{0}] {1}" -f $(if ($selection.LiveCoding) { "on" } else { "off" }), $LiveCodingStatus.Status)
        Write-Host ("[7] EditorScriptingUtilities              [{0}]" -f $(if ($selection.EditorScriptingUtilities) { "on" } else { "off" }))
        Write-Host ("[8] Optional engine integrations           [{0}]" -f $(if ($selection.Extras) { "on" } else { "off" }))
        Write-Host ("[9] Configure loopback remote execution   [{0}]" -f $(if ($selection.RemoteExecution) { "on" } else { "off" }))
        Write-Host ("[A] Build project now                     [{0}]" -f $(if ($selection.Build) { "on" } else { "off" }))
        Write-Host ("[B] Generate MCP client config recipe     [{0}]" -f $(if ($selection.ClientConfig) { "on" } else { "off" }))
        Write-Host "    (the recipe is not registered with your AI client)"
        Write-Host ("[P] Profile: {0}" -f $selection.Profile)
        Write-Host "[D] Details / paths"
        Write-Host "[Enter] Review and install   [Q] Quit"
        Write-Host ""

        $answer = Read-Host "Toggle a component, or press Enter to continue"
        if ($null -eq $answer) { $answer = "" }
        $answer = $answer.Trim()
        if ($answer -eq "") {
            if ($selection.Python -and -not $PythonStatus.Exists) {
                Write-McpMessage -Message "PythonScriptPlugin is missing; deselect Python or restore it in the engine." -Level "Error"
                continue
            }
            if (-not $selection.Python) {
                Write-McpMessage -Message "PythonScriptPlugin will not be enabled. The MCP server will not be able to call the editor until it is enabled." -Level "Warn"
                $continue = Read-Host "Continue without Python? [y/N]"
                if ($continue -notmatch "^(?i)y(es)?$") { continue }
                $selection.ContinueWithoutPython = $true
            }
            if (($selection.History -or $selection.Panel) -and -not $selection.Build) {
                Write-McpMessage -Message "Native plugins are selected but Build is off; the editor will not load them until the project is built." -Level "Warn"
                $continue = Read-Host "Continue without building? [y/N]"
                if ($continue -notmatch "^(?i)y(es)?$") { continue }
            }
            if (-not $selection.LiveCoding) {
                Write-McpMessage -Message "Live Coding is off. Full builds are still required for new UCLASSes, headers, and class layouts." -Level "Info"
            }
            break
        }

        switch -Regex ($answer.ToUpperInvariant()) {
            "^1$" { $selection.Server = $true }
            "^2$" { $selection.History = -not $selection.History }
            "^3$" {
                $selection.Panel = -not $selection.Panel
                if ($selection.Panel) { $selection.History = $true }
            }
            "^4$" { $selection.Supervisor = -not $selection.Supervisor }
            "^5$" {
                if (-not $PythonStatus.Exists) {
                    Write-McpMessage -Message "PythonScriptPlugin is not in this engine. Restore it, or continue without Python." -Level "Error"
                } else {
                    $selection.Python = -not $selection.Python
                }
            }
            "^6$" {
                if (-not $LiveCodingStatus.Available) {
                    Write-McpMessage -Message "Live Coding is not available in this engine; use full builds." -Level "Warn"
                } else {
                    $selection.LiveCoding = -not $selection.LiveCoding
                }
            }
            "^7$" { $selection.EditorScriptingUtilities = -not $selection.EditorScriptingUtilities }
            "^8$" { $selection.Extras = -not $selection.Extras }
            "^9$" { $selection.RemoteExecution = -not $selection.RemoteExecution }
            "^A$" { $selection.Build = -not $selection.Build }
            "^B$" { $selection.ClientConfig = -not $selection.ClientConfig }
            "^P$" {
                if ($selection.Profile -eq "supervised") { $selection.Profile = "unattended" } else { $selection.Profile = "supervised" }
            }
            "^D$" {
                Write-Host ""
                Write-Host ("Python:      {0}" -f $PythonStatus.Status)
                Write-Host ("Live Coding: {0}" -f $LiveCodingStatus.Status)
                Write-Host ("ESU source:  {0}" -f $EngineInfo.EditorScriptingUtilitiesSource)
                Write-Host ("Install root: {0}" -f $Parameters.InstallRoot)
                Write-Host ("Client config: {0}" -f $Parameters.ClientConfig)
                Read-Host "Press Enter to return" | Out-Null
            }
            "^Q$" { return $null }
            default { Write-McpMessage -Message "Unknown selection '$answer'." -Level "Warn" }
        }
    }

    $components = @()
    if ($selection.History) { $components += "History" }
    if ($selection.Panel) { $components += "Panel" }
    if ($selection.Supervisor) { $components += "Supervisor" }
    if ($selection.Python) { $components += "Python" }
    if ($selection.LiveCoding) { $components += "LiveCoding" }
    if ($selection.EditorScriptingUtilities) { $components += "EditorScriptingUtilities" }
    if ($selection.Extras) { $components += "Extras" }
    if ($selection.RemoteExecution) { $components += "RemoteExecution" }
    if ($selection.Build) { $components += "Build" }
    if ($selection.ClientConfig) { $components += "ClientConfig" }

    Write-Host ""
    Write-Host "Install summary" -ForegroundColor Cyan
    Write-Host ("  Project:  {0}" -f $ProjectInfo.File)
    Write-Host ("  Engine:   {0}" -f $EngineInfo.Root)
    Write-Host ("  Profile:  {0}" -f $selection.Profile)
    Write-Host ("  Components: Server, {0}" -f ($components -join ", "))
    if (-not $selection.Python) { Write-Host "  WARNING: Python is disabled; editor calls will not work." -ForegroundColor Yellow }
    if (-not $selection.LiveCoding) { Write-Host "  Live Coding is disabled; new reflected classes require a full build." -ForegroundColor Yellow }
    Write-Host ""
    if (-not $Parameters.Yes) {
        $confirm = Read-Host "Install now? [Y/n]"
        if ($confirm -match "^(?i)n(o)?$") { return $null }
    }
    return $selection
}

function Test-McpPrerequisite {
    param(
        [Parameter(Mandatory = $true)]$ProjectInfo,
        [Parameter(Mandatory = $true)]$EngineInfo,
        [Parameter(Mandatory = $true)]$Selection,
        [Parameter(Mandatory = $true)]$Parameters
    )

    if (Test-McpEditorRunning) {
        throw "UE4Editor is running. Close the editor before installing or updating; plugin DLLs and config must not be in use."
    }
    if (-not $ProjectInfo.IsCpp) {
        throw "The project is not C++-capable: no Source/*.Target.cs and *.Build.cs found. Create a C++ project (or add a C++ module) before installing the source native plugins."
    }
    if ($Selection.Supervisor) {
        $supervisor = Join-Path $script:PackageRoot "supervisor\UEVSupervisor.exe"
        if (-not (Test-Path -LiteralPath $supervisor)) {
            throw "Packaged supervisor not found: $supervisor. Rebuild the package."
        }
        $packageManifest = Get-McpPackageManifest
        if ($null -ne $packageManifest.supervisorSelfContained -and -not [bool]$packageManifest.supervisorSelfContained) {
            $dotnet = Get-McpDotnetStatus
            if (-not $dotnet.Found -or -not $dotnet.HasNet9) {
                throw "The packaged supervisor is framework-dependent and requires the .NET 9 runtime. Install .NET 9 or rebuild the package with a self-contained supervisor."
            }
        }
    }
    $entry = Join-Path $script:PackageRoot "payload\app\dist\bin.js"
    if (-not (Test-Path -LiteralPath $entry)) {
        throw "Packaged MCP server not found: $entry. Rebuild the package."
    }
    $bundledNode = Join-Path $script:PackageRoot "payload\node\node.exe"
    if (Test-Path -LiteralPath $bundledNode) {
        $node = Get-McpNodeStatus -Path $bundledNode
        if (-not $node.Ok) { $node = Get-McpNodeStatus }
    } else {
        $node = Get-McpNodeStatus
    }
    if (-not $node.Ok) {
        throw "The package has no bundled Node runtime and Node.js 18 or newer was not found on PATH (found '$($node.Version)')."
    }
    if ($Selection.Python -and -not $EngineInfo.PythonPluginDescriptor) {
        throw "PythonScriptPlugin was not found in this engine. The MCP server cannot work without it."
    }
    return $node
}

function Copy-McpDirectory {
    param([string]$Source, [string]$Destination, [string[]]$ExcludedNames = @("Binaries", "Intermediate", "Saved", ".git"))
    if (-not (Test-Path -LiteralPath $Source)) { throw "Source directory not found: $Source" }
    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Get-ChildItem -LiteralPath $Source -Force | Where-Object { $ExcludedNames -notcontains $_.Name } | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force
    }
}

function Copy-McpApplication {
    param([string]$Source, [string]$InstallRoot, [string]$LogPath)
    $target = Join-Path $InstallRoot "app"
    $staging = Join-Path $InstallRoot ("app.new." + [guid]::NewGuid().ToString("N"))
    $old = Join-Path $InstallRoot ("app.old." + [guid]::NewGuid().ToString("N"))
    if (-not (Test-Path -LiteralPath $InstallRoot)) { New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null }
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
    Write-McpMessage -Message "Copying MCP server runtime..." -Level "Step" -LogPath $LogPath
    Copy-Item -LiteralPath $Source -Destination $staging -Recurse -Force
    try {
        if (Test-Path -LiteralPath $target) { Move-Item -LiteralPath $target -Destination $old -Force }
        Move-Item -LiteralPath $staging -Destination $target -Force
        if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Recurse -Force }
    } catch {
        if ((Test-Path -LiteralPath $old) -and -not (Test-Path -LiteralPath $target)) {
            Move-Item -LiteralPath $old -Destination $target -Force
        }
        throw
    }
    return $target
}

function Copy-McpSupervisor {
    param([string]$Source, [string]$InstallRoot, [string]$LogPath)
    $target = Join-Path $InstallRoot "supervisor"
    $staging = Join-Path $InstallRoot ("supervisor.new." + [guid]::NewGuid().ToString("N"))
    $old = Join-Path $InstallRoot ("supervisor.old." + [guid]::NewGuid().ToString("N"))
    if (-not (Test-Path -LiteralPath $InstallRoot)) { New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null }
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
    Write-McpMessage -Message "Copying supervisor runtime..." -Level "Step" -LogPath $LogPath
    Copy-Item -LiteralPath $Source -Destination $staging -Recurse -Force
    try {
        if (Test-Path -LiteralPath $target) { Move-Item -LiteralPath $target -Destination $old -Force }
        Move-Item -LiteralPath $staging -Destination $target -Force
        if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Recurse -Force }
    } catch {
        if ((Test-Path -LiteralPath $old) -and -not (Test-Path -LiteralPath $target)) {
            Move-Item -LiteralPath $old -Destination $target -Force
        }
        throw
    }
    return $target
}

function Copy-McpNodeRuntime {
    param([string]$Source, [string]$InstallRoot, [string]$LogPath)
    $target = Join-Path $InstallRoot "node"
    if (-not (Test-Path -LiteralPath $InstallRoot)) { New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null }
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Write-McpMessage -Message "Copying bundled Node runtime..." -Level "Step" -LogPath $LogPath
    Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $target -Recurse -Force
    }
    return $target
}

function Update-McpProjectPlugins {
    param(
        [Parameter(Mandatory = $true)][string]$ProjectFile,
        [Parameter(Mandatory = $true)]$Entries
    )

    $json = Get-Content -LiteralPath $ProjectFile -Raw | ConvertFrom-Json
    $plugins = @()
    if ($null -ne $json.Plugins) { $plugins = @($json.Plugins) }

    $before = @{}
    $after = @{}
    foreach ($name in $Entries.Keys) {
        $optional = [bool]$Entries[$name]
        $entry = (@($plugins | Where-Object { $_.Name -eq $name }) | Select-Object -First 1)
        if ($null -eq $entry) {
            $before[$name] = $null
            $entry = [pscustomobject]@{ Name = $name; Enabled = $true }
            $plugins += $entry
        } else {
            $before[$name] = ($entry | ConvertTo-Json -Compress -Depth 10)
        }
        $entry.Enabled = $true
        if ($optional) {
            $entry | Add-Member -NotePropertyName Optional -NotePropertyValue $true -Force
        } elseif ($null -ne $entry.PSObject.Properties["Optional"]) {
            $entry.PSObject.Properties.Remove("Optional")
        }
        $after[$name] = ($entry | ConvertTo-Json -Compress -Depth 10)
    }

    $json | Add-Member -NotePropertyName Plugins -NotePropertyValue @($plugins) -Force
    $jsonText = $json | ConvertTo-Json -Depth 12
    $utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false
    [System.IO.File]::WriteAllText($ProjectFile, $jsonText, $utf8)
    return [pscustomobject]@{ Before = $before; After = $after }
}

function Undo-McpProjectPlugins {
    param([Parameter(Mandatory = $true)][string]$ProjectFile, [Parameter(Mandatory = $true)]$Before, [Parameter(Mandatory = $true)]$After)
    $json = Get-Content -LiteralPath $ProjectFile -Raw | ConvertFrom-Json
    $plugins = @()
    if ($null -ne $json.Plugins) { $plugins = @($json.Plugins) }
    $newPlugins = @()
    foreach ($entry in $plugins) {
        $name = [string]$entry.Name
        if ($After.ContainsKey($name)) {
            $current = $entry | ConvertTo-Json -Compress -Depth 10
            if ($current -eq [string]$After[$name]) {
                $old = $Before[$name]
                if ($null -ne $old -and -not [string]::IsNullOrWhiteSpace([string]$old)) {
                    $newPlugins += ($old | ConvertFrom-Json)
                }
                continue
            }
        }
        $newPlugins += $entry
    }
    if ($newPlugins.Count -eq 0) {
        if ($null -ne $json.PSObject.Properties["Plugins"]) { $json.PSObject.Properties.Remove("Plugins") }
    } else {
        $json | Add-Member -NotePropertyName Plugins -NotePropertyValue ([object[]]$newPlugins) -Force
    }
    $utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false
    [System.IO.File]::WriteAllText($ProjectFile, ($json | ConvertTo-Json -Depth 12), $utf8)
}


function Merge-McpIniChanges {
    param($ExistingChanges, $NewChanges)
    $result = @()
    $existing = @($ExistingChanges)
    $incoming = @($NewChanges)
    foreach ($new in $incoming) {
        $match = @($existing | Where-Object { $_.Path -eq $new.Path -and $_.Section -eq $new.Section } | Select-Object -First 1)
        if ($match.Count -eq 0) {
            $result += $new
            continue
        }
        $before = @{}
        if ($null -ne $match[0].Before) {
            foreach ($property in $match[0].Before.PSObject.Properties) { $before[$property.Name] = $property.Value }
        }
        foreach ($key in $new.Before.Keys) {
            if (-not $before.ContainsKey($key)) { $before[$key] = $new.Before[$key] }
        }
        $result += [pscustomobject]@{ Path = $new.Path; Section = $new.Section; Before = $before; After = $new.After }
    }
    foreach ($old in $existing) {
        $found = @($incoming | Where-Object { $_.Path -eq $old.Path -and $_.Section -eq $old.Section }).Count -gt 0
        if (-not $found) { $result += $old }
    }
    return $result
}

function Get-McpPluginModules {
    param([string]$PluginRoot)
    $descriptor = Get-ChildItem -LiteralPath $PluginRoot -Filter "*.uplugin" -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $descriptor) { return @() }
    try {
        $json = Get-Content -LiteralPath $descriptor.FullName -Raw | ConvertFrom-Json
        return @($json.Modules | ForEach-Object { [string]$_.Name })
    } catch {
        return @()
    }
}

function Build-McpProject {
    param(
        [Parameter(Mandatory = $true)]$ProjectInfo,
        [Parameter(Mandatory = $true)]$EngineInfo,
        [string]$LogPath
    )

    Write-McpMessage -Message ("Building {0}Editor..." -f $ProjectInfo.Name) -Level "Step" -LogPath $LogPath
    $buildArgs = @(
        ("{0}Editor" -f $ProjectInfo.Name),
        "Win64",
        "Development",
        ("-Project=" + $ProjectInfo.File),
        "-WaitMutex"
    )
    $output = & $EngineInfo.BuildBat @buildArgs 2>&1
    $code = $LASTEXITCODE
    foreach ($line in @($output)) {
        Write-Host $line
        if (-not [string]::IsNullOrWhiteSpace($LogPath)) {
            $utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false
            [System.IO.File]::AppendAllText($LogPath, ([string]$line + [Environment]::NewLine), $utf8)
        }
    }
    if ($code -ne 0) {
        throw "Project build failed with exit code $code. See $LogPath"
    }
}

function Test-McpPluginBuild {
    param([Parameter(Mandatory = $true)]$ProjectInfo, [Parameter(Mandatory = $true)][string]$PluginName, [string]$LogPath)
    $pluginRoot = Join-Path $ProjectInfo.Directory ("Plugins\" + $PluginName)
    $modulesFile = Join-Path $pluginRoot "Binaries\Win64\UE4Editor.modules"
    $binariesDir = Join-Path $pluginRoot "Binaries\Win64"
    $dlls = @(Get-ChildItem -LiteralPath $binariesDir -Filter "UE4Editor-*.dll" -File -ErrorAction SilentlyContinue)
    if ((-not (Test-Path -LiteralPath $modulesFile)) -and $dlls.Count -eq 0) {
        throw "Plugin $PluginName did not produce a loadable build under $binariesDir. Check the build log."
    }
    $buildId = ""
    if (Test-Path -LiteralPath $modulesFile) {
        try {
            $buildId = [string]((Get-Content -LiteralPath $modulesFile -Raw | ConvertFrom-Json).BuildId)
        } catch {
        }
    }
    Write-McpMessage -Message ("{0} built{1}" -f $PluginName, $(if ($buildId) { " (BuildId $buildId)" } else { "" })) -Level "Ok" -LogPath $LogPath
    return [pscustomobject]@{ Plugin = $PluginName; Root = $pluginRoot; BuildId = $buildId; ModulesFile = $modulesFile }
}

function Backup-McpFile {
    param([string]$Path, [string]$BackupDir)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    if (-not (Test-Path -LiteralPath $BackupDir)) { New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null }
    $name = Split-Path -Leaf $Path
    $target = Join-Path $BackupDir $name
    Copy-Item -LiteralPath $Path -Destination $target -Force
    return $target
}

function Backup-McpPlugin {
    param([string]$PluginRoot, [string]$BackupDir)
    if (-not (Test-Path -LiteralPath $PluginRoot)) { return $null }
    $name = Split-Path -Leaf $PluginRoot
    $target = Join-Path $BackupDir ("plugins\" + $name)
    Copy-McpDirectory -Source $PluginRoot -Destination $target -ExcludedNames @("Binaries", "Intermediate", "Saved", ".git")
    return $target
}

function Get-McpPackageManifest {
    param([string]$LogPath = "")
    if ($null -ne $script:PackageManifestCache) { return $script:PackageManifestCache }
    $path = Join-Path $script:PackageRoot "manifest.json"
    $manifest = $null
    if (Test-Path -LiteralPath $path) {
        try {
            $manifest = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
        } catch {
            Write-McpMessage -Message ("Package manifest is not valid JSON: {0}" -f $path) -Level "Warn" -LogPath $LogPath
            $manifest = $null
        }
    }
    if ($null -eq $manifest -or [string]::IsNullOrWhiteSpace([string]$manifest.productVersion)) {
        Write-McpMessage -Message ("No usable package manifest beside the installer; using the built-in fallback version {0}." -f $script:ProductVersionFallback) -Level "Warn" -LogPath $LogPath
        $manifest = [pscustomobject]@{ productVersion = $script:ProductVersionFallback; serverVersion = "" }
    }
    $script:PackageManifestCache = $manifest
    return $manifest
}

function Get-McpProductVersion {
    param([string]$LogPath = "")
    $manifest = Get-McpPackageManifest -LogPath $LogPath
    return [string]$manifest.productVersion
}

function Write-McpLauncher {
    param(
        [Parameter(Mandatory = $true)]$ProjectInfo,
        [Parameter(Mandatory = $true)]$EngineInfo,
        [Parameter(Mandatory = $true)]$Selection,
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [string]$NodePath = "node",
        [string]$LogPath
    )
    $saved = Join-Path $ProjectInfo.SavedDir $script:ProjectDataDirName
    if (-not (Test-Path -LiteralPath $saved)) { New-Item -ItemType Directory -Force -Path $saved | Out-Null }
    $entry = Join-Path $InstallRoot "app\dist\bin.js"
    $supervisor = Join-Path $InstallRoot "supervisor\UEVSupervisor.exe"
    $editor = $EngineInfo.EditorExe
    $project = $ProjectInfo.File
    $profile = $Selection.Profile
    $node = $NodePath
    $escape = { param($value) ([string]$value).Replace("'", "''") }

    if ($Selection.Supervisor) {
        $script = @'
param(
    [ValidateSet("unattended", "supervised")]
    [string]$Profile = "__PROFILE__",
    [int]$ControlPort = 8765
)
$ErrorActionPreference = "Stop"
$editor = '__EDITOR__'
$project = '__PROJECT__'
$entry = '__ENTRY__'
$supervisor = '__SUPERVISOR__'
$node = '__NODE__'
foreach ($path in @($editor, $project, $entry, $supervisor, $node)) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Missing install path: $path" }
}
if (Get-Process UE4Editor -ErrorAction SilentlyContinue) { throw "UE4Editor is already running. Close it before starting the stack." }
Write-Host "Starting UEV stack"
Write-Host "  project: $project"
Write-Host "  profile: $Profile"
Write-Host "  control: http://127.0.0.1:$ControlPort"
& $supervisor --editor $editor --project $project --pipe "uev-supervisor" --control-api --mcp-entry $entry --mcp-node $node --mcp-profile $Profile --control-port $ControlPort
'@
        $script = $script.Replace("__PROFILE__", (& $escape $profile)).Replace("__EDITOR__", (& $escape $editor)).Replace("__PROJECT__", (& $escape $project)).Replace("__ENTRY__", (& $escape $entry)).Replace("__SUPERVISOR__", (& $escape $supervisor)).Replace("__NODE__", (& $escape $node))
        $launcher = Join-Path $saved "run-stack.ps1"
        $utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false
        [System.IO.File]::WriteAllText($launcher, $script, $utf8)
        Write-McpMessage -Message "Created launcher: $launcher" -Level "Info" -LogPath $LogPath
        return $launcher
    }

    $script = @'
param(
    [ValidateSet("unattended", "supervised")]
    [string]$Profile = "__PROFILE__",
    [int]$ControlPort = 8765
)
$ErrorActionPreference = "Stop"
$entry = '__ENTRY__'
$editor = '__EDITOR__'
$project = '__PROJECT__'
$node = '__NODE__'
foreach ($path in @($entry, $node)) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Missing install path: $path" }
}
$env:UEV_PROFILE = $Profile
$env:UEV_BIND_ADDRESS = "127.0.0.1"
$env:UEV_COMMAND_ADDRESS = "127.0.0.1"
$env:UEV_MULTICAST_TTL = "0"
$env:UEV_SUPERVISOR = "0"
$env:UEV_CONTROL_PORT = "$ControlPort"
Write-Host "Starting standalone MCP control API. Launch the editor separately:"
Write-Host "  $editor $project"
Push-Location (Split-Path -Parent $entry)
try { & $node $entry --control } finally { Pop-Location }
'@
    $script = $script.Replace("__PROFILE__", (& $escape $profile)).Replace("__ENTRY__", (& $escape $entry)).Replace("__EDITOR__", (& $escape $editor)).Replace("__PROJECT__", (& $escape $project)).Replace("__NODE__", (& $escape $node))
    $launcher = Join-Path $saved "run-control-panel.ps1"
    $utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false
    [System.IO.File]::WriteAllText($launcher, $script, $utf8)
    Write-McpMessage -Message "Created launcher: $launcher" -Level "Info" -LogPath $LogPath
    return $launcher
}

function Write-McpStackConfig {
    param(
        [Parameter(Mandatory = $true)]$ProjectInfo,
        [Parameter(Mandatory = $true)]$Selection,
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [string]$NodePath = "node",
        [string]$EditorPath = "",
        [string]$SupervisorPath = "",
        [string]$StackConfigPath = "",
        [switch]$PreserveStackSettings,
        [string]$LogPath
    )
    # The stack config describes the runtime that lives beside it, so it is written even when the
    # MCP client recipe is skipped (-NoClientConfig): unlike mcp-client.json it belongs to the
    # install, not to a particular MCP client.
    if ($SupervisorPath -and (Test-Path -LiteralPath $SupervisorPath -PathType Container)) {
        $SupervisorPath = Join-Path $SupervisorPath "UEVSupervisor.exe"
    }
    if ([string]::IsNullOrWhiteSpace($StackConfigPath)) {
        # A custom -InstallRoot keeps its own stack.json instead of overwriting the one under %LOCALAPPDATA%\UEV.
        $StackConfigPath = Join-Path $InstallRoot "stack.json"
    }
    $entry = Join-Path $InstallRoot "app\dist\bin.js"
    $stackConfig = [ordered]@{
        project = $ProjectInfo.File
        editor = $EditorPath
        supervisor = $SupervisorPath
        mcpEntry = $entry
        node = $NodePath
        profile = $Selection.Profile
        pipe = $script:DefaultSupervisorPipe
        controlPort = 8765
        autoLaunch = $true
    }
    if ($PreserveStackSettings -and (Test-Path -LiteralPath $StackConfigPath)) {
        # -Update keeps the user-owned stack settings; only paths and the profile move.
        try {
            $previousStack = Get-Content -LiteralPath $StackConfigPath -Raw | ConvertFrom-Json
        } catch {
            $previousStack = $null
            Write-McpMessage -Message ("Existing stack config is not valid JSON and will be rewritten: {0}" -f $StackConfigPath) -Level "Warn" -LogPath $LogPath
        }
        if ($null -ne $previousStack) {
            foreach ($key in @("controlPort", "autoLaunch", "pipe", "profile")) {
                $previous = $previousStack.$key
                if ($null -ne $previous -and -not [string]::IsNullOrWhiteSpace([string]$previous)) { $stackConfig[$key] = $previous }
            }
            Write-McpMessage -Message ("Preserved stack settings from {0}: pipe={1}, controlPort={2}, autoLaunch={3}" -f $StackConfigPath, $stackConfig["pipe"], $stackConfig["controlPort"], $stackConfig["autoLaunch"]) -Level "Info" -LogPath $LogPath
        }
    }
    $stackDirectory = Split-Path -Parent $StackConfigPath
    if ($stackDirectory -and -not (Test-Path -LiteralPath $stackDirectory)) {
        New-Item -ItemType Directory -Force -Path $stackDirectory | Out-Null
    }
    $stackUtf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false
    [System.IO.File]::WriteAllText($StackConfigPath, ($stackConfig | ConvertTo-Json -Depth 10), $stackUtf8)
    Write-McpMessage -Message "Stack config: $StackConfigPath" -Level "Info" -LogPath $LogPath

    return $StackConfigPath
}

function Update-McpSharedStackConfig {
    # Refresh the shared stack.json under %LOCALAPPDATA%\UEV when it already points into the root
    # we just installed; a descriptor that belongs to another install is left alone.
    param(
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [Parameter(Mandatory = $true)]$ProjectInfo,
        [Parameter(Mandatory = $true)]$Selection,
        [string]$NodePath = "node",
        [string]$EditorPath = "",
        [string]$SupervisorPath = "",
        [switch]$DryRun,
        [string]$LogPath
    )
    $shared = Join-Path (Join-Path $env:LOCALAPPDATA "UEV") "stack.json"
    $own = Join-Path $InstallRoot "stack.json"
    if (-not (Test-Path -LiteralPath $shared)) { return $null }
    try {
        $previous = Get-Content -LiteralPath $shared -Raw | ConvertFrom-Json
    } catch {
        return $null
    }
    if ($shared -eq $own) { return $null }
    $root = $InstallRoot.TrimEnd('\', '/').Replace('/', '\')
    $referencesRoot = $false
    foreach ($key in @("supervisor", "mcpEntry", "node")) {
        $value = ([string]$previous.$key).Replace('/', '\')
        if (-not [string]::IsNullOrWhiteSpace($value) -and $value.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
            $referencesRoot = $true
        }
    }
    if (-not $referencesRoot) { return $null }
    if ($DryRun) {
        Write-McpMessage -Message ("[dry run] would refresh the shared stack config {0} to the UEV runtime" -f $shared) -Level "Info" -LogPath $LogPath
        return $shared
    }
    Write-McpMessage -Message ("Refreshing shared stack config {0} to the UEV runtime" -f $shared) -Level "Step" -LogPath $LogPath
    return Write-McpStackConfig -ProjectInfo $ProjectInfo -Selection $Selection -InstallRoot $InstallRoot -NodePath $NodePath -EditorPath $EditorPath -SupervisorPath $SupervisorPath -StackConfigPath $shared -PreserveStackSettings -LogPath $LogPath
}

function Write-McpClientConfig {
    param(
        [Parameter(Mandatory = $true)]$ProjectInfo,
        [Parameter(Mandatory = $true)]$Selection,
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [string]$NodePath = "node",
        [string]$ClientConfigPath = "",
        [string]$EditorPath = "",
        [string]$SupervisorPath = "",
        [string]$StackConfigPath = "",
        [switch]$PreserveStackSettings,
        [switch]$MergeExistingEnvironment,
        [string]$LogPath
    )
    $entry = Join-Path $InstallRoot "app\dist\bin.js"
    $StackConfigPath = Write-McpStackConfig -ProjectInfo $ProjectInfo -Selection $Selection -InstallRoot $InstallRoot -NodePath $NodePath -EditorPath $EditorPath -SupervisorPath $SupervisorPath -StackConfigPath $StackConfigPath -PreserveStackSettings:$PreserveStackSettings -LogPath $LogPath

    $target = $ClientConfigPath
    if ([string]::IsNullOrWhiteSpace($target)) {
        $target = Join-Path $ProjectInfo.SavedDir ($script:ProjectDataDirName + "\mcp-client.json")
    }
    $existingConfig = $null
    $existingServer = $null
    if (Test-Path -LiteralPath $target) {
        try {
            $existingConfig = Get-Content -LiteralPath $target -Raw | ConvertFrom-Json
        } catch {
            throw "Existing client config is not valid JSON: $target"
        }
        if ($null -ne $existingConfig.mcpServers) {
            $existingEntry = $existingConfig.mcpServers.PSObject.Properties["uev"]
            if ($null -ne $existingEntry) { $existingServer = $existingEntry.Value }
        }
    }

    $environment = [ordered]@{
        UEV_PROFILE = $Selection.Profile
        UEV_BIND_ADDRESS = "127.0.0.1"
        UEV_COMMAND_ADDRESS = "127.0.0.1"
        UEV_MULTICAST_TTL = "0"
        UEV_STACK_CONFIG = $StackConfigPath
        UEV_AUTO_LAUNCH = "1"
    }
    if ($Selection.Supervisor) {
        $environment["UEV_SUPERVISOR_PIPE"] = "\\.\pipe\$($script:DefaultSupervisorPipe)"
    } else {
        $environment["UEV_SUPERVISOR"] = "0"
    }
    if ($MergeExistingEnvironment -and $null -ne $existingServer -and $null -ne $existingServer.env) {
        # -Update keeps anything the user added to the recipe (audit log, allowlist, ports).
        $extra = 0
        foreach ($property in $existingServer.env.PSObject.Properties) {
            if (-not $environment.Contains($property.Name)) {
                $environment[$property.Name] = [string]$property.Value
                $extra += 1
            }
        }
        if ($extra -gt 0) {
            Write-McpMessage -Message ("Kept {0} existing environment entr(ies) from the previous client config." -f $extra) -Level "Info" -LogPath $LogPath
        }
    }
    $server = [ordered]@{
        transport = "stdio"
        command = $NodePath
        args = @($entry, "--stack-config", $StackConfigPath)
        env = $environment
    }

    $directory = Split-Path -Parent $target
    if ($directory -and -not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }

    if ($null -ne $existingConfig) {
        if ($null -eq $existingConfig.mcpServers) {
            $existingConfig | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{}) -Force
        }
        $existingConfig.mcpServers | Add-Member -NotePropertyName "uev" -NotePropertyValue ([pscustomobject]$server) -Force
        $text = $existingConfig | ConvertTo-Json -Depth 20
    } else {
        $root = [ordered]@{ mcpServers = [ordered]@{ "uev" = $server } }
        $text = $root | ConvertTo-Json -Depth 20
    }

    $utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false
    [System.IO.File]::WriteAllText($target, $text, $utf8)
    Write-McpMessage -Message "Client config: $target" -Level "Info" -LogPath $LogPath
    return $target
}

function Read-McpManifest {
    param([string]$InstallRoot, [string]$ProjectHash)
    $path = Join-Path $InstallRoot ("installs\" + $ProjectHash + ".json")
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    return (Get-Content -LiteralPath $path -Raw | ConvertFrom-Json)
}

function Write-McpManifest {
    param([string]$InstallRoot, [string]$ProjectHash, $Manifest, [string]$LogPath)
    $dir = Join-Path $InstallRoot "installs"
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $path = Join-Path $dir ($ProjectHash + ".json")
    $utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false
    [System.IO.File]::WriteAllText($path, ($Manifest | ConvertTo-Json -Depth 20), $utf8)
    Write-McpMessage -Message "Install manifest: $path" -Level "Info" -LogPath $LogPath
    return $path
}

function Invoke-UEVInstall {
    param(
        [string]$Project = "",
        [string]$Engine = "",
        [string]$InstallRoot = (Get-McpDefaultInstallRoot),
        [ValidateSet("unattended", "supervised")][string]$Profile = "supervised",
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
        [switch]$Json,
        [string]$LogPath = "",
        [switch]$AllowUnsupportedEngine,
        [switch]$Extras,
        [switch]$NoExtras,
        [string]$DebloatRoot = ""
    )

    if ($RegisterCommandCode) {
        if ($NoClientConfig) { throw "Use either -RegisterCommandCode or -NoClientConfig, not both." }
        if ([string]::IsNullOrWhiteSpace($ClientConfig)) {
            $ClientConfig = Join-Path $env:USERPROFILE ".commandcode\mcp.json"
        }
        $NoClientConfig = $false
    }

    $parameters = [pscustomobject]@{
        Project = $Project
        Engine = $Engine
        InstallRoot = $InstallRoot
        Profile = $Profile
        Components = @($Components)
        EnablePython = [bool]$EnablePython
        NoPython = [bool]$NoPython
        EnableLiveCoding = [bool]$EnableLiveCoding
        NoLiveCoding = [bool]$NoLiveCoding
        ContinueWithoutPython = [bool]$ContinueWithoutPython
        WithPanel = [bool]$WithPanel
        NoPanel = [bool]$NoPanel
        WithSupervisor = [bool]$WithSupervisor
        NoSupervisor = [bool]$NoSupervisor
        NoBuild = [bool]$NoBuild
        NoClientConfig = [bool]$NoClientConfig
        RegisterCommandCode = [bool]$RegisterCommandCode
        DryRun = [bool]$DryRun
        Force = [bool]$Force
        Update = [bool]$Update
        NonInteractive = [bool]$NonInteractive
        Yes = [bool]$Yes
        ClientConfig = $ClientConfig
        Json = [bool]$Json
        LogPath = $LogPath
        AllowUnsupportedEngine = [bool]$AllowUnsupportedEngine
        Extras = [bool]$Extras
        NoExtras = [bool]$NoExtras
        DebloatRoot = $DebloatRoot
    }

    if ([string]::IsNullOrWhiteSpace($Project)) {
        if ($NonInteractive) { throw "Project is required. Pass -Project <path-to-uproject>." }
        $Project = Read-Host "Path to the .uproject file or project folder"
    }
    $projectInfo = Get-McpProjectInfo -Path $Project

    if ([string]::IsNullOrWhiteSpace($LogPath) -and -not $DryRun) {
        $logDir = Join-Path $projectInfo.SavedDir $script:ProjectDataDirName
        if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
        $LogPath = Join-Path $logDir "install.log"
    }
    if ($DryRun) { $LogPath = "" }

    # -Json keeps stdout for the wrapper's ConvertTo-Json output: every human line moves to stderr.
    $script:JsonMode = [bool]$parameters.Json
    $packageManifest = Get-McpPackageManifest -LogPath $LogPath
    $script:ProductVersion = Get-McpProductVersion -LogPath $LogPath
    Write-McpMessage -Message ("UEV {0} installer (server {1}, protocol {2})" -f $script:ProductVersion, $packageManifest.serverVersion, $packageManifest.protocolVersion) -Level "Info" -LogPath $LogPath

    $resolvedEngine = Resolve-McpEnginePath -EnginePath $Engine -EngineAssociation $projectInfo.EngineAssociation
    $engineInfo = Get-McpEngineInfo -EnginePath $resolvedEngine -DebloatRoot $DebloatRoot -ProjectDir $projectInfo.Directory
    if ($engineInfo.Version -notmatch "^4\.27\.") {
        $message = "Engine version '$($engineInfo.Version)' is not a tested UE 4.27 release."
        if (-not $AllowUnsupportedEngine) { throw "$message Pass -AllowUnsupportedEngine to continue." }
        Write-McpMessage -Message $message -Level "Warn" -LogPath $LogPath
    }

    Write-McpMessage -Message "Resolved project: $($projectInfo.File)" -Level "Info" -LogPath $LogPath
    Write-McpMessage -Message "Resolved engine:  $($engineInfo.Root) ($($engineInfo.Version), BuildId $($engineInfo.BuildId))" -Level "Info" -LogPath $LogPath
    $pythonStatus = Get-McpPythonStatus -ProjectInfo $projectInfo -EngineInfo $engineInfo
    $liveCodingStatus = Get-McpLiveCodingStatus -ProjectInfo $projectInfo -EngineInfo $engineInfo

    $selection = Read-McpSelection -ProjectInfo $projectInfo -EngineInfo $engineInfo -PythonStatus $pythonStatus -LiveCodingStatus $liveCodingStatus -Parameters $parameters
    if ($null -eq $selection) {
        Write-McpMessage -Message "Install cancelled." -Level "Warn" -LogPath $LogPath
        return [pscustomobject]@{ Cancelled = $true }
    }

    if ($pythonStatus.Exists -and -not $pythonStatus.Enabled) {
        Write-McpMessage -Message "PythonScriptPlugin is available but disabled. The installer will add it to the .uproject and configure loopback remote execution." -Level "Warn" -LogPath $LogPath
    }
    if (-not $pythonStatus.Exists) {
        Write-McpMessage -Message "PythonScriptPlugin is missing from the engine. Python cannot be enabled by this installer." -Level "Warn" -LogPath $LogPath
    }
    if ($liveCodingStatus.Available -and -not $liveCodingStatus.Enabled) {
        Write-McpMessage -Message "Live Coding is available but disabled. Compile execution may still start it on demand; new UCLASSes/headers require a full build." -Level "Warn" -LogPath $LogPath
    }
    if (-not $liveCodingStatus.Available) {
        Write-McpMessage -Message "Live Coding is unavailable in this engine. Use full project builds for C++ changes." -Level "Warn" -LogPath $LogPath
    }

    $node = Test-McpPrerequisite -ProjectInfo $projectInfo -EngineInfo $engineInfo -Selection $selection -Parameters $parameters

    if ($DryRun) {
        Write-McpMessage -Message "Dry run: preflight passed; no installation was performed." -Level "Ok" -LogPath $LogPath
        return [pscustomobject]@{
            DryRun = $true
            ProductVersion = $script:ProductVersion
            ServerVersion = [string]$packageManifest.serverVersion
            ProtocolVersion = $packageManifest.protocolVersion
            ProductName = $script:ProductName
            InstallRoot = $InstallRoot
            SupervisorPipe = $script:DefaultSupervisorPipe
            Project = $projectInfo.File
            Engine = $engineInfo.Root
            Profile = $selection.Profile
            Update = [bool]$Update
            Python = $pythonStatus.Status
            LiveCoding = $liveCodingStatus.Status
            Components = $selection
        }
    }

    Clear-McpStaleControlDescriptor
    if (-not (Test-Path -LiteralPath $InstallRoot)) { New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null }
    $existingManifest = Read-McpManifest -InstallRoot $InstallRoot -ProjectHash $projectInfo.Hash
    if ($null -ne $existingManifest) {
        # Replacing the runtime under a live stack fails on locked files; stop every process
        # this root owns before any runtime or plugin file is rewritten.
        $stopped = Stop-McpInstalledProcesses -InstallRoot $InstallRoot
        if ($stopped -gt 0) {
            Write-McpMessage -Message ("Stopped {0} running process(es) under {1} before replacing the runtime." -f $stopped, $InstallRoot) -Level "Info" -LogPath $LogPath
        }
    }
    if ($Update -and $null -ne $existingManifest) {
        Write-McpMessage -Message ("Updating existing install at {0}: {1} -> {2}" -f $InstallRoot, [string]$existingManifest.productVersion, $script:ProductVersion) -Level "Info" -LogPath $LogPath
    } elseif ($Update) {
        Write-McpMessage -Message ("-Update requested but {0} holds no install manifest for this project; performing a fresh install." -f $InstallRoot) -Level "Warn" -LogPath $LogPath
    }
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $backupDir = Join-Path $projectInfo.SavedDir ($script:ProjectDataDirName + "\backups\" + $timestamp)
    $projectBackup = Backup-McpFile -Path $projectInfo.File -BackupDir $backupDir
    $engineIniPath = Join-Path $projectInfo.ConfigDir "DefaultEngine.ini"
    $liveCodingIniPath = Join-Path $projectInfo.ConfigDir "DefaultEditorPerProjectUserSettings.ini"
    $engineIniBackup = Backup-McpFile -Path $engineIniPath -BackupDir $backupDir
    $liveCodingIniBackup = Backup-McpFile -Path $liveCodingIniPath -BackupDir $backupDir
    $manifestBackup = $null
    if ($null -ne $existingManifest) {
        $manifestBackup = Backup-McpFile -Path (Join-Path $InstallRoot ("installs\" + $projectInfo.Hash + ".json")) -BackupDir $backupDir
    }

    $pluginNames = @()
    if ($selection.History) { $pluginNames += "UEVNative" }
    if ($selection.Panel) { $pluginNames += "UEVControlPanel" }
    if ($selection.EditorScriptingUtilities) { $pluginNames += "EditorScriptingUtilities" }

    $pluginBackups = @{}
    foreach ($pluginName in $pluginNames) {
        $existingPlugin = Join-Path $projectInfo.Directory ("Plugins\" + $pluginName)
        if (Test-Path -LiteralPath $existingPlugin) {
            $pluginBackups[$pluginName] = Backup-McpPlugin -PluginRoot $existingPlugin -BackupDir $backupDir
        }
    }

    $originalBackupDir = $backupDir
    if ($null -ne $existingManifest) {
        if (-not [string]::IsNullOrWhiteSpace([string]$existingManifest.originalBackupDir)) {
            $originalBackupDir = [string]$existingManifest.originalBackupDir
        } elseif ($null -ne $existingManifest.backups -and -not [string]::IsNullOrWhiteSpace([string]$existingManifest.backups.directory)) {
            $originalBackupDir = [string]$existingManifest.backups.directory
        }
    }
    $pluginExistedBefore = @{}
    if ($null -ne $existingManifest -and $null -ne $existingManifest.pluginExistedBefore) {
        foreach ($property in $existingManifest.pluginExistedBefore.PSObject.Properties) { $pluginExistedBefore[$property.Name] = [bool]$property.Value }
    }

    $createdPluginDirs = New-Object System.Collections.Generic.List[string]
    $pluginHashes = @{}
    $placement = @{}
    $oldEntries = $null
    $iniChanges = @()
    $launcher = ""
    $clientConfigPath = ""
    $stackConfigPath = ""
    $manifestPath = ""

    try {
        $appTarget = Copy-McpApplication -Source (Join-Path $script:PackageRoot "payload\app") -InstallRoot $InstallRoot -LogPath $LogPath
        $supervisorTarget = ""
        if ($selection.Supervisor) {
            $supervisorTarget = Copy-McpSupervisor -Source (Join-Path $script:PackageRoot "supervisor") -InstallRoot $InstallRoot -LogPath $LogPath
        }
        $nodeTarget = ""
        $nodePath = [string]$node.Path
        $nodeSource = Join-Path $script:PackageRoot "payload\node"
        if (Test-Path -LiteralPath (Join-Path $nodeSource "node.exe")) {
            $nodeTarget = Copy-McpNodeRuntime -Source $nodeSource -InstallRoot $InstallRoot -LogPath $LogPath
            $nodePath = Join-Path $nodeTarget "node.exe"
        }

        # Install the verifier next to the runtime so the editor's UEV Control
        # Panel can run the same checks as the package's -Verify mode.
        $installedInstaller = Join-Path $InstallRoot "installer"
        $installedModuleDir = Join-Path $installedInstaller "installer"
        New-Item -ItemType Directory -Force -Path $installedModuleDir | Out-Null
        $packageInstaller = Join-Path $script:PackageRoot "install.ps1"
        if (-not (Test-Path -LiteralPath $packageInstaller)) {
            $packageInstaller = Join-Path $script:PackageRoot "installer\Install-UEV.ps1"
        }
        Copy-Item -LiteralPath $packageInstaller -Destination (Join-Path $installedInstaller "install.ps1") -Force
        Copy-Item -LiteralPath (Join-Path $script:PackageRoot "installer\UEV.Installer.psm1") -Destination (Join-Path $installedModuleDir "UEV.Installer.psm1") -Force
        if (Test-Path -LiteralPath (Join-Path $script:PackageRoot "manifest.json")) {
            Copy-Item -LiteralPath (Join-Path $script:PackageRoot "manifest.json") -Destination (Join-Path $installedInstaller "manifest.json") -Force
        }
        Write-McpMessage -Message "Installed verification script: $installedInstaller\install.ps1" -Level "Info" -LogPath $LogPath

        $entries = [ordered]@{}
        if ($selection.Python) { $entries["PythonScriptPlugin"] = $false }
        if ($selection.EditorScriptingUtilities) { $entries["EditorScriptingUtilities"] = $true }
        if ($selection.History) { $entries["UEVNative"] = $true }
        if ($selection.Panel) { $entries["UEVControlPanel"] = $true }
        if ($selection.Extras) {
            if (Test-Path -LiteralPath (Join-Path $engineInfo.SequencerSource "SequencerScripting.uplugin")) { $entries["SequencerScripting"] = $true }
            if (Test-Path -LiteralPath (Join-Path $engineInfo.RtxgiSource "RTXGI.uplugin")) { $entries["RTXGI"] = $true }
        }

        foreach ($pluginName in $pluginNames) {
            $destination = Join-Path $projectInfo.Directory ("Plugins\" + $pluginName)
            if ($pluginName -eq "EditorScriptingUtilities") {
                $source = $engineInfo.EditorScriptingUtilitiesSource
                if ([string]::IsNullOrWhiteSpace($source) -or -not (Test-Path -LiteralPath $source)) {
                    throw "EditorScriptingUtilities source was not found in the engine. Pass -DebloatRoot or deselect the component."
                }
            } else {
                $source = Join-Path $script:PackageRoot ("payload\plugins\" + $pluginName)
                if (-not (Test-Path -LiteralPath $source)) {
                    throw "Packaged native plugin not found: $source"
                }
            }

            $sourceFull = (Resolve-Path -LiteralPath $source).Path
            $destinationFull = [System.IO.Path]::GetFullPath($destination)
            $samePath = $sourceFull.TrimEnd("\", "/").Equals($destinationFull.TrimEnd("\", "/"), [System.StringComparison]::OrdinalIgnoreCase)
            $managedCopy = $true

            if (Test-Path -LiteralPath $destination) {
                if ($samePath) {
                    $managedCopy = $false
                    Write-McpMessage -Message ("Using existing {0} at {1}" -f $pluginName, $destination) -Level "Info" -LogPath $LogPath
                } else {
                    if ($null -eq $existingManifest -and -not $Force) {
                        throw "Plugin '$pluginName' already exists at $destination and is not managed by this installer. Re-run with -Force to replace it."
                    }
                    if ($null -ne $existingManifest -and -not $Force) {
                        $expectedHash = [string]$existingManifest.pluginHashes.$pluginName
                        if (-not [string]::IsNullOrWhiteSpace($expectedHash)) {
                            $currentHash = Get-McpTreeHash -Path $destination
                            if ($currentHash -ne $expectedHash) {
                                throw "Plugin '$pluginName' has local modifications. Re-run with -Force to replace it, or move the changes aside first."
                            }
                        }
                    }
                    Remove-Item -LiteralPath $destination -Recurse -Force
                }
            }

            if ($managedCopy) {
                Write-McpMessage -Message ("Installing {0} source..." -f $pluginName) -Level "Step" -LogPath $LogPath
                Copy-McpDirectory -Source $source -Destination $destination
                $createdPluginDirs.Add($destination)
            }
            $placement[$pluginName] = $destination
            $pluginHashes[$pluginName] = Get-McpTreeHash -Path $destination
        }

        $pluginUpdate = Update-McpProjectPlugins -ProjectFile $projectInfo.File -Entries $entries
        $oldEntries = @{}
        if ($null -ne $existingManifest -and $null -ne $existingManifest.pluginEntriesBefore) {
            foreach ($property in $existingManifest.pluginEntriesBefore.PSObject.Properties) { $oldEntries[$property.Name] = $property.Value }
        }
        foreach ($name in $pluginUpdate.Before.Keys) {
            if (-not $oldEntries.ContainsKey($name)) { $oldEntries[$name] = $pluginUpdate.Before[$name] }
        }
        foreach ($pluginName in $pluginNames) {
            if (-not $pluginExistedBefore.ContainsKey($pluginName)) {
                $pluginExistedBefore[$pluginName] = $pluginBackups.ContainsKey($pluginName)
            }
        }

        if ($selection.Python -or $selection.RemoteExecution) {
            $pythonIniValues = [ordered]@{
                bRemoteExecution = "True"
                RemoteExecutionMulticastBindAddress = "127.0.0.1"
                RemoteExecutionMulticastTtl = "0"
            }
            $before = Set-McpIniValues -Path $engineIniPath -Section $script:PythonIniSection -Values $pythonIniValues
            $after = [ordered]@{
                bRemoteExecution = "True"
                RemoteExecutionMulticastBindAddress = "127.0.0.1"
                RemoteExecutionMulticastTtl = "0"
            }
            $iniChanges += [pscustomobject]@{ Path = $engineIniPath; Section = $script:PythonIniSection; Before = $before; After = $after }
        }

        if ($selection.LiveCoding -and $engineInfo.LiveCodingAvailable) {
            $liveValues = [ordered]@{
                bEnabled = "True"
                Startup = "Manual"
            }
            $before = Set-McpIniValues -Path $liveCodingIniPath -Section $script:LiveCodingIniSection -Values $liveValues
            $after = [ordered]@{ bEnabled = "True"; Startup = "Manual" }
            $iniChanges += [pscustomobject]@{ Path = $liveCodingIniPath; Section = $script:LiveCodingIniSection; Before = $before; After = $after }
        }

        if ($null -ne $existingManifest -and $null -ne $existingManifest.iniChanges) {
            $iniChanges = Merge-McpIniChanges -ExistingChanges $existingManifest.iniChanges -NewChanges $iniChanges
        }

        $buildResults = @()
        if ($selection.Build -and $pluginNames.Count -gt 0) {
            Build-McpProject -ProjectInfo $projectInfo -EngineInfo $engineInfo -LogPath $LogPath
            foreach ($pluginName in $pluginNames) {
                $buildResults += Test-McpPluginBuild -ProjectInfo $projectInfo -PluginName $pluginName -LogPath $LogPath
            }
            if ($engineInfo.BuildId) {
                foreach ($result in $buildResults) {
                    if ($result.BuildId -and $result.BuildId -ne $engineInfo.BuildId) {
                        Write-McpMessage -Message ("{0} BuildId {1} does not match engine BuildId {2}; rebuilding the project may be required." -f $result.Plugin, $result.BuildId, $engineInfo.BuildId) -Level "Warn" -LogPath $LogPath
                    }
                }
            }
        } elseif ($selection.Build) {
            Write-McpMessage -Message "No native plugins selected; skipping project build." -Level "Info" -LogPath $LogPath
        } else {
            Write-McpMessage -Message "Build skipped. The native plugins will not load until the project is built." -Level "Warn" -LogPath $LogPath
        }

        $launcher = Write-McpLauncher -ProjectInfo $projectInfo -EngineInfo $engineInfo -Selection $selection -InstallRoot $InstallRoot -NodePath $nodePath -LogPath $LogPath
        $editorPath = Join-Path $engineInfo.Root "Engine\Binaries\Win64\UE4Editor.exe"
        if ($selection.ClientConfig) {
            $clientConfigPath = Write-McpClientConfig -ProjectInfo $projectInfo -Selection $selection -InstallRoot $InstallRoot -NodePath $nodePath -ClientConfigPath $ClientConfig -EditorPath $editorPath -SupervisorPath $supervisorTarget -PreserveStackSettings:$Update -MergeExistingEnvironment:$Update -LogPath $LogPath
        } else {
            # -NoClientConfig still owns the stack descriptor: it is runtime state, not a client recipe.
            $stackConfigPath = Write-McpStackConfig -ProjectInfo $projectInfo -Selection $selection -InstallRoot $InstallRoot -NodePath $nodePath -EditorPath $editorPath -SupervisorPath $supervisorTarget -PreserveStackSettings:$Update -LogPath $LogPath
        }

        # 1.6.0 could leave a shared stack.json naming the pre-rename supervisor; keep it usable.
        $sharedStackConfig = Update-McpSharedStackConfig -InstallRoot $InstallRoot -ProjectInfo $projectInfo -Selection $selection -NodePath $nodePath -EditorPath $editorPath -SupervisorPath $supervisorTarget -DryRun:$DryRun -LogPath $LogPath

        $manifest = [ordered]@{
            schemaVersion = 1
            productVersion = [string]$packageManifest.productVersion
            serverVersion = [string]$packageManifest.serverVersion
            installedAt = (Get-Date -Format "o")
            project = $projectInfo.File
            projectHash = $projectInfo.Hash
            projectName = $projectInfo.Name
            engine = $engineInfo.Root
            engineVersion = $engineInfo.Version
            engineBuildId = $engineInfo.BuildId
            profile = $selection.Profile
            components = $selection
            managedPluginDirs = @($createdPluginDirs)
            pluginPlacement = $placement
            pluginHashes = $pluginHashes
            pluginExistedBefore = $pluginExistedBefore
            pluginEntriesBefore = $oldEntries
            pluginEntriesAfter = $pluginUpdate.After
            originalBackupDir = $originalBackupDir
            iniChanges = @($iniChanges)
            backups = [ordered]@{
                directory = $backupDir
                project = $projectBackup
                engineIni = $engineIniBackup
                liveCodingIni = $liveCodingIniBackup
                manifest = $manifestBackup
            }
            launcher = $launcher
            clientConfig = $clientConfigPath
            stackConfig = $stackConfigPath
            sharedStackConfig = $sharedStackConfig
            commandCodeRegistered = [bool]($RegisterCommandCode -and $clientConfigPath)
            installRoot = $InstallRoot
            appPath = $appTarget
            supervisorPath = $supervisorTarget
            nodePath = $nodePath
            nodeVersion = [string]$node.Version
            nodeBundled = [bool]$nodeTarget
            schema = 1
        }
        $manifestPath = Write-McpManifest -InstallRoot $InstallRoot -ProjectHash $projectInfo.Hash -Manifest $manifest -LogPath $LogPath

        Write-McpMessage -Message "UEV installation complete." -Level "Ok" -LogPath $LogPath
        Write-McpMessage -Message ("  Project:    {0}" -f $projectInfo.File) -Level "Info" -LogPath $LogPath
        Write-McpMessage -Message ("  Server:     {0}" -f $appTarget) -Level "Info" -LogPath $LogPath
        Write-McpMessage -Message ("  Node:       {0}" -f $nodePath) -Level "Info" -LogPath $LogPath
        if ($supervisorTarget) { Write-McpMessage -Message ("  Supervisor: {0}" -f $supervisorTarget) -Level "Info" -LogPath $LogPath }
        Write-McpMessage -Message ("  Launcher:   {0}" -f $launcher) -Level "Info" -LogPath $LogPath
        if ($stackConfigPath) { Write-McpMessage -Message ("  Stack:      {0}" -f $stackConfigPath) -Level "Info" -LogPath $LogPath }
        if ($clientConfigPath) { Write-McpMessage -Message ("  Client:     {0}" -f $clientConfigPath) -Level "Info" -LogPath $LogPath }
        if ($RegisterCommandCode) {
            Write-McpMessage -Message "Command Code registration written. Restart Command Code or open /mcp to load the native Unreal tools." -Level "Ok" -LogPath $LogPath
        } else {
            Write-McpMessage -Message "  IMPORTANT: the client config is a recipe, not registration. Your AI client will not see the server until it is added to that client's MCP list." -Level "Warn" -LogPath $LogPath
            Write-McpMessage -Message "  Command Code: rerun with -RegisterCommandCode, or merge the client config into `"$env:USERPROFILE\.commandcode\mcp.json`"." -Level "Info" -LogPath $LogPath
        }
        Write-McpMessage -Message ("  Manifest:   {0}" -f $manifestPath) -Level "Info" -LogPath $LogPath
        if (-not $selection.Python) {
            Write-McpMessage -Message "  DEGRADED: Python was not enabled; editor calls will time out until PythonScriptPlugin is enabled." -Level "Warn" -LogPath $LogPath
        }
        if (-not $liveCodingStatus.Available) {
            Write-McpMessage -Message "  Live Coding unavailable; use a full build for C++ changes." -Level "Warn" -LogPath $LogPath
        }

        return [pscustomobject]@{
            Success = $true
            Project = $projectInfo.File
            Engine = $engineInfo.Root
            Profile = $selection.Profile
            Components = $selection
            App = $appTarget
            Supervisor = $supervisorTarget
            Node = $nodePath
            Launcher = $launcher
            StackConfig = $stackConfigPath
            ClientConfig = $clientConfigPath
            CommandCodeRegistered = [bool]($RegisterCommandCode -and $clientConfigPath)
            Manifest = $manifestPath
            Python = $pythonStatus.Status
            LiveCoding = $liveCodingStatus.Status
        }
    } catch {
        Write-McpMessage -Message ("Install failed: {0}" -f $_.Exception.Message) -Level "Error" -LogPath $LogPath
        if ($projectBackup -and (Test-Path -LiteralPath $projectBackup)) { Copy-Item -LiteralPath $projectBackup -Destination $projectInfo.File -Force }
        if ($engineIniBackup -and (Test-Path -LiteralPath $engineIniBackup)) { Copy-Item -LiteralPath $engineIniBackup -Destination $engineIniPath -Force }
        if ($liveCodingIniBackup -and (Test-Path -LiteralPath $liveCodingIniBackup)) { Copy-Item -LiteralPath $liveCodingIniBackup -Destination $liveCodingIniPath -Force }
        if ($manifestPath -and (Test-Path -LiteralPath $manifestPath)) { Remove-Item -LiteralPath $manifestPath -Force }
        if ($manifestBackup -and (Test-Path -LiteralPath $manifestBackup)) {
            $manifestTarget = Join-Path $InstallRoot ("installs\" + $projectInfo.Hash + ".json")
            if (-not (Test-Path -LiteralPath (Split-Path -Parent $manifestTarget))) { New-Item -ItemType Directory -Force -Path (Split-Path -Parent $manifestTarget) | Out-Null }
            Copy-Item -LiteralPath $manifestBackup -Destination $manifestTarget -Force
        }
        foreach ($pluginName in $pluginBackups.Keys) {
            $backup = $pluginBackups[$pluginName]
            $destination = Join-Path $projectInfo.Directory ("Plugins\" + $pluginName)
            if ($backup -and (Test-Path -LiteralPath $backup)) {
                if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
                Copy-McpDirectory -Source $backup -Destination $destination
            }
        }
        throw
    }
}

function Invoke-UEVUninstall {
    param(
        [Parameter(Mandatory = $true)][string]$Project,
        [string]$InstallRoot = (Get-McpDefaultInstallRoot),
        [switch]$Force,
        [switch]$NonInteractive,
        [switch]$Yes,
        [switch]$KeepBackups,
        [switch]$PurgeUserState,
        [string]$LogPath = ""
    )

    Clear-McpStaleControlDescriptor
    $projectInfo = Get-McpProjectInfo -Path $Project
    if ([string]::IsNullOrWhiteSpace($LogPath)) {
        $logDir = Join-Path $projectInfo.SavedDir $script:ProjectDataDirName
        if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
        $LogPath = Join-Path $logDir "uninstall.log"
    }
    if (Test-McpEditorRunning) { throw "UE4Editor is running. Close it before uninstalling." }
    $manifest = Read-McpManifest -InstallRoot $InstallRoot -ProjectHash $projectInfo.Hash
    if ($null -eq $manifest) { throw "No installer manifest found for $($projectInfo.File) under $InstallRoot\installs." }

    if (-not $Yes -and -not $NonInteractive) {
        $confirm = Read-Host "Remove the managed UEV install from $($projectInfo.Name)? [y/N]"
        if ($confirm -notmatch "^(?i)y(es)?$") { Write-McpMessage -Message "Uninstall cancelled." -Level "Warn" -LogPath $LogPath; return }
    }

    $managedNames = @()
    if ($null -ne $manifest.managedPluginDirs) {
        foreach ($dir in @($manifest.managedPluginDirs)) { $managedNames += (Split-Path -Leaf ([string]$dir)) }
    }
    if ($managedNames.Count -eq 0 -and $null -ne $manifest.pluginPlacement) {
        $managedNames = @($manifest.pluginPlacement.PSObject.Properties.Name)
    }
    $backupRoot = ""
    if (-not [string]::IsNullOrWhiteSpace([string]$manifest.originalBackupDir)) {
        $backupRoot = [string]$manifest.originalBackupDir
    } elseif ($null -ne $manifest.backups -and -not [string]::IsNullOrWhiteSpace([string]$manifest.backups.directory)) {
        $backupRoot = [string]$manifest.backups.directory
    }
    foreach ($pluginName in $managedNames) {
        $destination = [string]$manifest.pluginPlacement.$pluginName
        $backupPlugin = ""
        if (-not [string]::IsNullOrWhiteSpace($backupRoot)) { $backupPlugin = Join-Path $backupRoot ("plugins\" + $pluginName) }
        $existedBefore = (Test-Path -LiteralPath $backupPlugin)
        if ($null -ne $manifest.pluginExistedBefore -and $null -ne $manifest.pluginExistedBefore.PSObject.Properties[$pluginName]) {
            $existedBefore = [bool]$manifest.pluginExistedBefore.$pluginName
        }
        if ((-not (Test-Path -LiteralPath $destination)) -and -not $existedBefore) { continue }
        $expected = [string]$manifest.pluginHashes.$pluginName
        $current = ""
        if (Test-Path -LiteralPath $destination) { $current = Get-McpTreeHash -Path $destination }
        if ((Test-Path -LiteralPath $destination) -and $expected -and $current -ne $expected -and -not $Force) {
            Write-McpMessage -Message "Leaving modified plugin directory: $destination (use -Force to remove)." -Level "Warn" -LogPath $LogPath
            continue
        }
        if ($Yes -or $NonInteractive -or $Force -or ((Read-Host ("Remove {0}? [y/N]" -f $destination)) -match "^(?i)y(es)?$")) {
            if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
            if ($KeepBackups -and $existedBefore -and (Test-Path -LiteralPath $backupPlugin)) {
                Copy-McpDirectory -Source $backupPlugin -Destination $destination
                Write-McpMessage -Message "Restored original $pluginName source at $destination" -Level "Ok" -LogPath $LogPath
            } else {
                Write-McpMessage -Message "Removed $destination" -Level "Ok" -LogPath $LogPath
            }
        }
    }

    if ($manifest.pluginEntriesBefore -and $manifest.pluginEntriesAfter) {
        $before = @{}
        foreach ($property in $manifest.pluginEntriesBefore.PSObject.Properties) { $before[$property.Name] = $property.Value }
        $after = @{}
        foreach ($property in $manifest.pluginEntriesAfter.PSObject.Properties) { $after[$property.Name] = $property.Value }
        Undo-McpProjectPlugins -ProjectFile $projectInfo.File -Before $before -After $after
    }

    foreach ($change in @($manifest.iniChanges)) {
        if ($null -eq $change) { continue }
        $before = @{}
        $after = @{}
        if ($change.Before) { foreach ($property in $change.Before.PSObject.Properties) { $before[$property.Name] = $property.Value } }
        if ($change.After) { foreach ($property in $change.After.PSObject.Properties) { $after[$property.Name] = $property.Value } }
        Restore-McpIniValues -Path ([string]$change.Path) -Section ([string]$change.Section) -Before $before -After $after
    }

    foreach ($path in @($manifest.launcher, $manifest.clientConfig)) {
        if ($path -and (Test-Path -LiteralPath ([string]$path))) { Remove-Item -LiteralPath ([string]$path) -Force }
    }
    $manifestPath = Join-Path $InstallRoot ("installs\" + $projectInfo.Hash + ".json")
    if (Test-Path -LiteralPath $manifestPath) { Remove-Item -LiteralPath $manifestPath -Force }

    if (-not $KeepBackups -and -not [string]::IsNullOrWhiteSpace($backupRoot) -and (Test-Path -LiteralPath $backupRoot)) {
        Remove-Item -LiteralPath $backupRoot -Recurse -Force -ErrorAction SilentlyContinue
    }

    Stop-McpInstalledProcesses -InstallRoot $InstallRoot

    $LogPath = ""
    $projectDataDir = Join-Path $projectInfo.SavedDir $script:ProjectDataDirName
    if (Test-Path -LiteralPath $projectDataDir) {
        Remove-Item -LiteralPath $projectDataDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    $installsDir = Join-Path $InstallRoot "installs"
    $remainingInstalls = @(Get-ChildItem -LiteralPath $installsDir -Filter "*.json" -File -ErrorAction SilentlyContinue)
    $runtimeRemoved = $false
    if ($remainingInstalls.Count -eq 0 -and (Test-Path -LiteralPath $InstallRoot)) {
        Remove-Item -LiteralPath $InstallRoot -Recurse -Force -ErrorAction SilentlyContinue
        $runtimeRemoved = -not (Test-Path -LiteralPath $InstallRoot)

        # The per-user root and ~/.uev are shared by every install of this product, so an uninstall
        # only removes them when the caller explicitly asks: they may still serve another install
        # root and they hold the audit/history journals.
        if ($PurgeUserState) {
            $perUserRoot = Join-Path $env:LOCALAPPDATA $script:ProductName
            if (Test-Path -LiteralPath $perUserRoot) { Remove-Item -LiteralPath $perUserRoot -Recurse -Force -ErrorAction SilentlyContinue }

            $historyDir = Join-Path $env:USERPROFILE ".uev"
            if (Test-Path -LiteralPath $historyDir) { Remove-Item -LiteralPath $historyDir -Recurse -Force -ErrorAction SilentlyContinue }
        }
    }

    $summary = if ($runtimeRemoved) {
        "Uninstall complete. Plugins, project install data, backups and the server runtime were removed."
    } else {
        "Uninstall complete. Plugins, project install data and backups were removed; server runtime kept for $($remainingInstalls.Count) remaining install(s)."
    }
    if ($runtimeRemoved -and -not $PurgeUserState) {
        $summary += " Shared per-user state was kept; pass -PurgeUserState to remove %LOCALAPPDATA%\UEV and ~/.uev as well."
    }
    Write-McpMessage -Message $summary -Level "Ok"
}

function Test-UEVInstall {
    param(
        [Parameter(Mandatory = $true)][string]$Project,
        [string]$InstallRoot = (Get-McpDefaultInstallRoot)
    )

    $projectInfo = Get-McpProjectInfo -Path $Project
    $manifest = Read-McpManifest -InstallRoot $InstallRoot -ProjectHash $projectInfo.Hash
    if ($null -eq $manifest) { throw "No installer manifest found for $($projectInfo.File)." }
    $checks = New-Object System.Collections.Generic.List[object]

    $appEntry = Join-Path $InstallRoot "app\dist\bin.js"
    $checks.Add([pscustomobject]@{ Name = "server entry"; Ok = (Test-Path -LiteralPath $appEntry); Detail = $appEntry })
    if (-not [string]::IsNullOrWhiteSpace([string]$manifest.nodePath)) {
        $nodeCheck = [string]$manifest.nodePath
        $checks.Add([pscustomobject]@{ Name = "Node runtime"; Ok = (Test-Path -LiteralPath $nodeCheck); Detail = $nodeCheck })
    }
    $scriptsDir = Join-Path $InstallRoot "app\dist\editor\scripts"
    $scriptCount = @(Get-ChildItem -LiteralPath $scriptsDir -Recurse -Filter "*.py" -File -ErrorAction SilentlyContinue).Count
    $checks.Add([pscustomobject]@{ Name = "editor Python scripts"; Ok = ($scriptCount -gt 0); Detail = "$scriptCount files" })
    $pluginManifest = Join-Path $InstallRoot "app\dist\plugins\plugins.manifest.json"
    $checks.Add([pscustomobject]@{ Name = "plugin manifest"; Ok = (Test-Path -LiteralPath $pluginManifest); Detail = $pluginManifest })

    # 1.7.0 identity: the manifest records the shipped product version and the supervisor image
    # is the UEV one.
    $manifestVersion = [string]$manifest.productVersion
    $checks.Add([pscustomobject]@{ Name = "product version"; Ok = ($manifestVersion -eq $script:ProductVersionFallback); Detail = "$manifestVersion (expected $($script:ProductVersionFallback))" })
    if ($manifest.components.Supervisor) {
        $supervisorExe = Join-Path $InstallRoot "supervisor\UEVSupervisor.exe"
        $checks.Add([pscustomobject]@{ Name = "UEV supervisor binary"; Ok = (Test-Path -LiteralPath $supervisorExe); Detail = $supervisorExe })
    }
    $projectDataDir = Join-Path $projectInfo.SavedDir $script:ProjectDataDirName
    $checks.Add([pscustomobject]@{ Name = "project data directory ($($script:ProjectDataDirName))"; Ok = (Test-Path -LiteralPath $projectDataDir); Detail = $projectDataDir })

    foreach ($pluginName in @($manifest.pluginPlacement.PSObject.Properties.Name)) {
        $destination = [string]$manifest.pluginPlacement.$pluginName
        $binaries = Join-Path $destination "Binaries\Win64"
        $dlls = @(Get-ChildItem -LiteralPath $binaries -Filter "UE4Editor-*.dll" -File -ErrorAction SilentlyContinue)
        $checks.Add([pscustomobject]@{ Name = "$pluginName DLL"; Ok = ($dlls.Count -gt 0); Detail = $binaries })
    }

    $json = Get-Content -LiteralPath $projectInfo.File -Raw | ConvertFrom-Json
    $plugins = @($json.Plugins)
    $componentNames = @()
    if ($manifest.components.Python) { $componentNames += "PythonScriptPlugin" }
    if ($manifest.components.History) { $componentNames += "UEVNative" }
    if ($manifest.components.Panel) { $componentNames += "UEVControlPanel" }
    if ($manifest.components.EditorScriptingUtilities) { $componentNames += "EditorScriptingUtilities" }
    foreach ($name in $componentNames) {
        $entry = (@($plugins | Where-Object { $_.Name -eq $name }) | Select-Object -First 1)
        $checks.Add([pscustomobject]@{ Name = "$name project entry"; Ok = ($null -ne $entry -and [bool]$entry.Enabled); Detail = "enabled" })
    }


    $iniPath = Join-Path $projectInfo.ConfigDir "DefaultEngine.ini"
    if ($manifest.components.Python -or $manifest.components.RemoteExecution) {
        $remote = Get-McpIniValue -Path $iniPath -Section $script:PythonIniSection -Key "bRemoteExecution"
        $checks.Add([pscustomobject]@{ Name = "Python remote execution"; Ok = ($remote -ieq "True"); Detail = "$remote" })
    }
    if ($manifest.components.LiveCoding) {
        $livePath = Join-Path $projectInfo.ConfigDir "DefaultEditorPerProjectUserSettings.ini"
        $live = Get-McpIniValue -Path $livePath -Section $script:LiveCodingIniSection -Key "bEnabled"
        $checks.Add([pscustomobject]@{ Name = "Live Coding setting"; Ok = ($live -ieq "True"); Detail = "$live" })
    }

    foreach ($check in $checks) {
        $level = "Ok"
        if (-not $check.Ok) { $level = "Warn" }
        Write-McpMessage -Message ("[{0}] {1}: {2}" -f $(if ($check.Ok) { "OK" } else { "MISSING" }), $check.Name, $check.Detail) -Level $level
    }
    $failures = @($checks | Where-Object { -not $_.Ok })
    if ($failures.Count -gt 0) { throw "$($failures.Count) verification check(s) failed." }
    Write-McpMessage -Message "Install verification passed." -Level "Ok"
    return $checks
}


function Get-UevClientTable {
    $tablePath = Join-Path $PSScriptRoot "clients.json"
    if (-not (Test-Path -LiteralPath $tablePath)) { throw "Client table not found: $tablePath" }
    $table = Get-Content -LiteralPath $tablePath -Raw | ConvertFrom-Json
    return @($table.clients)
}

function Resolve-UevClientPath {
    param([string]$Path, [string]$Project)
    if ([string]::IsNullOrWhiteSpace($Path)) { return "" }
    $projectDir = ""
    if (-not [string]::IsNullOrWhiteSpace($Project)) {
        $projectDir = $Project.TrimEnd('')
        if ($projectDir -match '.uproject$') { $projectDir = Split-Path -Parent $projectDir }
    }
    $resolved = $Path.Replace('${USERPROFILE}', $env:USERPROFILE).Replace('${APPDATA}', $env:APPDATA).Replace('${LOCALAPPDATA}', $env:LOCALAPPDATA).Replace('${PROJECT}', $projectDir)
    return $resolved
}

function New-UevServerEntry {
    param([string]$InstallRoot)
    $root = $InstallRoot.TrimEnd('\')
    $entry = [ordered]@{}
    $entry["transport"] = "stdio"
    $entry["command"] = (Join-Path $root "node\node.exe")
    $entry["args"] = @((Join-Path $root "app\dist\bin.js"))
    $entry["env"] = [ordered]@{
        UEV_PROFILE = "supervised"
        UEV_BIND_ADDRESS = "127.0.0.1"
        UEV_COMMAND_ADDRESS = "127.0.0.1"
        UEV_MULTICAST_TTL = "0"
        UEV_SUPERVISOR_PIPE = "\\.\pipe\uev-supervisor"
    }
    return $entry
}

function Get-UevClientSnippet {
    param([string]$Client, [string]$InstallRoot, [string]$Project = "")
    $table = Get-UevClientTable
    $row = $table | Where-Object { $_.id -eq $Client }
    if ($null -eq $row) { throw "Unknown client '$Client'. Run -ListClients to see the table." }
    $entry = New-UevServerEntry -InstallRoot $InstallRoot
    $nl = [Environment]::NewLine
    switch ($row.format) {
        "servers" {
            $vscodeEntry = [ordered]@{ type = "stdio" }
            foreach ($k in $entry.Keys) { $vscodeEntry[$k] = $entry[$k] }
            return ([ordered]@{ servers = [ordered]@{ uev = $vscodeEntry } } | ConvertTo-Json -Depth 12)
        }
        "context_servers" {
            $zedEntry = [ordered]@{ command = [ordered]@{ path = $entry["command"]; args = $entry["args"]; env = $entry["env"] } }
            return ([ordered]@{ context_servers = [ordered]@{ uev = $zedEntry } } | ConvertTo-Json -Depth 12)
        }
        "toml" {
            $lines = @("[mcp_servers.uev]", "command = '" + $entry["command"].Replace("'", "''") + "'", "args = ['" + $entry["args"][0].Replace("'", "''") + "']", "[mcp_servers.uev.env]")
            foreach ($k in $entry["env"].Keys) { $lines += ($k + " = '" + $entry["env"][$k] + "'") }
            return ($lines -join $nl)
        }
        "yaml" {
            $lines = @("mcpServers:", "  - name: uev", "    type: stdio", "    command: " + $entry["command"], "    args:", "      - " + $entry["args"][0], "    env:")
            foreach ($k in $entry["env"].Keys) { $lines += ("      " + $k + ": '" + $entry["env"][$k] + "'") }
            return ($lines -join $nl)
        }
        "opencode" {
            $block = [ordered]@{ mcp = [ordered]@{ uev = [ordered]@{ type = "local"; command = @($entry["command"], $entry["args"][0]); environment = $entry["env"] } } }
            return ($block | ConvertTo-Json -Depth 12)
        }
        "dsh" {
            return (@(
                "DeepSeek Harness manages MCP servers through a plugin, not a config file this installer can edit:",
                "  1. Install the dsh-mcp-manager plugin (Settings > Plugins > Marketplace).",
                "  2. Open its MCP settings page and add a stdio server named 'uev'.",
                "  3. command: " + $entry["command"],
                "     args:    " + $entry["args"][0],
                "     env:     UEV_PROFILE=supervised, UEV_BIND_ADDRESS=127.0.0.1, UEV_COMMAND_ADDRESS=127.0.0.1, UEV_MULTICAST_TTL=0, UEV_SUPERVISOR_PIPE=\\.\pipe\uev-supervisor",
                "",
                ([ordered]@{ mcpServers = [ordered]@{ uev = $entry } } | ConvertTo-Json -Depth 12)
            ) -join $nl)
        }
        default { return ([ordered]@{ mcpServers = [ordered]@{ uev = $entry } } | ConvertTo-Json -Depth 12) }
    }
}

function Set-UevMcpClientEntry {
    param(
        [Parameter(Mandatory = $true)][string]$Client,
        [string]$Scope = "user",
        [Parameter(Mandatory = $true)][string]$Project,
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [switch]$Force,
        [switch]$DryRun
    )
    $table = Get-UevClientTable
    $row = $table | Where-Object { $_.id -eq $Client }
    if ($null -eq $row) { throw "Unknown client '$Client'. Run -ListClients to see the table." }
    if (-not $row.writable) {
        Write-McpMessage -Message ("{0} needs a manual paste: {1}" -f $row.label, $row.note) -Level "Info"
        Write-McpMessage -Message (Get-UevClientSnippet -Client $Client -InstallRoot $InstallRoot -Project $Project) -Level "Info"
        return [pscustomobject]@{ client = $Client; wrote = $false; reason = "paste-required" }
    }
    if ($Scope -eq "project") { $path = Resolve-UevClientPath -Path $row.projectPath -Project $Project }
    else { $path = Resolve-UevClientPath -Path $row.userPath -Project $Project }
    if ([string]::IsNullOrWhiteSpace($path)) {
        Write-McpMessage -Message ("{0} has no {1}-scope config path; printing the snippet instead." -f $row.label, $Scope) -Level "Warn"
        Write-McpMessage -Message (Get-UevClientSnippet -Client $Client -InstallRoot $InstallRoot -Project $Project) -Level "Info"
        return [pscustomobject]@{ client = $Client; wrote = $false; reason = "no-path-for-scope" }
    }

    $nl = [Environment]::NewLine
    $entry = New-UevServerEntry -InstallRoot $InstallRoot
    $wrapper = "mcpServers"
    if ($row.format -eq "servers") { $wrapper = "servers" }
    if ($row.format -eq "context_servers") { $wrapper = "context_servers" }

    $doc = $null
    if (Test-Path -LiteralPath $path) {
        $raw = Get-Content -LiteralPath $path -Raw
        if (-not [string]::IsNullOrWhiteSpace($raw)) {
            try { $doc = $raw | ConvertFrom-Json } catch { throw "Refusing to rewrite $path - it is not valid JSON: $($_.Exception.Message)" }
        }
    }
    if ($null -eq $doc) { $doc = New-Object psobject }
    if ($null -eq $doc.PSObject.Properties[$wrapper]) {
        $doc | Add-Member -MemberType NoteProperty -Name $wrapper -Value (New-Object psobject) -Force
    }
    $container = $doc.PSObject.Properties[$wrapper]
    $existing = $container.Value.PSObject.Properties["uev"]
    $action = "add"
    if ($null -ne $existing) {
        $currentCommand = ""
        if ($existing.Value.PSObject.Properties["command"]) { $currentCommand = [string]$existing.Value.command }
        if ($currentCommand -and $currentCommand -notmatch "node\.exe$" -and -not $Force) {
            throw "$path already defines a server named 'uev' that does not look like this install ($currentCommand). Pass -Force to replace it."
        }
        $action = "replace"
    }
    if ($row.format -eq "servers") {
        $vscodeEntry = [ordered]@{ type = "stdio" }
        foreach ($k in $entry.Keys) { $vscodeEntry[$k] = $entry[$k] }
        $value = $vscodeEntry
    } elseif ($row.format -eq "context_servers") {
        $value = [ordered]@{ command = [ordered]@{ path = $entry["command"]; args = $entry["args"]; env = $entry["env"] } }
    } else {
        $value = $entry
    }
    $container.Value | Add-Member -MemberType NoteProperty -Name "uev" -Value ([pscustomobject]$value) -Force

    if ($DryRun) {
        Write-McpMessage -Message ("[dry-run] would {0} 'uev' in {1} ({2})" -f $action, $path, $wrapper) -Level "Info"
        return [pscustomobject]@{ client = $Client; path = $path; action = $action; wrote = $false; dryRun = $true }
    }

    $dir = Split-Path -Parent $path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $backup = ""
    if (Test-Path -LiteralPath $path) {
        $backup = $path + ".uev-backup-" + (Get-Date -Format "yyyyMMdd-HHmmss-fff")
        Copy-Item -LiteralPath $path -Destination $backup -Force
    }
    $json = $doc | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText($path, $json + $nl, (New-Object System.Text.UTF8Encoding($false)))
    $verb = "Updated"
    if ($action -eq "add") { $verb = "Added" }
    $suffix = ""
    if ($backup) { $suffix = " (backup: $backup)" }
    Write-McpMessage -Message ("{0} 'uev' in {1}{2}" -f $verb, $path, $suffix) -Level "Ok"
    return [pscustomobject]@{ client = $Client; path = $path; action = $action; wrote = $true; backup = $backup }
}

function Show-UevClientMenu {
    $table = Get-UevClientTable
    Write-McpMessage -Message "Agent harness setup - which client should receive the MCP entry?" -Level "Info"
    $i = 1
    foreach ($row in $table) {
        $how = "prints a snippet"
        if ($row.writable) { $how = "writes " + $row.scope + " config" }
        Write-McpMessage -Message ("  [{0}] {1} ({2})" -f $i, $row.label, $how) -Level "Info"
        $i++
    }
    Write-McpMessage -Message "  [s] skip for now" -Level "Info"
    return $table
}


function Invoke-UevClientMenuPrompt {
    param([string]$Project, [string]$InstallRoot)
    $table = Show-UevClientMenu
    $answer = Read-Host "Number, client id, or s to skip"
    if ($answer -match '^\s*s(kip)?\s*$') { return $null }
    $row = $null
    if ($answer -match '^\d+$') {
        $index = [int]$answer - 1
        if ($index -ge 0 -and $index -lt $table.Count) { $row = $table[$index] }
    } else {
        $row = $table | Where-Object { $_.id -eq $answer.Trim() }
    }
    if ($null -eq $row) { Write-McpMessage -Message "No such client; nothing written." -Level "Warn"; return $null }
    $scope = $row.scope
    if ($row.projectPath -and $row.userPath) {
        $pick = Read-Host ("Scope: [u]ser or [p]roject (default " + $scope + ")")
        if ($pick -match '^\s*p') { $scope = "project" }
        elseif ($pick -match '^\s*u') { $scope = "user" }
    }
    return Set-UevMcpClientEntry -Client $row.id -Scope $scope -Project $Project -InstallRoot $InstallRoot
}
Export-ModuleMember -Function Invoke-UEVInstall, Invoke-UEVUninstall, Test-UEVInstall, Get-UevClientTable, Get-UevClientSnippet, Set-UevMcpClientEntry, Show-UevClientMenu, Invoke-UevClientMenuPrompt

