/**
 * Integration test: namespace discovery decides, in Chromium itself, which
 * names go to the Handshake guard without an ordinary DNS lookup first
 * (`src/main/network-manager.js`, `fetchHnsNamespaces` and
 * `setImportedHnsRoots`); no page can have such a name looked up through a
 * prefetch hint (`src/main/blink-settings.js`); every session answers right
 * after a root-set change (`src/main/session-proxy-controller.js`); and the
 * discovery request carries no cookie, takes no redirect and keeps no cache.
 *
 * The unit suites pin the PAC text, the switch and the fetch options on
 * fakes, and infer from the PAC that a listed root is never looked up. This
 * spawns Electron on `hns-namespace-discovery-electron-probe.js`, which runs
 * Chromium's resolver against a local DNS-over-HTTPS server so every lookup
 * is seen where it is made, rather than inferred, and asserts the probe's
 * report. It runs the probe twice: as Freedom starts, and once more with
 * DNS prefetching explicitly enabled, the positive control that requires
 * the page's prefetch hints to reach the resolver. Nothing it dials leaves
 * the machine.
 *
 * Skipped when the Electron binary cannot be resolved; the `ipfs-gateway-proxy`
 * CI job sets `FREEDOM_ELECTRON_NET_TEST=1`, which turns a missing binary into
 * a failure instead (see `ipfs-gateway-proxy.test.js` for the details).
 */

const path = require('path');
const { runProbe: runProbeProcess } = require('./hns-discovery-probe-runner');
// Hosted runners append a DNS search suffix to names that do not exist; see
// this module, which the unit job tests on its own.
const { under, namesSeen } = require('./hns-discovery-probe-names');

const REQUIRED = process.env.FREEDOM_ELECTRON_NET_TEST === '1';

function electronBinaryPath() {
  try {
    // Outside Electron, `require('electron')` resolves to the installed
    // binary's path (the package's own `path.txt`), on every platform.
    const resolved = jest.requireActual('electron');
    return typeof resolved === 'string' ? resolved : null;
  } catch {
    return null;
  }
}

const ELECTRON_PATH = electronBinaryPath();
if (REQUIRED && !ELECTRON_PATH) {
  throw new Error(
    'FREEDOM_ELECTRON_NET_TEST=1 but no Electron binary is installed — fetch it with ' +
      '`node -e "require(\'electron\')"` (npm ci does not, at any --ignore-scripts setting)'
  );
}
const describeWithElectron = ELECTRON_PATH ? describe : describe.skip;

const PROBE = path.join(__dirname, 'hns-namespace-discovery-electron-probe.js');
const PROBE_TIMEOUT_MS = 90_000;
const LISTED = 'hnsprobe';
const PIRATE = 'pirate';
const UNLISTED = 'unlistedprobe';
const GUESTS = ['default', 'private'];

const ROUNDS = ['', '-r2'];
const isHint = (name) => /^(header|html)-/.test(name);
// The hinted names one guest's page carries in one round, as the probe builds them.
const hintNames = (guest, round) => ['header', 'html'].flatMap((form) =>
  [LISTED, PIRATE, UNLISTED].map((root) => `${form}-${guest}${round}.${root}`));
const imageNames = (round) => GUESTS.map((guest) => `img-${guest}${round}.${UNLISTED}`);

function runProbe(env = {}) {
  return runProbeProcess({
    electronPath: ELECTRON_PATH, probePath: PROBE, timeoutMs: PROBE_TIMEOUT_MS, env,
  });
}

describeWithElectron('HNS namespace discovery in a real Electron process', () => {
  let results;
  let control;

  beforeAll(async () => {
    results = await runProbe();
    control = await runProbe({ FREEDOM_PROBE_WITHOUT_BLINK_SETTINGS: '1' });
  }, 2 * PROBE_TIMEOUT_MS);

  test('runs on a live guard with no routing failure, and starts with prefetching off', () => {
    expect(results.guard).toMatch(/^PROXY 127\.0\.0\.1:\d+$/);
    expect(results.fatal).toBeNull();
    expect(results.firstRefresh).toEqual([LISTED]);
    expect(results.blinkSettings).toBe('dnsPrefetchingEnabled=false');
    expect(control.blinkSettings).toBe('dnsPrefetchingEnabled=true');
  });

  // The baseline the list exists to change: with only `.pirate` built in, a
  // dotted name is first asked of ordinary DNS and goes DIRECT when it exists.
  test('before any list, a name under the root is looked up in ordinary DNS and goes DIRECT', () => {
    expect(results.beforeDiscovery.existing).toBe('DIRECT');
    expect(namesSeen(results.beforeDiscovery.queried, [`app.${LISTED}`])).toEqual([`app.${LISTED}`]);
  });

  test('a listed root goes to the guard even for a name that also resolves in ordinary DNS', () => {
    expect(results.ordinaryDns.listed).toBe(results.guard);
    expect(results.ordinaryDns.unlisted).toBe('DIRECT');
    expect(namesSeen(results.ordinaryDns.queried, [`www.${UNLISTED}`])).toEqual([`www.${UNLISTED}`]);
  });

  // A resolver that answers every name would send an unlisted Handshake name
  // DIRECT to whatever it made up; a listed root never asks it.
  test('a resolver that fabricates answers cannot pull a listed root off the guard', () => {
    expect(results.honestResolver.unlistedMissing).toBe(results.guard);
    expect(results.fabricatingResolver.unlistedMissing).toBe('DIRECT');
    expect(results.fabricatingResolver.listedMissing).toBe(results.guard);
    expect(results.honestResolver.queried.filter(under(LISTED))).toEqual([]);
    expect(namesSeen(results.honestResolver.queried, [`gone.${UNLISTED}`])).toEqual([`gone.${UNLISTED}`]);
    expect(results.fabricatingResolver.queried.filter(under(LISTED))).toEqual([]);
    expect(namesSeen(results.fabricatingResolver.queried, [`missing.${UNLISTED}`])).toEqual([`missing.${UNLISTED}`]);
  });

  // Observed at the resolver, so a lookup Chromium makes before or beside the
  // PAC would show here. The unlisted fetch is the control that is seen.
  test('a fetch under a listed root or .pirate is not looked up, and an unlisted one is', () => {
    const { fetches } = results;
    for (const leg of ['listed', 'pirate', 'unlisted']) {
      expect(fetches[leg].error).toMatch(/ERR_TUNNEL_CONNECTION_FAILED/);
    }
    expect(fetches.queried.filter(under(LISTED))).toEqual([]);
    expect(fetches.queried.filter(under(PIRATE))).toEqual([]);
    expect(namesSeen(fetches.queried, [`fetch.${UNLISTED}`])).toEqual([`fetch.${UNLISTED}`]);
  });

  test('both pages load, in a default-session webview and a private-window partition webview, before and after a theme change', () => {
    for (const run of [results, control]) {
      expect(run.pages.hostLoad).toEqual({});
      expect(run.pages.pagesSeen.met).toBe(true);
      // The web preferences update reached both guests before their second pages.
      expect(run.pages.themeApplied.light.met).toBe(true);
      expect(run.pages.themeApplied.dark.met).toBe(true);
      expect(run.pages.secondLoads).toEqual({ default: {}, private: {} });
      expect(run.pages.secondPagesSeen.met).toBe(true);
      expect(run.pages.guestSessions).toEqual({ default: 'default', private: 'private' });
      for (const guest of GUESTS) {
        expect(run.pages.navigated[guest].error).toMatch(/ERR_TUNNEL_CONNECTION_FAILED/);
      }
    }
  });

  // The control: with prefetching explicitly enabled, a page's dns-prefetch hints,
  // in its HTML and in a `Link:` header, are looked up for every root, on the
  // first page and on the second, after the theme change. The probe waited
  // for exactly these lookups before reading. Missing requests still fail;
  // the readiness timeout must not turn them into an optional observation.
  // The private guest prefetches all of a page's hints or none of them, about
  // half the runs each, so only the default guest is required to.
  test('with prefetching enabled, hints are looked up, before and after a theme change', () => {
    const lookups = control.hintLookups.map(({ name }) => name);
    for (const round of ROUNDS) {
      const expected = hintNames('default', round);
      expect(namesSeen(lookups, expected).filter((name) => expected.includes(name))).toEqual([...expected].sort());
      const privateSeen = namesSeen(lookups, hintNames('private', round)).filter((name) => hintNames('private', round).includes(name));
      expect([0, 6]).toContain(privateSeen.length);
    }
  });

  test('as Freedom starts, no page has a name under a listed root or .pirate looked up, from a hint or a load', () => {
    const queried = [...new Set(results.pages.queriedInOrder)];
    // A suffixed lookup under either root would count too.
    expect(queried.filter(under(LISTED))).toEqual([]);
    expect(queried.filter(under(PIRATE))).toEqual([]);
    // Prefetching is off altogether, for unlisted names too, before and after
    // the theme change and for the whole run: several more seconds pass after
    // the pages before it ends.
    expect(queried.filter(isHint)).toEqual([]);
    expect(results.hintLookups).toEqual([]);
    expect(results.runMs - results.pages.loadedAtMs).toBeGreaterThan(3_000);
    // The controls: each guest's unlisted image on both pages, fetched after
    // the hints, is seen, bare or with a search suffix, and nothing else is.
    const expected = ROUNDS.flatMap(imageNames);
    expect(namesSeen(queried, expected)).toEqual([...expected].sort());
  });

  test('the request sends no cookie or header of its own and is never cached', () => {
    const { request } = results;
    // The control: the same session's own default fetch does send the cookie.
    expect(request.controlCookie).toEqual(['probe-session=probe-cookie']);
    expect(request.cookies).toEqual([null, null]);
    // A cacheable answer, asked for twice, reaches the server twice.
    expect(request.paths).toEqual(['/public/hns/namespaces/v1', '/public/hns/namespaces/v1']);
    for (const names of request.headerNames) {
      expect(names).not.toContain('cookie');
      expect(names).not.toContain('authorization');
      expect(names.filter((name) => name.startsWith('x-'))).toEqual([]);
    }
  });

  test('a redirect is refused, not followed', () => {
    expect(results.redirect.error).toMatch(/redirect/i);
    expect(results.redirect.paths).toEqual(['/redirect']);
  });

  test('a body that stalls is unavailable at the 3-second deadline, and an oversized one at 64 KiB', () => {
    expect(results.stall.error).toBe('namespace list deadline exceeded');
    expect(results.stall.ms).toBeGreaterThanOrEqual(2_900);
    expect(results.stall.ms).toBeLessThan(4_500);
    expect(results.oversized.error).toBe('namespace list exceeds 64 KiB');
  });

  // hns-manager.test.js pins the next refresh to 10 minutes after the last;
  // this shows that refresh is all a new root needs, on every session, read
  // straight after it with no wait.
  test('a root added after the last refresh goes to the guard at the next one', () => {
    const { addedRoot } = results;
    expect(addedRoot.before).toBe('DIRECT');
    expect(addedRoot.refresh).toEqual([LISTED, 'laterprobe']);
    expect(addedRoot.after).toEqual({
      defaultSession: results.guard,
      enrolled: results.guard,
      privateSession: results.guard,
      queried: [],
    });
  });

  // Each change reloads every session's PAC and closes its connections; a
  // close that aborted the PAC fetch used to leave a session failing every
  // lookup for about 8 seconds.
  test('every session answers straight after each of a run of root-set changes', () => {
    for (const run of [results, control]) {
      expect(run.routingRounds.rounds).toBe(20);
      expect(run.routingRounds.sessions).toEqual(['defaultSession', 'enrolled', 'privateSession']);
      expect(run.routingRounds.failures).toEqual([]);
    }
  });
});
