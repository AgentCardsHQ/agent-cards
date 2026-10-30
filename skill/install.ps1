# Installs the Agent Cards skill on Windows (PowerShell 5.1 or 7): downloads the package, verifies its checksum,
# installs it to %USERPROFILE%\.agents\skills\agent-cards, writes kart.cmd into %USERPROFILE%\.local\bin, adds that
# folder to your user PATH and prints the package's sha256.
#   irm https://SITE/skill/install.ps1 | iex
# Pinned: with AGENT_CARDS_SHA256 set to a release's sha256 you got somewhere other than this site (the release post),
# the package must also have exactly that hash, so the site can't hand you different code:
#   $env:AGENT_CARDS_SHA256 = "<sha256>"; irm https://SITE/skill/install.ps1 | iex
# Errors throw rather than exit, so the window this was pasted into stays open.
& {
  $ErrorActionPreference = "Stop"
  $ProgressPreference = "SilentlyContinue" # Windows PowerShell's progress bar slows downloads down a lot
  $site = if ($env:AGENT_CARDS_SITE) { $env:AGENT_CARDS_SITE } else { "https://SITE" }
  $dir = if ($env:AGENT_CARDS_DIR) { $env:AGENT_CARDS_DIR } else { Join-Path $env:USERPROFILE ".agents\skills\agent-cards" }
  $bin = if ($env:AGENT_CARDS_BIN) { $env:AGENT_CARDS_BIN } else { Join-Path $env:USERPROFILE ".local\bin" }
  $pin = "$env:AGENT_CARDS_SHA256".Trim().ToLower()
  $tar = Join-Path $env:SystemRoot "System32\tar.exe" # Windows' own tar: Git's GNU tar reads "C:\..." as a remote host

  if (-not (Get-Command node -ErrorAction SilentlyContinue) -or [int](node -p "process.versions.node.split('.')[0]") -lt 20) { throw "Node.js 20+ is required." }
  if (-not (Test-Path $tar)) { throw "Windows 10 (1803) or later is required: it brings tar.exe." }
  if ($pin -and $pin -notmatch '^[0-9a-f]{64}$') { throw "AGENT_CARDS_SHA256 must be a sha256: 64 hex characters." }

  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("agent-cards-" + [Guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $tgz = Join-Path $tmp "agent-cards.tgz"
    Invoke-WebRequest -UseBasicParsing -Uri "$site/skill/agent-cards.tgz" -OutFile $tgz
    $got = (Get-FileHash -Algorithm SHA256 -Path $tgz).Hash.ToLower()
    $listed = Join-Path $tmp "agent-cards.tgz.sha256"
    Invoke-WebRequest -UseBasicParsing -Uri "$site/skill/agent-cards.tgz.sha256" -OutFile $listed
    $want = if ((Get-Content -Raw -Path $listed) -match '^\s*([0-9a-fA-F]{64})') { $Matches[1].ToLower() } else { "" }
    if ($got -ne $want) { throw "Checksum mismatch, installation aborted." }
    # the site's .sha256 comes from the site too: a pin is a hash it didn't hand out
    if ($pin -and $got -ne $pin) { throw "The site serves a package with sha256 $got, not the pinned $pin (a newer release, or not the package you meant): installation aborted." }

    & $tar -xzf $tgz -C $tmp
    if ($LASTEXITCODE -ne 0) { throw "Could not unpack the package (tar.exe exit code $LASTEXITCODE)." }
    $pkg = Join-Path $tmp "agent-cards"
    if (-not (Test-Path (Join-Path $pkg "SKILL.md"))) { throw "Broken package." }
    # kart says "ok": true when it runs; it must run on this machine before it replaces anything. (No 2>&1 on native
    # commands: Windows PowerShell turns redirected stderr into a terminating error here.)
    $ran = (node (Join-Path $pkg "cli\kart.mjs") version) -join "`n"
    if ($ran -notmatch '"ok": ?true') { throw "kart doesn't run on this machine (kart version printed: $ran): installation aborted." }

    if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
    New-Item -ItemType Directory -Force -Path (Split-Path $dir) | Out-Null
    Copy-Item -Recurse $pkg $dir
    New-Item -ItemType Directory -Force -Path $bin | Out-Null
    # kart.cmd runs kart.mjs with node; %USERPROFILE% keeps a non-ASCII user name out of a file cmd reads in its code page
    $target = Join-Path $dir "cli\kart.mjs"
    if ($target.StartsWith($env:USERPROFILE + "\", [StringComparison]::OrdinalIgnoreCase)) { $target = "%USERPROFILE%" + $target.Substring($env:USERPROFILE.Length) }
    [IO.File]::WriteAllText((Join-Path $bin "kart.cmd"), "@node `"$target`" %*`r`n")

    # the folder on the user PATH, kept as REG_EXPAND_SZ so entries like %USERPROFILE%\... still expand, and in this window
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
    $entries = @(([string]$key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)) -split ";" | Where-Object { $_ })
    if (-not ($entries | Where-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd("\") -ieq $bin.TrimEnd("\") })) {
      $key.SetValue("Path", (($entries + $bin) -join ";"), [Microsoft.Win32.RegistryValueKind]::ExpandString)
      # setting a user variable through .NET tells Windows the environment changed, so new terminals see the new PATH
      [Environment]::SetEnvironmentVariable("AGENT_CARDS_INSTALL", "1", "User")
      [Environment]::SetEnvironmentVariable("AGENT_CARDS_INSTALL", $null, "User")
      Write-Host "Added $bin to your user PATH; terminals that were already open need a restart to see it."
    }
    $key.Close()
    if (-not (($env:Path -split ";") | Where-Object { $_.TrimEnd("\") -ieq $bin.TrimEnd("\") })) { $env:Path = "$env:Path;$bin" }

    $out = (& (Join-Path $bin "kart.cmd") version) -join "`n"
    Write-Host $out
    if ($out -notmatch '"ok": ?true') { throw "kart is in $dir, but $bin\kart.cmd doesn't run it (kart version printed no `"ok`": true): installation incomplete." }
    Write-Host "Installed to $dir (read SKILL.md). Package sha256: $got$(if ($pin) { ' (as pinned)' })"
    Write-Host "Next: kart preview"
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}
