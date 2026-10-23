# Targeted upstream corrections for 0.7.17

These ports start from the accepted Linux tree `2c7bb661633de1b2732f83a3a808b4124b9e85c8`,
preserved by candidate `6c968a492bf34a6235bd3aa8064a719d01fa881d`, main
`67323617e0453116d2d0e9aaeb9e238f5817936e` and sync
`c9144e810e5b8dd510c13f2b4bceee24b0aeaed8`.

The upstream inputs are PR 765 at `8a671891e85cdf7fdbefc29c7112b23b0dd04d29`,
PR 755 at `06ee52ca1f57398989834e81be4cf639c152e338`, and PR 756 at
`94b0af4eb6cd2d0e37cb886f49449306b99ba3ba`. Each port includes the corrections
present at the PR's merge, including DNS-named ENS over IPNS and the distinct
unnormalized-name warning.

This is a scoped source port, not a complete upstream merge. The common
ancestor is upstream v0.8.7 at `3a8c75e696f7eb7fafae0a0d9fbcd46a4ade23f0`,
320 upstream commits before that upstream head. A trial full merge had 48
conflicts. The previously inspected security-review pin `3b25e5ef` is not an
ancestor of the fork. Broader upstream reconciliation remains separate work.

## Wallet attribution

The accepted fork already derived wallet request identity from the requesting
webview's URL. It did not have upstream's address-bar request-attribution bug
in that path. Its connection banners still read the address bar, and main's
auto-approval check lacked an independent binding between a requesting guest
and the named site's permission. Earlier assessment prose that described the
request path as reading the address bar was too broad.

The port preserves the fork's account/origin permission checks, guest main-frame
restriction, navigation generation checks, Safe sessions and session routing.
Main independently checks the guest's host window and committed origin before
auto-approval. ENS names over IPNS require a matching main-process resolution,
with guest and session validity checked again after the lookup. That lookup
uses the requesting window's browsing session and private log context.
Spaces aliases cannot substitute for a website's HTTPS origin grant.

Renderer requests use the requesting tab's committed identity. Visible-page
banners use that same identity, ignore refreshes for other sites and recheck
after asynchronous work. Tests reproduce the additional delayed-result race
in all three connection banners, including lookup failures and token metadata.
No new IPC channel or process responsibility is introduced: main retains
authorization and network ownership, while the renderer retains presentation.

## ENS and Radicle

All three ENS reverse-result paths require a name to equal its ENSIP-15
normalization. Invalid or oversized claims remain unverified, with their
cause retained for the send review warning. The claim is absent from visible
recipient text. Existing trust and resolver fallback behavior is preserved.

Radicle's OpenSSH encoding adds zero padding to an already aligned private
section. Regression cases cover ASCII aliases across block boundaries and
multibyte UTF-8 aliases. The key derivation and native addon pin are unchanged.

## Qualification

The unchanged source failed the new padding, ENS and main guest-binding
regressions before their fixes. The port also retains the existing fork tests.
Local checks use one worker with bounded CPU and memory, reusing existing
advisory tools; hosted exact-lock CI remains authoritative. The harness tests
and installed successor require fresh execution. Source or unit-test success
does not replace installed acceptance or approve a public release.

The recurring HNS prefetch-control CI failure remains open in the separately
owned `freedom-hns-prefetch-control-flake-20261023` task. Passing runs do not
establish its repair. Dependency and native binary versions are unchanged.
Release identity and update policy are recorded in
[Linux evaluation distribution](../linux-evaluation-release.md).
