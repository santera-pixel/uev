<#
.SYNOPSIS
    Rebuilds the user-facing main branch from dev.

.DESCRIPTION
    main is a projection of dev: only the files a user needs to install and understand UEV.
    The target tree is assembled in a throwaway worktree, so the checkout you run this from is
    never touched. Use -Check to verify that main still matches dev (exits 1 on drift).

.PARAMETER Check
    Compare only; change nothing.

.PARAMETER NoPush
    Commit on the target branch but do not push.

.PARAMETER Force
    Rebuild the target branch from its merge base first, discarding commits made on it.
    Only for a branch nobody has pulled yet.

.EXAMPLE
    & .\packaging\Publish-Main.ps1 -Check
#>
[CmdletBinding()]
param(
    [string]$SourceBranch = "dev",
    [string]$TargetBranch = "main",
    [string]$Remote = "origin",
    [switch]$Check,
    [switch]$NoPush,
    [switch]$Force
)

$ErrorActionPreference = "Stop"

# The published surface. Add a path here when it belongs on the front page; directories expand.
$allow = @(
    "README.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "docs/tutorial.md",
    "docs/install.md",
    "docs/tool-tour.md",
    "docs/TOOLS.md",
    "docs/troubleshooting.md",
    "docs/security.md",
    "docs/compatibility.md",
    "docs/migration-1.7.md",
    "docs/assets"
)

function Invoke-Git {
    param([string[]]$Arguments)
    # git writes progress to stderr; keep that from becoming a terminating error.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $out = (& git @Arguments 2>&1 | Out-String)
        $code = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previous
    }
    if ($code -ne 0) {
        throw ("git " + ($Arguments -join " ") + " failed:" + [Environment]::NewLine + $out.Trim())
    }
    return $out
}

function Get-TreeHash {
    param([string]$Branch, [string]$Path)
    $spec = $Branch + ":" + $Path
    $hash = & git rev-parse --verify --quiet $spec 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return $hash.Trim()
}

function Split-Lines {
    param([string]$Text)
    return @(($Text -split "\r?\n") | Where-Object { $_ -ne "" })
}

$repo = (& git rev-parse --show-toplevel 2>$null)
if (-not $repo) { $repo = (Get-Location).Path }
$repo = $repo.Trim()
Push-Location $repo
$startBranch = $null
try {
    $startBranch = (& git rev-parse --abbrev-ref HEAD).Trim()

    $expected = @((& git ls-tree -r --name-only $SourceBranch -- $allow) | Sort-Object)
    $actual = @((& git ls-tree -r --name-only $TargetBranch) | Sort-Object)

    $missing = @($expected | Where-Object { $actual -notcontains $_ })
    $extra = @($actual | Where-Object { $expected -notcontains $_ })
    $changed = @()
    foreach ($path in $expected) {
        if ($missing -contains $path) { continue }
        if ((Get-TreeHash $SourceBranch $path) -ne (Get-TreeHash $TargetBranch $path)) { $changed += $path }
    }

    if ($Check) {
        Write-Host ("source: " + $SourceBranch + " (" + $expected.Count + " files)")
        Write-Host ("target: " + $TargetBranch + " (" + $actual.Count + " files)")
        if ($missing.Count) { Write-Host "missing on target:"; $missing | ForEach-Object { Write-Host ("  " + $_) } }
        if ($extra.Count) { Write-Host "not part of the published surface:"; $extra | ForEach-Object { Write-Host ("  " + $_) } }
        if ($changed.Count) { Write-Host "content differs:"; $changed | ForEach-Object { Write-Host ("  " + $_) } }
        if (($missing.Count + $extra.Count + $changed.Count) -eq 0) { Write-Host "in sync."; exit 0 }
        exit 1
    }

    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("uev-publish-" + [Guid]::NewGuid().ToString("N"))
    Invoke-Git -Arguments @("worktree", "add", "--detach", "--force", $tmp, $TargetBranch) | Out-Null
    $sha = $null
    Push-Location $tmp
    try {
        if ($Force) {
            $base = (Invoke-Git -Arguments @("merge-base", $SourceBranch, $TargetBranch)).Trim()
            Invoke-Git -Arguments @("reset", "--hard", "-q", $base) | Out-Null
        }

        Invoke-Git -Arguments @("read-tree", "--empty") | Out-Null
        Invoke-Git -Arguments (@("checkout", $SourceBranch, "--") + $allow) | Out-Null
        Invoke-Git -Arguments @("clean", "-fdxq", "--", ".") | Out-Null
        Invoke-Git -Arguments @("add", "-A") | Out-Null

        $staged = Split-Lines (Invoke-Git -Arguments @("ls-files"))
        $drift = @(Compare-Object $expected @($staged | Sort-Object))
        if ($drift.Count -gt 0) {
            $report = @($drift | ForEach-Object { $_.SideIndicator + " " + $_.InputObject })
            throw ("published tree does not match the allowlist:" + [Environment]::NewLine + ($report -join [Environment]::NewLine))
        }

        $pending = Split-Lines (Invoke-Git -Arguments @("status", "--porcelain"))
        if ($pending.Count -eq 0 -and -not $Force) {
            $sha = (Invoke-Git -Arguments @("rev-parse", "HEAD")).Trim()
            Write-Host ($TargetBranch + " already matches " + $SourceBranch + "; nothing to commit.")
        } else {
            Invoke-Git -Arguments @("commit", "-q", "-m", ("Publish the user-facing tree from " + $SourceBranch)) | Out-Null
            $sha = (Invoke-Git -Arguments @("rev-parse", "HEAD")).Trim()
            Write-Host ("committed " + $staged.Count + " file(s) on " + $TargetBranch)
        }

        if (-not $NoPush) {
            $ref = "HEAD:refs/heads/" + $TargetBranch
            $pushArgs = @("push", $Remote, $ref)
            if ($Force) { $pushArgs = @("push", "--force-with-lease", $Remote, $ref) }
            Write-Host (Invoke-Git -Arguments $pushArgs).Trim()
        }
    }
    finally {
        Pop-Location
        Invoke-Git -Arguments @("worktree", "remove", "--force", $tmp) | Out-Null
    }

    Invoke-Git -Arguments @("branch", "-f", $TargetBranch, $sha) | Out-Null
    Write-Host ("local " + $TargetBranch + " -> " + $sha.Substring(0, 7))
}
finally {
    Pop-Location
}
