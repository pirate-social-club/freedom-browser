// Run with an official Electron binary, not Node:
//   electron --no-sandbox --headless scripts/webauthn-account-smoke.js
// Scratch profile, loopback TLS fixture and virtual credentials only. This
// verifies native account events/frame binding/MessagePorts, not a YubiKey,
// HNS/DANE trust, or the proposed native PIN API.
const { app, BrowserWindow, MessageChannelMain, session, webContents } = require('electron');
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { generateKeyPairSync, randomBytes } = require('crypto');
const { registerWebauthnPrompts } = require('../src/main/webauthn-prompts');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-account-smoke-'));
app.setPath('userData', scratch);
app.disableHardwareAcceleration();
let server;
let finished = false;
function finish(error, result) {
  if (finished) return;
  finished = true;
  server?.close();
  console.log('WEBAUTHN-ACCOUNT-SMOKE ' + JSON.stringify(error
    ? { ok: false, error: error.message, electron: process.versions.electron }
    : { ok: true, electron: process.versions.electron, ...result }));
  app.exit(error ? 1 : 0);
}
setTimeout(() => finish(new Error('Account smoke test timed out')), 30000).unref();

async function waitFor(predicate, label) {
  for (let i = 0; i < 100; i++) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${label}`);
}

app.whenReady().then(async () => {
  const fixtures = path.join(__dirname, '..', 'test', 'fixtures', 'cert-verify-concurrency-tls');
  server = https.createServer({ key: fs.readFileSync(path.join(fixtures, 'cert-verify-test.key')),
    cert: fs.readFileSync(path.join(fixtures, 'cert-verify-test.crt')) });
  server.on('request', (request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(request.url.startsWith('/child') ? '<!doctype html><title>Child</title>'
      : '<!doctype html><title>WebAuthn fixture</title><iframe id="child" src="/child"></iframe>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `https://localhost:${server.address().port}`;
  const owner = new BrowserWindow({ show: false, webPreferences: { webviewTag: true,
    nodeIntegration: false, contextIsolation: true, sandbox: true } });
  registerWebauthnPrompts({ app, BrowserWindow, MessageChannelMain, session, webContents,
    getMainWindows: () => [owner] });
  // Trust only the isolated fixture origin in this scratch profile. There is
  // no global ignore-certificate-errors switch and no public network server.
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    callback(request.hostname === 'localhost' ? 0 : -3);
  });
  await owner.loadURL('data:text/html,<html><body></body></html>');
  const attached = new Promise((resolve) => owner.webContents.once('did-attach-webview', (_event, guest) => resolve(guest)));
  await owner.webContents.executeJavaScript(`{
    const guest = document.createElement('webview');
    guest.src = ${JSON.stringify(origin)};
    document.body.append(guest);
  }`);
  const guest = await attached;
  await waitFor(() => !guest.isLoading() && guest.getURL() === origin + '/', 'guest page');
  guest.debugger.attach('1.3');
  await guest.debugger.sendCommand('WebAuthn.enable');
  const { authenticatorId } = await guest.debugger.sendCommand('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  const ids = [];
  for (let i = 1; i <= 2; i++) {
    const id = randomBytes(32); ids.push(id.toString('base64url'));
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    await guest.debugger.sendCommand('WebAuthn.addCredential', { authenticatorId, credential: {
      credentialId: id.toString('base64'), isResidentCredential: true, rpId: 'localhost',
      privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      userHandle: Buffer.from(`fixture-user-${i}`).toString('base64'),
      userName: `fixture-user-${i}`, userDisplayName: `Fixture ${i}`, signCount: 0,
    } });
  }
  const begin = () => guest.executeJavaScript(`{
    window.passkeyResult = null;
    navigator.credentials.get({publicKey: {challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId:'localhost', userVerification:'required', timeout:10000}})
      .then(value => window.passkeyResult = {id:value.id})
      .catch(error => window.passkeyResult = {error:error.name});
    true;
  }`);
  const chooser = () => waitFor(async () => {
    const dialog = BrowserWindow.getAllWindows().find((w) => w !== owner && !w.isDestroyed());
    if (!dialog) return null;
    const count = await dialog.webContents.executeJavaScript("document.querySelectorAll('#account option').length").catch(() => 0);
    return count === 2 ? dialog : null;
  }, 'two-account native chooser');
  await begin();
  const first = await chooser();
  assert.equal(await first.webContents.executeJavaScript("document.getElementById('origin').textContent"), origin);
  // Native child-frame navigation and pushState must leave the modal alive.
  await guest.executeJavaScript("new Promise(resolve => { history.pushState({}, '', '/same-document#x'); const child=document.getElementById('child'); child.addEventListener('load', () => resolve(true), {once:true}); child.src='/child?reload=1'; })");
  assert.equal(first.isDestroyed(), false);
  await first.webContents.executeJavaScript(`document.getElementById('account').value=${JSON.stringify(ids[1])}; document.getElementById('form').requestSubmit(); true;`);
  const result = await waitFor(() => guest.executeJavaScript('window.passkeyResult'), 'credential assertion');
  assert.equal(result.id, ids[1]);
  await begin();
  const second = await chooser();
  const closed = new Promise((resolve) => second.once('closed', resolve));
  guest.reload();
  await closed;
  finish(null, { offeredAccounts: 2, selectedExpectedAccount: true,
    childNavigationPreserved: true, sameDocumentPreserved: true, mainDocumentCancelled: true });
}).catch((error) => finish(error));
