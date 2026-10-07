# Run with Windows PowerShell 5.1 or PowerShell 7. No test framework required.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\deploy.ps1"

function Assert([bool] $Condition, [string] $Message) {
    if (-not $Condition) { throw $Message }
}

function Assert-Throws([scriptblock] $Action) {
    $failed = $false
    try { & $Action } catch { $failed = $true }
    Assert $failed 'Expected validation to reject the input.'
}

Assert ((Confirm-PiAddress '192.168.50.200' 'upsadmin') -eq '192.168.50.200') 'Valid Pi address rejected.'
foreach ($address in @('-oProxyCommand=x', '127.1', '256.1.2.3', '::1', '192.168.1.1;whoami')) {
    Assert-Throws { Confirm-PiAddress $address 'upsadmin' }
}
Assert-Throws { Confirm-PiAddress '192.168.50.200' 'root;whoami' }
Assert ((ConvertTo-NativeArgument '') -eq '""') 'Empty native argument must be retained.'
Assert ((ConvertTo-NativeArgument 'C:\a b\') -eq '"C:\a b\\"') 'Trailing backslash must survive native quoting.'
Assert ((ConvertTo-NativeArgument 'bash -c "x"') -eq '"bash -c \"x\""') 'Remote shell quotes must survive Windows argument parsing.'

$testId = [guid]::NewGuid().ToString('N')
$archivePath = Join-Path ([System.IO.Path]::GetTempPath()) "ups-test-$testId.zip"
$sourceArchive = Join-Path ([System.IO.Path]::GetTempPath()) "ups-source-test-$testId.zip"
$downloadArchive = Join-Path ([System.IO.Path]::GetTempPath()) "ups-download-test-$testId.zip"
# Spaces and apostrophes exercise Windows native and PowerShell quoting.
$keyPath = Join-Path ([System.IO.Path]::GetTempPath()) "ups test's $testId"
try {
    New-ProjectArchive $archivePath $PSScriptRoot 'unused-local-ref'
    $archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
    $source = [System.IO.Compression.ZipFile]::Open($sourceArchive, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        Assert ($archive.Entries.Count -eq $projectFiles.Count) 'Deployment manifest incomplete.'
        foreach ($name in $projectFiles) {
            $entry = $archive.GetEntry($name)
            Assert ($null -ne $entry) "Deployment file missing: $name"
            $reader = New-Object System.IO.StreamReader($entry.Open())
            try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
            Assert (-not $text.Contains("`r")) "Linux file has CR newlines: $name"
            Assert ($text.Length -eq 0 -or [int] $text[0] -ne 0xfeff) "Linux file has BOM: $name"
            $copy = $source.CreateEntry("github-root/$name")
            $writer = New-Object System.IO.StreamWriter($copy.Open(), $utf8)
            try { $writer.Write($text) } finally { $writer.Dispose() }
        }
    } finally { $archive.Dispose(); $source.Dispose() }

    # Standalone deployment must fetch only its fixed manifest, without Git or local Python.
    function Invoke-WebRequest {
        param([switch] $UseBasicParsing, [string] $Uri, [string] $OutFile)
        Assert ($Uri.EndsWith('/feature%2Fmcp-server')) 'GitHub source ref is not URL encoded.'
        Copy-Item -LiteralPath $sourceArchive -Destination $OutFile
    }
    New-ProjectArchive $downloadArchive ([System.IO.Path]::GetTempPath()) 'feature/mcp-server'
    $archive = [System.IO.Compression.ZipFile]::OpenRead($downloadArchive)
    try { Assert ($archive.Entries.Count -eq $projectFiles.Count) 'Standalone download manifest incomplete.' }
    finally { $archive.Dispose() }
    Remove-Item Function:\Invoke-WebRequest

    $public = New-McpKey (Find-OpenSshTool 'ssh-keygen') $keyPath
    Assert ($public.StartsWith('ssh-ed25519 ')) 'Public key generation failed.'
    $hash = (Get-FileHash -LiteralPath $keyPath).Hash
    [System.IO.File]::WriteAllText("$keyPath.pub", 'stale public key')
    $reused = New-McpKey (Find-OpenSshTool 'ssh-keygen') $keyPath
    Assert ($public -eq $reused) 'Repeat deployment must derive the correct public key.'
    Assert ($hash -eq (Get-FileHash -LiteralPath $keyPath).Hash) 'Repeat deployment replaced the private key.'

    $arguments = @('-T', '-i', $keyPath, '-o', 'BatchMode=yes', 'upsadmin@192.168.50.200', '/usr/bin/python3', '-u', '/usr/local/lib/ups-network-adapter/ups_mcp.py')
    $command = Get-HermesCommand 'C:\Windows\System32\OpenSSH\ssh.exe' $arguments 'C:\ProgramData'
    # Execute the generated PowerShell syntax against a capture function, never real Hermes.
    function hermes { $script:capturedArguments = @($args) }
    Invoke-Expression $command
    $expected = @('mcp', 'add', 'ups_adapter', '--command', 'C:\Windows\System32\OpenSSH\ssh.exe',
        '--env', 'PROGRAMDATA=C:\ProgramData', '--connect-timeout', '15', '--args') + $arguments
    Assert ($capturedArguments.Count -eq $expected.Count) 'Hermes command lost an argument.'
    for ($index = 0; $index -lt $expected.Count; $index++) {
        Assert ($capturedArguments[$index] -ceq $expected[$index]) "Hermes argument changed at position $index."
    }
    $yaml = Get-HermesYaml 'C:\Windows\System32\OpenSSH\ssh.exe' $arguments 'C:\ProgramData'
    Assert ($yaml.StartsWith("mcp_servers:`n  ups_adapter:")) 'Wrong Hermes YAML root.'
    Assert ($yaml.Contains('PROGRAMDATA: "C:\\ProgramData"')) 'Hermes YAML omits OpenSSH environment.'
    Write-Host 'Deployment checks passed: input validation, Linux packaging, standalone download, key reuse and Hermes command quoting.'
} finally {
    # Delete only the individual temporary files created by this check.
    foreach ($path in @($archivePath, $sourceArchive, $downloadArchive, $keyPath, "$keyPath.pub")) {
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path }
    }
}
