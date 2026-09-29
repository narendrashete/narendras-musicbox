# Narendra's Musicbox - one-time install on the Windows server. Later updates deploy themselves (update.ps1).
# Run in an ADMIN PowerShell over RDP, from the extracted package:  C:\Musicbox\app\deploy\windows-server\setup.ps1
#
#   .\setup.ps1 -Check                 read-only: shows what is installed / missing, changes nothing
#   .\setup.ps1 -Email you@example.com full install (safe to re-run)
#   .\setup.ps1 -ResetAdmin            also print a new one-time password for the admin user
#
# Layout:  C:\Musicbox\app (code + .env)  \data (SQLite DB)  \rclone.exe + rclone.conf (own OneDrive login)
#          \cache (rclone VFS cache, max 3 GB)  \logs  \www (IIS site: web.config only)
# Tasks:   Musicbox-Mount (OneDrive -> M:), Musicbox-App (node on 127.0.0.1:4300) - SYSTEM at startup;
#          Musicbox-Update - every 5 min, deploys the newest main commit that passed CI (see update.ps1).
# Secrets (JWT secret, OneDrive token, admin password) are generated / entered here on the server only.
# Developed by Prime Computers.

param(
    [switch]$Check,
    [switch]$ResetAdmin,
    [string]$Email,
    [string]$HostName = 'musicbox.narendrashete.com',
    [string]$Repo = 'narendrashete/narendras-musicbox',
    [string]$AdminUser = 'narendra'
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Root      = 'C:\Musicbox'
$App       = "$Root\app"
$Here      = $PSScriptRoot
$NodeDir   = 'C:\Program Files\nodejs'
$Rclone    = "$Root\rclone.exe"
$Conf      = "$Root\rclone.conf"
$Remote    = 'musicbox:Narendras musicbox'
$SiteName  = $HostName
$Drive     = 'M:'
$PublicIp  = try { (Invoke-RestMethod 'https://api.ipify.org' -TimeoutSec 10).Trim() } catch { '' }

function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "   ok  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "   !!  $m" -ForegroundColor Yellow }
function Info($m) { Write-Host "       $m" }

function Test-Admin { ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrators') }
function Get-NodeMajor { if (Test-Path "$NodeDir\node.exe") { [int]((& "$NodeDir\node.exe" -v).TrimStart('v').Split('.')[0]) } else { 0 } }
function Test-WinFsp { Test-Path "${env:ProgramFiles(x86)}\WinFsp\bin\winfsp-x64.dll" }
function Test-Module($n) { Import-Module WebAdministration; [bool](Get-WebGlobalModule | Where-Object Name -eq $n) }
function Find-Wacs {
    foreach ($t in Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object TaskName -like 'win-acme*') {
        $exe = $t.Actions[0].Execute.Trim('"'); if (Test-Path $exe) { return $exe }
    }
    foreach ($p in "$env:ProgramFiles\win-acme\wacs.exe", 'C:\win-acme\wacs.exe', 'C:\Tools\win-acme\wacs.exe') { if (Test-Path $p) { return $p } }
    return $null
}
function Get-DnsIp { try { @(Resolve-DnsName $HostName -Type A -DnsOnly -ErrorAction Stop | Where-Object { $_.Section -eq 'Answer' -and $_.IPAddress } | ForEach-Object IPAddress) } catch { @() } }
function Get-GitHubAsset($repo, $pattern) {
    $rel = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers @{ 'User-Agent' = 'musicbox-setup' }
    ($rel.assets | Where-Object name -match $pattern | Select-Object -First 1).browser_download_url
}
function Install-Msi($url, $name) {
    New-Item -ItemType Directory -Force "$Root\installers" | Out-Null
    $f = "$Root\installers\$name"
    Info "downloading $url"
    Invoke-WebRequest $url -OutFile $f -UseBasicParsing
    $p = Start-Process msiexec.exe -ArgumentList "/i `"$f`" /qn /norestart" -Wait -PassThru
    if ($p.ExitCode -notin 0, 3010) { throw "$name install failed (msiexec exit $($p.ExitCode))" }
    Ok "$name installed"
}
function Stop-Ours {
    foreach ($t in 'Musicbox-App', 'Musicbox-Mount') { if (Get-ScheduledTask $t -ErrorAction SilentlyContinue) { Stop-ScheduledTask $t } }
    # Only our own processes: node running this app, and the rclone copy in C:\Musicbox.
    # The backup job's rclone lives in C:\PrimeBackups and is left alone.
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -like '*server\index.js*' |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Get-Process rclone -ErrorAction SilentlyContinue | Where-Object Path -eq $Rclone | Stop-Process -Force
    Start-Sleep -Seconds 3
}

if (-not (Test-Admin)) { throw 'Run this in PowerShell opened with "Run as administrator".' }

# ---------------------------------------------------------------- check (read-only)
if ($Check) {
    Step 'Server'
    $os = Get-CimInstance Win32_OperatingSystem
    Info "$($os.Caption)  build $($os.BuildNumber)"
    Info ("C: free {0:N1} GB" -f ((Get-PSDrive C).Free / 1GB))
    Info "Drive $Drive in use: $(Test-Path "$Drive\")"
    Info "Plesk installed: $((Test-Path "${env:ProgramFiles(x86)}\Plesk") -or (Test-Path "$env:ProgramFiles\Plesk") -or [bool]$env:plesk_dir)"
    Step 'Software'
    Info "Node.js major version: $(Get-NodeMajor)  (need 20+)"
    Info "WinFsp: $(Test-WinFsp)"
    Info "IIS URL Rewrite: $(Test-Module 'RewriteModule')"
    Info "IIS ARR: $(Test-Module 'ApplicationRequestRouting')"
    if (Test-Module 'ApplicationRequestRouting') { Info "ARR proxy enabled: $((Get-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter system.webServer/proxy -Name enabled).Value)" }
    Info "win-acme: $(Find-Wacs)"
    Info "Certify The Web: $(Test-Path "$env:ProgramFiles\CertifyTheWeb")"
    Info "rclone for backups: $(Test-Path 'C:\PrimeBackups\rclone.exe')   musicbox rclone: $(Test-Path $Rclone)"
    Step 'IIS'
    Import-Module WebAdministration
    foreach ($s in Get-Website) { Info ("{0,-45} {1,-8} {2}" -f $s.Name, $s.State, (($s.Bindings.Collection | ForEach-Object { "$($_.protocol)/$($_.bindingInformation)" }) -join '  ')) }
    Step 'DNS'
    Info "$HostName -> $((Get-DnsIp) -join ', ')  (this server's public IP: $PublicIp)"
    Step 'Musicbox'
    Info "package at $App : $(Test-Path "$App\server\index.js")"
    Info "live DB: $(Test-Path "$Root\data\musicbox.db")   .env: $(Test-Path "$App\.env")"
    foreach ($t in 'Musicbox-Mount', 'Musicbox-App', 'Musicbox-Update') { $st = Get-ScheduledTask $t -ErrorAction SilentlyContinue; Info "task ${t}: $(if ($st) { $st.State } else { 'not created' })" }
    Write-Host "`nNothing was changed. Paste this output back to Claude." -ForegroundColor Cyan
    return
}

if (-not (Test-Path "$App\server\index.js")) { throw "Extract the package so that $App\server\index.js exists, then run this again." }
foreach ($d in 'data', 'cache', 'logs', 'www', 'installers') { New-Item -ItemType Directory -Force "$Root\$d" | Out-Null }

# ---------------------------------------------------------------- 1. prerequisites
Step 'Prerequisites'
if ((Get-NodeMajor) -lt 20) {
    $v = ((Invoke-RestMethod 'https://nodejs.org/dist/index.json') | Where-Object { $_.version -like 'v22.*' -and $_.lts } | Select-Object -First 1).version
    Install-Msi "https://nodejs.org/dist/$v/node-$v-x64.msi" "node-$v-x64.msi"
} else { Ok "Node.js $(& "$NodeDir\node.exe" -v)" }
$env:Path = "$NodeDir;$env:Path"

if (-not (Test-WinFsp)) { Install-Msi (Get-GitHubAsset 'winfsp/winfsp' '\.msi$') 'winfsp.msi' } else { Ok 'WinFsp' }

if (-not (Test-Module 'RewriteModule')) {
    Install-Msi 'https://download.microsoft.com/download/1/2/8/128E2E22-C1B9-44A4-BE2A-5859ED1D4592/rewrite_amd64_en-US.msi' 'rewrite_amd64.msi'
} else { Ok 'IIS URL Rewrite' }
if (-not (Test-Module 'ApplicationRequestRouting')) {
    Install-Msi 'https://download.microsoft.com/download/E/9/8/E9849D6A-020E-47E4-9FD0-A023E99B54EB/requestRouter_amd64.msi' 'requestRouter_amd64.msi'
} else { Ok 'IIS ARR' }

if (-not (Test-Path $Rclone)) {
    if (Test-Path 'C:\PrimeBackups\rclone.exe') { Copy-Item 'C:\PrimeBackups\rclone.exe' $Rclone }
    else {
        Invoke-WebRequest 'https://downloads.rclone.org/rclone-current-windows-amd64.zip' -OutFile "$Root\installers\rclone.zip" -UseBasicParsing
        Expand-Archive "$Root\installers\rclone.zip" "$Root\installers\rclone" -Force
        Copy-Item (Get-ChildItem "$Root\installers\rclone" -Recurse -Filter rclone.exe | Select-Object -First 1).FullName $Rclone
    }
}
Ok "rclone $((& $Rclone version | Select-Object -First 1))"

# ---------------------------------------------------------------- 2. OneDrive login (own token, not the backup job's)
Step 'OneDrive'
$remotes = if (Test-Path $Conf) { & $Rclone listremotes --config $Conf } else { @() }
if ($remotes -notcontains 'musicbox:') {
    Warn 'A browser will open: sign in with the Microsoft account that owns the OneDrive, then come back here.'
    & $Rclone config create musicbox onedrive config_type=onedrive config_drive_ok=true --config $Conf | Out-Null
    if ((& $Rclone listremotes --config $Conf) -notcontains 'musicbox:') { throw 'OneDrive sign-in did not complete - run this script again.' }
}
Ok 'OneDrive remote "musicbox" configured'

# ---------------------------------------------------------------- 3. app
Step 'App'
Push-Location $App
try { & "$NodeDir\npm.cmd" ci --omit=dev --no-audit --no-fund; if ($LASTEXITCODE) { throw 'npm ci failed' } } finally { Pop-Location }
Ok 'dependencies installed'

$firstInstall = -not (Test-Path "$Root\data\musicbox.db")
if ($firstInstall -and (Test-Path "$App\initial-data\musicbox.db")) {
    Copy-Item "$App\initial-data\musicbox.db" "$Root\data\musicbox.db"
    Ok 'song index copied from the package (no need to re-read 2 GB from OneDrive)'
}
Remove-Item "$App\initial-data" -Recurse -Force -ErrorAction SilentlyContinue   # never overwrite the live DB on updates

if (-not (Test-Path "$App\.env")) {
    $bytes = New-Object byte[] 48; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    @(
        'PORT=4300', 'HOST=127.0.0.1', "LIBRARY_DIR=$Drive\", "DB_PATH=$Root\data\musicbox.db",
        "JWT_SECRET=$(-join ($bytes | ForEach-Object { $_.ToString('x2') }))"
    ) | Set-Content "$App\.env" -Encoding ascii
    Ok '.env created (random JWT secret)'
}

# Only SYSTEM + Administrators can read the folder (it holds the OneDrive token and the JWT secret);
# IIS only needs to read the tiny www folder.
& icacls $Root /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' /T /C /Q | Out-Null
& icacls "$Root\www" /grant 'IIS_IUSRS:(OI)(CI)RX' 'IUSR:(OI)(CI)RX' /T /C /Q | Out-Null
Ok 'folder permissions locked down'

# ---------------------------------------------------------------- 4. check the library is fully in OneDrive
Step 'Library check'
$size = & $Rclone size $Remote --json --config $Conf | ConvertFrom-Json
$dbCount = [int](& "$NodeDir\node.exe" --no-warnings -e "const {DatabaseSync}=require('node:sqlite');console.log(new DatabaseSync('$($Root -replace '\\','/')/data/musicbox.db').prepare('select count(*) n from songs').get().n)")
Info ("OneDrive has {0} files ({1:N1} GB); the song index has {2}" -f $size.count, ($size.bytes / 1GB), $dbCount)
if ($size.count -lt $dbCount) {
    throw "OneDrive still has fewer songs than the index - the PC's OneDrive app hasn't finished uploading 'Narendras musicbox'. Wait for it to finish, then run this again."
}
Ok 'all songs are in OneDrive'

# ---------------------------------------------------------------- 5. background tasks
Step 'Background tasks'
if (Test-Path "$Drive\" ) { if (-not (Get-Process rclone -ErrorAction SilentlyContinue | Where-Object Path -eq $Rclone)) { throw "Drive $Drive is already used by something else." } }
Stop-Ours
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
# Working directory is C:\Musicbox (not app\) so an update can replace app\ while the mount keeps running.
function New-PsAction($file) { New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $Root -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$App\deploy\windows-server\$file`"" }
foreach ($t in @(@{ n = 'Musicbox-Mount'; f = 'run-mount.ps1' }, @{ n = 'Musicbox-App'; f = 'run-app.ps1' })) {
    Register-ScheduledTask -TaskName $t.n -Action (New-PsAction $t.f) -Trigger (New-ScheduledTaskTrigger -AtStartup) -Principal $principal -Settings $settings -Force | Out-Null
}
$every5 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 5)
$updSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName 'Musicbox-Update' -Action (New-PsAction "update.ps1 -Repo $Repo") -Trigger $every5 -Principal $principal -Settings $updSettings -Force | Out-Null
if ((Test-Path "$App\REVISION") -and -not (Test-Path "$Root\deployed.txt")) { Copy-Item "$App\REVISION" "$Root\deployed.txt" }
Ok 'auto-update task registered (checks GitHub every 5 minutes)'
Start-ScheduledTask 'Musicbox-Mount'
for ($i = 0; $i -lt 40 -and -not (Test-Path "$Drive\"); $i++) { Start-Sleep -Seconds 2 }
if (-not (Test-Path "$Drive\")) { throw "OneDrive mount did not come up - see $Root\logs\mount.log" }
Ok "OneDrive mounted as $Drive ($((Get-ChildItem "$Drive\" -Directory).Count) artist folders)"
Start-ScheduledTask 'Musicbox-App'
$up = $false
for ($i = 0; $i -lt 30 -and -not $up; $i++) {
    Start-Sleep -Seconds 2
    try { Invoke-WebRequest 'http://127.0.0.1:4300/api/me' -UseBasicParsing -TimeoutSec 5 | Out-Null } catch { $up = $_.Exception.Response.StatusCode.value__ -eq 401 }
}
if (-not $up) { throw "App did not start - see $Root\logs\app-error.log" }
Ok 'app running on 127.0.0.1:4300'

if ($firstInstall -or $ResetAdmin) {
    Push-Location $App
    Write-Host ''
    & "$NodeDir\node.exe" scripts\create-user.js $AdminUser --admin
    Write-Host '   ^ note this one-time password down - you will set your own at first sign-in.' -ForegroundColor Yellow
    Pop-Location
}

# ---------------------------------------------------------------- 6. IIS site
Step 'IIS'
Import-Module WebAdministration
Copy-Item "$Here\web.config" "$Root\www\web.config" -Force
Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter system.webServer/proxy -Name enabled -Value $true
# ARR's timeout is server-wide (other proxied sites share it): only ever raise it, for slow phone uploads.
$oldTimeout = [TimeSpan](Get-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter system.webServer/proxy -Name timeout).Value
if ($oldTimeout -lt [TimeSpan]'00:10:00') {
    Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter system.webServer/proxy -Name timeout -Value '00:10:00'
    Info "ARR proxy timeout raised from $oldTimeout to 00:10:00"
}
if (-not (Test-Path "IIS:\AppPools\Musicbox")) {
    New-WebAppPool Musicbox | Out-Null
    Set-ItemProperty IIS:\AppPools\Musicbox -Name managedRuntimeVersion -Value ''
}
if (-not (Get-Website -Name $SiteName)) {
    # Bind to the server's own IP like the other sites on this box (falls back to all addresses).
    $bindIp = if ((Get-NetIPAddress -AddressFamily IPv4).IPAddress -contains $PublicIp) { $PublicIp } else { '*' }
    New-Website -Name $SiteName -PhysicalPath "$Root\www" -HostHeader $HostName -IPAddress $bindIp -Port 80 -ApplicationPool Musicbox | Out-Null
    Ok "site $SiteName created on ${bindIp}:80"
} else { Ok "site $SiteName exists" }
$allowed = Get-WebConfiguration -PSPath 'MACHINE/WEBROOT/APPHOST' -Location $SiteName -Filter system.webServer/rewrite/allowedServerVariables/add
if (-not ($allowed | Where-Object name -eq 'HTTP_X_FORWARDED_PROTO')) {
    Add-WebConfiguration -PSPath 'MACHINE/WEBROOT/APPHOST' -Location $SiteName -Filter system.webServer/rewrite/allowedServerVariables -Value @{ name = 'HTTP_X_FORWARDED_PROTO' }
}
Ok 'reverse proxy configured'

# ---------------------------------------------------------------- 7. HTTPS certificate (Let's Encrypt via win-acme)
Step 'HTTPS'
$site = Get-Website -Name $SiteName
if ($site.Bindings.Collection | Where-Object protocol -eq 'https') {
    Ok 'HTTPS binding already present (win-acme renews it automatically)'
} elseif ((Get-DnsIp) -notcontains $PublicIp) {
    Warn "DNS for $HostName doesn't point to this server ($PublicIp) yet. Add the A record at GoDaddy, wait a few minutes, then run this script again."
    return
} else {
    $wacs = Find-Wacs
    if (-not $wacs) {
        if (-not $Email) { throw 'win-acme is not installed yet: run again with -Email <your email> (Let''s Encrypt expiry notices go there).' }
        $zip = "$Root\installers\win-acme.zip"
        Invoke-WebRequest (Get-GitHubAsset 'win-acme/win-acme' 'x64\.pluggable\.zip$') -OutFile $zip -UseBasicParsing
        Expand-Archive $zip "$env:ProgramFiles\win-acme" -Force
        $wacs = "$env:ProgramFiles\win-acme\wacs.exe"
    }
    $wacsArgs = @('--target', 'iis', '--siteid', $site.Id, '--host', $HostName, '--installation', 'iis', '--accepttos', '--usedefaulttaskuser', '--closeonfinish')
    if ($Email) { $wacsArgs += @('--emailaddress', $Email) }
    & $wacs @wacsArgs
    if (-not ((Get-Website -Name $SiteName).Bindings.Collection | Where-Object protocol -eq 'https')) { throw 'Certificate was not installed - see the win-acme output above.' }
    Ok 'Let''s Encrypt certificate installed'
}

Step 'Done'
try { Invoke-WebRequest "https://$HostName/api/me" -UseBasicParsing -TimeoutSec 15 | Out-Null } catch { $code = $_.Exception.Response.StatusCode.value__ }
if ($code -eq 401) { Ok "https://$HostName is live" } else { Warn "https://$HostName answered '$code' - check $Root\logs" }
Info 'On the phone: open the address, sign in, then Android: menu > Install app / iPhone: Share > Add to Home Screen.'

