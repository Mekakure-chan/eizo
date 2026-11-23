[CmdletBinding()]
param(
    [ValidatePattern('^[a-p]{32}$')][string]$ExtensionId,
    [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$extension = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\extension')).Path
if (-not $ExtensionId) {
    # Chromium hashes the UTF-16LE unpacked directory, with an uppercase drive letter.
    if ($extension -match '^[a-z]:') { $extension = $extension.Substring(0,1).ToUpperInvariant() + $extension.Substring(1) }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $idBytes = $sha.ComputeHash([Text.Encoding]::Unicode.GetBytes($extension)) } finally { $sha.Dispose() }
    $alphabet = 'abcdefghijklmnop'
    $ExtensionId = -join $(foreach ($byte in $idBytes[0..15]) { $alphabet[$byte -shr 4]; $alphabet[$byte -band 15] })
}
$nativeName = 'jp.embedded_video_saver.full.' + $ExtensionId
$root = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'EmbeddedVideoSaver'
$hosts = Join-Path $root 'hosts'
$manifestPath = Join-Path $hosts ($ExtensionId + '.json')
$keyName = 'Software\Google\Chrome\NativeMessagingHosts\' + $nativeName
$registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey('CurrentUser', 'Registry32')
$utf8 = New-Object Text.UTF8Encoding($false)

# Only remove task-owned flat directories under the explicitly selected parent.
function Remove-InstallFolder([string]$Path, [string]$Parent) {
    if (-not [IO.Directory]::Exists($Path)) { return }
    $actual = (Resolve-Path -LiteralPath $Path).Path
    $base = (Resolve-Path -LiteralPath $Parent).Path
    if ([IO.Path]::GetDirectoryName($actual) -ne $base -or
        ([IO.File]::GetAttributes($actual) -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unexpected tool directory.' }
    $items = @(Get-ChildItem -LiteralPath $actual -Force)
    $ownedFiles = @('ffmpeg.zip','ffmpeg.exe','ffprobe.exe','yt-dlp.exe','VideoHost.exe','host.sha256')
    if ($items | Where-Object { $_.PSIsContainer -or ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $_.Name -notin $ownedFiles }) { throw 'Unexpected tool directory contents.' }
    foreach ($item in $items) { Remove-Item -LiteralPath $item.FullName -Force }
    [IO.Directory]::Delete($actual)
}

function Get-RegisteredManifest {
    $key = $registry.OpenSubKey($keyName)
    if ($null -eq $key) { return $null }
    try { return $key.GetValue('') } finally { $key.Dispose() }
}

$registered = Get-RegisteredManifest
if ($registered -and $registered -ne $manifestPath) { throw 'Another native host already uses this registration.' }
$runtimes = Join-Path $root 'tools'
if ($Remove) {
    if ($registered) { $registry.DeleteSubKey($keyName, $false) }
    if ([IO.File]::Exists($manifestPath)) { Remove-Item -LiteralPath $manifestPath }
    if ([IO.Directory]::Exists($hosts) -and @(Get-ChildItem -LiteralPath $hosts -Filter '*.json').Count -eq 0 -and [IO.Directory]::Exists($runtimes)) {
        foreach ($package in Get-ChildItem -LiteralPath $runtimes -Directory) {
            if ($package.Name -match '^release-[a-f0-9]{16}-[a-f0-9]{32}$' -and [IO.File]::Exists((Join-Path $package.FullName 'host.sha256'))) {
                Remove-InstallFolder $package.FullName $runtimes
            }
        }
    }
    Write-Host "Removed the Chrome host registration for $ExtensionId."
    return
}

$ytHash = 'f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d'
$ffZipHash = 'b9bbbb3acece000cbeec994f856649354e52c773807841e78908374b24d658fd'
$toolsHashes = @{
    'yt-dlp.exe' = $ytHash
    'ffmpeg.exe' = 'ed8f66cb877087a96f5bbb40a2944f0e764f2ad8870d5cb647360d912e62bc07'
    'ffprobe.exe' = 'df0199f606faa88e9ad192732a7c3987acfb647663534c297772e17730611a08'
}
$sources = @((Join-Path $PSScriptRoot 'VideoHost.cs'), (Join-Path $PSScriptRoot 'ChildProcessJob.cs'))
$hashInput = (@($sources | ForEach-Object { (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash }) + $ytHash + $ffZipHash) -join ''
$sha = [Security.Cryptography.SHA256]::Create()
try { $buildHash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::ASCII.GetBytes($hashInput))).Replace('-','').ToLowerInvariant().Substring(0,16) }
finally { $sha.Dispose() }

function Valid-File([string]$Path, [string]$Hash) {
    return [IO.File]::Exists($Path) -and (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -eq $Hash
}
function Valid-Runtime([string]$Dir) {
    $stamp = Join-Path $Dir 'host.sha256'
    if (-not [IO.File]::Exists($stamp) -or -not (Valid-File (Join-Path $Dir 'VideoHost.exe') ([IO.File]::ReadAllText($stamp).Trim()))) { return $false }
    foreach ($name in $toolsHashes.Keys) { if (-not (Valid-File (Join-Path $Dir $name) $toolsHashes[$name])) { return $false } }
    return $true
}
function Download-File([string]$Url, [string]$To, [string]$Hash) {
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $To -TimeoutSec 300
    if (-not (Valid-File $To $Hash)) { throw "Published SHA-256 does not match: $([IO.Path]::GetFileName($To))" }
}

foreach ($dir in @($root, $hosts, $runtimes)) { [IO.Directory]::CreateDirectory($dir) | Out-Null }
$runtime = Get-ChildItem -LiteralPath $runtimes -Directory -Filter "release-$buildHash-*" |
    Where-Object { Valid-Runtime $_.FullName } | Select-Object -First 1 -ExpandProperty FullName
if (-not $runtime) {
    $nonce = [Guid]::NewGuid().ToString('N')
    $stage = Join-Path $runtimes ('stage-' + $nonce)
    [IO.Directory]::CreateDirectory($stage) | Out-Null
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $cached = Get-ChildItem -LiteralPath $runtimes -Directory -Filter 'release-*' |
            Where-Object { Valid-Runtime $_.FullName } | Select-Object -First 1 -ExpandProperty FullName
        if ($cached) {
            Write-Host 'Reusing verified yt-dlp and FFmpeg files.'
            foreach ($name in $toolsHashes.Keys) {
                $from = Join-Path $cached $name
                $to = Join-Path $stage $name
                try { New-Item -ItemType HardLink -Path $to -Target $from -ErrorAction Stop | Out-Null }
                catch { [IO.File]::Copy($from,$to) }
            }
        } else {
            Write-Host 'Downloading yt-dlp and FFmpeg for Windows (about 143 MB)...'
            Download-File 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp.exe' (Join-Path $stage 'yt-dlp.exe') $ytHash
            $archive = Join-Path $stage 'ffmpeg.zip'
            Download-File 'https://github.com/GyanD/codexffmpeg/releases/download/9.1/ffmpeg-9.1-essentials_build.zip' $archive $ffZipHash
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            $zip = [IO.Compression.ZipFile]::OpenRead($archive)
            try {
                foreach ($name in @('ffmpeg.exe','ffprobe.exe')) {
                    $entry = @($zip.Entries | Where-Object FullName -like "*/bin/$name")
                    if ($entry.Count -ne 1) { throw 'Unexpected FFmpeg archive.' }
                    $dest = Join-Path $stage $name
                    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry[0],$dest,$false)
                    if (-not (Valid-File $dest $toolsHashes[$name])) { throw "Unexpected checksum for $name" }
                }
            } finally { $zip.Dispose() }
            Remove-Item -LiteralPath $archive
        }
        $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
        $exe = Join-Path $stage 'VideoHost.exe'
        & $csc /nologo /target:exe /platform:anycpu /optimize+ /codepage:65001 /r:System.Web.Extensions.dll "/out:$exe" @sources
        if ($LASTEXITCODE -ne 0 -or -not [IO.File]::Exists($exe)) { throw 'Cannot build the Windows native messaging host.' }
        [IO.File]::WriteAllText((Join-Path $stage 'host.sha256'), (Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash, $utf8)
        $runtime = Join-Path $runtimes ("release-$buildHash-$nonce")
        if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($runtime)) -ne (Resolve-Path -LiteralPath $runtimes).Path -or
            [IO.Path]::GetDirectoryName((Resolve-Path -LiteralPath $stage).Path) -ne (Resolve-Path -LiteralPath $runtimes).Path) { throw 'Unexpected install path.' }
        [IO.Directory]::Move($stage, $runtime)
    } finally { Remove-InstallFolder $stage $runtimes }
}
$config = [ordered]@{
    name = $nativeName
    description = 'Embedded Video Saver full-length downloads'
    path = (Join-Path $runtime 'VideoHost.exe')
    type = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
$tmpManifest = Join-Path $hosts ([Guid]::NewGuid().ToString('N') + '.tmp')
try {
    [IO.File]::WriteAllText($tmpManifest, ($config | ConvertTo-Json), $utf8)
    if ([IO.File]::Exists($manifestPath)) { [IO.File]::Replace($tmpManifest, $manifestPath, [NullString]::Value) }
    else { [IO.File]::Move($tmpManifest, $manifestPath) }
    $key = $registry.CreateSubKey($keyName)
    try { $key.SetValue('', $manifestPath, [Microsoft.Win32.RegistryValueKind]::String) } finally { $key.Dispose() }
} finally { if ([IO.File]::Exists($tmpManifest)) { Remove-Item -LiteralPath $tmpManifest } }
Write-Host "Ready for extension $ExtensionId"
Write-Host "Chrome extension folder: $extension"
