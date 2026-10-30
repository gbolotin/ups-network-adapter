# Passwordless kiosk login

Home Assistant trusts exactly `192.168.50.200/32` and maps that address to the
existing non-admin `pi-kiosk` user. `trusted_networks` precedes the ordinary
`homeassistant` provider, and `allow_bypass_login` skips account selection because
only the one kiosk user is permitted. Other addresses retain password login.
The kiosk account password remains valid; it has not been cleared or changed.

The Pi currently receives its address through DHCP. Router-side reservation was
not verified or changed. If its address changes, a new session from the new IP
requires normal credentials. Keep this exact-IP allowlist rather than widening
it to the entire LAN. A device taking over the trusted IP would have the same
kiosk login privilege.

`apply_trusted_pi_auth.mjs` verifies the kiosk user, refuses changed preflight
configuration, saves a private write-ahead record, validates HA configuration,
and restores the previous file on validation failure. Existing auth/proxy config
requires explicit review; the builder does not replace it. One HA restart applies
the provider configuration.

Private backup and before/after configuration:
`trusted-pi-auth-before.json` in the protected deployment directory. For rollback,
restore its `before` text to the recorded configuration path, validate the file,
and restart HA. Preserve subsequent unrelated configuration changes. Existing
password sessions and the independent NUT services remain usable.

Verification on October 30, 2026:

- Two focused builder tests passed: exact-IP/single-user access, provider order,
  password fallback, and refusal of conflicting/injected configuration.
- `check_pi_trusted_login.py` opened a new disposable Chromium context on the Pi,
  entered no credentials, and reached Home Console as `pi-kiosk`, non-admin.
  Its temporary refresh token was revoked and the context closed. The retained
  kiosk session was not cleared or logged out.
- From the operator PC, the trusted provider was not advertised; an explicit
  trusted-network login attempt returned `abort / not_allowed`.
- The normal password login provider still presented its password form.
- NUT and kiosk services stayed active during the HA restart.

This does not configure DHCP reservation or prove behavior after a real IP change.
