# Spaces fixtures

Inputs for the verified Spaces browsing tests (`src/main/spaces-resolver.test.js`
and `src/main/spaces/*.test.js`). They live outside `src/` so packaged builds
never contain them.

## Real relay answers, 2026-10-15

`relay-anchors-2026-10-15.json` holds what the four upstream certrelay relays
(cosmos, atlas, orion and pulsar, version 0.2.11) answered on `GET /anchors` at
21:35:23Z: each relay's signed `x-anchor-root`, `x-anchor-height` and
`x-anchor-sig` headers and the 60-anchor body, which was byte-identical from
all four. All four signed root `50e07f…` at height 971604. `newestBlockHeader`
is Blockstream's `/api/block/<hash>/header` answer for that newest anchor's
block, mined at 17:24:03Z. `previousSet` is the set cosmos and atlas signed
earlier the same day (root `a9fc2a…` at 971568), with its own newest header,
so the tests can make real, validly signed relays disagree.

`query-yahoo-cosmos.bin` and `query-yahoo-atlas.bin` are the bodies of
`GET /query?q=%40yahoo` from cosmos and atlas at 21:35:41Z; they verify against
the 971604 set at anchors 970596 and 970560. `query-absent-cosmos.bin` is
cosmos's answer for `@freedomabsentprobe7`, a name nobody holds, at 21:40:45Z.

## Generated chains

No live space publishes signed records yet, so the positive path uses a
simulated chain. `generated-chain.json` is the output of
`freedom_spaces_fixture.rs`, an example program for libveritas's own test
utilities: one root space `@example` with no delegate, owner-signed record sets
(a website, a website with a path, a second website at sequence 2, and refused
variants), one set signed by an unrelated key and one signed for another name,
plus `@delegated`, whose delegate signs a website. The messages verify
without dev mode. Every `libveritas_testutil` key comes from one zero-seeded
generator, so the output is deterministic.

Regenerate from a checkout of https://github.com/spacesprotocol/libveritas at
tag v0.4.5 (Rust 1.90 or later; the 2026-10-15 run used `rust:1.91-bookworm`):

```sh
cp freedom_spaces_fixture.rs <libveritas>/testutil/examples/
cd <libveritas>
cargo run --locked -p libveritas_testutil --example freedom_spaces_fixture > generated-chain.json
```
