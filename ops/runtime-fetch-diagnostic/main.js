// A minimal replacement ASAR in a disposable hosted copy, never the real app.
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { Worker } = require('node:worker_threads');
const { report, observeRuntime, request } = require('./request');

const args = process.argv.slice(1);
const value = (name) => args.find((arg) => arg.startsWith(name + '='))?.slice(name.length + 1);
const context = value('--probe-context');
const origin = value('--probe-origin');
if (!['main', 'worker'].includes(context) || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(origin || '')) {
  process.exit(64);
}
for (const [name, directory] of [['userData', '/tmp/freedom-runtime-fetch-probe'], ['crashDumps', '/tmp/freedom-runtime-fetch-probe-crashes']]) {
  fs.mkdirSync(directory, { recursive: true });
  app.setPath(name, directory);
}
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  if (context === 'main') {
    observeRuntime();
    if (await request(origin)) app.exit(0);
    else app.exit(43);
    return;
  }
  const worker = new Worker(path.join(__dirname, 'worker.js'), { workerData: { origin } });
  worker.on('error', (error) => report('worker-error', { name: String(error.name).slice(0, 80) }));
  worker.on('exit', (code) => {
    report('worker-exit', { code });
    app.exit([0, 42].includes(code) ? 0 : 44);
  });
}).catch(() => app.exit(45));
