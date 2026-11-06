[CmdletBinding()]
param(
    [string]$Version = "1.7.0",
    [string]$OutputRoot = "",
    [string]$ZipPath = "",
    [int]$ControlPort = 8765,
    [string]$Descriptor = "",
    [switch]$SkipBuild,
    [switch]$SkipCatalog,
    [switch]$SkipZip,
    [switch]$Force
)

# One-command 1.7.x release: build, regenerate the tool reference from the live
# catalog, cross-check the docs, build the package, verify every hash and ship the zip.
$ErrorActionPreference = "Stop"
$repo = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
# The server tree is "app" in this repo; older authoring copies called it "mcp-fork".
$mcpRoot = Join-Path $repo "app"
if (-not (Test-Path -LiteralPath (Join-Path $mcpRoot "package.json"))) {
    $legacyRoot = Join-Path $repo "mcp-fork"
    if (Test-Path -LiteralPath (Join-Path $legacyRoot "package.json")) { $mcpRoot = $legacyRoot }
}
$productRoot = Join-Path $PSScriptRoot "product"
$buildScript = Join-Path $PSScriptRoot "Build-UEVPackage.ps1"
$toolRefScript = Join-Path $PSScriptRoot "tests\make-tool-reference.mjs"
$utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false

$releaseRoot = $env:UEV_RELEASE_ROOT
if ([string]::IsNullOrWhiteSpace($releaseRoot)) { $releaseRoot = Join-Path $env:USERPROFILE "uev-releases" }
if ([string]::IsNullOrWhiteSpace($OutputRoot)) { $OutputRoot = Join-Path $releaseRoot ("uev-mcp-{0}-release" -f $Version) }
if ([string]::IsNullOrWhiteSpace($ZipPath)) { $ZipPath = Join-Path $releaseRoot ("uev-{0}.zip" -f $Version) }
$output = [System.IO.Path]::GetFullPath($OutputRoot)
$zip = [System.IO.Path]::GetFullPath($ZipPath)

function Write-ReleaseMessage {
    param([string]$Message, [string]$Level = "Info")
    $color = "Gray"
    if ($Level -eq "Ok") { $color = "Green" }
    if ($Level -eq "Warn") { $color = "Yellow" }
    if ($Level -eq "Error") { $color = "Red" }
    if ($Level -eq "Step") { $color = "Cyan" }
    Write-Host $Message -ForegroundColor $color
}

function Get-Sha256 {
    param([string]$Path)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $stream = [System.IO.File]::OpenRead($Path)
        try { return ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant() }
        finally { $stream.Dispose() }
    } finally { $sha.Dispose() }
}

function Get-BuiltIdentity {
    # dist/version.js is what clients report at runtime; everything else must agree with it.
    param([string]$DistRoot)
    $versionPath = Join-Path $DistRoot "version.js"
    if (-not (Test-Path -LiteralPath $versionPath)) { throw "Built version module not found: $versionPath (run npm run build, or drop -SkipBuild)" }
    $text = [System.IO.File]::ReadAllText($versionPath)
    $product = [regex]::Match($text, 'exports\.productVersion = "([^"]+)"').Groups[1].Value
    $server = [regex]::Match($text, 'exports\.serverVersion = "([^"]+)"').Groups[1].Value
    $protocol = [regex]::Match($text, 'exports\.protocolVersion = (\d+)').Groups[1].Value
    if ([string]::IsNullOrWhiteSpace($product) -or [string]::IsNullOrWhiteSpace($server) -or [string]::IsNullOrWhiteSpace($protocol)) {
        throw "Could not read the version triple from $versionPath"
    }
    return [pscustomobject]@{ ProductVersion = $product; ServerVersion = $server; ProtocolVersion = [int]$protocol }
}

function Resolve-ControlDescriptor {
    param([string]$Explicit)
    if (-not [string]::IsNullOrWhiteSpace($Explicit)) { return $Explicit }
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA "UEV\control.json")
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    return $null
}

function Get-LiveCatalogCounts {
    param([string]$DescriptorPath, [int]$Port)
    if ($null -eq $DescriptorPath) { throw "No control descriptor found. Start the stack (run-stack.ps1) or pass -Descriptor, or use -SkipCatalog." }
    $descriptorText = Get-Content -LiteralPath $DescriptorPath -Raw
    $descriptor = $descriptorText | ConvertFrom-Json
    $token = [string]$descriptor.token
    if ([string]::IsNullOrWhiteSpace($token)) { throw "Control descriptor has no token: $DescriptorPath" }
    $effectivePort = $Port
    if ($effectivePort -le 0 -and $descriptor.port) { $effectivePort = [int]$descriptor.port }
    if ($effectivePort -le 0) { $effectivePort = 8765 }
    $headers = @{ Authorization = "Bearer $token" }
    $base = "http://127.0.0.1:$effectivePort"
    $health = Invoke-RestMethod -Uri "$base/api/health" -Headers $headers -UseBasicParsing -TimeoutSec 30
    $catalog = Invoke-RestMethod -Uri "$base/api/catalog" -Headers $headers -UseBasicParsing -TimeoutSec 60
    $tools = @($catalog.tools)
    $namespaces = @($tools | Where-Object { $_.kind -eq "namespace" })
    $actions = 0
    $params = 0
    foreach ($tool in $tools) {
        foreach ($action in @($tool.actions)) {
            if ($null -ne $action) { $actions += 1; $params += @($action.params).Count }
        }
    }
    return [pscustomobject]@{
        Descriptor = $DescriptorPath
        Port = $effectivePort
        ProductVersion = [string]$health.productVersion
        ServerVersion = [string]$health.serverVersion
        ProtocolVersion = [int]$health.protocolVersion
        Tools = $tools.Count
        Namespaces = $namespaces.Count
        Direct = $tools.Count - $namespaces.Count
        Actions = $actions
        Params = $params
    }
}

function Assert-DocCounts {
    # The docs quote the catalog; a release must never ship numbers the server does not report.
    param([string]$Root, $Counts, $Identity)
    $readmePath = Join-Path $Root "README.md"
    $findingsPath = Join-Path $Root "FINDINGS.md"
    $readme = [System.IO.File]::ReadAllText($readmePath)
    $findings = [System.IO.File]::ReadAllText($findingsPath)
    $expectations = @(
        [pscustomobject]@{ Name = "README surface sentence"; File = $readmePath; Text = ("({0} tools, {1} namespaces, {2} actions in this build)" -f $Counts.Tools, $Counts.Namespaces, $Counts.Actions) },
        [pscustomobject]@{ Name = "README release summary"; File = $readmePath; Text = ("**{0} tools / {1} namespaces / {2} actions**" -f $Counts.Tools, $Counts.Namespaces, $Counts.Actions) },
        [pscustomobject]@{ Name = "README version banner"; File = $readmePath; Text = ("**Package version:** {0}, **Server version:** {1}, **Protocol:** {2}" -f $Identity.ProductVersion, $Identity.ServerVersion, $Identity.ProtocolVersion) },
        [pscustomobject]@{ Name = "FINDINGS header"; File = $findingsPath; Text = ("Package {0}, protocol {1}" -f $Identity.ProductVersion, $Identity.ProtocolVersion) },
        [pscustomobject]@{ Name = "FINDINGS surface counts"; File = $findingsPath; Text = ("{0} tools / {1} namespaces / {2} actions" -f $Counts.Tools, $Counts.Namespaces, $Counts.Actions) }
    )
    foreach ($expectation in $expectations) {
        $text = $readme
        if ($expectation.File -eq $findingsPath) { $text = $findings }
        if ($text -notlike ("*" + $expectation.Text + "*")) {
            throw ("Doc/catalog drift: {0} does not contain '{1}'. Fix {2} (or regenerate it) before releasing." -f $expectation.Name, $expectation.Text, $expectation.File)
        }
    }
    Write-ReleaseMessage ("Docs match the live catalog: {0} tools / {1} namespaces / {2} actions / {3} params." -f $Counts.Tools, $Counts.Namespaces, $Counts.Actions, $Counts.Params) -Level "Ok"
}

function Update-ToolReference {
    param([string]$DescriptorPath, [int]$Port, [string]$OutFile, [string]$Title)
    if (-not (Test-Path -LiteralPath $toolRefScript)) { throw "Tool reference generator not found: $toolRefScript" }
    $node = (Get-Command node -ErrorAction SilentlyContinue)
    if ($null -eq $node) { throw "Node.js is required to regenerate docs/TOOLS.md" }
    if (-not $Title) { $Title = "UEV Tool Reference" }
    & $node.Source $toolRefScript --descriptor $DescriptorPath --port $Port --out $OutFile --title $Title
    if ($LASTEXITCODE -ne 0) { throw "docs/TOOLS.md generation failed with exit code $LASTEXITCODE" }
    if (-not (Test-Path -LiteralPath $OutFile)) { throw "docs/TOOLS.md was not written: $OutFile" }
    $size = (Get-Item -LiteralPath $OutFile).Length
    if ($size -lt 50000) { throw "docs/TOOLS.md looks truncated ($size bytes)" }
    Write-ReleaseMessage ("Regenerated docs/TOOLS.md ({0:N0} bytes)." -f $size) -Level "Ok"
}

function Test-ReleaseTree {
    param([string]$Root, [string]$ExpectedProduct, [string]$ExpectedServer, [int]$ExpectedProtocol, $Counts)
    $manifestPath = Join-Path $Root "manifest.json"
    if (-not (Test-Path -LiteralPath $manifestPath)) { throw "manifest.json missing from $Root" }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ([int]$manifest.schemaVersion -ne 1) { throw "manifest.json schemaVersion is '$($manifest.schemaVersion)', expected 1" }
    if ([string]$manifest.productVersion -ne $ExpectedProduct) { throw "manifest productVersion '$($manifest.productVersion)' != '$ExpectedProduct'" }
    if ([string]$manifest.serverVersion -ne $ExpectedServer) { throw "manifest serverVersion '$($manifest.serverVersion)' != '$ExpectedServer'" }
    if ([int]$manifest.protocolVersion -ne $ExpectedProtocol) { throw "manifest protocolVersion '$($manifest.protocolVersion)' != '$ExpectedProtocol'" }
    if (-not $manifest.engine -or [string]$manifest.engine.strictEnvVar -ne "UEV_STRICT_ENGINE") { throw "manifest engine.strictEnvVar is not UEV_STRICT_ENGINE" }
    $builtAt = [datetime]::Parse([string]$manifest.builtAt, [System.Globalization.CultureInfo]::InvariantCulture)
    $age = (Get-Date) - $builtAt
    if ($age.TotalMinutes -gt 240 -or $age.TotalMinutes -lt -10) { throw ("manifest builtAt '$($manifest.builtAt)' is not from this build run (age {0:N1} min)" -f $age.TotalMinutes) }
    Write-ReleaseMessage ("Manifest: {0} / {1} / protocol {2}, built {3}" -f $manifest.productVersion, $manifest.serverVersion, $manifest.protocolVersion, $manifest.builtAt) -Level "Ok"

    $checksPath = Join-Path $Root "checksums.txt"
    if (-not (Test-Path -LiteralPath $checksPath)) { throw "checksums.txt missing from $Root" }
    $listed = 0
    $mismatched = New-Object System.Collections.ArrayList
    foreach ($line in [System.IO.File]::ReadAllLines($checksPath)) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        if ($line -notmatch '^([0-9a-fA-F]{64})  (.+)$') { throw "Malformed checksums line: $line" }
        $expected = $Matches[1].ToLowerInvariant()
        $relative = $Matches[2].TrimStart('.', '/', '\')
        $target = Join-Path $Root $relative
        if (-not (Test-Path -LiteralPath $target)) { [void]$mismatched.Add("missing: $relative"); continue }
        $actual = Get-Sha256 -Path $target
        if ($actual -ne $expected) { [void]$mismatched.Add("hash: $relative") }
        $listed += 1
    }
    if ($mismatched.Count -gt 0) { throw ("checksums.txt does not match the tree: {0}" -f (($mismatched | Select-Object -First 5) -join "; ")) }
    $files = @(Get-ChildItem -LiteralPath $Root -Recurse -File)
    $expectedListed = $files.Count - 1
    if ($listed -ne $expectedListed) { throw ("checksums.txt lists {0} files but the tree has {1} (checksums.txt excluded: {2})" -f $listed, $files.Count, $expectedListed) }
    Write-ReleaseMessage ("Checksums: {0} files verified, 0 mismatched." -f $listed) -Level "Ok"

    $forbidden = @($files | Where-Object {
        ($_.FullName -match '\\\.git\\') -or ($_.Extension -eq ".log") -or
        ($_.Name -match '(-results|-run\d*)\.json$') -or
        ($_.Name -in @("STATE.md", "manifest.json.tmp")) -or
        ($_.FullName -match '\\(Binaries|Intermediate|__pycache__)\\')
    })
    if ($forbidden.Count -gt 0) { throw ("Forbidden content in the release tree: {0}" -f (($forbidden | Select-Object -First 5 | ForEach-Object { $_.FullName.Substring($Root.Length + 1) }) -join ", ")) }
    Write-ReleaseMessage "No .git, logs, run artifacts, Binaries, Intermediate or __pycache__ in the tree." -Level "Ok"

    if ($null -ne $Counts) {
        $toolsDoc = Join-Path $Root "docs\TOOLS.md"
        if (-not (Test-Path -LiteralPath $toolsDoc)) { throw "docs/TOOLS.md missing from the package" }
        $toolsText = [System.IO.File]::ReadAllText($toolsDoc)
        $expectHeader = "**{0} tools**" -f $Counts.Tools
        if ($toolsText -notlike ("*" + $expectHeader + "*")) { throw "docs/TOOLS.md is stale: it does not report $($Counts.Tools) tools" }
        Write-ReleaseMessage "docs/TOOLS.md matches the live catalog." -Level "Ok"
    }
    return [pscustomobject]@{ Files = $files.Count; Listed = $listed }
}

function New-ReleaseZip {
    param([string]$Root, [string]$ZipFile, [int]$ExpectedFiles)
    Add-Type -AssemblyName System.IO.Compression | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
    if (Test-Path -LiteralPath $ZipFile) { [System.IO.File]::Delete($ZipFile) }
    # CreateFromDirectory writes backslash-separated entry names under .NET Framework, which
    # unzip on Linux/macOS treats as literal file names. Write forward-slash entries explicitly.
    $archive = [System.IO.Compression.ZipFile]::Open($ZipFile, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in @(Get-ChildItem -LiteralPath $Root -Recurse -File -Force | Sort-Object FullName)) {
            $entryName = $file.FullName.Substring($Root.Length).TrimStart("\").Replace("\", "/")
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $entryName, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    } finally { $archive.Dispose() }
    $archive = [System.IO.Compression.ZipFile]::OpenRead($ZipFile)
    try {
        $entryNames = @($archive.Entries | ForEach-Object { $_.FullName })
        $entries = $entryNames.Count
    } finally { $archive.Dispose() }
    if (@($entryNames | Where-Object { $_.Contains("\") }).Count -gt 0) { throw "Zip entry names contain backslashes; the archive would not extract portably." }
    $sha = Get-Sha256 -Path $ZipFile
    $size = (Get-Item -LiteralPath $ZipFile).Length
    Write-ReleaseMessage ("Zip: {0} entries, {1:N0} bytes, sha256 {2}" -f $entries, $size, $sha) -Level "Ok"
    if ($entries -ne $ExpectedFiles) { throw ("Zip has {0} entries but the release tree has {1} files" -f $entries, $ExpectedFiles) }
    $reportPath = $ZipFile + ".sha256.txt"
    $report = @(
        ("file    {0}" -f $ZipFile),
        ("sha256  {0}" -f $sha),
        ("bytes   {0}" -f $size),
        ("entries {0}" -f $entries),
        ("builtAt {0}" -f (Get-Date -Format "o"))
    ) -join [Environment]::NewLine
    [System.IO.File]::WriteAllText($reportPath, $report + [Environment]::NewLine, $utf8)
    Write-ReleaseMessage "Hash report: $reportPath" -Level "Ok"
    return [pscustomobject]@{ Path = $ZipFile; Sha256 = $sha; Bytes = $size; Entries = $entries; Report = $reportPath }
}

Write-ReleaseMessage "UEV $Version release" -Level "Step"
Write-ReleaseMessage "Release tree: $output"
Write-ReleaseMessage "Zip:          $zip"

if (-not $SkipBuild) {
    Push-Location -LiteralPath $mcpRoot
    try {
        Write-ReleaseMessage "Type-checking the server..." -Level "Step"
        & npm run typecheck
        if ($LASTEXITCODE -ne 0) { throw "npm run typecheck failed with exit code $LASTEXITCODE" }
        Write-ReleaseMessage "Building the server..." -Level "Step"
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }
    } finally { Pop-Location }
}

$identity = Get-BuiltIdentity -DistRoot (Join-Path $mcpRoot "dist")
if ($identity.ProductVersion -ne $Version) { throw ("Built productVersion is '{0}' but -Version is '{1}'" -f $identity.ProductVersion, $Version) }
Write-ReleaseMessage ("Built server identity: {0} / {1} / protocol {2}" -f $identity.ProductVersion, $identity.ServerVersion, $identity.ProtocolVersion) -Level "Ok"

$counts = $null
if ($SkipCatalog) {
    Write-ReleaseMessage "Catalog checks skipped (-SkipCatalog): docs/TOOLS.md and the doc counts are not verified." -Level "Warn"
} else {
    $descriptorPath = Resolve-ControlDescriptor -Explicit $Descriptor
    $counts = Get-LiveCatalogCounts -DescriptorPath $descriptorPath -Port $ControlPort
    if ($counts.ProductVersion -ne $identity.ProductVersion) { throw ("Live catalog reports productVersion '{0}' but the build is '{1}'. Restart the stack with the new dist first." -f $counts.ProductVersion, $identity.ProductVersion) }
    if ($counts.ServerVersion -ne $identity.ServerVersion) { throw ("Live catalog reports serverVersion '{0}' but the build is '{1}'." -f $counts.ServerVersion, $identity.ServerVersion) }
    Write-ReleaseMessage ("Live catalog: {0} tools ({1} namespaces + {2} direct), {3} actions, {4} params via {5}" -f $counts.Tools, $counts.Namespaces, $counts.Direct, $counts.Actions, $counts.Params, $counts.Descriptor) -Level "Ok"
    Assert-DocCounts -Root $productRoot -Counts $counts -Identity $identity
    Update-ToolReference -DescriptorPath $counts.Descriptor -Port $counts.Port -OutFile (Join-Path $productRoot "docs\TOOLS.md") -Title ("UEV {0}" -f $identity.ProductVersion)
}

if (-not (Test-Path -LiteralPath $buildScript)) { throw "Package builder not found: $buildScript" }
Write-ReleaseMessage "Building the package..." -Level "Step"
& $buildScript -OutputRoot $output -Version $Version -Force
Write-ReleaseMessage "Package builder finished (its exit code is not authoritative; the tree is verified next)." -Level "Info"

$tree = Test-ReleaseTree -Root $output -ExpectedProduct $identity.ProductVersion -ExpectedServer $identity.ServerVersion -ExpectedProtocol $identity.ProtocolVersion -Counts $counts

if (-not $SkipZip) {
    Write-ReleaseMessage "Packing the zip..." -Level "Step"
    $archive = New-ReleaseZip -Root $output -ZipFile $zip -ExpectedFiles $tree.Files
}

Write-ReleaseMessage "" 
Write-ReleaseMessage ("Release {0} ready: {1} files, {2} verified checksums." -f $Version, $tree.Files, $tree.Listed) -Level "Ok"
Write-ReleaseMessage ("Tree: {0}" -f $output) -Level "Ok"
if ($null -ne $archive) {
    Write-ReleaseMessage ("Zip:  {0} ({1:N0} bytes, sha256 {2})" -f $archive.Path, $archive.Bytes, $archive.Sha256) -Level "Ok"
}
exit 0
