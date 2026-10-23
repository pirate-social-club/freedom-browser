# Verified Spaces browsing

Type `@space` or `name@space` into the address bar. Freedom checks the exact
name's proof locally with libveritas, then opens the one HTTPS website signed
by its current owner. The name stays in the address bar. A parent space's
website does not stand in for a member's website. Member names require at
least two relays to prove a finalized sovereign certificate for the same owner
key; pending and temporary member certificates cannot open a website.

The owner's signature authenticates the destination URL. Its HTTPS connection
uses ordinary WebPKI, or Handshake DANE when the destination uses Handshake
and that integration is enabled. The record does not pin a TLS public key.
Different names may sign the same website, in which case they share that
website's origin; Freedom does not create a new origin for each alias.

Trust anchors come from the pinned upstream relay quorum with signature,
freshness and Bitcoin-header checks. Freedom does not independently replay the
whole Bitcoin chain. Proofs may verify at any accepted historical anchor, and
signed website records have a sequence but no expiry. A quorum withholding a
newer record can therefore serve an older valid record of the current owner.
An absent result means the name was absent from enough returned proofs, not
a cryptographic proof of nonexistence. These results are not cached.

Relays learn the names requested. Requests use the requesting window's browsing
session and routing. Each session has separate anchor and result caches;
private-window caches are discarded when that window closes. Normal successful
or refused results are cached for thirty seconds and anchors for ten minutes.
This feature does not provide full DNS or destination privacy.

## Installed member acceptance

The root-name gate remains in `test-e2e/packaged-live/spaces-browsing.spec.js`.
The separate `spaces-member-browsing.spec.js` gate requires a real finalized
member whose owner has already published a signed website. Set
`FREEDOM_E2E_SPACES_MEMBER_LIVE=1`,
`FREEDOM_E2E_SPACES_MEMBER_WEBSITE=member@space=https://site.example/path`, and
`FREEDOM_E2E_EXECUTABLE=/opt/Freedom/freedom`, then run the member spec with the
`packaged-live` project. Use `FREEDOM_E2E_ACCEPTANCE=1` for acceptance so a
missing flag or executable fails instead of skipping. The shown target is an
example; it cannot qualify a real run.

The gate requires the exact expected destination and address-bar name in both
normal and private windows, an absent member refusal, a clean full quit with
no surviving packaged helpers, and the same checks after restarting the same
scratch profile. Keep the system VPN connected. It uses the public relays and
the installed verifier; generated chains and mocked anchors do not qualify.
The existing root and other installed gates remain required as regressions.
