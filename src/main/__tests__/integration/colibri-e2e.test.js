/**
 * End-to-end battery for the Colibri-backed ENS resolution path.
 *
 * Gated by ENS_COLIBRI_E2E=1 — CI does not hit the partner prover by
 * default. Run locally with:
 *
 *   NODE_OPTIONS=--experimental-vm-modules ENS_COLIBRI_E2E=1 \
 *     npx jest src/main/__tests__/integration/colibri-e2e.test.js
 *
 * The Colibri CJS shim loads the emscripten glue via dynamic import, so
 * Jest needs VM Modules enabled.
 *
 * Verifies the three scenarios the partner is on the hook for:
 *   1. contenthash + addr on a well-known name (verified happy path)
 *   2. NO_RESOLVER on an unregistered name (revert proven correctly)
 *   3. .box contenthash with a known URI and verified Colibri trust
 *
 * ENS_COLIBRI_PRIMARY_NAME defaults to the public ENS integration fixture.
 * Supply ENS_COLIBRI_REVERSE_ADDRESS and ENS_COLIBRI_REVERSE_NAME for a
 * forward-confirmed reverse fixture, and ENS_COLIBRI_BOX_NAME plus
 * ENS_COLIBRI_BOX_URI for a registered contenthash fixture. Missing fixture
 * inputs fail an enabled run; a missing record never passes a positive case.
 *
 * No package mocks — the real @corpus-core/colibri-stateless WASM runs
 * (WASM specifically: since 2.0.5 the package prefers a native addon, which
 * `src/main/ens/colibri-runtime.js` disables — see the comment there).
 * Electron's app.getPath is mocked to a temp dir so the verifier state
 * doesn't pollute the developer's userData folder.
 */

const E2E_ENABLED = process.env.ENS_COLIBRI_E2E === '1';
const describeOrSkip = E2E_ENABLED ? describe : describe.skip;

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mockTempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'colibri-e2e-'));

jest.mock('electron', () => ({
  app: { getPath: () => mockTempUserData },
  ipcMain: { handle: jest.fn() },
  session: { defaultSession: {} },
}));
// Plain Node has no Electron network stack, so this live check dials with
// Node's fetch on a stand-in default session, as it did before session-bound
// transport. Routing by session is proven in real Electron by
// session-transport-proxy.test.js.
jest.mock('../../ipfs/gateway-transport', () => ({
  ...jest.requireActual('../../ipfs/gateway-transport'),
  gatewayFetch: (url, init) => fetch(url, init),
  netGatewayFetch: (url, init) => fetch(url, init),
}));

const TIMEOUT_MS = 60_000;
const PRIMARY_NAME = process.env.ENS_COLIBRI_PRIMARY_NAME || 'ur.integration-tests.eth';

// Nothing is stubbed: the real network-registry reads the builtin
// chains.json / endpoint-sources.json, and the fresh temp userData dir has
// no user config — so mainnet resolves to its `colibri` default against the
// default prover. The Colibri package is NOT mocked — real WASM, real prover.
const {
  resolveEnsContent,
  resolveEnsAddress,
  resolveEnsReverse,
  clearEnsResolutionCaches,
} = require('../../ens-resolver');
const { clearColibriClientForTest } = require('../../ens/colibri-resolver');

beforeEach(() => {
  clearEnsResolutionCaches();
});

afterAll(() => {
  clearColibriClientForTest();
  try { fs.rmSync(mockTempUserData, { recursive: true, force: true }); }
  catch { /* best-effort cleanup */ }
});

describeOrSkip('colibri e2e against mainnet1.colibri-proof.tech', () => {
  test('resolves the fixture contenthash with verified Colibri trust', async () => {
    const result = await resolveEnsContent(PRIMARY_NAME);
    expect(result.type).toBe('ok');
    expect(result.uri).toMatch(/^(ipfs|ipns|bzz):\/\//);
    expect(result.trust).toMatchObject({
      level: 'verified',
      method: 'colibri',
      prover: 'mainnet1.colibri-proof.tech',
    });
  }, TIMEOUT_MS);

  test('resolves the fixture to a non-zero address', async () => {
    const result = await resolveEnsAddress(PRIMARY_NAME);
    expect(result.success).toBe(true);
    expect(result.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(result.address.toLowerCase()).not.toBe('0x' + '0'.repeat(40));
    expect(result.trust.method).toBe('colibri');
  }, TIMEOUT_MS);

  test('reverse-resolves the pinned address to its forward-confirmed name', async () => {
    const address = process.env.ENS_COLIBRI_REVERSE_ADDRESS;
    const name = process.env.ENS_COLIBRI_REVERSE_NAME;
    expect(address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(name).toMatch(/\.eth$/);
    const result = await resolveEnsReverse(address);
    expect(result.success).toBe(true);
    expect(result.name).toBe(name);
    expect(result.trust).toMatchObject({
      level: 'verified',
      method: 'colibri',
      prover: 'mainnet1.colibri-proof.tech',
    });
  }, TIMEOUT_MS);

  test('unregistered name surfaces as NO_RESOLVER (verified revert)', async () => {
    const result = await resolveEnsContent('this-name-definitely-does-not-exist-zzz-12345.eth');
    expect(result.type).toBe('not_found');
    expect(result.reason).toBe('NO_RESOLVER');
    expect(result.trust.method).toBe('colibri');
  }, TIMEOUT_MS);

  test('.box contenthash resolves to the pinned URI with verified Colibri trust', async () => {
    const name = process.env.ENS_COLIBRI_BOX_NAME;
    const uri = process.env.ENS_COLIBRI_BOX_URI;
    expect(name).toMatch(/\.box$/);
    expect(uri).toMatch(/^(ipfs|ipns|bzz):\/\//);
    const result = await resolveEnsContent(name);
    expect(result.type).toBe('ok');
    expect(result.uri).toBe(uri);
    expect(result.trust).toMatchObject({ level: 'verified', method: 'colibri' });
  }, TIMEOUT_MS);
});
