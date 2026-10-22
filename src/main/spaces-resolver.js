const { runWithPrivateLogContext, redactForLog } = require('./private/private-log-context');
const { isPrivateWebContents } = require('./private/private-windows');
const { browsingSessionFor } = require('./browsing-transport');
const log = require('./logger');
const { ipcMain } = require('electron');
const IPC = require('../shared/ipc-channels');
const { establishTrust } = require('./spaces/anchors');
const { fetchBytes } = require('./spaces/transport');
const { loadVeritas } = require('./spaces/veritas');
const { parseSpaceHandle } = require('./spaces/names');
const { websiteFromZone } = require('./spaces/website');

/**
 * Verified Spaces browsing.
 *
 * `@space` and finalized `name@space` resolve only to an owner-signed https website:
 *  1. anchors come from src/main/spaces/anchors.js (relay quorum plus a fresh,
 *     proof-of-work-checked Bitcoin header), refreshed every TRUST_TTL_MS;
 *  2. every agreeing relay is asked for a proof of the name, and libveritas
 *     verifies each answer locally against those anchors only (production
 *     options, no dev mode);
 *  3. the owner key is the one at the newest anchor among the proofs that
 *     verify, and at least PROOF_AGREEMENT relays must have proved that same
 *     key, so no single relay can substitute an older proof from before a
 *     transfer. libveritas's ordering (commitment, then delegate records, then
 *     the owner record set's sequence, then anchor height) picks among the
 *     zones under that key;
 *  4. member names additionally need PROOF_AGREEMENT sovereign proofs of that
 *     owner key. Temporary and unfinalized certificates are refused. A parent
 *     zone cannot substitute for the exact member's verified zone;
 *  5. src/main/spaces/website.js reads only that zone's owner-signed `website`.
 *
 * What this cannot rule out: a proof verifies at any of the trusted anchors,
 * which span about 15 days, and owner record sets carry a sequence number but
 * no expiry, so relays that all serve an older set of the current owner's
 * records, or all withhold a newer one, are believed. Relays learn the names
 * looked up. When only two relays agree on the anchors, either of them can
 * block every lookup, by failing or by answering "not found", though neither
 * can make one come out wrong.
 *
 * "Not found" is only an absence from the relays' proofs, not a proof of
 * absence, so it needs PROOF_AGREEMENT relays and is never cached.
 * Requests go through the session the requesting window browses in (a private
 * window's partition, not the default session its chrome runs on), so they follow that
 * session's routing, and each session gets its own resolver and caches, so a
 * private window neither reuses nor reveals another window's lookups.
 * Verification runs on the main thread. libveritas verifies every bundle in a
 * message, requested or not, but by default refuses the compact Groth16
 * receipts, so each receipt it checks is a large succinct one: a 226 KB
 * message with one receipt-bearing bundle verified in about 24 ms on one CPU
 * (2026-10-16), and MAX_PROOF_BYTES keeps a whole message to a handful of
 * them.
 */
const TRUST_TTL_MS = 10 * 60 * 1000;
const RESULT_TTL_MS = 30 * 1000;
const MAX_PROOF_BYTES = 1024 * 1024;
const PROOF_AGREEMENT = 2;

/**
 * The zone to trust among verified answers for one name: the owner key is the
 * one at the newest anchor, and `isBetterThan` (libveritas's ordering) picks
 * among the zones under that key.
 */
function chooseZone(zones, isBetterThan) {
  const newest = zones.reduce((a, b) => (b.anchor > a.anchor ? b : a));
  const current = zones.filter((zone) => zone.script_pubkey === newest.script_pubkey);
  return current.reduce((best, zone) => (isBetterThan(zone, best) ? zone : best));
}

function createSpacesResolver({
  fetch,
  lib = loadVeritas,
  now = Date.now,
  trust = establishTrust,
}) {
  let trusted = null;
  let pendingTrust = null;
  const results = new Map();

  async function trustedAnchors(veritasLib, refresh) {
    if (!refresh && trusted && now() - trusted.at < TRUST_TTL_MS) return trusted.value;
    if (!pendingTrust) {
      pendingTrust = trust({ fetch, lib: veritasLib, now })
        .then((value) => {
          trusted = { value, at: now() };
          return value;
        })
        .finally(() => {
          pendingTrust = null;
        });
    }
    return pendingTrust;
  }

  async function queryRelay(veritasLib, relay, handle, veritas) {
    let bytes;
    try {
      ({ bytes } = await fetchBytes(fetch, `${relay.url}/query?q=${encodeURIComponent(handle)}`, {
        limit: MAX_PROOF_BYTES,
      }));
    } catch (err) {
      return { relay, error: `${relay.name}: ${err.message}` };
    }
    const owned = [];
    const own = (object) => {
      owned.push(object);
      return object;
    };
    try {
      const ctx = own(new veritasLib.QueryContext());
      ctx.addRequest(handle);
      const message = own(new veritasLib.Message(bytes));
      const verified = own(veritas.verifyWithOptions(ctx, message, veritasLib.VERIFY_DEFAULT()));
      // zones() hands back plain objects, which outlive the wasm ones.
      const zone = verified
        .zones()
        .find((candidate) => candidate.handle === handle && candidate.canonical === handle);
      return zone ? { relay, zone } : { relay, notFound: true };
    } catch (err) {
      const message = String(err?.message || err);
      // libveritas: the requested space is not among the leaves this relay's
      // proof holds. Any other space missing is just a bad message.
      if (message === `space ${handle} not found in proof`) return { relay, notFound: true };
      return { relay, error: `${relay.name}: ${message}` };
    } finally {
      for (const object of owned) object.free();
    }
  }

  async function attempt(veritasLib, name, refresh) {
    const { handle, member } = name;
    let anchors;
    try {
      anchors = await trustedAnchors(veritasLib, refresh);
    } catch (err) {
      return { type: 'error', handle, reason: 'ANCHORS_UNAVAILABLE', message: err.message };
    }
    const anchorSet = new veritasLib.Anchors(JSON.stringify(anchors.entries));
    let outcomes;
    try {
      const veritas = new veritasLib.Veritas(anchorSet);
      try {
        outcomes = await Promise.all(
          anchors.relays.map((relay) => queryRelay(veritasLib, relay, handle, veritas))
        );
      } finally {
        veritas.free();
      }
    } finally {
      anchorSet.free();
    }

    const proved = outcomes.filter((outcome) => outcome.zone);
    const detail = (others) =>
      others
        .map(
          (outcome) =>
            outcome.error ||
            `${outcome.relay.name}: ${outcome.notFound ? 'name not in its proof' : 'proved another owner key'}`
        )
        .join('; ');
    if (proved.length) {
      let zone = chooseZone(
        proved.map((outcome) => outcome.zone),
        (a, b) => veritasLib.zoneIsBetterThan(a, b)
      );
      const agreeing = proved.filter(
        (outcome) => outcome.zone.script_pubkey === zone.script_pubkey
      );
      if (agreeing.length < PROOF_AGREEMENT) {
        return {
          type: 'error',
          handle,
          reason: 'PROOF_UNCONFIRMED',
          message:
            `${agreeing.length} of ${outcomes.length} relays proved the current owner key, ` +
            `${PROOF_AGREEMENT} needed (${detail(outcomes.filter((outcome) => !agreeing.includes(outcome)))})`,
        };
      }
      if (member) {
        const finalized = agreeing.filter((outcome) => outcome.zone.sovereignty === 'sovereign');
        if (finalized.length < PROOF_AGREEMENT) {
          return {
            type: 'refused',
            handle,
            reason: 'MEMBER_NOT_FINAL',
            anchorHeight: zone.anchor,
            trustRoot: anchors.root,
          };
        }
        zone = chooseZone(
          finalized.map((outcome) => outcome.zone),
          (a, b) => veritasLib.zoneIsBetterThan(a, b)
        );
      }
      const website = websiteFromZone(zone);
      const verifiedAt = { anchorHeight: zone.anchor, trustRoot: anchors.root };
      return website.url
        ? { type: 'ok', handle, url: website.url, ...verifiedAt }
        : { type: 'refused', handle, reason: website.reason, ...verifiedAt };
    }
    if (outcomes.filter((outcome) => outcome.notFound).length >= PROOF_AGREEMENT) {
      return { type: 'refused', handle, reason: 'SPACE_NOT_FOUND' };
    }
    return { type: 'error', handle, reason: 'PROOF_UNVERIFIED', message: detail(outcomes) };
  }

  async function resolve(input) {
    const name = parseSpaceHandle(input);
    if (!name) {
      return { type: 'refused', handle: String(input ?? '').trim(), reason: 'INVALID_HANDLE' };
    }
    const cached = results.get(name.handle);
    if (cached && now() - cached.at < RESULT_TTL_MS) return cached.result;

    // Loading the verifier is not a relay failure: if it throws, so does this.
    const veritasLib = lib();
    let result = await attempt(veritasLib, name, false);
    // Proofs may sit at an anchor newer than a cached set; retry once fresh.
    if (['PROOF_UNVERIFIED', 'PROOF_UNCONFIRMED'].includes(result.reason)) {
      result = await attempt(veritasLib, name, true);
    }
    if (result.type !== 'error' && result.reason !== 'SPACE_NOT_FOUND') {
      results.set(name.handle, { result, at: now() });
    }
    return result;
  }

  return { resolve };
}

const resolvers = new WeakMap();

function resolverFor(targetSession) {
  let resolver = resolvers.get(targetSession);
  if (!resolver) {
    resolver = createSpacesResolver({ fetch: (url, init) => targetSession.fetch(url, init) });
    resolvers.set(targetSession, resolver);
  }
  return resolver;
}

// Electron keeps an in-memory partition's session object alive after its
// private window closes, so its lookups are dropped explicitly.
function forgetSpacesSession(targetSession) {
  resolvers.delete(targetSession);
}

async function resolveSpace(targetSession, handle) {
  if (!targetSession) {
    return { type: 'error', handle: String(handle ?? '').trim(), reason: 'SESSION_UNAVAILABLE' };
  }
  const result = await resolverFor(targetSession).resolve(handle);
  if (result.type === 'error') {
    log.warn(
      `[spaces] ${redactForLog(result.handle)}: ${result.reason} ${redactForLog(result.message || '')}`
    );
  } else {
    log.info(
      `[spaces] ${redactForLog(result.handle)}: ${result.type === 'ok' ? 'verified website' : result.reason}`
    );
  }
  return result;
}

// `browsingSessionFor` (src/main/browsing-transport.js) picks the session the
// window's tabs browse in; a sender without a live window, or a private window
// whose partition is already gone, gets none, never the default session.
function registerSpacesIpc() {
  ipcMain.handle(IPC.SPACES_RESOLVE, async (event, payload = {}) =>
    runWithPrivateLogContext(isPrivateWebContents(event.sender), () =>
      resolveSpace(browsingSessionFor(event.sender), payload.handle)
    )
  );
}

module.exports = {
  browsingSessionFor,
  chooseZone,
  createSpacesResolver,
  forgetSpacesSession,
  registerSpacesIpc,
  resolveSpace,
};
