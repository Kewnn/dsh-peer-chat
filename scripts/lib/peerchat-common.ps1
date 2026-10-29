<#
  peerchat-common.ps1 -- shared helpers for install-peer-chat.ps1 / uninstall-peer-chat.ps1.

  Design rules (learned the hard way, see INSTALL.md "Why this is written the way it is"):
    * NEVER write UTF-8 with BOM. Every write goes through Write-TextNoBom, which uses
      UTF8Encoding($false). A BOM in package.json makes the DSH boot die on JSON.parse.
    * ASCII only. Windows PowerShell 5.1 decodes a BOM-less .ps1 as ANSI, so non-ASCII
      literals inside these scripts would be mangled before they ever run. This file is
      therefore pure ASCII, which is a strict subset of UTF-8 without BOM.
    * Minimal diffs. package.json is edited with text surgery (insert the one line / the one
      array element) instead of being re-serialized, so the user's ordering and formatting
      survive. Re-serialization exists only as a fallback and is always validated.
    * Validate, then keep; otherwise roll back. Callers write to a temp file, parse it, and
      only then move it over the original.

  Targets Windows PowerShell 5.1 and PowerShell 7+: no ternary, no ??, no -AsHashtable,
  no ConvertFrom-Json -Depth.
#>

$script:PeerChatName = 'dsh-peer-chat'
$script:PeerChatUtf8 = New-Object System.Text.UTF8Encoding($false)
$script:PeerChatStateFile = '.dsh-peer-chat-install.json'

# ---------------------------------------------------------------- logging

function Log {
  param([string]$Message)
  # Write-Output (not Write-Host) so callers, log files and CI can capture the transcript.
  Write-Output $Message
}

function LogStep {
  param([string]$Tag, [string]$Message)
  Write-Output ("[{0}] {1}" -f $Tag, $Message)
}

function Write-Detail {
  param([string]$Message)
  Write-Output ("        " + $Message)
}

# ---------------------------------------------------------------- text files (UTF-8, no BOM)

function Read-TextFile {
  param([string]$Path)
  # ReadAllText strips a BOM when it finds one (StreamReader detects BOMs), so callers get
  # clean text even from a profile that was broken by the earlier Set-Content -Encoding utf8.
  return [IO.File]::ReadAllText($Path, $script:PeerChatUtf8)
}

function Test-HasUtf8Bom {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  $bytes = [IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { return $true }
  return $false
}

function Write-TextNoBom {
  param([string]$Path, [string]$Text)
  $dir = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $tmp = Join-Path $dir ('.' + (Split-Path -Leaf $Path) + '.peerchat-tmp')
  if (Test-Path -LiteralPath $tmp) { [IO.File]::Delete($tmp) }
  [IO.File]::WriteAllText($tmp, $Text, $script:PeerChatUtf8)
  if (Test-Path -LiteralPath $Path) {
    try {
      # Atomic on NTFS and preserves the original ACLs/attributes.
      [IO.File]::Replace($tmp, $Path, $null)
      return
    } catch {
      [IO.File]::Delete($Path)
    }
  }
  [IO.File]::Move($tmp, $Path)
}

function Get-TextNewLine {
  param([string]$Text)
  if ($Text.Contains("`r`n")) { return "`r`n" }
  return "`n"
}

function Get-FileSha256 {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return '' }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# ---------------------------------------------------------------- JSON scanning helpers

function ConvertTo-JsonStringLiteral {
  param([string]$Value)
  return ('"' + $Value.Replace('\', '\\').Replace('"', '\"') + '"')
}

function Find-MatchingClose {
  param([string]$Text, [int]$OpenIndex, [char]$OpenChar, [char]$CloseChar)
  $depth = 0
  $inString = $false
  $escaped = $false
  for ($i = $OpenIndex; $i -lt $Text.Length; $i++) {
    $c = $Text[$i]
    if ($inString) {
      if ($escaped) { $escaped = $false; continue }
      if ($c -eq [char]92) { $escaped = $true; continue }
      if ($c -eq [char]34) { $inString = $false }
      continue
    }
    if ($c -eq [char]34) { $inString = $true; continue }
    if ($c -eq $OpenChar) { $depth++ }
    elseif ($c -eq $CloseChar) {
      $depth--
      if ($depth -eq 0) { return $i }
    }
  }
  return -1
}

function Get-LineIndentInfo {
  param([string]$Text, [int]$Index)
  $start = 0
  if ($Index -gt 0) {
    $nl = $Text.LastIndexOf([char]10, $Index - 1)
    if ($nl -ge 0) { $start = $nl + 1 }
  }
  $n = 0
  while (($start + $n) -lt $Text.Length) {
    $c = $Text[$start + $n]
    if ($c -eq ' ' -or $c -eq "`t") { $n++ } else { break }
  }
  return @{ Start = $start; Indent = $Text.Substring($start, $n) }
}

<#
  Add one key/value pair to the top-level "dependencies" object without touching anything
  else. Returns $null when the file's layout is not one this helper can edit safely; the
  caller then falls back to a full re-serialization.
#>
function Add-DependencyEntry {
  param([string]$Json, [string]$Name, [string]$Spec)

  $m = [regex]::Match($Json, '"dependencies"\s*:\s*\{')
  if (-not $m.Success) { return $null }
  $open = $m.Index + $m.Length - 1
  $close = Find-MatchingClose -Text $Json -OpenIndex $open -OpenChar ([char]'{') -CloseChar ([char]'}')
  if ($close -lt 0) { return $null }

  $nl = Get-TextNewLine $Json
  $entry = (ConvertTo-JsonStringLiteral $Name) + ': ' + (ConvertTo-JsonStringLiteral $Spec)
  $inner = $Json.Substring($open + 1, $close - $open - 1)

  if ([string]::IsNullOrWhiteSpace($inner)) {
    $line = Get-LineIndentInfo -Text $Json -Index $open
    $entryIndent = $line.Indent + '  '
    $body = $nl + $entryIndent + $entry + $nl + $line.Indent
    return $Json.Substring(0, $open + 1) + $body + $Json.Substring($close)
  }

  $firstNonWs = $open + 1
  while ($firstNonWs -lt $close -and [char]::IsWhiteSpace($Json[$firstNonWs])) { $firstNonWs++ }
  # Single-line objects (`{"a": 1}`) are not worth a fragile edit -- hand them to the fallback.
  if ($Json.Substring($open + 1, $firstNonWs - $open - 1) -notmatch "[`r`n]") { return $null }

  $line = Get-LineIndentInfo -Text $Json -Index $firstNonWs
  $entryIndent = $Json.Substring($line.Start, $firstNonWs - $line.Start)
  # Insert in front of the first key, i.e. after that line's indent: the indent is already in
  # the head slice, so the new row reuses it and the existing row keeps its own.
  $insert = $entry + ',' + $nl + $entryIndent
  return $Json.Substring(0, $firstNonWs) + $insert + $Json.Substring($firstNonWs)
}

<#
  Append one element to the "bundles" array in place, adding the comma only when needed.
  Returns $null when the layout has to be handled by the fallback path.
#>
function Add-BundleEntry {
  param([string]$Json, [string]$Name)

  $m = [regex]::Match($Json, '"bundles"\s*:\s*\[')
  if (-not $m.Success) { return $null }
  $open = $m.Index + $m.Length - 1
  $close = Find-MatchingClose -Text $Json -OpenIndex $open -OpenChar ([char]'[') -CloseChar ([char]']')
  if ($close -lt 0) { return $null }

  $nl = Get-TextNewLine $Json
  $literal = ConvertTo-JsonStringLiteral $Name
  $inner = $Json.Substring($open + 1, $close - $open - 1)

  if ([string]::IsNullOrWhiteSpace($inner)) {
    $line = Get-LineIndentInfo -Text $Json -Index $open
    $entryIndent = $line.Indent + '  '
    $body = $nl + $entryIndent + $literal + $nl + $line.Indent
    return $Json.Substring(0, $open + 1) + $body + $Json.Substring($close)
  }

  $firstNonWs = $open + 1
  while ($firstNonWs -lt $close -and [char]::IsWhiteSpace($Json[$firstNonWs])) { $firstNonWs++ }
  if ($Json.Substring($open + 1, $firstNonWs - $open - 1) -notmatch "[`r`n]") { return $null }

  $line = Get-LineIndentInfo -Text $Json -Index $firstNonWs
  $entryIndent = $Json.Substring($line.Start, $firstNonWs - $line.Start)

  $lastNonWs = $close - 1
  while ($lastNonWs -gt $open -and [char]::IsWhiteSpace($Json[$lastNonWs])) { $lastNonWs-- }
  $comma = ''
  if ($Json[$lastNonWs] -ne ',') { $comma = ',' }
  $added = $comma + $nl + $entryIndent + $literal
  return $Json.Substring(0, $lastNonWs + 1) + $added + $Json.Substring($lastNonWs + 1)
}

<#
  Remove our dependency row and our bundle row by re-serializing the manifest.
  Deliberately dumb on purpose: removal runs once and its output is then compared with the
  pre-install backup, so the caller can restore the original bytes byte-for-byte when the
  user made no other change (that is what makes uninstall a true restore).
#>
function Remove-ManifestEntries {
  param([string]$Json, [string]$Name)

  $obj = $Json | ConvertFrom-Json
  if ($obj.PSObject.Properties['dependencies']) {
    $deps = $obj.dependencies
    if ($deps.PSObject.Properties[$Name]) { $deps.PSObject.Properties.Remove($Name) }
  }
  $dsh = $null
  if ($obj.PSObject.Properties['dsh']) { $dsh = $obj.dsh }
  if ($null -ne $dsh -and $dsh.PSObject.Properties['profile']) {
    $profile = $dsh.profile
    if ($profile.PSObject.Properties['bundles']) {
      $kept = @($profile.bundles | Where-Object { [string]$_ -ne $Name })
      # -Force overwrites in place and keeps the property order, so an unchanged file still
      # compares equal with the backup below (that is what enables the byte-exact restore).
      $profile | Add-Member -MemberType NoteProperty -Name bundles -Value $kept -Force
    }
  }
  return ($obj | ConvertTo-Json -Depth 32)
}

# ---------------------------------------------------------------- manifest assertions

function Get-DependencyMap {
  param([string]$Json)
  $obj = $Json | ConvertFrom-Json
  if ($obj.PSObject.Properties['dependencies']) { return $obj.dependencies }
  return $null
}

function Get-BundleNames {
  param([string]$Json)
  $obj = $Json | ConvertFrom-Json
  if (-not $obj.PSObject.Properties['dsh']) { return @() }
  if (-not $obj.dsh.PSObject.Properties['profile']) { return @() }
  if (-not $obj.dsh.profile.PSObject.Properties['bundles']) { return @() }
  return @($obj.dsh.profile.bundles)
}

<#
  Problems found in an installed manifest (empty list == good).
  $RawText is used for the duplicate-row count because JSON object keys collapse on parse.
#>
function Test-ManifestInstalled {
  param([string]$Json, [string]$RawText, [string]$Name, [string]$Spec)

  $problems = New-Object System.Collections.ArrayList

  try { $obj = $Json | ConvertFrom-Json } catch {
    [void]$problems.Add('package.json does not parse: ' + $_.Exception.Message)
    return $problems
  }

  $deps = $null
  if ($obj.PSObject.Properties['dependencies']) { $deps = $obj.dependencies }
  if ($null -eq $deps) {
    [void]$problems.Add('dependencies object is missing')
  } else {
    if (-not $deps.PSObject.Properties[$Name]) {
      [void]$problems.Add("dependencies.$Name is missing")
    } elseif ([string]$deps.$Name -ne $Spec) {
      [void]$problems.Add(("dependencies.{0} = '{1}', expected '{2}'" -f $Name, $deps.$Name, $Spec))
    }
  }

  $bundles = Get-BundleNames -Json $Json
  $hits = @($bundles | Where-Object { [string]$_ -eq $Name })
  if ($hits.Count -eq 0) { [void]$problems.Add("dsh.profile.bundles does not list $Name") }
  elseif ($hits.Count -gt 1) { [void]$problems.Add(("dsh.profile.bundles lists {0} {1} times (duplicate load)" -f $Name, $hits.Count)) }

  $keyHits = ([regex]::Matches($RawText, '"' + [regex]::Escape($Name) + '"\s*:')).Count
  if ($keyHits -ne 1) { [void]$problems.Add(("package.json contains {0} occurrences of `"{1}`": -- expected exactly 1" -f $keyHits, $Name)) }
  $anyHits = ([regex]::Matches($RawText, '"' + [regex]::Escape($Name) + '"')).Count
  if ($anyHits -ne 2) { [void]$problems.Add(("package.json contains {0} occurrences of `"{1}`" in total -- expected 2 (1 dependency + 1 bundle)" -f $anyHits, $Name)) }

  return $problems
}

function Test-ManifestRemoved {
  param([string]$Json, [string]$RawText, [string]$Name)

  $problems = New-Object System.Collections.ArrayList
  try { $obj = $Json | ConvertFrom-Json } catch {
    [void]$problems.Add('package.json does not parse: ' + $_.Exception.Message)
    return $problems
  }
  if ($obj.PSObject.Properties['dependencies'] -and $obj.dependencies.PSObject.Properties[$Name]) {
    [void]$problems.Add("dependencies.$Name is still present")
  }
  $bundles = Get-BundleNames -Json $Json
  $hits = @($bundles | Where-Object { [string]$_ -eq $Name })
  if ($hits.Count -gt 0) { [void]$problems.Add(("dsh.profile.bundles still lists {0} ({1}x)" -f $Name, $hits.Count)) }
  $anyHits = ([regex]::Matches($RawText, '"' + [regex]::Escape($Name) + '"')).Count
  if ($anyHits -ne 0) { [void]$problems.Add(("{0} still appears {1} times in package.json" -f $Name, $anyHits)) }
  return $problems
}

# ---------------------------------------------------------------- cordis.patch.yml (manual insert)

<#
  Find hand-written `- insert:` rows that mount dsh-peer-chat in the user layer.
  Returns one map per row: Start/End line indexes, Indent, BlockLine (the `- insert:` header,
  -1 when unknown), WholeBlock ($true when the insert block holds nothing else).
#>
function Find-ManualInsertEntries {
  param([string[]]$Lines)

  $hits = New-Object System.Collections.ArrayList
  $pattern = '^\s*-\s+(id|name):\s*[''"]?' + [regex]::Escape($script:PeerChatName) + '[''"]?\s*$'

  for ($i = 0; $i -lt $Lines.Length; $i++) {
    $line = $Lines[$i]
    if ($line -match '^\s*#') { continue }
    if ($line -notmatch $pattern) { continue }

    $indent = $line.Length - $line.TrimStart().Length
    $end = $i
    for ($j = $i + 1; $j -lt $Lines.Length; $j++) {
      $l = $Lines[$j]
      if ($l.Trim() -eq '') { break }
      if ($l -match '^\s*#') { break }
      $childIndent = $l.Length - $l.TrimStart().Length
      if ($childIndent -le $indent) { break }
      $end = $j
    }

    # Locate the owning `- insert:` header (it must be less indented than the row).
    $blockLine = -1
    for ($k = $i - 1; $k -ge 0; $k--) {
      $l = $Lines[$k]
      if ($l.Trim() -eq '') { continue }
      if ($l -match '^\s*#') { continue }
      $kIndent = $l.Length - $l.TrimStart().Length
      if ($kIndent -ge $indent) { continue }
      if ($l -match '^\s*-\s+insert:\s*$') { $blockLine = $k }
      break
    }

    # Does that insert block carry any other row? (Then only this row may be commented.)
    $wholeBlock = $false
    if ($blockLine -ge 0) {
      $headerIndent = $Lines[$blockLine].Length - $Lines[$blockLine].TrimStart().Length
      $rowCount = 0
      $blockEnd = $blockLine
      for ($j = $blockLine + 1; $j -lt $Lines.Length; $j++) {
        $l = $Lines[$j]
        if ($l.Trim() -eq '') { continue }
        if ($l -match '^\s*#') { continue }
        $jIndent = $l.Length - $l.TrimStart().Length
        if ($jIndent -le $headerIndent) { break }
        $blockEnd = $j
        if ($l -match '^\s*-\s+' -and ($l.Length - $l.TrimStart().Length) -eq $indent) { $rowCount++ }
      }
      if ($rowCount -le 1) { $wholeBlock = $true }
    }

    [void]$hits.Add(@{ Start = $i; End = $end; Indent = $indent; BlockLine = $blockLine; WholeBlock = $wholeBlock })
  }

  return $hits
}

function Test-PatchHasManualInsert {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return @() }
  $text = Read-TextFile $Path
  if ([string]::IsNullOrWhiteSpace($text)) { return @() }
  return @(Find-ManualInsertEntries -Lines ($text -split "`r?`n"))
}

<#
  Comment out every manual dsh-peer-chat insert row (with its `- insert:` header when the block
  holds only that row). Commenting, not deleting: the user can see and undo exactly what the
  installer changed, and the file keeps a valid YAML shape.
  Returns @{ CommentedLineNumbers = @(); Hints = @() }.
#>
function Update-PatchManualInsert {
  param([string]$Path)

  $result = @{ Commented = 0; Lines = @() }
  if (-not (Test-Path -LiteralPath $Path)) { return $result }

  $text = Read-TextFile $Path
  if ([string]::IsNullOrWhiteSpace($text)) { return $result }
  $nl = Get-TextNewLine $text
  $lines = [System.Collections.ArrayList]@($text -split "`r?`n")

  $hits = @(Find-ManualInsertEntries -Lines $lines.ToArray())
  if ($hits.Count -eq 0) { return $result }

  # Work bottom-up so earlier indexes stay valid.
  $sorted = @($hits | Sort-Object -Property Start -Descending)
  $touched = New-Object System.Collections.ArrayList
  foreach ($hit in $sorted) {
    $from = $hit.Start
    $to = $hit.End
    if ($hit.WholeBlock -and $hit.BlockLine -ge 0) { $from = $hit.BlockLine }
    for ($i = $from; $i -le $to; $i++) {
      $line = $lines[$i]
      if ($line -match '^\s*#') { continue }
      if ($line.Trim() -eq '') { continue }
      $lines[$i] = ($line -replace '^(\s*)', '$1# ')
      [void]$touched.Add($i + 1)
    }
  }

  $updated = ($lines -join $nl)
  # If the whole layer was just that hand-written insert, the file would now carry no YAML
  # content at all. Leave a valid empty entry list behind instead of an entry-list schema error.
  $activeLines = @($lines | Where-Object { $_.Trim() -ne '' -and $_ -notmatch '^\s*#' })
  if ($activeLines.Count -eq 0) {
    while ($lines.Count -gt 0 -and ([string]$lines[$lines.Count - 1]).Trim() -eq '') { $lines.RemoveAt($lines.Count - 1) }
    [void]$lines.Add('[]')
    $updated = ($lines -join $nl)
    Write-Output '[install] cordis.patch.yml had no other rows; left it as an empty entry list ([])'
  }
  # Keep the file's trailing newline if it had one.
  if ($text.EndsWith("`n") -and -not $updated.EndsWith("`n")) { $updated = $updated + $nl }
  Write-TextNoBom -Path $Path -Text $updated
  $result.Commented = $touched.Count
  $result.Lines = @($touched | Sort-Object)
  return $result
}

# ---------------------------------------------------------------- filesystem helpers

function Test-IsReparsePoint {
  param([string]$Path)
  try {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    return [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
  } catch {
    return $false
  }
}

<#
  Delete a file or a directory tree WITHOUT following links: a directory junction/symlink is
  unlinked, never its target's contents (Remove-Item -Recurse would delete through it).
#>
function Remove-TreeSafe {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  if (Test-IsReparsePoint -Path $Path) {
    [IO.Directory]::Delete($Path, $false)
    return $true
  }
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.PSIsContainer) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  } else {
    Remove-Item -LiteralPath $Path -Force
  }
  return $true
}

function Copy-PluginTree {
  param([string]$From, [string]$To)

  $skip = @('node_modules', '.git', '.pnpm', '.DS_Store', '.peerchat-tmp')
  $sourceRoot = (Resolve-Path -LiteralPath $From).ProviderPath
  $sourceLen = $sourceRoot.TrimEnd('\', '/').Length
  $copied = 0

  if (-not (Test-Path -LiteralPath $To)) { New-Item -ItemType Directory -Path $To -Force | Out-Null }

  Get-ChildItem -LiteralPath $sourceRoot -Recurse -Force | ForEach-Object {
    $relative = $_.FullName.Substring($sourceLen).TrimStart('\', '/')
    $segments = $relative -split '[\\/]'
    $skipIt = $false
    foreach ($segment in $segments) { if ($skip -contains $segment) { $skipIt = $true } }
    if ($skipIt) { return }

    $destination = Join-Path $To $relative
    if ($_.PSIsContainer) {
      if (-not (Test-Path -LiteralPath $destination)) { New-Item -ItemType Directory -Path $destination -Force | Out-Null }
      return
    }
    $parent = Split-Path -Parent $destination
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
    $copied++
  }
  return $copied
}

function New-BackupSuffix {
  return (Get-Date).ToString('yyyyMMdd-HHmmss')
}

function Backup-File {
  param([string]$Path, [string]$Tag)
  if (-not (Test-Path -LiteralPath $Path)) { return '' }
  $name = (Split-Path -Leaf $Path) + '.bak-' + $Tag + '-' + (New-BackupSuffix)
  $target = Join-Path (Split-Path -Parent $Path) $name
  Copy-Item -LiteralPath $Path -Destination $target -Force
  return $name
}

# ---------------------------------------------------------------- install state

function Get-InstallStatePath {
  param([string]$Target)
  return (Join-Path $Target $script:PeerChatStateFile)
}

function Read-InstallState {
  param([string]$Target)
  $path = Get-InstallStatePath -Target $Target
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  try {
    return (Read-TextFile $path | ConvertFrom-Json)
  } catch {
    return $null
  }
}

function Write-InstallState {
  param([string]$Target, $State)
  $path = Get-InstallStatePath -Target $Target
  Write-TextNoBom -Path $path -Text ($State | ConvertTo-Json -Depth 10)
}

function Remove-InstallState {
  param([string]$Target)
  $path = Get-InstallStatePath -Target $Target
  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
}

function New-InstallState {
  param([string]$Target, [string]$Source, [string]$Spec)
  return [pscustomobject]@{
    schema              = 1
    plugin              = $script:PeerChatName
    target              = $Target
    source              = $Source
    spec                = $Spec
    installedAt         = (Get-Date).ToString('o')
    originalPackageJson = ''
    patchBackups        = @()
    nodeModulesBackup   = ''
    pending             = $true
  }
}
