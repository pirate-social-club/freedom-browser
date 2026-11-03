const fs = require('fs');
const path = require('path');
const vm = require('vm');

describe('security key prompt preload', () => {
  test('uses only its transferred port and sends at most one response', () => {
    const events = {};
    let api;
    const electron = { ipcRenderer: { once: (name, callback) => { events[name] = callback; } },
      contextBridge: { exposeInMainWorld: (name, value) => { expect(name).toBe('securityKeyPrompt'); api = value; } } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'webauthn-prompt-preload.js'), 'utf8'), {
      require: (name) => { expect(name).toBe('electron'); return electron; },
    });
    const listener = jest.fn();
    const port = { postMessage: jest.fn() };
    api.respond('submit', 'before-port');
    api.onRequest(listener);
    expect(Object.keys(events)).toEqual(['webauthn:prompt']);
    events['webauthn:prompt']({ ports: [port] }, { kind: 'pin', origin: 'https://news.web3' });
    expect(listener).toHaveBeenCalledWith({ kind: 'pin', origin: 'https://news.web3' });
    api.respond('submit', 'test-pin');
    api.respond('submit', 'replay');
    expect(port.postMessage.mock.calls).toEqual([[{ action: 'submit', value: 'test-pin' }]]);
  });
});
