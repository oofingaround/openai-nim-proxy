// polyfill.js — Runs before ANY other code
if (typeof globalThis !== 'undefined' && typeof globalThis.SharedWorker === 'undefined') {
  globalThis.SharedWorker = class SharedWorker {
    constructor() {
      this.port = {
        start: () => {},
        postMessage: () => {},
        onmessage: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        close: () => {},
      };
      this.onerror = null;
    }
  };
}