# Raspberry Pi UPS network adapter

One USB UPS → automatic driver selection → NUT `ups` → Python bridge → one Net-SNMP endpoint → monitoring client.

An installable Raspberry Pi 4 project for **read-only RFC 1628 UPS-MIB monitoring** of **one connected UPS at a time**, either an APC BX750MI or an Eaton 5E 2200i. Connect either UPS to any Pi USB host port. The adapter automatically selects the USB driver at boot and when the connected UPS changes. Both models use the same NUT name (`ups`), SNMP address, port, and community, so replacing the UPS requires no client configuration change. Read-only MCP tools also provide live UPS readings, Pi health and adapter service states to AI assistants over SSH. Python uses only its standard library; NUT handles USB and Net-SNMP handles SNMP packets and access control.

**Status:** on 2026-10-07, `setup.sh` was tested on a Raspberry Pi 4 with NUT 2.8.1 and an APC BX750MI (`051d:0002`). Initial migration, a repeat run without configuration or service changes, a read-only check, and recovery of a stopped SNMP service all passed. Live SNMP v2c GET returned the correct model, charge, and mains source; walk and bulkwalk returned 20 UPS-MIB readings in increasing OID order. All three synthetic checks also passed on the Pi. On 2026-10-08, NUT wildcard binding and LAN protocol access were verified; see the deployment notes below for the USB communication issue observed then. Eaton detection/model switching, reboot and outage behavior, SNMP LAN access, and the monitoring client's interoperability remain hardware acceptance checks.

## Hardware and compatibility

Use a Raspberry Pi 4, microSD card with Raspberry Pi OS Lite 64-bit, an appropriate USB-C power supply, Ethernet cable, and the selected UPS's USB **data** cable. Connect only one UPS at a time. Power the Pi's supply and the network equipment from battery-backed outlets so monitoring continues during an outage. UPS USB communication does not replace the Pi's power supply. The [Pi 4 specifications](https://www.raspberrypi.com/products/raspberry-pi-4-model-b/specifications/) specify 5 V / 3 A power and provide Ethernet and four USB ports.

| UPS | Expected detected driver | Verification required |
| --- | --- | --- |
| APC Back-UPS BX750MI, 750 VA / 410 W | `usbhid-ups`, USB `051d:0002` | Live NUT reads verified. Confirm disconnect/reconnect and battery transitions. |
| Eaton 5E 2200i | Usually `nutdrv_qx` | Check the full model label and USB IDs. NUT lists **5E2200** under Qx; smaller 5E HID models are not evidence that this unit uses HID. |

The detector runs [nut-scanner](https://networkupstools.org/historic/v2.8.1/docs/man/nut-scanner.html) every ten seconds. It accepts exactly one scan entry using `usbhid-ups` or `nutdrv_qx`, and generates `/etc/nut/ups.conf` with section `[ups]`, its USB vendor/product IDs, and a literal serial match when available. It does not pin a physical USB port. The installed NUT scanner selects the driver from its USB compatibility database; the driver supplies the actual model and measurements. Detection by USB ID is not proof of compatibility with every model using those IDs. The expected drivers follow the [NUT hardware compatibility list](https://networkupstools.org/stable-hcl.html).

On a changed selection, the detector stops the old driver, updates the configuration, invokes NUT's driver enumerator, and resets the SNMP bridge cache. No UPS, multiple detected UPSs, an unsupported driver, or a failed scan clears the selection. SNMP then reports unknown states and a communication-lost alarm instead of retaining previous measurements. Changes can take ten seconds to be discovered, plus scanning and driver startup time. USB scanning reads descriptors rather than starting another UPS driver. Normal operation does not require manual driver selection.

## 1. Prepare the Pi

Target: Raspberry Pi OS Lite 64-bit with Python 3.10+, systemd, and distro NUT 2.8.x packages. Reserve the Pi's address in DHCP. Enable SSH when preparing the SD card, then connect from Windows PowerShell with `ssh upsadmin@ups-adapter.local` (replace the username and hostname with yours, or use the Pi's IP address).

### One Windows script, including Hermes MCP

Run [deploy.ps1](deploy.ps1) **on the Windows computer where your Hermes backend runs** (for example LENOVO720). The Pi must already boot Raspberry Pi OS with SSH enabled, have network access for package installation, and allow your account to use `sudo`. Windows needs the built-in OpenSSH Client. Download the script alongside this project, or download just the script: when project files are absent, it fetches them from this repository's `main` branch. The v0.1.0 release predates MCP and the wildcard NUT listener; use `main` for the current installer.

To download just the script from PowerShell:

```powershell
Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/gbolotin/ups-network-adapter/main/deploy.ps1 -OutFile deploy.ps1
```

In **Windows PowerShell**, from the directory containing the script:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy.ps1
```

It asks for the Pi's IPv4 address. The account defaults to `upsadmin`; for another account or to skip the address question:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy.ps1 -PiAddress 192.168.50.200 -PiUser upsadmin
```

Run this in a normal PowerShell window; Administrator is not required when OpenSSH Client is already installed. `-ExecutionPolicy Bypass` applies only to this PowerShell process and avoids a policy blocking the script.

Enter the Pi password at the SSH prompts and again if `sudo` asks. On a first connection, verify the displayed host fingerprint against the Pi before accepting it. The script copies the shell/Python/configuration/test files with Linux newlines, backs up any existing Pi project in its home directory, runs the checks and `sudo bash setup.sh`, and then verifies the MCP tools over SSH. Setup configures one automatically detected USB UPS and replaces all active NUT `LISTEN` lines with **`LISTEN 0.0.0.0 3493`** on both new and existing installations. NUT accepts IPv4 connections on all interfaces, including loopback, for Home Assistant and other NUT clients. Setup preserves existing SNMP access settings; SNMP remains loopback-only on a new installation unless `--manager` is supplied. Automated shutdown remains disabled.

The script creates `%USERPROFILE%\.ssh\ups_adapter_mcp` without a passphrase, or reuses an existing unencrypted Ed25519 key there. The private key stays on your Windows computer. It authorizes the public key on the Pi with a forced MCP command and disabled forwarding/PTYs, preserving other keys and backing up changed `authorized_keys`. Installation uses password authentication because the restricted MCP key cannot run administrative commands. Keep SSH password login available for rerunning deployment.

After successful verification, it prints a personalized **`hermes mcp add ups_adapter ...` command**, also saved as `%USERPROFILE%\add-ups-to-hermes.ps1`. Run that command on the same computer, then run `hermes mcp test ups_adapter`. In Hermes, use `/reload-mcp` or restart Desktop and ask it to check your UPS and Pi health. The command includes `PROGRAMDATA`, required by Windows OpenSSH when Hermes filters the environment. Existing Hermes configuration is not changed by the deployment script.

If `hermes` is unavailable in your terminal, the script also saves `%USERPROFILE%\ups-adapter-hermes.yaml`. Merge its `ups_adapter` entry into the `mcp_servers` section of the configuration used by your Desktop backend (normally `%USERPROFILE%\.hermes\config.yaml`); preserve any other servers and settings. A remotely hosted Hermes backend needs its own SSH key and paths on that host. See the [Hermes MCP configuration reference](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference) and [MCP guide](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp/).

Verified on 2026-10-07: the Windows deployment checks passed on PowerShell 5.1 and 7. A complete deployment from Windows PowerShell 5.1 to the Pi at `192.168.50.200` passed the four Python checks, NUT/SNMP setup verification, SSH key authorization and all three live MCP tools with an APC BX750MI. Hermes registration on LENOVO720 remains to be run there, using the command generated on that computer.

Also verified on 2026-10-07: a fresh UPS software installation after purging NUT/SNMP and their four libraries, removing adapter/project/configuration files, stopping UPS processes, and clearing MCP key authorizations. The standalone script downloaded its project from GitHub, installed all eight missing packages, detected the APC, passed local SNMP verification, created and authorized a new client key, and successfully called all three MCP tools. A repeat setup and read-only check preserved configuration hashes and service process identities. The OS, login accounts, SSH settings and network settings were preserved; this test did not reimage the SD card. Existing MCP key access was restored after testing and the disposable key revoked. The reset generates a new SNMP community; the previous configuration is retained in a private Pi backup.

Verified on 2026-10-08: all four Python checks passed locally and on the Pi, and Windows deployment checks passed on PowerShell 5.1 and 7. Deployment to `192.168.50.200` backed up and replaced the old NUT listeners with one `LISTEN 0.0.0.0 3493`. The live socket and a LAN `LIST UPS` exchange confirmed access on TCP 3493; migration preserved the UPS/SNMP configuration hashes and detector/SNMP process identities. Repeat setup and the read-only check preserved configuration hashes and service process identities, returning nonzero because live UPS readings were unavailable. SSH MCP initialization, discovery, Pi health and adapter status passed. Full deployment validation stopped because the APC USB driver could not read its device; driver failures also appear in logs from before deployment. LAN UPS queries therefore returned `ERR DRIVER-NOT-CONNECTED`, and the UPS MCP tool reported unavailable readings. Reconnect the USB data cable and rerun setup to verify live telemetry; this is separate from the successful listener migration.

### Install from the Pi shell

At the **Pi's shell prompt**, download and install the project:

```sh
sudo apt update
sudo apt install -y git
git clone https://github.com/gbolotin/ups-network-adapter.git
cd ups-network-adapter
sudo bash setup.sh
```

Alternatively, download and extract the [current main archive](https://github.com/gbolotin/ups-network-adapter/archive/refs/heads/main.zip) on Windows, then copy its files from **Windows PowerShell**. Replace the local path, username, and hostname with yours. These commands also copy updates into an existing project directory:

```powershell
Set-Location "C:\path\to\ups-network-adapter"
ssh upsadmin@ups-adapter.local "mkdir -p /home/upsadmin/ups-network-adapter/config && chmod u+rwx /home/upsadmin/ups-network-adapter /home/upsadmin/ups-network-adapter/config"
scp .\*.py .\*.sh .\README.md upsadmin@ups-adapter.local:/home/upsadmin/ups-network-adapter/
scp .\config\* upsadmin@ups-adapter.local:/home/upsadmin/ups-network-adapter/config/
ssh upsadmin@ups-adapter.local
```

For this copy method, if you are already at the Pi's shell prompt, run `exit` first to return to Windows PowerShell. Then, **on the Pi**, run the single setup command from the copied project:

```sh
cd ~/ups-network-adapter
sudo bash setup.sh
```

`setup.sh` checks the installed packages, project files, NUT/SNMP configuration, and service states. It installs missing packages, prepares or repairs NUT autodetection, migrates the previous APC/Eaton SNMP settings when available, and enables the single SNMP service. It preserves configured communities and manager ACLs. If no community is configured, it generates a random secret in `/etc/ups-network-adapter/ups.conf`; it does not print the secret or pass it in SNMP command arguments. Changed configurations are backed up under private `/root/ups-adapter-backup-...` directories.

The command prints Pi temperature, detected UPS model/status/charge, and a local SNMP verification result. With no UPS attached, software checks can pass while the report explains that USB readings still need verification. An attached UPS without live NUT readings, an ambiguous/failed USB scan, or a failed SNMP query causes a nonzero exit. The command requires the copied project files; `setup.sh` uses the standard-library helper `setup_pi.py` and the existing installer.

To allow your monitoring computer over the LAN, replace the example address with that computer's IPv4 address:

```sh
sudo bash setup.sh --manager 192.0.2.20
```

This enables IPv4 SNMP listening with access limited by the configured communities and source ACLs, adding the requested manager. Existing ACLs remain in place. The first setup without `--manager` uses loopback only. Read the community in the private configuration file when configuring your monitoring client; do not share it in diagnostic output.

Rerun `sudo bash setup.sh` after copying updates or to repair the adapter. A healthy repeat run preserves configuration and does not restart UPS/SNMP services. For a read-only check of packages, configuration, services, NUT, and local SNMP:

```sh
sudo bash setup.sh --check
```

`--check` makes no package, configuration, or service changes. It returns nonzero when setup or repair is needed. The sections below describe the individual settings and manual commands if you need to customize them. The NUT name is `ups` for either model. Scanner warnings about XML, Avahi, or IPMI libraries do not affect a successful USB scan.

## 2. Configure USB monitoring

The single setup command performs this configuration when needed. For explicit manual setup or migration on this dedicated Pi, run:

```sh
sudo bash install.sh --configure-nut
```

This installs the bridge, detector, `ups-autodetect.service`, and `ups-snmp.service`. Before changing NUT, it backs up `/etc/nut` and the SNMP configurations to a private `/root/ups-adapter-backup-...` directory and prints its path. It sets `MODE=netserver`, enables autodetection, and replaces the previous manually selected UPS sections with the managed `[ups]` selection. Do not edit the generated `/etc/nut/ups.conf`; the detector owns it.

The setup replaces all active NUT listener lines with a single wildcard listener, sets `MAXAGE 6`, and enables `ALLOW_NO_DEVICE true` so the server can run when no UPS is attached. `/etc/nut/upsd.conf` contains:

```ini
LISTEN 0.0.0.0 3493
MAXAGE 6
ALLOW_NO_DEVICE true
```

Keep `/etc/nut/upsd.users` without control accounts for the initial read-only setup. The bridge's `upsc` queries need no login. The setup keeps NUT configuration ownership `root:nut` and mode `0640`.

On an existing installation, `sudo bash setup.sh` backs up `upsd.conf`, replaces the old loopback/fixed-IP listeners, and restarts `nut-server.service`. A listener-only migration preserves the selected USB driver and SNMP configuration and does not restart their services. Repeat runs leave the single wildcard listener unchanged. Do not add a separate loopback `LISTEN` line: the wildcard already includes `127.0.0.1`. See the [NUT listener documentation](https://networkupstools.org/historic/v2.8.1/docs/man/upsd.conf.html).

This monitoring setup masks `nut-monitor.service` and generates `sdorder=-1` to leave automated shutdown disabled. It disables the enumerator's file watcher; the detector explicitly invokes the enumerator after writing a complete configuration. Do not use this setup option on a machine whose existing NUT monitoring or shutdown policy you need to retain.

If upgrading the earlier APC/Eaton setup, the installer disables `ups-snmp@apc` and `ups-snmp@eaton`. Their configuration files remain available for reference. `setup.sh` imports configured credentials and access settings automatically; when using only the manual installer, copy them into the new `/etc/ups-network-adapter/ups.conf` in the next step. There is now one endpoint and one name for either UPS.

Allow time for the driver to initialize, then check:

```sh
systemctl status ups-autodetect.service
journalctl -u ups-autodetect -b
upsc ups@127.0.0.1
```

Confirm the actual model and `ups.status` before proceeding. A missing runtime/current/temperature variable is a hardware/driver capability, not necessarily an installation failure. `MAXAGE` limits stale driver data accepted by `upsd`; it does not force all USB sensors to update every six seconds. The message `Init SSL without certificate database` does not invalidate an otherwise successful local `upsc` query.

If a driver fails, inspect `systemctl list-units 'nut-driver@*'` and `journalctl -u nut-driver-enumerator -u nut-server -b`. Check permissions and the scan output before changing protocols. Do not enable APC low-battery/calibration workarounds blindly: inspect the installed `man usbhid-ups` and compare the reported state to the unit. Some workarounds in current upstream manuals may not exist in your distro version.

For later code updates, use `sudo bash setup.sh` to install changes and restart affected services. The lower-level `sudo bash install.sh` installs files only; you must restart the services yourself. Its `--configure-nut` option explicitly resets the generated UPS selection and stops SNMP until you start it again.

## 3. Configure SNMP access

`setup.sh` supplies a community and local access, and its `--manager` option adds your monitoring machine. For manual customization, edit `/etc/ups-network-adapter/ups.conf`. The raw template has no active community. Generate a random value (or reuse your previous secret), then replace the example community and allow only your monitoring machine:

```sh
python3 -c 'import secrets; print(secrets.token_hex(24))'
sudoedit /etc/ups-network-adapter/ups.conf
```

Example addresses for a Pi at `192.0.2.200` and a manager at `192.0.2.20` (replace both addresses with yours):

```text
agentaddress udp:127.0.0.1:1161,udp:192.0.2.200:1161
rocommunity YOUR_GENERATED_SECRET 127.0.0.1/32 -V upsView
rocommunity YOUR_GENERATED_SECRET 192.0.2.20/32 -V upsView
```

Keep the other template lines, including `--ups ups`. Use the same community and port `1161` regardless of which UPS is connected. For an initial local test, keep the default loopback address and enable only the loopback `rocommunity` line.

SNMP v1/v2c GET, GETNEXT, and v2c GETBULK are handled by Net-SNMP. Access is read-only, limited to system identification and UPS-MIB; SET is also rejected inside the bridge. Communities are sent in clear text: use a trusted management LAN/VLAN and restrict UDP ingress to your manager on the chosen ports. Do not forward these ports from the Internet. This project's configurations do not provision SNMPv3 users.

If your client requires UDP `161`, change the endpoint's port. On this dedicated Pi, stop/disable the distro `snmpd.service` before taking its port. The adapter's service is `ups-snmp.service`; its default port `1161` avoids a conflict with the distro daemon.

```sh
sudo systemctl enable ups-snmp.service
sudo systemctl restart ups-snmp.service
```

If binding to a DHCP address fails early during boot, the service retries after five seconds. Check status and logs:

```sh
systemctl status ups-snmp
journalctl -u ups-snmp -b
```

## 4. Verify actual SNMP

Run on the Pi with the loopback ACL enabled. `COMMUNITY` means the secret you configured; `read` avoids recording its value in shell history. The value can still be visible in a running SNMP client's process arguments.

```sh
read -rsp 'SNMP community: ' COMMUNITY
printf '\n'
snmpget -v2c -c "$COMMUNITY" -t 3 -r 1 -On udp:127.0.0.1:1161 .1.3.6.1.2.1.33.1.4.1.0
snmpwalk -v2c -c "$COMMUNITY" -t 3 -r 1 -On udp:127.0.0.1:1161 .1.3.6.1.2.1.33
snmpbulkwalk -v2c -c "$COMMUNITY" -t 3 -r 1 -On udp:127.0.0.1:1161 .1.3.6.1.2.1.33
unset COMMUNITY
```

Repeat from the allowed manager using the Pi's LAN address. Then disconnect the APC's USB cable, connect the Eaton, and repeat using the **same endpoint**. `3` is normal mains output; `5` is battery output. Missing sensors return `noSuchInstance` or are skipped by a walk; they are not reported as zero. Numeric OIDs work without installing MIB text files. Configure UPSWarden or another RFC 1628 client with the Pi IP, port `1161`, SNMP v2c, and the community. Actual UPSWarden interoperability remains an acceptance check.

## NUT network clients and Home Assistant

"UPS NAT" was clarified as **NUT network access**. No IP forwarding or NAT is needed. Setup already configures `/etc/nut/upsd.conf` with:

```ini
LISTEN 0.0.0.0 3493
MAXAGE 6
ALLOW_NO_DEVICE true
```

This includes every IPv4 interface and loopback. If DHCP changes the Pi's address, **no Pi NUT reconfiguration or restart is needed**. Update clients that use the old IP, including Home Assistant and Hermes SSH arguments, or use a hostname that resolves to the new address. A DHCP reservation avoids those client changes. Restrict TCP `3493` to trusted clients in your network/host firewall. Query from a client with NUT installed:

```sh
upsc ups@192.0.2.200
```

In Home Assistant, add the **Network UPS Tools (NUT)** integration:

| Setting | Value |
| --- | --- |
| Host | Pi's current IP, for example `192.168.50.200`, or a resolvable hostname |
| Port | `3493` |
| Username | Leave empty |
| Password | Leave empty |
| UPS, if prompted | `ups` |

`upsadmin` and its password are SSH/Linux credentials, not NUT credentials. NUT telemetry reads do not require authentication. A connection-refused error happens before login; check `systemctl status nut-server` and `ss -ltn 'sport = :3493'` on the Pi. See the [Home Assistant NUT integration](https://www.home-assistant.io/integrations/nut/).

For a client's `upsmon` login, add a distinct strong password and a secondary role to `/etc/nut/upsd.users`:

```ini
[observer]
    password = REPLACE_WITH_A_DIFFERENT_RANDOM_SECRET
    upsmon secondary
```

Restart `nut-server` after editing. The corresponding **client** `upsmon.conf` entry is `MONITOR ups@192.0.2.200 1 observer YOUR_NUT_PASSWORD secondary` for either model. This permits monitoring; it does not configure a complete coordinated shutdown policy. NUT transport is plain TCP here. Do not add `actions = SET`, `actions = FSD`, or `instcmds = ALL` for monitoring clients. See the upstream [NUT user/role documentation](https://networkupstools.org/docs/man/upsd.users.html).

## MCP access for AI assistants

The installer includes `ups_mcp.py`. After copying or pulling updates, run `sudo bash setup.sh` to install it at `/usr/local/lib/ups-network-adapter/ups_mcp.py`, then reconnect your MCP client. An MCP client launches the server on demand over SSH, using an ordinary Pi account. No MCP daemon, listening network port, `sudo`, API key, or additional Python package is needed. SNMP and NUT clients continue to work independently.

Verified on 2026-10-07: all three tools returned live data on a Raspberry Pi 4 with an APC BX750MI as an ordinary user. An official Python MCP SDK client on Windows also negotiated a session, discovered the tools and read all three through SSH key authentication. Installing only the MCP update preserved existing NUT/SNMP configuration hashes and service PIDs, invocation IDs and restart counts.

| Tool | Returned data |
| --- | --- |
| `get_ups_status` | Current model, manufacturer, driver, NUT status flags, battery charge/runtime/voltage, input voltage and load. Runtime is in seconds. Missing sensors are `null`. |
| `get_pi_health` | CPU temperature in Celsius, uptime in seconds and root filesystem capacity/used/free bytes. |
| `get_adapter_status` | Load, active and substate of USB detection, NUT driver target, NUT server and SNMP services. Active services alone do not prove UPS communication. |

All tools take an empty arguments object. Results include a UTC `observed_at` timestamp and JSON text; clients using the June/November 2025 protocol also receive `structuredContent`. UPS queries are fresh, use the fixed local name `ups`, and time out after one second. Service queries time out after three seconds. A failed query produces an MCP tool error without retaining old readings. The server cannot change UPS settings, shut down equipment, run arbitrary commands, or read private credential files.

Use SSH key authentication so the MCP client can connect without an interactive password prompt. First connect normally and verify the Pi's host key. Then verify this command from your PC succeeds without prompting (replace the account/hostname with yours):

```sh
ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes upsadmin@ups-adapter.local true
```

For clients that accept an `mcpServers` JSON configuration, add:

```json
{
  "mcpServers": {
    "ups-adapter": {
      "command": "ssh",
      "args": [
        "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
        "upsadmin@ups-adapter.local",
        "/usr/bin/python3", "-u", "/usr/local/lib/ups-network-adapter/ups_mcp.py"
      ]
    }
  }
}
```

Use the full path to `ssh.exe` on Windows if your client cannot find it. Client configuration formats vary; select a **stdio** MCP server and use the same command/arguments. A client on the Pi can instead launch `/usr/bin/python3 -u /usr/local/lib/ups-network-adapter/ups_mcp.py` directly. Never allocate an SSH PTY (`-t`), and keep shell startup banners off stdout for noninteractive SSH commands.

To select a dedicated key, insert `"-i", "C:\\path\\to\\your\\mcp_key"` in the SSH arguments before the hostname (use your key's path). For a key restricted to this server, authorize its public key in the Pi account's `~/.ssh/authorized_keys` with this prefix:

```text
restrict,command="/usr/bin/python3 -u /usr/local/lib/ups-network-adapter/ups_mcp.py" ssh-ed25519 YOUR_PUBLIC_KEY ups-adapter-mcp
```

This key starts only the MCP process and disables SSH forwarding and PTYs. Keep private keys outside the repository. A personalized `mcp-client.local.json` may be kept locally; Git ignores it. On Windows, clients that filter environment variables must preserve `PROGRAMDATA`; Windows OpenSSH exited before connecting when this was omitted in the independent client test. In a JSON client configuration, add `"env": {"PROGRAMDATA": "C:\\ProgramData"}` alongside `command` and `args`, using your system's actual value if different.

The implementation supports the tools subset of MCP protocol versions `2024-11-05`, `2025-03-26`, `2025-06-18` and `2025-11-25`: initialization, initialized notification, ping, tool discovery/calls, JSON-RPC errors and newline-delimited UTF-8 stdio. Messages are limited to 64 KiB. It handles one bounded request at a time; notifications do not execute tools or produce replies. HTTP transport, resources, prompts, subscriptions and background tasks are not advertised. A cloud assistant that cannot launch a local SSH process needs a separate authenticated HTTP gateway; that is not provided by this server. The wire format follows the [MCP stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) and [tool protocol](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).

## Implemented UPS-MIB subset

The following suffixes are relative to `.1.3.6.1.2.1.33.1`. Availability depends on the USB driver. Types and units follow [RFC 1628](https://www.rfc-editor.org/rfc/rfc1628.html), with NUT inputs from its [variable reference](https://networkupstools.org/docs/developer-guide.chunked/apas02.html).

| Suffix | Reading |
| --- | --- |
| `1.1.0`–`1.5.0` | Manufacturer, model, UPS firmware, bridge version, UPS name |
| `2.1.0` | Battery state: unknown `1`, normal `2`, low `3`; no invented depleted state |
| `2.2.0` | Observed seconds on battery; zero off battery, omitted on communication failure |
| `2.3.0` | Runtime in minutes, positive partial minutes rounded up |
| `2.4.0` | Charge percentage |
| `2.5.0`, `2.6.0`, `2.7.0` | Battery voltage/current in tenths; battery temperature in °C |
| `3.2.0`, `3.3.1.{2,3,4,5}.1` | One input phase: frequency in tenths Hz, volts, current in tenths A, real watts |
| `4.1.0`, `4.2.0`, `4.3.0` | Output source, frequency in tenths Hz, one output phase |
| `4.4.1.{2,3,4,5}.1` | Output volts, current in tenths A, real watts, load percentage |
| `6.1.0`, `6.2.1.2.<alarm>` | Alarm count and standard alarm-description OIDs |
| `9.{1,2,3,4,5,6,7,9,10}.0` | Available nominal input/output ratings, low-runtime threshold, transfer voltages |

Alarm IDs follow their standard descriptions: battery replacement `1`, on battery `2`, low battery `3`, overload `8`, bypass `9`, output off `14`, general alarm `18`, communication lost `20`, shutdown pending `22`, calibration/test in progress `24`. `LB` and `FSD` do not imply depleted battery. Unknown vendor alarm text is conservatively represented as general alarm.

Measurements are truncated after unit scaling, except remaining runtime, which rounds up to positive whole minutes. Zero/unavailable runtime is omitted because that RFC object has `PositiveInteger` syntax. A missing battery temperature is not replaced with UPS enclosure temperature. Watts are not guessed from VA or load percentage.

The bridge reads NUT on demand with a two-second cache and a one-second subprocess timeout. After a failed read or NUT stale-data error, measurements disappear, battery/output states become unknown, and the communication-lost alarm appears; a successful read restores data. NUT's own staleness detection and the client's polling interval add detection delay. Battery elapsed time starts when this bridge first observes battery operation and resets on mains, communication loss, or bridge restart; unobserved transitions between polls cannot be reconstructed.

This is **partial, read-only UPS-MIB support**, not a claim of an RFC conformance group. It omits alarm timestamps (the bridge does not receive Net-SNMP's `sysUpTime`), trap generation, bypass sensor tables, test/control operations, writable settings, and unsupported sensors. No nonstandard serial-number or battery-condition objects are added under the standard subtree. A manager must tolerate missing objects; clients requiring alarm timestamps or control operations need those features implemented before deployment.

## Hardware acceptance checks

1. Connect the APC alone and verify `upsc ups@127.0.0.1`; replace its USB connection with the Eaton and verify the same query without editing any configuration. Save each unit's USB IDs, model, firmware, NUT version, and available variables. Check that only one driver runs.
2. Compare SNMP charge, runtime, voltage, load, and source with `upsc`. Walk and bulkwalk must terminate in increasing numeric OID order. Repeat using SNMP v1 if that is your client's protocol.
3. Unplug the **USB data cable**. After detection and bridge refresh, source must become `other(1)`, battery state `unknown(1)`, readings disappear, and alarm `20` appears. Reconnect and confirm recovery. Swap models on the same Pi USB port and on another port; verify the new model appears at the same SNMP endpoint without old readings or battery elapsed time. Repeat by stopping and restarting `nut-server`.
4. On a noncritical test load, briefly remove mains input to that UPS. Verify battery source `5` and alarm `2`, then restore mains and verify normal source `3`. Keep the Pi and network powered. Low-battery behavior can be tested with synthetic data; do not drain a production load to test it.
5. Reboot with each UPS connected separately, then boot with neither attached and connect one afterwards. Verify automatic detection, driver, `upsd`, and SNMP recovery. Connect both temporarily: selection must be cleared, then recover when only one remains.
6. Verify the correct community works only from allowed addresses and a wrong community gets no data. A SET of the harmless UPS-name object `1.1.5.0` must be rejected. Do not test writable shutdown OIDs on a live UPS.
7. Verify your actual monitoring client tolerates the documented missing objects and handles communication loss. NUT LAN access is enabled by default; verify a permitted remote `upsc` client and any firewall rules intended to block untrusted clients.

Web UI and physical display are left optional. A coordinated host/Pi shutdown policy, traps, and SNMPv3 provisioning are not included in this monitoring build; agree and test that policy before relying on the adapter to shut down equipment. To remove the installation, disable `ups-autodetect.service` and `ups-snmp.service`, stop the managed driver, and restore the backed-up NUT configuration and previous enumerator/monitor-service policy.

## Local development checks

On Windows, verify deployment helpers with either Windows PowerShell 5.1 or PowerShell 7:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\test_deploy.ps1
```

This checks address validation, Linux file packaging, standalone archive download handling, real OpenSSH key creation/reuse, and the generated Hermes command, including paths with spaces and apostrophes. It does not connect to a Pi. Run `deploy.ps1` for an actual installation and MCP connection test.

```sh
python3 test_ups_mib.py
python3 test_ups_autodetect.py
python3 test_setup_pi.py
python3 test_ups_mcp.py
bash -n install.sh
bash -n setup.sh
git diff --check
```

The bridge check uses synthetic inputs and verifies unit conversion, status priority, alarms, missing/invalid data, cache expiry, failed reads/recovery, the `upsc` command boundary, numeric GETNEXT ordering, SET rejection, and the real command-line entry point. The detection check verifies both driver selections, model changes, disconnects, ambiguous/failed scans, serial matching, protection of unmanaged configuration, and service sequencing. The setup check verifies repeated runs, migration from multiple NUT listeners to one wildcard with a backup and only a NUT server restart, preservation/migration of credentials, manager validation, a private SNMP query, and read-only checks. The MCP check verifies lifecycle/version negotiation, tool discovery, sensor units, fixed command boundaries, invalid requests, failed reads/recovery, message limits and the real stdio process. These are not USB or on-wire SNMP integration tests. The extension protocol follows the [Net-SNMP pass_persist documentation](https://www.net-snmp.org/wiki/index.php/Pass_persist).
