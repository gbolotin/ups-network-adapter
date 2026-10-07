# Run on the Windows computer where Hermes runs. Requires Windows OpenSSH Client.
[CmdletBinding()]
param(
    [string] $PiAddress,
    [string] $PiUser = 'upsadmin',
    [string] $SourceRef = 'feature/mcp-server'
)

$ErrorActionPreference = 'Stop'
$projectFiles = @(
    'install.sh', 'setup.sh', 'setup_pi.py', 'ups_mib.py', 'ups_autodetect.py', 'ups_mcp.py',
    'config/ups.conf', 'config/ups-autodetect.service', 'config/ups-snmp.service',
    'test_ups_mib.py', 'test_ups_autodetect.py', 'test_setup_pi.py', 'test_ups_mcp.py', 'README.md'
)
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Find-OpenSshTool([string] $Name) {
    $command = Get-Command "$Name.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    $path = Join-Path $env:SystemRoot "System32\OpenSSH\$Name.exe"
    if (Test-Path -LiteralPath $path -PathType Leaf) { return $path }
    throw "Install Windows Optional Features > OpenSSH Client, reopen PowerShell, and try again. Missing: $Name.exe"
}

function Confirm-PiAddress([string] $Address, [string] $User) {
    $parsed = $null
    if ($Address -notmatch '^\d{1,3}(\.\d{1,3}){3}$' -or
        -not [System.Net.IPAddress]::TryParse($Address, [ref] $parsed) -or
        $parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
        throw 'Enter a complete IPv4 address, for example 192.168.50.200.'
    }
    if ($User -notmatch '^[a-z_][a-z0-9_-]{0,31}$') { throw 'Enter a valid Linux username.' }
    return $parsed.ToString()
}

# ProcessStartInfo.Arguments uses Windows native quoting, including empty arguments.
# This is needed for ssh-keygen -N "" under Windows PowerShell 5.1.
function ConvertTo-NativeArgument([string] $Value) {
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}

function ConvertTo-PowerShellArgument([string] $Value) {
    return "'" + $Value.Replace("'", "''") + "'"
}

function New-ProjectArchive([string] $Destination, [string] $LocalRoot, [string] $Ref) {
    Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
    $source = $null
    $download = Join-Path ([System.IO.Path]::GetTempPath()) ("ups-source-" + [guid]::NewGuid().ToString('N') + '.zip')
    $archive = $null
    try {
        $useLocal = $true
        foreach ($name in $projectFiles) {
            if (-not (Test-Path -LiteralPath (Join-Path $LocalRoot $name) -PathType Leaf)) { $useLocal = $false; break }
        }
        if (-not $useLocal) {
            Write-Host "Downloading project files from GitHub ($Ref)..."
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            $url = 'https://api.github.com/repos/gbolotin/ups-network-adapter/zipball/' + [Uri]::EscapeDataString($Ref)
            Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $download
            $source = [System.IO.Compression.ZipFile]::OpenRead($download)
        }
        $archive = [System.IO.Compression.ZipFile]::Open($Destination, [System.IO.Compression.ZipArchiveMode]::Create)
        foreach ($name in $projectFiles) {
            if ($useLocal) {
                $contents = [System.IO.File]::ReadAllText((Join-Path $LocalRoot $name))
            } else {
                $matches = @($source.Entries | Where-Object { $_.FullName -match ('^[^/]+/' + [regex]::Escape($name) + '$') })
                if ($matches.Count -ne 1) { throw "GitHub archive is missing a unique $name entry." }
                $reader = New-Object System.IO.StreamReader($matches[0].Open())
                try { $contents = $reader.ReadToEnd() } finally { $reader.Dispose() }
            }
            # Bash scripts must have LF newlines, regardless of the Windows checkout settings.
            $contents = $contents.Replace("`r`n", "`n").Replace("`r", "`n")
            $entry = $archive.CreateEntry($name)
            $writer = New-Object System.IO.StreamWriter($entry.Open(), $utf8)
            try { $writer.Write($contents) } finally { $writer.Dispose() }
        }
    } finally {
        if ($archive) { $archive.Dispose() }
        if ($source) { $source.Dispose() }
        if (Test-Path -LiteralPath $download) { Remove-Item -LiteralPath $download }
    }
}

function Invoke-RemoteScript([string] $Ssh, [string[]] $Options, [string] $Target, [string] $Body, [switch] $Terminal) {
    $encoded = [Convert]::ToBase64String($utf8.GetBytes($Body.Replace("`r`n", "`n")))
    # The command contains only base64 of our own script, never a password.
    $remoteCommand = 'bash -c "$(printf %s ' + $encoded + ' | base64 -d)"'
    $terminalOption = '-T'
    if ($Terminal) { $terminalOption = '-tt' }
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $Ssh
    $info.UseShellExecute = $false
    $arguments = @($terminalOption) + $Options + @($Target, $remoteCommand)
    $info.Arguments = ($arguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' '
    $process = [System.Diagnostics.Process]::Start($info)
    try {
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) { throw "Pi command failed (SSH exit $($process.ExitCode))." }
    } finally { $process.Dispose() }
}

function New-McpKey([string] $Keygen, [string] $KeyPath) {
    $directory = Split-Path -Parent $KeyPath
    if (-not (Test-Path -LiteralPath $directory)) { [void] [System.IO.Directory]::CreateDirectory($directory) }
    if (-not (Test-Path -LiteralPath $KeyPath -PathType Leaf)) {
        Write-Host "Creating a dedicated MCP SSH key at $KeyPath..."
        $info = New-Object System.Diagnostics.ProcessStartInfo
        $info.FileName = $Keygen
        $info.UseShellExecute = $false
        $info.CreateNoWindow = $true
        $arguments = @('-t', 'ed25519', '-f', $KeyPath, '-N', '', '-C', 'ups-adapter-mcp')
        $info.Arguments = ($arguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' '
        $process = [System.Diagnostics.Process]::Start($info)
        try { $process.WaitForExit(); if ($process.ExitCode -ne 0) { throw 'SSH key generation failed.' } }
        finally { $process.Dispose() }
    } else {
        Write-Host 'Reusing the existing MCP private key.'
    }
    # Derive the public key from the private key so a stale .pub file cannot authorize another key.
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $Keygen
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.Arguments = (@('-y', '-P', '', '-f', $KeyPath) | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' '
    $process = [System.Diagnostics.Process]::Start($info)
    try {
        $public = $process.StandardOutput.ReadToEnd()
        [void] $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        if ($process.ExitCode -ne 0 -or $public -notmatch '^ssh-ed25519 [A-Za-z0-9+/]+={0,3}( |$)') {
            throw 'The existing MCP key must be an Ed25519 key without a passphrase. It was not replaced.'
        }
        $public = $public.Trim()
    } finally { $process.Dispose() }
    $public = ($public -split ' ')[0..1] -join ' '
    [System.IO.File]::WriteAllText("$KeyPath.pub", "$public ups-adapter-mcp`n", $utf8)
    return "$public ups-adapter-mcp"
}

function Get-KeyAuthorizationScript([string] $PublicKey) {
    $entry = 'restrict,command="/usr/bin/python3 -u /usr/local/lib/ups-network-adapter/ups_mcp.py" ' + $PublicKey
    $encoded = [Convert]::ToBase64String($utf8.GetBytes($entry))
    return @'
set -euo pipefail
/usr/bin/python3 - <<'PY'
import base64, os, pathlib, tempfile, time
entry = base64.b64decode('__ENTRY__').decode('utf-8')
key = entry.split()[-2]
directory = pathlib.Path.home() / '.ssh'
path = directory / 'authorized_keys'
if directory.is_symlink() or path.is_symlink():
    raise SystemExit('Refusing to modify a symlinked SSH directory or authorized_keys file.')
directory.mkdir(mode=0o700, exist_ok=True)
directory.chmod(0o700)
previous = path.read_text() if path.exists() else ''
# Keep every other authorized key. Replace any options for this exact public key.
lines = [line for line in previous.splitlines() if key not in line.split()]
updated = '\n'.join(lines + [entry]) + '\n'
if updated != previous:
    if path.exists():
        backup = directory / ('authorized_keys.before-ups-' + str(time.time_ns()))
        backup.write_text(previous)
        backup.chmod(0o600)
    fd, name = tempfile.mkstemp(dir=directory, prefix='authorized_keys-')
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(updated)
        os.replace(name, path)
    finally:
        if os.path.exists(name): os.unlink(name)
path.chmod(0o600)
print('MCP-only SSH key authorized; other keys preserved.')
PY
'@.Replace('__ENTRY__', $encoded)
}

function Test-McpConnection([string] $Ssh, [string[]] $Arguments) {
    $messages = @(
        @{ jsonrpc = '2.0'; id = 1; method = 'initialize'; params = @{ protocolVersion = '2025-11-25'; capabilities = @{}; clientInfo = @{ name = 'ups-deploy'; version = '1' } } },
        @{ jsonrpc = '2.0'; method = 'notifications/initialized' },
        @{ jsonrpc = '2.0'; id = 2; method = 'tools/list' }
    )
    $names = @('get_ups_status', 'get_pi_health', 'get_adapter_status')
    for ($index = 0; $index -lt $names.Count; $index++) {
        $messages += @{ jsonrpc = '2.0'; id = ($index + 3); method = 'tools/call'; params = @{ name = $names[$index]; arguments = @{} } }
    }
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $Ssh
    $info.Arguments = ($Arguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' '
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::Start($info)
    try {
        $output = $process.StandardOutput.ReadToEndAsync()
        $errors = $process.StandardError.ReadToEndAsync()
        foreach ($message in $messages) { $process.StandardInput.WriteLine(($message | ConvertTo-Json -Depth 8 -Compress)) }
        $process.StandardInput.Close()
        if (-not $process.WaitForExit(30000)) { $process.Kill(); throw 'MCP test timed out.' }
        if ($process.ExitCode -ne 0) { throw ('MCP SSH connection failed: ' + $errors.Result.Trim()) }
        $responses = @($output.Result -split '\r?\n' | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json })
        if ($responses.Count -ne 5 -or (($responses.id | Sort-Object) -join ',') -ne '1,2,3,4,5') {
            throw 'MCP returned an incomplete session.'
        }
        foreach ($response in $responses) { if ($response.error) { throw ('MCP protocol error: ' + $response.error.message) } }
        $initialized = @($responses | Where-Object { $_.id -eq 1 })[0]
        if ($initialized.result.protocolVersion -ne '2025-11-25') { throw 'MCP protocol negotiation failed.' }
        $tools = @($responses | Where-Object { $_.id -eq 2 })
        foreach ($name in $names) { if ($name -notin $tools[0].result.tools.name) { throw "MCP tool missing: $name" } }
        foreach ($id in @(4, 5)) {
            $response = @($responses | Where-Object { $_.id -eq $id })
            if ($response.Count -ne 1 -or $response[0].result.isError) { throw 'MCP Pi health or adapter status query failed.' }
        }
        $ups = @($responses | Where-Object { $_.id -eq 3 })[0].result
        if ($ups.isError) { Write-Warning 'MCP connects, but UPS readings are unavailable. Connect one supported UPS and check NUT.' }
        else { Write-Host ('MCP UPS reading: ' + $ups.content[0].text) }
        Write-Host 'MCP initialization, discovery, Pi health and adapter status passed using the restricted key.'
    } finally { if (-not $process.HasExited) { $process.Kill() }; $process.Dispose() }
}

function Get-HermesCommand([string] $Ssh, [string[]] $Arguments, [string] $ProgramData) {
    # --args consumes every following argument, so it MUST be the last Hermes option.
    $tokens = @('hermes', 'mcp', 'add', 'ups_adapter', '--command', $Ssh,
        '--env', "PROGRAMDATA=$ProgramData", '--connect-timeout', '15', '--args') + $Arguments
    return '& ' + (($tokens | ForEach-Object { ConvertTo-PowerShellArgument $_ }) -join ' ')
}

function Get-HermesYaml([string] $Ssh, [string[]] $Arguments, [string] $ProgramData) {
    # JSON quoted strings are also valid YAML scalars (including Windows paths).
    $lines = @('mcp_servers:', '  ups_adapter:', ('    command: ' + (ConvertTo-Json -InputObject $Ssh -Compress)), '    args:')
    foreach ($argument in $Arguments) { $lines += '      - ' + (ConvertTo-Json -InputObject $argument -Compress) }
    $lines += @('    env:', ('      PROGRAMDATA: ' + (ConvertTo-Json -InputObject $ProgramData -Compress)),
        '    connect_timeout: 15', '    timeout: 15', '    supports_parallel_tool_calls: false')
    return ($lines -join "`n") + "`n"
}

function Invoke-Deployment {
    if (-not $PiAddress) { $PiAddress = Read-Host 'Raspberry Pi IPv4 address (for example 192.168.50.200)' }
    $address = Confirm-PiAddress $PiAddress $PiUser
    $ssh = Find-OpenSshTool 'ssh'
    $scp = Find-OpenSshTool 'scp'
    $keygen = Find-OpenSshTool 'ssh-keygen'
    $target = "$PiUser@$address"
    $id = [guid]::NewGuid().ToString('N')
    $basename = "ups-adapter-deploy-$id.zip"
    $payload = Join-Path ([System.IO.Path]::GetTempPath()) $basename
    # Never use the restricted MCP key for installation, including on repeat runs.
    $adminOptions = @('-o', 'PubkeyAuthentication=no', '-o', 'PreferredAuthentications=password,keyboard-interactive',
        '-o', 'StrictHostKeyChecking=ask', '-o', 'ConnectTimeout=10')
    try {
        New-ProjectArchive $payload $PSScriptRoot $SourceRef
        Write-Host "Copying project to $target. Enter the Pi account password at SSH prompts; sudo may ask again."
        Write-Host 'On first connection, compare the displayed host fingerprint with your Pi before accepting it.'
        & $scp @adminOptions $payload "${target}:$basename"
        if ($LASTEXITCODE -ne 0) { throw "Project upload failed (SCP exit $LASTEXITCODE)." }
        $installation = @'
set -euo pipefail
cd "$HOME"
trap 'rm -f -- "$HOME/__ARCHIVE__"' EXIT
if [[ -d ups-network-adapter ]]; then
    (umask 077; tar -czf 'ups-network-adapter-before-deploy-__ID__.tar.gz' ups-network-adapter)
    echo 'Existing project backed up in your home directory.'
fi
/usr/bin/python3 - <<'PY'
import pathlib, zipfile
root = pathlib.Path.home() / 'ups-network-adapter'
if root.is_symlink():
    raise SystemExit('Refusing to replace a symlinked project directory.')
root.mkdir(mode=0o755, exist_ok=True)
root = root.resolve()
with zipfile.ZipFile(pathlib.Path.home() / '__ARCHIVE__') as archive:
    for entry in archive.infolist():
        target = (root / entry.filename).resolve()
        if not target.is_relative_to(root):
            raise SystemExit('Unsafe project archive path: ' + entry.filename)
        target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        target.write_bytes(archive.read(entry))
PY
cd ups-network-adapter
for test in test_ups_mib.py test_ups_autodetect.py test_setup_pi.py test_ups_mcp.py; do
    /usr/bin/python3 "$test"
done
sudo bash setup.sh
'@.Replace('__ARCHIVE__', $basename).Replace('__ID__', $id)
        Write-Host 'Installing and checking NUT, USB autodetection, SNMP and MCP on the Pi...'
        Invoke-RemoteScript $ssh $adminOptions $target $installation -Terminal
        $keyPath = Join-Path $env:USERPROFILE '.ssh\ups_adapter_mcp'
        $publicKey = New-McpKey $keygen $keyPath
        Write-Host 'Authorizing the MCP-only key on the Pi (one more Pi password prompt)...'
        Invoke-RemoteScript $ssh $adminOptions $target (Get-KeyAuthorizationScript $publicKey)
        $mcpArguments = @('-T', '-i', $keyPath, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
            '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=10', $target,
            '/usr/bin/python3', '-u', '/usr/local/lib/ups-network-adapter/ups_mcp.py')
        Test-McpConnection $ssh $mcpArguments
        $command = Get-HermesCommand $ssh $mcpArguments $env:ProgramData
        $commandFile = Join-Path $env:USERPROFILE 'add-ups-to-hermes.ps1'
        [System.IO.File]::WriteAllText($commandFile, "$command`nif (`$LASTEXITCODE -ne 0) { throw 'Hermes MCP registration failed.' }`n", $utf8)
        $yamlFile = Join-Path $env:USERPROFILE 'ups-adapter-hermes.yaml'
        [System.IO.File]::WriteAllText($yamlFile, (Get-HermesYaml $ssh $mcpArguments $env:ProgramData), $utf8)
        Write-Host "`nRun this command in PowerShell on this Hermes computer:"
        Write-Host $command
        Write-Host "`nAlso saved to: $commandFile"
        Write-Host "If the hermes command is unavailable, merge the server entry from $yamlFile into your Hermes config.yaml."
        Write-Host 'Then run: hermes mcp test ups_adapter'
        Write-Host 'In Hermes, use /reload-mcp or restart Desktop, then ask: Check my UPS and Raspberry Pi health.'
        Write-Host 'Hermes must use the backend on this Windows computer; a remote backend needs its own key and paths.'
    } finally {
        if (Test-Path -LiteralPath $payload) { Remove-Item -LiteralPath $payload }
    }
}

if ($MyInvocation.InvocationName -ne '.') { Invoke-Deployment }
