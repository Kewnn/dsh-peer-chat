<#
.SYNOPSIS
  Remove dsh-peer-chat from one DSH profile directory.

.DESCRIPTION
  The exact inverse of install-peer-chat.ps1, and safe to run twice:

    1. drops "dsh-peer-chat" from package.json dependencies;
    2. drops "dsh-peer-chat" from package.json dsh.profile.bundles;
    3. deletes <profile>\node_modules\dsh-peer-chat (a junction is unlinked, never followed);
    4. comments out any hand-written dsh-peer-chat `- insert:` row in cordis.patch.yml;
    5. deletes .dsh-peer-chat-install.json.

  Restoring package.json: the removal is computed from the current file, then compared with the
  backup the installer recorded. When nothing else changed since the install, the ORIGINAL BYTES
  are written back -- a real restore, not a re-serialization. When something else changed
  (another plugin installed later, say), only our two rows are removed so that work is kept.
  Use -RestoreBackup to force the recorded backups over the current files.

  cordis.patch.yml is never restored wholesale by default: putting a hand-written insert back
  would re-mount a plugin whose package is gone. -RestoreBackup restores it, then still comments
  that row out so the instance stays bootable.

.PARAMETER Target
  The profile directory to clean, e.g. <profile>.

.PARAMETER RestoreBackup
  Force the recorded pre-install backups of package.json (and cordis.patch.yml) back into place
  instead of removing rows surgically. Nothing else you changed in those files survives.

.EXAMPLE
  pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall-peer-chat.ps1 `
       -Target <profile>

.NOTES
  Exit codes: 0 ok (also when there was nothing to remove) / 2 preflight refused / 4 post-check
  failed (this run's backup was put back) / 5 unexpected IO.
  Restart the instance that owns the profile afterwards.
  ASCII-only and PowerShell 5.1 compatible on purpose (see scripts\lib\peerchat-common.ps1).
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Target,

  [switch]$RestoreBackup
)

$ErrorActionPreference = 'Stop'
$PluginName = 'dsh-peer-chat'

. (Join-Path $PSScriptRoot 'lib\peerchat-common.ps1')

function Fail {
  param([string]$Message, [int]$Code)
  Write-Output ('[uninstall] ERROR: ' + $Message)
  exit $Code
}

Write-Output ('[uninstall] dsh-peer-chat uninstaller -- ' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))

# ------------------------------------------------------------------ preflight

$targetItem = Resolve-Path -LiteralPath $Target -ErrorAction SilentlyContinue
if (-not $targetItem) { Fail ('profile directory not found: ' + $Target) 2 }
$targetPath = $targetItem.ProviderPath
$pkgPath = Join-Path $targetPath 'package.json'
$patchPath = Join-Path $targetPath 'cordis.patch.yml'
$nodeModulesDir = Join-Path $targetPath 'node_modules'
$destDir = Join-Path $nodeModulesDir $PluginName

if (-not (Test-Path -LiteralPath $pkgPath)) {
  Fail ('no package.json in ' + $targetPath + ' -- is this really a DSH profile?') 2
}
$pkgText = Read-TextFile $pkgPath
try { $null = $pkgText | ConvertFrom-Json } catch {
  Fail ('package.json does not parse, refusing to touch it: ' + $_.Exception.Message) 2
}

$state = Read-InstallState -Target $targetPath
$changes = New-Object System.Collections.ArrayList

$deps = Get-DependencyMap $pkgText
$depPresent = $false
if ($null -ne $deps -and $deps.PSObject.Properties[$PluginName]) { $depPresent = $true }
$bundleHits = @(Get-BundleNames $pkgText | Where-Object { [string]$_ -eq $PluginName }).Count
$manualCount = @(Test-PatchHasManualInsert -Path $patchPath).Count
$copyPresent = Test-Path -LiteralPath $destDir
$statePresent = ($null -ne $state)
$restoredAsideCopy = $false

if ($depPresent) { [void]$changes.Add('remove dependency') }
if ($bundleHits -gt 0) { [void]$changes.Add('remove bundle entry') }
if ($copyPresent) { [void]$changes.Add('delete node_modules copy') }
if ($manualCount -gt 0) { [void]$changes.Add('comment out manual insert') }
if ($statePresent) { [void]$changes.Add('delete install record') }
if ($RestoreBackup) { [void]$changes.Add('restore recorded backups') }

if ($changes.Count -eq 0) {
  Write-Output '[uninstall] nothing to do: this profile has no dsh-peer-chat install'
  Write-Output '[uninstall] PASS (idempotent no-op)'
  exit 0
}
Write-Output ('[uninstall] planned: ' + ($changes -join ', '))

# ------------------------------------------------------------------ backups of what we touch

$runPkgBackup = Backup-File -Path $pkgPath -Tag 'peerchat-uninstall'
if ($runPkgBackup) { Write-Output ('[uninstall] backup package.json -> ' + $runPkgBackup) }
$runPatchBackup = ''
if ($RestoreBackup -or $manualCount -gt 0) {
  $runPatchBackup = Backup-File -Path $patchPath -Tag 'peerchat-uninstall'
  if ($runPatchBackup) { Write-Output ('[uninstall] backup cordis.patch.yml -> ' + $runPatchBackup) }
}

function Restore-ThisRun {
  param([string]$Reason)
  Write-Output ('[uninstall] check failed (' + $Reason + '); putting package.json back')
  if ($runPkgBackup) { Copy-Item -LiteralPath (Join-Path $targetPath $runPkgBackup) -Destination $pkgPath -Force }
  if ($runPatchBackup) { Copy-Item -LiteralPath (Join-Path $targetPath $runPatchBackup) -Destination $patchPath -Force }
  exit 4
}

# ------------------------------------------------------------------ 1. package.json

$originalText = $null
if ($state -and $state.originalPackageJson) {
  $originalPath = Join-Path $targetPath ([string]$state.originalPackageJson)
  if (Test-Path -LiteralPath $originalPath) { $originalText = Read-TextFile $originalPath }
}

$newText = $pkgText
$restoredExactly = $false

if ($RestoreBackup) {
  if (-not $originalText) {
    Fail 'no recorded package.json backup for this profile; rerun without -RestoreBackup' 2
  }
  $newText = $originalText
  Write-Output ('[uninstall] package.json restored from ' + $state.originalPackageJson)
} elseif ($depPresent -or $bundleHits -gt 0) {
  $newText = Remove-ManifestEntries -Json $pkgText -Name $PluginName
  # Byte-exact restore when the user changed nothing else since the install.
  if ($originalText) {
    $canonicalNew = ($newText | ConvertFrom-Json | ConvertTo-Json -Depth 32)
    $canonicalOriginal = ($originalText | ConvertFrom-Json | ConvertTo-Json -Depth 32)
    if ($canonicalNew -eq $canonicalOriginal) {
      $newText = $originalText
      $restoredExactly = $true
    }
  }
} elseif (Test-HasUtf8Bom -Path $pkgPath) {
  Write-Output '[uninstall] package.json had a BOM; rewriting it without one'
}

$manifestTouched = ($RestoreBackup -or $depPresent -or $bundleHits -gt 0 -or (Test-HasUtf8Bom -Path $pkgPath))
if ($manifestTouched) {
  $problems = @(Test-ManifestRemoved -Json $newText -RawText $newText -Name $PluginName)
  if ($problems.Count -gt 0) {
    foreach ($problem in $problems) { Write-Output ('           ' + $problem) }
    Restore-ThisRun 'the cleaned manifest is not valid'
  }
  if ($newText -ne $pkgText) {
    Write-TextNoBom -Path $pkgPath -Text $newText
    if ($restoredExactly) {
      Write-Output '[uninstall] package.json restored to the pre-install bytes (nothing else had changed)'
    } else {
      Write-Output '[uninstall] package.json updated: dependency and bundle entry removed (UTF-8, no BOM)'
    }
  } else {
    Write-Output '[uninstall] package.json already clean'
  }
}

# ------------------------------------------------------------------ 2. node_modules copy

if (Test-Path -LiteralPath $destDir) {
  if (Test-IsReparsePoint -Path $destDir) {
    Remove-TreeSafe -Path $destDir | Out-Null
    Write-Output '[uninstall] unlinked node_modules\dsh-peer-chat (symlink; target untouched)'
  } else {
    Remove-TreeSafe -Path $destDir | Out-Null
    Write-Output '[uninstall] deleted node_modules\dsh-peer-chat'
  }
  if ($state -and $state.nodeModulesBackup) {
    $aside = Join-Path $nodeModulesDir ([string]$state.nodeModulesBackup)
    if (Test-Path -LiteralPath $aside) {
      Move-Item -LiteralPath $aside -Destination $destDir -Force
      $restoredAsideCopy = $true
      Write-Output ('[uninstall] restored the copy the installer had moved aside: ' + $state.nodeModulesBackup)
    }
  }
}

# ------------------------------------------------------------------ 3. cordis.patch.yml

if ($RestoreBackup -and $state -and @($state.patchBackups).Count -gt 0) {
  $newest = @($state.patchBackups) | Select-Object -Last 1
  $backupPath = Join-Path $targetPath ([string]$newest)
  if (Test-Path -LiteralPath $backupPath) {
    Copy-Item -LiteralPath $backupPath -Destination $patchPath -Force
    Write-Output ('[uninstall] cordis.patch.yml restored from ' + $newest)
  }
}

$patchResult = Update-PatchManualInsert -Path $patchPath
if ($patchResult.Commented -gt 0) {
  Write-Output ('[uninstall] commented out manual insert on line(s): ' + (@($patchResult.Lines) -join ', '))
}
$activeManual = @(Test-PatchHasManualInsert -Path $patchPath)
if ($activeManual.Count -gt 0) {
  Restore-ThisRun 'cordis.patch.yml still carries an active dsh-peer-chat insert'
}

# ------------------------------------------------------------------ 4. install record

if (Test-Path -LiteralPath (Get-InstallStatePath -Target $targetPath)) {
  Remove-InstallState -Target $targetPath
  Write-Output '[uninstall] deleted .dsh-peer-chat-install.json'
}

# ------------------------------------------------------------------ report

$finalText = Read-TextFile $pkgPath
$problems = @(Test-ManifestRemoved -Json $finalText -RawText $finalText -Name $PluginName)
if (Test-HasUtf8Bom -Path $pkgPath) { $problems += 'package.json has a BOM after writing' }
if ((Test-Path -LiteralPath $destDir) -and -not $restoredAsideCopy) { $problems += 'node_modules\dsh-peer-chat still exists' }
if (@(Test-PatchHasManualInsert -Path $patchPath).Count -gt 0) { $problems += 'cordis.patch.yml still has an active insert' }
if ($problems.Count -gt 0) {
  foreach ($problem in $problems) { Write-Output ('           ' + $problem) }
  Restore-ThisRun 'final check failed'
}

$copyRow = @(('node_modules\' + $PluginName), ('OK  (absent)'))
if ($restoredAsideCopy) { $copyRow = @(('node_modules\' + $PluginName), ('OK  (your pre-existing copy was put back)')) }
Write-Output ''
$report = @(
  @('package.json encoding', ('OK  (UTF-8, no BOM)')),
  @(('dependencies.' + $PluginName), ('OK  (absent)')),
  @('dsh.profile.bundles', ('OK  (no entry)')),
  $copyRow,
  @('cordis.patch.yml', ('OK  (no active manual insert)')),
  @('.dsh-peer-chat-install.json', ('OK  (absent)'))
)
foreach ($row in $report) { Write-Output ('[verify] ' + $row[0].PadRight(28) + $row[1]) }
Write-Output ''
Write-Output '[uninstall] PASS'
Write-Output '[uninstall] RESTART REQUIRED: restart the instance that owns this profile so the removed'
Write-Output '[uninstall]   bundle layer and client module stop being served.'
exit 0
