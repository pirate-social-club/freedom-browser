const { contextBridge, ipcRenderer } = require('electron');

let port;
let request;
let listener;
let sent = false;
ipcRenderer.once('webauthn:prompt', (event, details) => {
  port = event.ports[0];
  request = details;
  listener?.(request);
});
contextBridge.exposeInMainWorld('securityKeyPrompt', {
  onRequest(callback) {
    listener = callback;
    if (request) callback(request);
  },
  respond(action, value) {
    if (!port || sent) return;
    sent = true;
    port.postMessage({ action, value });
  },
});
