const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Use Node's real CJS/ESM loaders and installed SDKs, outside Jest's mocks and
// transform registry. This performs no signing, HTTP request or key access.
const probe = String.raw`
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(path.join(process.cwd(), 'package.json'));
const consumers = ['@ethersphere/bee-js', '@x402/core/schemas', '@x402/evm'];
const resolutions = consumers.map(consumer => {
  const own = createRequire(require.resolve(consumer));
  const resolved = own.resolve('zod');
  const version = own('zod/package.json').version;
  const parts = version.split('.').map(Number);
  assert(parts[0] >= 4 && (parts[0] > 4 || parts[1] > 6 || (parts[1] === 6 && parts[2] >= 6)));
  assert.equal(own('zod').z.core.version.major, 4);
  return { consumer, resolved, version };
});
assert.equal(new Set(resolutions.map(row => row.resolved)).size, 1);
const cjs = require('@x402/core/schemas');
const esm = await import('@x402/core/schemas');
assert.equal(cjs.z.core.version.major, 4);
assert.equal(esm.z.core.version.major, 4);
const req1 = { scheme: 'exact', network: 'base', maxAmountRequired: '1', resource: 'https://merchant.example/item',
  description: 'fixture', payTo: '0x0000000000000000000000000000000000000001', maxTimeoutSeconds: 60, asset: '0x0000000000000000000000000000000000000002' };
const req2 = { scheme: 'exact', network: 'eip155:8453', amount: '1', asset: req1.asset, payTo: req1.payTo, maxTimeoutSeconds: 60 };
const v1 = { x402Version: 1, accepts: [req1] };
const v2 = { x402Version: 2, resource: { url: 'https://merchant.example/item', tags: ['fixture'] }, accepts: [req2], extensions: { fixture: { nested: [1, null, true] } } };
const payload1 = { x402Version: 1, scheme: 'exact', network: 'base', payload: { signature: 'inert-fixture' } };
const payload2 = { x402Version: 2, resource: v2.resource, accepted: req2, payload: { signature: 'inert-fixture' }, extensions: v2.extensions };
const outcomes = [];
for (const [format, sdk] of [['cjs', cjs], ['esm', esm]]) {
  for (const value of [v1, v2]) assert.equal(sdk.parsePaymentRequired(value).success, true);
  for (const value of [payload1, payload2]) assert.equal(sdk.parsePaymentPayload(value).success, true);
  assert.deepEqual(sdk.parsePaymentRequired(v2).data.extensions, v2.extensions);
  for (const value of [null, {}, { ...v1, x402Version: '1' }, { ...v2, accepts: [] },
    { ...v2, accepts: [{ ...req2, maxTimeoutSeconds: -1 }] }, { ...v2, extensions: [] }]) {
    assert.equal(sdk.parsePaymentRequired(value).success, false);
  }
  const oversized = sdk.parsePaymentRequired({ ...v2, resource: { ...v2.resource, tags: Array(24).fill(0) } });
  assert.equal(oversized.success, false);
  assert.equal(oversized.error.issues.length, 1);
  assert.equal(oversized.error.issues[0].code, 'too_big');
  assert.deepEqual(oversized.error.issues[0].path, ['resource', 'tags']);
  let visits = 0;
  const bounded = sdk.z.array(sdk.z.any().superRefine(() => { visits++; })).max(5).safeParse(Array(24).fill(0));
  assert.equal(bounded.success, false);
  assert.equal(visits, 0);
  outcomes.push({ format, validRequirements: 2, validPayloads: 2, invalidRequirements: 6, oversizedIssueCount: oversized.error.issues.length, elementVisits: visits });
}
const cjsClient = require('@x402/core/client');
const esmClient = await import('@x402/core/client');
assert.equal(typeof cjsClient.x402Client, 'function');
assert.equal(typeof esmClient.x402Client, 'function');
for (const format of ['cjs', 'esm']) {
  const http = format === 'cjs' ? require('@x402/core/http') : await import('@x402/core/http');
  assert.deepEqual(http.decodePaymentRequiredHeader(Buffer.from(JSON.stringify(v2)).toString('base64')), v2);
}
assert(Object.keys(require('@x402/evm')).length > 0);
assert(Object.keys(await import('@x402/evm')).length > 0);
const { Address4, Address6 } = require('ip-address');
assert.equal(new Address4('192.0.2.1').correctForm(), '192.0.2.1');
assert.equal(new Address6('2001:db8::1%eth0').zone, '%eth0');
assert.throws(() => new Address6('::1' + '%'.repeat(4096) + '\ninvalid'));
console.log(JSON.stringify({ consumers: resolutions.map(({ consumer, version }) => ({ consumer, version })), sharedResolution: true, outcomes, entrypointsLoaded: true, addressInputsChecked: true }));
`;

let result;
beforeAll(() => {
  result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  }));
}, 35_000);

test('Bee and both x402 consumers resolve the patched v4 implementation', () => {
  expect(result.sharedResolution).toBe(true);
  expect(result.consumers.map(row => row.consumer)).toEqual(['@ethersphere/bee-js', '@x402/core/schemas', '@x402/evm']);
});

test.each(['cjs', 'esm'])('%s x402 accepts valid V1/V2 requirements and inert payloads', (format) => {
  expect(result.outcomes.find(row => row.format === format)).toMatchObject({ validRequirements: 2, validPayloads: 2 });
});

test.each(['cjs', 'esm'])('%s x402 rejects malformed requirements and oversized tags before visiting elements', (format) => {
  expect(result.outcomes.find(row => row.format === format)).toMatchObject({ invalidRequirements: 6, oversizedIssueCount: 1, elementVisits: 0 });
});

test('real client, HTTP and EVM entrypoints load in both module formats', () => {
  expect(result.entrypointsLoaded).toBe(true);
});

test('IPv4 and ordinary IPv6 zones work and an oversized invalid zone suffix is refused', () => {
  expect(result.addressInputsChecked).toBe(true);
});
