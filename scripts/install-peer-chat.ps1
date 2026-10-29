<#
.SYNOPSIS
  Install dsh-peer-chat into one DSH profile directory.

.DESCRIPTION
  Idempotent, backed up, and rolled back on any check failure. It does exactly four things:

    1. backs up package.json and cordis.patch.yml (timestamped, same directory);
    2. copies the plugin to <profile>\node_modules\dsh-peer-chat;
    3. adds "dsh-peer-chat": "file:<plugin dir>" to package.json dependencies;
    4. appends "dsh-peer-chat" to package.json dsh.profile.bundles (exactly once).

  It never writes a hand-made `- insert:` row into cordis.patch.yml. The bundle entry alone is
  what mounts the plugin: the profile composer applies each bundle's own dsh.bundle.patch
  (this plugin ships one) over the empty root, then the profile's user layer. A hand-written
  insert PLUS the bundle entry mounts the plugin twice, which is the second bug this tool
  exists to prevent -- so a manual insert is detected and the install refuses to run until it
  is gone (see -RemoveManualInsert).

.PARAMETER Target
  The profile directory to change, e.g. <profile>.
  The directory must exist; it must contain a package.json.

.PARAMETER Source
  The plugin directory to copy. Defaults to the parent of this script's folder, i.e. the
  plugin root next to scripts\.

.PARAMETER RemoveManualInsert
  Comment out a hand-written dsh-peer-chat `- insert:` row found in the profile's
  cordis.patch.yml (the row is commented, not deleted). Without this switch the install stops
  with exit code 3 and prints the offending line numbers.

.EXAMPLE
  pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\install-peer-chat.ps1 `
       -Target <profile>

.EXAMPLE
  # profile that was hand-installed earlier: drop the duplicate manual insert first
  pwsh -NoProfile -File scripts\install-peer-chat.ps1 -Target <profile> -RemoveManualInsert

.NOTES
  Exit codes: 0 ok / 2 preflight refused (nothing was written) / 3 manual insert conflict
  (nothing was written) / 4 post-check failed (everything was rolled back) / 5 unexpected IO.
  Restart the instance that owns the profile afterwards: bundle layers are read at boot.
  ASCII-only and PowerShell 5.1 compatible on purpose (see scripts\lib\peerchat-common.ps1).
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Target,

  [string]$Source = '',

  [switch]$RemoveManualInsert
)

$ErrorActionPreference = 'Stop'
$PluginName = 'dsh-peer-chat'

. (Join-Path $PSScriptRoot 'lib\peerchat-common.ps1')

function Fail {
  param([string]$Message, [int]$Code)
  Write-Output ("[install] ERROR: " + $Message)
  exit $Code
}

function Invoke-Rollback {
  param([string]$Reason)

  Write-Output ("[install] rolling back: " + $Reason)
  try {
    if ($script:RunPkgBackup -and (Test-Path -LiteralPath (Join-Path $script:TargetPath $script:RunPkgBackup))) {
      Copy-Item -LiteralPath (Join-Path $script:TargetPath $script:RunPkgBackup) -Destination $script:PkgPath -Force
      Write-Output ("[install] package.json restored from " + $script:RunPkgBackup)
    }
    if ($script:RunPatchBackup -and (Test-Path -LiteralPath (Join-Path $script:TargetPath $script:RunPatchBackup))) {
      Copy-Item -LiteralPath (Join-Path $script:TargetPath $script:RunPatchBackup) -Destination $script:PatchPath -Force
      Write-Output ("[install] cordis.patch.yml restored from " + $script:RunPatchBackup)
    }
    if (Test-Path -LiteralPath $script:DestDir) {
      Remove-TreeSafe -Path $script:DestDir | Out-Null
      Write-Output ("[install] removed " + $script:DestDir)
    }
    if ($script:NodeModulesBackupName) {
      $aside = Join-Path $script:NodeModulesDir $script:NodeModulesBackupName
      if (Test-Path -LiteralPath $aside) {
        Move-Item -LiteralPath $aside -Destination $script:DestDir -Force
        Write-Output ("[install] previous plugin copy restored from " + $script:NodeModulesBackupName)
      }
    }
    if ($script:StateExistedBefore) {
      Write-InstallState -Target $script:TargetPath -State $script:State
    } else {
      Remove-InstallState -Target $script:TargetPath
    }
  } catch {
    Write-Output ("[install] ROLLBACK INCOMPLETE: " + $_.Exception.Message)
    Write-Output ("[install] backups to restore by hand live in " + $script:TargetPath)
    exit 5
  }
  exit 4
}

# ------------------------------------------------------------------ preflight (writes nothing)

Write-Output ('[install] dsh-peer-chat installer -- ' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))

$targetItem = Resolve-Path -LiteralPath $Target -ErrorAction SilentlyContinue
if (-not $targetItem) { Fail ("profile directory not found: " + $Target) 2 }
$script:TargetPath = $targetItem.ProviderPath
if (-not (Test-Path -LiteralPath (Join-Path $script:TargetPath 'package.json'))) {
  Fail ("no package.json in " + $script:TargetPath + " -- is this really a DSH profile?") 2
}

if ([string]::IsNullOrWhiteSpace($Source)) {
  $Source = Split-Path -Parent $PSScriptRoot
}
$sourceItem = Resolve-Path -LiteralPath $Source -ErrorAction SilentlyContinue
if (-not $sourceItem) { Fail ("plugin directory not found: " + $Source) 2 }
$sourceRoot = $sourceItem.ProviderPath
if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'package.json'))) {
  Fail ("no package.json in " + $sourceRoot + " -- pass -Source <plugin dir>") 2
}
$sourceManifest = Read-TextFile (Join-Path $sourceRoot 'package.json') | ConvertFrom-Json
if ([string]$sourceManifest.name -ne $PluginName) {
  Fail ("source package name is '" + $sourceManifest.name + "', expected '" + $PluginName + "'") 2
}
if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'index.js'))) {
  Fail ("source has no index.js: " + $sourceRoot) 2
}

$script:PkgPath = Join-Path $script:TargetPath 'package.json'
$script:PatchPath = Join-Path $script:TargetPath 'cordis.patch.yml'
$script:NodeModulesDir = Join-Path $script:TargetPath 'node_modules'
$script:DestDir = Join-Path $script:NodeModulesDir $PluginName

if ($script:DestDir.ToLowerInvariant().StartsWith($sourceRoot.ToLowerInvariant() + '\')) {
  Fail ("destination " + $script:DestDir + " is inside the source tree; pass another -Target") 2
}
if ($sourceRoot.ToLowerInvariant() -eq $script:DestDir.ToLowerInvariant()) {
  Fail 'source and destination are the same directory' 2
}

if (Test-HasUtf8Bom -Path $script:PkgPath) {
  Write-Output '[install] NOTE: package.json currently has a UTF-8 BOM (the classic startup-crash cause); it will be rewritten without one.'
}
$pkgText = Read-TextFile $script:PkgPath
try {
  $null = $pkgText | ConvertFrom-Json
} catch {
  Fail ('package.json does not parse, refusing to touch it: ' + $_.Exception.Message) 2
}

$spec = 'file:' + ($sourceRoot -replace '\\', '/')
$preDependencyKeys = @()
$preDeps = Get-DependencyMap $pkgText
if ($null -ne $preDeps) { $preDependencyKeys = @($preDeps.PSObject.Properties | ForEach-Object { $_.Name }) }
$preBundleNames = @(Get-BundleNames $pkgText)
if ($preBundleNames.Count -eq 0) {
  Write-Output '[install] WARNING: dsh.profile.bundles is empty -- after this install the profile would mount only dsh-peer-chat.'
  Write-Output '[install]          Add your base bundle(s) first unless this really is an empty probe profile.'
}

$bundleListPresent = $false
try {
  $manifestObject = $pkgText | ConvertFrom-Json
  $bundleListPresent = [bool]($manifestObject.PSObject.Properties['dsh'] -and
    $manifestObject.dsh.PSObject.Properties['profile'] -and
    $manifestObject.dsh.profile.PSObject.Properties['bundles'])
} catch { $bundleListPresent = $false }
if (-not $bundleListPresent) {
  Write-Output '[install] REFUSED: this profile has no dsh.profile.bundles list.'
  Write-Output '[install]   A profile is composed from that list; appending one entry to a missing list would'
  Write-Output '[install]   mount the plugin without the base layer. Add the profile bundles first, e.g.'
  Write-Output '[install]     "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base"] } }'
  Write-Output '[install]   or let "dsh plugin --profile <name> add <package>" create the profile for you.'
  exit 2
}

$manual = @(Test-PatchHasManualInsert -Path $script:PatchPath)
if ($manual.Count -gt 0 -and -not $RemoveManualInsert) {
  $patchLines = (Read-TextFile $script:PatchPath) -split "`r?`n"
  Write-Output '[install] REFUSED: cordis.patch.yml already mounts dsh-peer-chat by hand:'
  foreach ($hit in $manual) {
    Write-Output ("           line " + ($hit.Start + 1) + ': ' + ([string]$patchLines[$hit.Start]).Trim())
  }
  Write-Output '[install] Having both this row and dsh.profile.bundles loads the plugin twice.'
  Write-Output '[install] Either delete the row yourself, or rerun with -RemoveManualInsert to have it commented out.'
  exit 3
}

# ------------------------------------------------------------------ backups + state

$script:RunPkgBackup = Backup-File -Path $script:PkgPath -Tag 'peerchat'
$script:RunPatchBackup = Backup-File -Path $script:PatchPath -Tag 'peerchat'
Write-Output ("[install] backup package.json    -> " + $script:RunPkgBackup)
if ($script:RunPatchBackup) { Write-Output ("[install] backup cordis.patch.yml -> " + $script:RunPatchBackup) }

$existingState = Read-InstallState -Target $script:TargetPath
$script:StateExistedBefore = ($null -ne $existingState)
if ($script:StateExistedBefore) {
  $script:State = $existingState
  Write-Output '[install] found a previous install record; its original backup stays authoritative for uninstall'
} else {
  $script:State = New-InstallState -Target $script:TargetPath -Source $sourceRoot -Spec $spec
}
if (-not $script:State.originalPackageJson) { $script:State.originalPackageJson = $script:RunPkgBackup }
if ($script:RunPatchBackup) {
  $script:State.patchBackups = @(@($script:State.patchBackups) + $script:RunPatchBackup | Where-Object { $_ })
}
$script:State.pending = $true
Write-InstallState -Target $script:TargetPath -State $script:State

try {

  # ---------------------------------------------------------------- 1. manual insert in the user layer

  if ($manual.Count -gt 0) {
    $patchResult = Update-PatchManualInsert -Path $script:PatchPath
    if (Test-HasUtf8Bom -Path $script:PatchPath) { Fail 'cordis.patch.yml ended up with a BOM' 4 }
    $stillThere = @(Test-PatchHasManualInsert -Path $script:PatchPath)
    if ($stillThere.Count -gt 0) { Fail 'a manual dsh-peer-chat insert is still active in cordis.patch.yml' 4 }
    Write-Output ("[install] commented out manual insert on line(s): " + ($patchResult.Lines -join ', '))
  }

  # ---------------------------------------------------------------- 2. node_modules copy

  if (-not (Test-Path -LiteralPath $script:NodeModulesDir)) {
    New-Item -ItemType Directory -Path $script:NodeModulesDir -Force | Out-Null
  }

  $skipSegments = @('node_modules', '.git', '.pnpm', '.DS_Store')
  $sourceFiles = @{}
  $sourceLen = $sourceRoot.TrimEnd('\', '/').Length
  Get-ChildItem -LiteralPath $sourceRoot -Recurse -Force | Where-Object { -not $_.PSIsContainer } | ForEach-Object {
    $relative = $_.FullName.Substring($sourceLen).TrimStart('\', '/')
    $skipIt = $false
    foreach ($segment in ($relative -split '[\\/]')) { if ($skipSegments -contains $segment) { $skipIt = $true } }
    if (-not $skipIt) { $sourceFiles[$relative] = (Get-FileSha256 -Path $_.FullName) }
  }

  $existingCopyIsCurrent = $false
  if (Test-Path -LiteralPath $script:DestDir) {
    if (Test-IsReparsePoint -Path $script:DestDir) {
      [IO.Directory]::Delete($script:DestDir, $false)
      Write-Output '[install] removed a symlink/junction at node_modules\dsh-peer-chat (link only, target untouched)'
    } else {
      $same = $true
      $destLen = $script:DestDir.Length
      $destFiles = @(Get-ChildItem -LiteralPath $script:DestDir -Recurse -Force | Where-Object { -not $_.PSIsContainer })
      $destRel = @{}
      foreach ($file in $destFiles) {
        $relative = $file.FullName.Substring($destLen).TrimStart('\', '/')
        $destRel[$relative] = (Get-FileSha256 -Path $file.FullName)
      }
      if ($destRel.Count -ne $sourceFiles.Count) { $same = $false }
      else {
        foreach ($key in $sourceFiles.Keys) {
          if (-not $destRel.ContainsKey($key)) { $same = $false; break }
          if ($destRel[$key] -ne $sourceFiles[$key]) { $same = $false; break }
        }
      }
      if ($same) {
        $existingCopyIsCurrent = $true
        Write-Output ("[install] node_modules\dsh-peer-chat already matches the source (" + $sourceFiles.Count + " files)")
      } else {
        $script:NodeModulesBackupName = $PluginName + '.bak-peerchat-' + (New-BackupSuffix)
        Move-Item -LiteralPath $script:DestDir -Destination (Join-Path $script:NodeModulesDir $script:NodeModulesBackupName) -Force
        $script:State.nodeModulesBackup = $script:NodeModulesBackupName
        Write-Output ("[install] previous copy moved aside -> " + $script:NodeModulesBackupName)
      }
    }
  }

  if (-not $existingCopyIsCurrent) {
    $copied = Copy-PluginTree -From $sourceRoot -To $script:DestDir
    Write-Output ("[install] copied plugin -> node_modules\dsh-peer-chat (" + $copied + " files)")
  }
  foreach ($required in @('package.json', 'index.js', 'client.js', 'cordis.patch.yml')) {
    if (-not (Test-Path -LiteralPath (Join-Path $script:DestDir $required))) {
      Fail ('copy is incomplete, missing ' + $required) 4
    }
  }

  # ---------------------------------------------------------------- 3. package.json

  $deps = Get-DependencyMap $pkgText
  $depPresent = $false
  $depValue = ''
  if ($null -ne $deps -and $deps.PSObject.Properties[$PluginName]) {
    $depPresent = $true
    $depValue = [string]$deps.$PluginName
  }
  $bundleHits = @(Get-BundleNames $pkgText | Where-Object { [string]$_ -eq $PluginName })
  $bundleCount = $bundleHits.Count
  $hadBom = Test-HasUtf8Bom -Path $script:PkgPath

  $changes = New-Object System.Collections.ArrayList
  if (-not $depPresent) { [void]$changes.Add('add dependency') }
  elseif ($depValue -ne $spec) { [void]$changes.Add('update dependency spec') }
  if ($bundleCount -eq 0) { [void]$changes.Add('add bundle entry') }
  elseif ($bundleCount -gt 1) { [void]$changes.Add(('dedupe bundle entry (found ' + $bundleCount + ')')) }
  if ($hadBom) { [void]$changes.Add('strip BOM') }

  if ($changes.Count -eq 0) {
    Write-Output '[install] package.json already has one dependency and one bundle entry -- left untouched'
  } else {
    Write-Output ("[install] package.json: " + ($changes -join ', '))

    $newText = $null
    $objectPath = ($depPresent -and $depValue -ne $spec) -or ($bundleCount -gt 1)

    if (-not $objectPath) {
      $newText = $pkgText
      if (-not $depPresent) {
        $edited = Add-DependencyEntry -Json $newText -Name $PluginName -Spec $spec
        if ($null -eq $edited) { $objectPath = $true } else { $newText = $edited }
      }
      if (-not $objectPath -and $bundleCount -eq 0) {
        $edited = Add-BundleEntry -Json $newText -Name $PluginName
        if ($null -eq $edited) { $objectPath = $true } else { $newText = $edited }
      }
    }

    if ($objectPath) {
      Write-Output '[install] using the structured fallback edit (keeps every other field, re-serializes the file)'
      $obj = $pkgText | ConvertFrom-Json
      if (-not $obj.PSObject.Properties['dependencies']) {
        $obj | Add-Member -MemberType NoteProperty -Name dependencies -Value (New-Object psobject)
      }
      $obj.dependencies | Add-Member -MemberType NoteProperty -Name $PluginName -Value $spec -Force
      if (-not $obj.PSObject.Properties['dsh']) {
        $obj | Add-Member -MemberType NoteProperty -Name dsh -Value (New-Object psobject)
      }
      if (-not $obj.dsh.PSObject.Properties['profile']) {
        $obj.dsh | Add-Member -MemberType NoteProperty -Name profile -Value (New-Object psobject)
      }
      $kept = @(Get-BundleNames $pkgText | Where-Object { [string]$_ -ne $PluginName })
      $kept = @($kept + $PluginName)
      $obj.dsh.profile | Add-Member -MemberType NoteProperty -Name bundles -Value $kept -Force
      $newText = ($obj | ConvertTo-Json -Depth 32)
    }

    $problems = @(Test-ManifestInstalled -Json $newText -RawText $newText -Name $PluginName -Spec $spec)
    if ($problems.Count -gt 0) {
      Write-Output '[install] the edited manifest failed its own checks:'
      foreach ($problem in $problems) { Write-Output ('           ' + $problem) }
      Invoke-Rollback 'edited package.json is not valid'
    }

    Write-TextNoBom -Path $script:PkgPath -Text $newText
    Write-Output '[install] wrote package.json (UTF-8, no BOM)'
  }

  # ---------------------------------------------------------------- 4. post-check

  if (Test-HasUtf8Bom -Path $script:PkgPath) { Invoke-Rollback 'package.json has a BOM after writing' }
  $finalText = Read-TextFile $script:PkgPath
  $problems = @(Test-ManifestInstalled -Json $finalText -RawText $finalText -Name $PluginName -Spec $spec)
  $finalDeps = Get-DependencyMap $finalText
  foreach ($key in $preDependencyKeys) {
    if (-not $finalDeps.PSObject.Properties[$key]) { $problems += ('pre-existing dependency was lost: ' + $key) }
  }
  foreach ($name in $preBundleNames) {
    if (-not (@(Get-BundleNames $finalText) -contains $name)) { $problems += ('pre-existing bundle entry was lost: ' + $name) }
  }
  $activeManual = @(Test-PatchHasManualInsert -Path $script:PatchPath)
  if ($activeManual.Count -gt 0) { $problems += 'cordis.patch.yml still has an active dsh-peer-chat insert' }
  if ($problems.Count -gt 0) {
    Write-Output '[install] post-check failed:'
    foreach ($problem in $problems) { Write-Output ('           ' + $problem) }
    Invoke-Rollback 'post-check failed'
  }

  $script:State.pending = $false
  $script:State.installedAt = (Get-Date).ToString('o')
  Write-InstallState -Target $script:TargetPath -State $script:State

} catch {
  Invoke-Rollback ('unexpected error: ' + $_.Exception.Message)
}

# ------------------------------------------------------------------ report

$copiedCount = @(Get-ChildItem -LiteralPath $script:DestDir -Recurse -Force | Where-Object { -not $_.PSIsContainer }).Count
Write-Output ''
$report = @(
  @('package.json encoding', ('OK  (UTF-8, no BOM)')),
  @(('dependencies.' + $PluginName), ('OK  (' + $spec + ')')),
  @('dsh.profile.bundles', ('OK  (exactly 1 entry)')),
  @('pre-existing rows kept', ('OK  (' + $preDependencyKeys.Count + ' dependencies, ' + $preBundleNames.Count + ' bundles)')),
  @(('node_modules\' + $PluginName), ('OK  (' + $copiedCount + ' files)')),
  @('cordis.patch.yml', ('OK  (no active manual insert)'))
)
foreach ($row in $report) { Write-Output ('[verify] ' + $row[0].PadRight(28) + $row[1]) }
Write-Output ''
Write-Output '[install] PASS'
Write-Output '[install] RESTART REQUIRED: bundle layers and the client module are read at boot only.'
Write-Output '[install]   restart the instance that owns this profile (dsh web / the desktop app),'
Write-Output '[install]   then confirm the panel entry is back and peer_list answers instead of 404.'
exit 0
