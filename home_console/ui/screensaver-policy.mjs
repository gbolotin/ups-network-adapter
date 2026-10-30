export const IDLE_MS = 120000;
export function screensaverMode({ pathname, search, idleMs, idleTimeoutMs = IDLE_MS, nativeState, nativeSource, musicState }) {
  if (!pathname.startsWith('/home-console/') || !new URLSearchParams(search).has('kiosk') || idleMs < idleTimeoutMs) return 'hidden';
  if (musicState === 'playing' && !['off', 'unknown', 'unavailable'].includes(nativeState)
      && ['HEOS Music', 'NET'].includes(nativeSource)) return 'music';
  return 'photos';
}

export function upsSupplyState(value) {
  const flags = typeof value === 'string' ? value.trim().toUpperCase().split(/\s+/) : [];
  if (flags.includes('OB')) return 'battery';
  if (flags.includes('OL')) return 'online';
  return 'unknown';
}
