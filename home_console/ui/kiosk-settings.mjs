export const PHOTO_INTERVALS = [5, 10, 15, 30, 60, 120, 300];
export const PHOTO_INTERVAL_KEY = 'home-console-photo-interval-seconds';
export function setConsoleTheme(root, mode) {
  if (!root?.hass?.themes || !['light', 'dark'].includes(mode)) throw new Error('Theme selection unavailable');
  const dark = mode === 'dark';
  const name = root.hass.themes.theme;
  const theme = root.hass.themes.themes?.[name];
  const detail = { dark };
  // A single-mode custom theme cannot honor the requested other mode.
  if (theme && !theme.modes?.[mode]) detail.theme = 'default';
  root.dispatchEvent(new CustomEvent('settheme', { detail, bubbles: true, composed: true }));
}
export async function nightBlankingSettings(hass, enabled) {
  if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('Expected a boolean screen setting');
  const result = await hass.callWS({ type: 'call_service', domain: 'rest_command',
    service: enabled === undefined ? 'home_console_pi_screen' : 'home_console_pi_set_screen',
    service_data: enabled === undefined ? {} : { enabled }, return_response: true });
  if (result.response?.status !== 200 || typeof result.response.content?.enabled !== 'boolean') throw new Error('Pi screen setting was not confirmed');
  return result.response.content.enabled;
}
export function photoInterval(value) {
  const seconds = Number(value);
  return PHOTO_INTERVALS.includes(seconds) ? seconds : 30;
}
export function opensDrawer(start, end) {
  return start.y <= 24 && end.y - start.y >= 60 && Math.abs(end.x - start.x) < end.y - start.y;
}

export const SCREENSAVER_ENABLED_KEY = 'home-console-screensaver-enabled';
export function screensaverEnabled(storage = globalThis.localStorage) {
  try { return storage?.getItem(SCREENSAVER_ENABLED_KEY) !== 'false'; }
  catch { return true; }
}

export const SCREENSAVER_DELAYS = [15, 30, 60, 120, 300, 600, 900, 1800];
export const SCREENSAVER_DELAY_KEY = 'home-console-screensaver-delay-seconds';
export function screensaverDelay(storage = globalThis.localStorage) {
  try {
    const seconds = Number(storage?.getItem(SCREENSAVER_DELAY_KEY));
    return SCREENSAVER_DELAYS.includes(seconds) ? seconds : 120;
  } catch { return 120; }
}
