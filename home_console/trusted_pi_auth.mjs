// Exact device allowlist. Existing authentication configuration needs manual review.
export function addTrustedPiAuth(before, userId) {
  if (!/^[a-f0-9]{32}$/.test(userId)) throw new Error('Expected the verified kiosk user ID');
  if (/^homeassistant\s*:/m.test(before) || /\bauth_providers\s*:/.test(before) || /\btrusted_proxies\s*:/.test(before)) {
    throw new Error('Review existing homeassistant/auth/proxy configuration before editing');
  }
  return before.trimEnd() + `

# Home Console: passwordless access only from the Raspberry Pi, only as pi-kiosk.
homeassistant:
  auth_providers:
    - type: trusted_networks
      trusted_networks:
        - 192.168.50.200/32
      trusted_users:
        192.168.50.200/32:
          - ${userId}
      allow_bypass_login: true
    - type: homeassistant
`;
}
