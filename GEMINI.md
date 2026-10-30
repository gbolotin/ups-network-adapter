# Project & Environment Rules

## Home Assistant (HA) Instance
- **Host / URL**: `http://192.168.50.117/` (running on Lenovo 720 VM)
- **Authentication**: Long-Lived Access Token stored at `C:\Users\gbolo\.ha_token\HA_token.txt`
- **API Base**: `http://192.168.50.117/api/`

## Raspberry Pi (UPS Adapter)
- **Host / IP**: `192.168.50.200`
- **Hostname**: `ups-adapter`
- **User**: `upsadmin`
- **SSH Key**: `C:\Users\gbolo\.ssh\ups_adapter_admin`
- **Services**: NUT server (`nut-server`), UPS name `ups`
