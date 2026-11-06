[CmdletBinding()]
param(
    [string]$OutputRoot = "",
    [string]$Version = "1.7.0",
    [switch]$NoBuild,
    [switch]$SkipSupervisorPublish,
    [switch]$Force,
    [switch]$KeepPdb
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
# The server tree is "app" in this repo; older authoring copies called it "mcp-fork".
$mcpRoot = Join-Path $repo "app"
if (-not (Test-Path -LiteralPath (Join-Path $mcpRoot "package.json"))) {
    $legacyRoot = Join-Path $repo "mcp-fork"
    if (Test-Path -LiteralPath (Join-Path $legacyRoot "package.json")) { $mcpRoot = $legacyRoot }
}
$nativeRoot = Join-Path $repo "native"
$supervisorRoot = Join-Path $repo "supervisor"
$installerRoot = Join-Path $repo "installer"
$productRoot = Join-Path $PSScriptRoot "product"
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    # Staging root defaults to a sibling of the repo; never a hard-coded machine path.
    $OutputRoot = Join-Path (Split-Path -Parent $repo) "uev-package"
}
$output = [System.IO.Path]::GetFullPath($OutputRoot)
$utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false

function Write-PackageMessage {
    param([string]$Message, [string]$Level = "Info")
    $color = "Gray"
    if ($Level -eq "Ok") { $color = "Green" }
    if ($Level -eq "Warn") { $color = "Yellow" }
    if ($Level -eq "Error") { $color = "Red" }
    if ($Level -eq "Step") { $color = "Cyan" }
    Write-Host $Message -ForegroundColor $color
}

function Get-PackageHash {
    param([string]$Path)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $stream = [System.IO.File]::OpenRead($Path)
        try { return ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant() }
        finally { $stream.Dispose() }
    } finally { $sha.Dispose() }
}

function Copy-PackageTree {
    param([string]$Source, [string]$Destination, [string[]]$ExcludedNames)
    if (-not (Test-Path -LiteralPath $Source)) { throw "Source not found: $Source" }
    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Get-ChildItem -LiteralPath $Source -Force | Where-Object { $ExcludedNames -notcontains $_.Name } | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force
    }
}

function Get-BuiltServerIdentity {
    # Clients report whatever dist/version.js says at runtime, so derive the manifest
    # fields from the built artifact and fail loudly instead of guessing a version.
    param([string]$DistRoot, [string]$PackageJsonPath, [string]$ExpectedProductVersion)
    $versionPath = Join-Path $DistRoot "version.js"
    if (-not (Test-Path -LiteralPath $versionPath)) { throw "Built version module not found: $versionPath (run npm run build first)" }
    $text = [System.IO.File]::ReadAllText($versionPath)
    $product = [regex]::Match($text, 'exports\.productVersion = "([^"]+)"').Groups[1].Value
    $server = [regex]::Match($text, 'exports\.serverVersion = "([^"]+)"').Groups[1].Value
    $protocol = [regex]::Match($text, 'exports\.protocolVersion = (\d+)').Groups[1].Value
    if ([string]::IsNullOrWhiteSpace($product) -or [string]::IsNullOrWhiteSpace($server) -or [string]::IsNullOrWhiteSpace($protocol)) {
        throw "Could not read productVersion/serverVersion/protocolVersion from $versionPath"
    }
    $package = Get-Content -LiteralPath $PackageJsonPath -Raw | ConvertFrom-Json
    if ([string]$package.version -ne $server) {
        throw "Server version mismatch: package.json says '$($package.version)' but the built dist reports '$server'."
    }
    if ($product -ne $ExpectedProductVersion) {
        throw "Product version mismatch: built dist says '$product' but -Version is '$ExpectedProductVersion'. Bump mcp-fork/server/version.ts productVersion or pass the matching -Version."
    }
    return [pscustomobject]@{ ProductVersion = $product; ServerVersion = $server; ProtocolVersion = [int]$protocol }
}

function Invoke-Npm {
    param([string]$WorkingDirectory, [string[]]$Arguments)
    Push-Location -LiteralPath $WorkingDirectory
    try {
        & npm @Arguments
        if ($LASTEXITCODE -ne 0) { throw "npm $($Arguments -join ' ') failed with exit code $LASTEXITCODE in $WorkingDirectory" }
    } finally {
        Pop-Location
    }
}

if (-not (Test-Path -LiteralPath $mcpRoot)) { throw "MCP server source not found: $mcpRoot" }
if (-not (Test-Path -LiteralPath $nativeRoot)) { throw "Native plugin source not found: $nativeRoot" }
if (-not (Test-Path -LiteralPath $installerRoot)) { throw "Installer source not found: $installerRoot" }
if (-not (Test-Path -LiteralPath $productRoot)) { throw "Product docs not found: $productRoot" }

if (Test-Path -LiteralPath $output) {
    if (-not $Force) { throw "Output already exists: $output. Re-run with -Force to rebuild it." }
    Write-PackageMessage "Removing previous package: $output" -Level "Step"
    Remove-Item -LiteralPath $output -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $output | Out-Null
$appStage = Join-Path $output "payload\app"
$supervisorStage = Join-Path $output "supervisor"
$pluginStage = Join-Path $output "payload\plugins"
$nodeStage = Join-Path $output "payload\node"
$templateStage = Join-Path $output "payload\templates"
$installerStage = Join-Path $output "installer"
foreach ($path in @($appStage, $supervisorStage, $pluginStage, $nodeStage, $templateStage, $installerStage)) {
    New-Item -ItemType Directory -Force -Path $path | Out-Null
}

Write-PackageMessage "Building MCP server..." -Level "Step"
if (-not $NoBuild) {
    if (-not (Test-Path -LiteralPath (Join-Path $mcpRoot "node_modules"))) {
        Invoke-Npm -WorkingDirectory $mcpRoot -Arguments @("ci", "--no-audit", "--no-fund")
    }
    Invoke-Npm -WorkingDirectory $mcpRoot -Arguments @("run", "build")
}
$dist = Join-Path $mcpRoot "dist"
if (-not (Test-Path -LiteralPath (Join-Path $dist "bin.js"))) { throw "Server build missing: $dist\bin.js" }
$editingScripts = @(Get-ChildItem -LiteralPath (Join-Path $dist "editor\scripts") -Recurse -Filter "*.py" -File -ErrorAction SilentlyContinue)
if ($editingScripts.Count -lt 100) { throw "Editor Python scripts missing or incomplete: $($editingScripts.Count) files" }
Write-PackageMessage "Server dist: $($editingScripts.Count) editor Python files" -Level "Ok"

Copy-Item -LiteralPath $dist -Destination $appStage -Recurse -Force
foreach ($file in @("package.json", "package-lock.json", "LICENSE", "README.md", "SAFETY.md")) {
    $source = Join-Path $mcpRoot $file
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $appStage -Force }
}
$distScripts = Join-Path $appStage "dist\scripts"
if (Test-Path -LiteralPath $distScripts) { Remove-Item -LiteralPath $distScripts -Recurse -Force }
Get-ChildItem -LiteralPath $appStage -Recurse -Force -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
Get-ChildItem -LiteralPath $appStage -Recurse -Force -File -Filter "*.pyc" -ErrorAction SilentlyContinue | Remove-Item -Force

Write-PackageMessage "Staging production Node dependencies..." -Level "Step"
$prodInstalled = $false
Push-Location -LiteralPath $appStage
try {
    $null = & npm ci --omit=dev --no-audit --no-fund --ignore-scripts 2>&1
    if ($LASTEXITCODE -eq 0) { $prodInstalled = $true }
} catch {
    $prodInstalled = $false
} finally {
    Pop-Location
}
if (-not $prodInstalled) {
    Write-PackageMessage "npm ci --omit=dev failed; pruning a copy of the existing node_modules." -Level "Warn"
    $sourceModules = Join-Path $mcpRoot "node_modules"
    if (-not (Test-Path -LiteralPath $sourceModules)) { throw "Could not create production dependencies: npm ci failed and $sourceModules is missing." }
    $targetModules = Join-Path $appStage "node_modules"
    if (Test-Path -LiteralPath $targetModules) { Remove-Item -LiteralPath $targetModules -Recurse -Force }
    Copy-Item -LiteralPath $sourceModules -Destination $targetModules -Recurse -Force
    Push-Location -LiteralPath $appStage
    try {
        $null = & npm prune --omit=dev --no-audit --no-fund --ignore-scripts 2>&1
        if ($LASTEXITCODE -ne 0) { throw "npm prune --omit=dev failed with exit code $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
}
foreach ($module in @("@modelcontextprotocol\sdk", "zod", "unreal-remote-execution")) {
    if (-not (Test-Path -LiteralPath (Join-Path $appStage ("node_modules\" + $module)))) {
        throw "Production dependency missing from package: $module"
    }
}
$typescriptPath = Join-Path $appStage "node_modules\typescript"
if (Test-Path -LiteralPath $typescriptPath) { Write-PackageMessage "Warning: TypeScript dev dependency is present in the app payload." -Level "Warn" }

Write-PackageMessage "Publishing supervisor..." -Level "Step"
$supervisorSelfContained = $false
$supervisorPublished = $false
if (-not $SkipSupervisorPublish) {
    Push-Location -LiteralPath $supervisorRoot
    try {
        $nugetSource = "https://api.nuget.org/v3/index.json"
        $null = & dotnet restore "UEVSupervisor.csproj" -r win-x64 --source $nugetSource 2>&1
        if ($LASTEXITCODE -ne 0) {
            # Offline or nuget.org unreachable: fall back to the machine's feed/cache configuration.
            $null = & dotnet restore "UEVSupervisor.csproj" -r win-x64 2>&1
        }
        if ($LASTEXITCODE -eq 0) {
            $null = & dotnet publish "UEVSupervisor.csproj" -c Release -r win-x64 --self-contained true --no-restore -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:DebugType=None -o $supervisorStage --nologo 2>&1
            if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath (Join-Path $supervisorStage "UEVSupervisor.exe"))) {
                $supervisorPublished = $true
                $supervisorSelfContained = $true
            } else {
                # Single-file publish needs Microsoft.NET.ILLink.Tasks, which offline machines may lack.
                # A plain self-contained folder still ships the same runtime; only the layout differs.
                Write-PackageMessage "Single-file publish unavailable; publishing a self-contained folder instead." -Level "Warn"
                $null = & dotnet publish "UEVSupervisor.csproj" -c Release -r win-x64 --self-contained true --no-restore -p:PublishSingleFile=false -p:DebugType=None -o $supervisorStage --nologo 2>&1
                if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath (Join-Path $supervisorStage "UEVSupervisor.exe"))) {
                    $supervisorPublished = $true
                    $supervisorSelfContained = $true
                }
            }
        }
    } catch {
        $supervisorPublished = $false
    } finally {
        Pop-Location
    }
}
if (-not $supervisorPublished) {
    Write-PackageMessage "Self-contained publish unavailable; selecting an existing supervisor build." -Level "Warn"
    $candidates = @(
        (Join-Path $supervisorRoot "bin\Release\net9.0\win-x64"),
        (Join-Path $supervisorRoot "bin\Release\net9.0")
    )
    $existing = $candidates | Where-Object { Test-Path -LiteralPath (Join-Path $_ "UEVSupervisor.exe") } | Select-Object -First 1
    if (-not $existing) {
        throw "Supervisor is not built. Run dotnet publish manually or remove -SkipSupervisorPublish."
    }
    if (Test-Path -LiteralPath $supervisorStage) { Remove-Item -LiteralPath $supervisorStage -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $supervisorStage | Out-Null
    Copy-Item -Path (Join-Path $existing "*") -Destination $supervisorStage -Recurse -Force
    $supervisorSelfContained = (Split-Path -Leaf $existing) -eq "win-x64"
}
Get-ChildItem -LiteralPath $supervisorStage -Filter "*.pdb" -File -ErrorAction SilentlyContinue | Remove-Item -Force
if (-not $KeepPdb) {
    Get-ChildItem -LiteralPath $supervisorStage -Filter "*.pdb" -File -ErrorAction SilentlyContinue | Remove-Item -Force
}
Write-PackageMessage ("Supervisor: self-contained={0}" -f $supervisorSelfContained) -Level "Ok"

Write-PackageMessage "Copying source-only native plugins..." -Level "Step"
foreach ($name in @("UEVNative", "UEVControlPanel")) {
    $source = Join-Path $nativeRoot $name
    $destination = Join-Path $pluginStage $name
    Copy-PackageTree -Source $source -Destination $destination -ExcludedNames @("Binaries", "Intermediate", "Saved", ".git")
    if (-not (Test-Path -LiteralPath (Join-Path $destination ($name + ".uplugin")))) { throw "Plugin descriptor missing after copy: $name" }
}
Write-PackageMessage "Native plugins staged without Binaries/Intermediate" -Level "Ok"

Write-PackageMessage "Copying installer..." -Level "Step"
$installerModuleDest = Join-Path $installerStage "UEV.Installer.psm1"
Copy-Item -LiteralPath (Join-Path $installerRoot "UEV.Installer.psm1") -Destination $installerModuleDest -Force
Copy-Item -LiteralPath (Join-Path $installerRoot "clients.json") -Destination (Join-Path $installerStage "clients.json") -Force
$installerModuleText = Get-Content -LiteralPath $installerModuleDest -Raw
# The shipped manifest.json is authoritative at install time; the module only carries a
# fallback version for a package whose manifest is missing, so stamp exactly that constant.
$installerVersionPattern = '\$script:ProductVersionFallback = "[^"]+"'
if ($installerModuleText -notmatch $installerVersionPattern) {
    throw "Installer module has no \$script:ProductVersionFallback constant to stamp: $installerModuleDest"
}
$installerModuleText = $installerModuleText -replace $installerVersionPattern, ('$script:ProductVersionFallback = "' + $Version + '"')
[System.IO.File]::WriteAllText($installerModuleDest, $installerModuleText, $utf8)
Copy-Item -LiteralPath (Join-Path $installerRoot "Install-UEV.ps1") -Destination (Join-Path $output "install.ps1") -Force
Copy-Item -LiteralPath (Join-Path $installerRoot "Install-UEV.bat") -Destination (Join-Path $output "install.bat") -Force
Copy-Item -LiteralPath (Join-Path $installerRoot "uninstall.bat") -Destination (Join-Path $output "uninstall.bat") -Force
Copy-Item -LiteralPath (Join-Path $installerRoot "Launch UEV.bat") -Destination (Join-Path $output "Launch UEV.bat") -Force
Copy-Item -LiteralPath (Join-Path $installerRoot "templates\mcp-client.json") -Destination (Join-Path $templateStage "mcp-client.json") -Force

Write-PackageMessage "Copying product docs..." -Level "Step"
Copy-Item -LiteralPath (Join-Path $productRoot "README.md") -Destination (Join-Path $output "README.md") -Force
Copy-Item -LiteralPath (Join-Path $productRoot "LICENSE") -Destination (Join-Path $output "LICENSE") -Force
Copy-Item -LiteralPath (Join-Path $productRoot "THIRD_PARTY_NOTICES.md") -Destination (Join-Path $output "THIRD_PARTY_NOTICES.md") -Force
Copy-Item -LiteralPath (Join-Path $productRoot "FINDINGS.md") -Destination (Join-Path $output "FINDINGS.md") -Force
Copy-Item -LiteralPath (Join-Path $productRoot "docs") -Destination (Join-Path $output "docs") -Recurse -Force

$testsRoot = Join-Path $PSScriptRoot "tests"
if (Test-Path -LiteralPath $testsRoot) {
    Write-PackageMessage "Copying release verification scripts..." -Level "Step"
    $testsStage = Join-Path $output "tests"
    Copy-Item -LiteralPath $testsRoot -Destination $testsStage -Recurse -Force
    # Runs write result artifacts (perf-results.json, matrix-runN.json) next to the
    # scripts they belong to; those must never ship inside a release.
    $artifacts = @(Get-ChildItem -LiteralPath $testsStage -Recurse -File |
        Where-Object { ($_.Name -match "(-results|-run\d*)\.json$") -or ($_.Extension -eq ".log") })
    foreach ($artifact in $artifacts) { [System.IO.File]::Delete($artifact.FullName) }
    if ($artifacts.Count -gt 0) {
        Write-PackageMessage ("Dropped {0} run artifact(s) from tests/." -f $artifacts.Count) -Level "Ok"
    }
}

Write-PackageMessage "Bundling Node runtime..." -Level "Step"
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand -or [string]::IsNullOrWhiteSpace([string]$nodeCommand.Source)) {
    throw "Node.js is required on the build machine to bundle the runtime."
}
Copy-Item -LiteralPath $nodeCommand.Source -Destination (Join-Path $nodeStage "node.exe") -Force
$nodeLicense = Join-Path $productRoot "NODE_LICENSE.txt"
if (Test-Path -LiteralPath $nodeLicense) {
    Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $nodeStage "LICENSE") -Force
}
$nodeVersion = [string](& $nodeCommand.Source --version 2>$null | Select-Object -First 1)
Write-PackageMessage ("Node runtime: {0} ({1})" -f $nodeVersion, $nodeCommand.Source) -Level "Ok"

$serverIdentity = Get-BuiltServerIdentity -DistRoot (Join-Path $appStage "dist") -PackageJsonPath (Join-Path $mcpRoot "package.json") -ExpectedProductVersion $Version
Write-PackageMessage ("Server identity: {0} / {1} / protocol {2}" -f $serverIdentity.ProductVersion, $serverIdentity.ServerVersion, $serverIdentity.ProtocolVersion) -Level "Ok"
$manifest = [ordered]@{
    schemaVersion = 1
    productVersion = $serverIdentity.ProductVersion
    serverVersion = $serverIdentity.ServerVersion
    protocolVersion = $serverIdentity.ProtocolVersion
    engine = [ordered]@{
        minVersion = "4.27.0"
        maxVersionExclusive = "4.28.0"
        strictEnvVar = "UEV_STRICT_ENGINE"
    }
    builtAt = (Get-Date -Format "o")
    supervisorSelfContained = [bool]$supervisorSelfContained
    nodeBundled = $true
    nodeVersion = $nodeVersion
    payload = [ordered]@{
        app = "payload/app"
        supervisor = "supervisor"
        node = "payload/node"
        plugins = @("payload/plugins/UEVNative", "payload/plugins/UEVControlPanel")
        templates = "payload/templates"
    }
    requirements = [ordered]@{
        windows = $true
        unreal = "4.27.x"
        node = "bundled"
        cppProject = $true
        buildTools = "Visual Studio + UnrealBuildTool for source plugin builds"
        dotnet = $(if ($supervisorSelfContained) { "none" } else { "9.0 runtime" })
    }
    python = [ordered]@{
        plugin = "PythonScriptPlugin"
        externalPythonRequired = $false
        remoteExecution = "loopback, multicast TTL 0"
    }
    liveCoding = [ordered]@{
        type = "engine module"
        newClassesRequireFullBuild = $true
    }
}
$manifestPath = Join-Path $output "manifest.json"
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 12), $utf8)

$checksumLines = @()
$files = @(Get-ChildItem -LiteralPath $output -Recurse -File -Force | Where-Object { $_.Name -ne "checksums.txt" } | Sort-Object FullName)
foreach ($file in $files) {
    $relative = $file.FullName.Substring($output.Length).TrimStart("\").Replace("\", "/")
    $checksumLines += ("{0}  {1}" -f (Get-PackageHash -Path $file.FullName), $relative)
}
[System.IO.File]::WriteAllText((Join-Path $output "checksums.txt"), (($checksumLines -join [Environment]::NewLine) + [Environment]::NewLine), $utf8)

$forbidden = @()
$forbidden += @(Get-ChildItem -LiteralPath $output -Recurse -Force -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq "STATE.md" -or $_.Name -match "^\d{2}-" -or $_.Name -eq "install.log" -or $_.Name -eq "uninstall.log" })
$forbidden += @(Get-ChildItem -LiteralPath $output -Recurse -Force -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq ".git" -or $_.Name -eq "Binaries" -or $_.Name -eq "Intermediate" -or $_.Name -eq "__pycache__" })
if ($forbidden.Count -gt 0) {
    $forbidden | ForEach-Object { Write-PackageMessage ("Forbidden package content: " + $_.FullName) -Level "Error" }
    throw "Package contains forbidden research/build artifacts."
}

$sizeMb = [math]::Round(((Get-ChildItem -LiteralPath $output -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB), 1)
Write-PackageMessage "" -Level "Info"
Write-PackageMessage "Package built: $output" -Level "Ok"
Write-PackageMessage ("  version: {0} (server {1}, protocol {2})" -f $serverIdentity.ProductVersion, $serverIdentity.ServerVersion, $serverIdentity.ProtocolVersion) -Level "Info"
Write-PackageMessage ("  size:    {0} MB" -f $sizeMb) -Level "Info"
Write-PackageMessage ("  supervisor self-contained: {0}" -f $supervisorSelfContained) -Level "Info"
Write-PackageMessage ("  installer: {0}" -f (Join-Path $output "install.bat")) -Level "Info"