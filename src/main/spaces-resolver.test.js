jest.mock('electron', () => ({
  BrowserWindow: { fromWebContents: jest.fn() },
  ipcMain: { handle: jest.fn() },
  session: { defaultSession: { name: 'default' }, fromPartition: jest.fn() },
}));
jest.mock('./private/private-windows', () => ({
  getPartitionForWebContents: jest.fn(() => null),
  isPrivateWebContents: jest.fn(() => false),
}));

const fs = require('fs');
const path = require('path');
const { BrowserWindow, session } = require('electron');
const privateWindows = require('./private/private-windows');
const { loadVeritas } = require('./spaces/veritas');
const {
  browsingSessionFor,
  chooseZone,
  createSpacesResolver,
  resolveSpace,
} = require('./spaces-resolver');

const FIXTURES = path.join(__dirname, '../../test/fixtures/spaces');
// libveritas_testutil chains (test/fixtures/spaces/freedom_spaces_fixture.rs):
// `@example` with no delegate and owner-signed record sets, `@delegated` whose
// delegate signed a website. They verify with the production options.
const generated = require('../../test/fixtures/spaces/generated-chain.json');
const captured = require('../../test/fixtures/spaces/relay-anchors-2026-10-15.json');

const lib = loadVeritas();
const hex = (value) => Buffer.from(value, 'hex');
const RELAY_A = { name: 'relay-a', url: 'https://relay-a.test' };
const RELAY_B = { name: 'relay-b', url: 'https://relay-b.test' };

function exampleMessage(variant) {
  const message = new lib.Message(hex(generated.root.message));
  if (variant) message.setRecords('@example', hex(generated.root.records[variant]));
  const bytes = Buffer.from(message.toBytes());
  message.free();
  return bytes;
}

function trustOf(entries, root = 'test-root') {
  return jest.fn(async () => ({
    root,
    height: entries[0].block.height,
    entries,
    relays: [RELAY_A, RELAY_B],
  }));
}

/** A fetch answering `/query` per relay from `answers[relayName]`: bytes, or an Error to throw. */
function relaysAnswering(answers) {
  return jest.fn(async (url) => {
    const relay = [RELAY_A, RELAY_B].find((candidate) =>
      url.startsWith(`${candidate.url}/query?q=`)
    );
    if (!relay) throw new Error(`unexpected request ${url}`);
    const answer = answers[relay.name];
    if (answer instanceof Error) throw answer;
    return new Response(answer);
  });
}

function exampleResolver(answers, options = {}) {
  const fetch = relaysAnswering(answers);
  const trust = options.trust || trustOf(generated.root.anchors);
  return { fetch, trust, resolver: createSpacesResolver({ fetch, trust, now: options.now }) };
}

const both = (bytes) => ({ 'relay-a': bytes, 'relay-b': bytes });

describe('verified Spaces resolution', () => {
  test('a root whose owner signed an https website resolves to it', async () => {
    const { fetch, resolver } = exampleResolver(both(exampleMessage('website')));
    await expect(resolver.resolve('@example')).resolves.toEqual({
      type: 'ok',
      handle: '@example',
      url: 'https://example.com/',
      anchorHeight: 144,
      trustRoot: 'test-root',
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://relay-a.test/query?q=%40example',
      expect.anything()
    );
    expect(fetch).toHaveBeenCalledWith(
      'https://relay-b.test/query?q=%40example',
      expect.anything()
    );
  });

  test('the website may carry a path, and the name is case-folded', async () => {
    const { resolver } = exampleResolver(both(exampleMessage('website-path')));
    await expect(resolver.resolve('@Example')).resolves.toMatchObject({
      type: 'ok',
      handle: '@example',
      url: 'https://example.com/c/@example',
    });
  });

  test.each([
    ['http', 'INVALID_WEBSITE_RECORD'],
    ['two-values', 'INVALID_WEBSITE_RECORD'],
    ['two-records', 'INVALID_WEBSITE_RECORD'],
    ['no-website', 'NO_WEBSITE_RECORD'],
    // libveritas drops a set signed by any other key, or for any other name.
    ['foreign-key', 'NO_WEBSITE_RECORD'],
    ['other-name', 'NO_WEBSITE_RECORD'],
  ])('owner record set "%s" is refused as %s', async (variant, reason) => {
    const { resolver } = exampleResolver(both(exampleMessage(variant)));
    await expect(resolver.resolve('@example')).resolves.toEqual({
      type: 'refused',
      handle: '@example',
      reason,
      anchorHeight: 144,
      trustRoot: 'test-root',
    });
  });

  test("a delegate's website is not the owner's", async () => {
    const fetch = relaysAnswering(both(hex(generated.delegated.message)));
    const resolver = createSpacesResolver({ fetch, trust: trustOf(generated.delegated.anchors) });
    await expect(resolver.resolve('@delegated')).resolves.toMatchObject({
      type: 'refused',
      reason: 'NO_WEBSITE_RECORD',
    });
  });

  test('a relay that withholds the records does not hide them', async () => {
    const { resolver } = exampleResolver({
      'relay-a': exampleMessage(null),
      'relay-b': exampleMessage('website'),
    });
    await expect(resolver.resolve('@example')).resolves.toMatchObject({
      type: 'ok',
      url: 'https://example.com/',
    });
  });

  test("the owner's newer record set wins, whichever relay serves it", async () => {
    for (const [a, b] of [
      ['website', 'website-seq2'],
      ['website-seq2', 'website'],
    ]) {
      const { resolver } = exampleResolver({
        'relay-a': exampleMessage(a),
        'relay-b': exampleMessage(b),
      });
      await expect(resolver.resolve('@example')).resolves.toMatchObject({
        type: 'ok',
        url: 'https://example.org/next',
      });
    }
  });

  test('a record set whose signature was altered is dropped', async () => {
    // The owner's record set ends the message; this byte is in its signature.
    const altered = exampleMessage('website');
    altered[altered.length - 40] ^= 0xff;
    const { resolver } = exampleResolver(both(altered));
    await expect(resolver.resolve('@example')).resolves.toMatchObject({
      type: 'refused',
      reason: 'NO_WEBSITE_RECORD',
    });
  });

  test('one relay proving the owner is not enough', async () => {
    // Byte 50 is inside the message's chain proof, ahead of any records.
    const tampered = exampleMessage('website');
    tampered[50] ^= 0xff;
    for (const answers of [
      { 'relay-a': tampered, 'relay-b': exampleMessage('website') },
      { 'relay-a': new Error('net::ERR_TIMED_OUT'), 'relay-b': exampleMessage('website') },
    ]) {
      const { trust, resolver } = exampleResolver(answers);
      await expect(resolver.resolve('@example')).resolves.toMatchObject({
        type: 'error',
        reason: 'PROOF_UNCONFIRMED',
        message: expect.stringMatching(
          /^1 of 2 relays proved the current owner key, 2 needed \(relay-a: .+\)$/
        ),
      });
      // The anchors are fetched afresh once before giving up.
      expect(trust).toHaveBeenCalledTimes(2);
    }
  });

  test('tampered proofs from every relay are an error', async () => {
    const tampered = exampleMessage('website');
    tampered[50] ^= 0xff;
    const { resolver } = exampleResolver(both(tampered));
    await expect(resolver.resolve('@example')).resolves.toMatchObject({
      type: 'error',
      reason: 'PROOF_UNVERIFIED',
      message: expect.stringMatching(/^relay-a: .+; relay-b: .+/),
    });
  });

  test('proofs against anchors that were not loaded do not verify', async () => {
    const { resolver } = exampleResolver(both(exampleMessage('website')), {
      trust: trustOf(captured.anchors.entries),
    });
    await expect(resolver.resolve('@example')).resolves.toMatchObject({
      type: 'error',
      reason: 'PROOF_UNVERIFIED',
    });
  });

  test('without trusted anchors nothing is queried, and the failure is not cached', async () => {
    const fetch = relaysAnswering({});
    const trust = jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('1 of 4 relays agree'), { code: 'ANCHORS_UNAVAILABLE' })
      );
    const resolver = createSpacesResolver({ fetch, trust });
    await expect(resolver.resolve('@example')).resolves.toEqual({
      type: 'error',
      handle: '@example',
      reason: 'ANCHORS_UNAVAILABLE',
      message: '1 of 4 relays agree',
    });
    await resolver.resolve('@example');
    expect(trust).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('a verifier that fails to load is an exception, not a relay answer', async () => {
    const { fetch, trust } = exampleResolver({});
    const resolver = createSpacesResolver({
      fetch,
      trust,
      lib: () => {
        throw new Error('libveritas_bg.wasm missing');
      },
    });
    await expect(resolver.resolve('@example')).rejects.toThrow('libveritas_bg.wasm missing');
    expect(trust).not.toHaveBeenCalled();
  });

  test('malformed names are refused without a request', async () => {
    const { fetch, trust, resolver } = exampleResolver({});
    for (const input of [
      '@',
      '@-x',
      '@a--b',
      '@under_score',
      '@example.com',
      'a@b@c',
      '@ünï',
      '',
    ]) {
      await expect(resolver.resolve(input)).resolves.toMatchObject({
        type: 'refused',
        reason: 'INVALID_HANDLE',
      });
    }
    expect(trust).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  test('anchors are reused for ten minutes and answers for thirty seconds', async () => {
    let clock = 1_000_000;
    const { fetch, trust, resolver } = exampleResolver(both(exampleMessage('website')), {
      now: () => clock,
    });
    await resolver.resolve('@example');
    await resolver.resolve('@example');
    expect(fetch).toHaveBeenCalledTimes(2);
    clock += 30_001;
    await resolver.resolve('@example');
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(trust).toHaveBeenCalledTimes(1);
    clock += 10 * 60 * 1000;
    await resolver.resolve('@example');
    expect(trust).toHaveBeenCalledTimes(2);
  });
});

describe('Spaces resolution against real relay answers', () => {
  // Both relays' answers for @yahoo at 2026-10-15T21:35Z, verified against the
  // 60 anchors the four relays signed then. @yahoo publishes no records.
  const ROOT = '50e07f73ea36981487d93d3139a108f8740087702b0448dced5f5573eb76b774';
  const realTrust = () => trustOf(captured.anchors.entries, ROOT);
  const capture = (name) => fs.readFileSync(path.join(FIXTURES, name));

  test('@yahoo verifies with no website, at the newer of the two proofs', async () => {
    const fetch = relaysAnswering({
      'relay-a': capture('query-yahoo-atlas.bin'),
      'relay-b': capture('query-yahoo-cosmos.bin'),
    });
    const resolver = createSpacesResolver({ fetch, trust: realTrust() });
    await expect(resolver.resolve('@yahoo')).resolves.toEqual({
      type: 'refused',
      handle: '@yahoo',
      reason: 'NO_WEBSITE_RECORD',
      anchorHeight: 970596,
      trustRoot: ROOT,
    });
  });

  test('a name both relays leave out of their proofs is not found, and that is not cached', async () => {
    const fetch = relaysAnswering(both(capture('query-absent-cosmos.bin')));
    const resolver = createSpacesResolver({ fetch, trust: realTrust() });
    for (let i = 0; i < 2; i++) {
      await expect(resolver.resolve('@freedomabsentprobe7')).resolves.toEqual({
        type: 'refused',
        handle: '@freedomabsentprobe7',
        reason: 'SPACE_NOT_FOUND',
      });
    }
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  test('one relay saying "not found" while the other fails proves nothing', async () => {
    const fetch = relaysAnswering({
      'relay-a': capture('query-absent-cosmos.bin'),
      'relay-b': new Error('net::ERR_CONNECTION_RESET'),
    });
    const resolver = createSpacesResolver({ fetch, trust: realTrust() });
    await expect(resolver.resolve('@freedomabsentprobe7')).resolves.toMatchObject({
      type: 'error',
      reason: 'PROOF_UNVERIFIED',
      message: 'relay-a: name not in its proof; relay-b: net::ERR_CONNECTION_RESET',
    });
  });

  test('a proof about some other missing space is a bad answer, not "not found"', async () => {
    const fetch = relaysAnswering(both(capture('query-absent-cosmos.bin')));
    const resolver = createSpacesResolver({ fetch, trust: realTrust() });
    await expect(resolver.resolve('@yahoo')).resolves.toMatchObject({
      type: 'error',
      reason: 'PROOF_UNVERIFIED',
      message: expect.stringContaining('relay-a: space @freedomabsentprobe7 not found in proof'),
    });
  });
});

describe('choosing among verified zones', () => {
  const zone = (anchor, key, seq) => ({ anchor, script_pubkey: key, seq });
  const bySeq = (a, b) => a.seq > b.seq;

  test("an older anchor cannot bring back a previous owner's records", () => {
    const previousOwner = zone(100, 'k1', 9);
    const currentOwner = zone(136, 'k2', 1);
    expect(chooseZone([previousOwner, currentOwner], bySeq)).toBe(currentOwner);
  });

  test('under the current key, the ordering decides whatever the anchor', () => {
    const newerRecords = zone(100, 'k2', 5);
    expect(chooseZone([zone(136, 'k2', 1), newerRecords], bySeq)).toBe(newerRecords);
  });
});

describe('the session a lookup uses', () => {
  const sender = (overrides = {}) => ({ isDestroyed: () => false, ...overrides });

  beforeEach(() => {
    BrowserWindow.fromWebContents.mockReset().mockReturnValue({ id: 1 });
    privateWindows.getPartitionForWebContents.mockReset().mockReturnValue(null);
    privateWindows.isPrivateWebContents.mockReset().mockReturnValue(false);
    session.fromPartition.mockReset().mockImplementation((partition) => ({ partition }));
  });

  test('a normal window browses in the default session', () => {
    expect(browsingSessionFor(sender())).toBe(session.defaultSession);
  });

  test("a private window uses its partition's session, not its chrome's", () => {
    privateWindows.getPartitionForWebContents.mockReturnValue('private-123');
    privateWindows.isPrivateWebContents.mockReturnValue(true);
    expect(browsingSessionFor(sender())).toEqual({ partition: 'private-123' });
  });

  test('a private window whose partition is gone gets no session', () => {
    privateWindows.isPrivateWebContents.mockReturnValue(true);
    expect(browsingSessionFor(sender())).toBeNull();
  });

  test('a sender without a live window gets no session', () => {
    BrowserWindow.fromWebContents.mockReturnValue(null);
    expect(browsingSessionFor(sender())).toBeNull();
    expect(browsingSessionFor(sender({ isDestroyed: () => true }))).toBeNull();
    expect(browsingSessionFor(null)).toBeNull();
  });

  test('without a session nothing is looked up', async () => {
    await expect(resolveSpace(null, '@example')).resolves.toEqual({
      type: 'error',
      handle: '@example',
      reason: 'SESSION_UNAVAILABLE',
    });
  });
});
