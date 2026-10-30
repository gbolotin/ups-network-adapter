// Operator-side MA HTTP API access; secrets stay in headers and private files.
export class MusicAssistant {
  constructor(baseUrl, headers = {}) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Use a Music Assistant HTTP(S) URL without embedded credentials');
    }
    this.baseUrl = url.href.replace(/\/$/, '');
    this.headers = headers;
    this.nextId = 1;
  }

  static async viaIngress(ha) {
    const info = await ha.command('supervisor/api', { endpoint: '/addons/d5369777_music_assistant/info', method: 'get' });
    if (info.state !== 'started' || !info.ingress) throw new Error('MA ingress is not ready');
    const url = new URL(info.ingress_entry, ha.baseUrl);
    if (url.origin !== ha.baseUrl || !/^\/api\/hassio_ingress\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname) || url.search || url.hash) {
      throw new Error('Unexpected MA ingress URL');
    }
    const session = await ha.command('supervisor/api', { endpoint: '/ingress/session', method: 'post' });
    if (!/^[a-zA-Z0-9_-]+$/.test(session.session)) throw new Error('Unexpected ingress session format');
    return new MusicAssistant(url.href, { Cookie: `ingress_session=${session.session}` });
  }

  async command(command, args = {}) {
    const response = await fetch(`${this.baseUrl}/api`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message_id: this.nextId++, command, args }),
    });
    if (!response.ok) throw new Error(`MA command ${command} failed (${response.status})`);
    return response.json();
  }
}
