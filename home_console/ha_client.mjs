// Operator-side tooling. Node 22+ provides fetch and WebSocket; no packages required.
import { readFile } from 'node:fs/promises';

export class HomeAssistant {
  constructor(baseUrl, token) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Use an HTTP(S) Home Assistant URL without embedded credentials');
    }
    this.baseUrl = url.origin;
    this.token = token.trim();
    this.nextId = 1;
    this.pending = new Map();
  }

  static async fromFile(baseUrl, tokenFile) {
    return new HomeAssistant(baseUrl, await readFile(tokenFile, 'utf8'));
  }

  async rest(path, { method = 'GET', body, timeoutMs = 15000 } = {}) {
    if (!path.startsWith('/api/') || path.includes('..')) {
      throw new Error('REST requests must use an /api/ path');
    }
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    if (!response.ok) {
      throw new Error(`HA REST request failed (${response.status})`);
    }
    return response.json();
  }

  async connect() {
    const address = new URL('/api/websocket', this.baseUrl);
    address.protocol = address.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(address);
    this.socket = socket;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('HA WebSocket authentication timed out'));
        socket.close();
      }, 15000);
      const fail = message => {
        clearTimeout(timeout);
        reject(new Error(message));
        this.rejectPending(new Error(message));
      };
      socket.addEventListener('error', () => fail('HA WebSocket connection failed'));
      socket.addEventListener('close', () => fail('HA WebSocket closed'));
      socket.addEventListener('message', event => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          fail('Invalid HA WebSocket response');
          socket.close();
          return;
        }
        if (message.type === 'auth_required') {
          socket.send(JSON.stringify({ type: 'auth', access_token: this.token }));
        } else if (message.type === 'auth_ok') {
          clearTimeout(timeout);
          resolve();
        } else if (message.type === 'auth_invalid') {
          fail('HA authentication rejected');
          socket.close();
        } else if (message.type === 'result') {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          clearTimeout(pending.timeout);
          this.pending.delete(message.id);
          if (message.success) pending.resolve(message.result);
          else pending.reject(new Error(`HA command ${pending.type} failed (${message.error?.code ?? 'unknown'})`));
        }
      });
    });
  }

  command(type, parameters = {}, timeoutMs = 15000) {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('HA WebSocket is not connected'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`HA command ${type} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout, type });
      this.socket.send(JSON.stringify({ ...parameters, id, type }));
    });
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.rejectPending(new Error('HA client closed'));
    this.socket?.close();
  }
}
