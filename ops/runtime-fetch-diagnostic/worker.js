// Representative Node worker only; not a catalog/checkpoint application run.
const { workerData, parentPort } = require('node:worker_threads');
const { observeRuntime, request } = require('./request');

observeRuntime();
request(workerData.origin).then((complete) => {
  parentPort.close();
  process.exit(complete ? 0 : 43);
}).catch(() => process.exit(45));
