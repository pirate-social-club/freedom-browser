# License Audit Report for Freedom Browser (Pirate fork)

Licence of this fork: AGPL-3.0-or-later. Upstream code inside it remains MPL-2.0 (see The AGPL fork posture).

Audit date: 2026-10-15

Baseline: `0.7.15`

Method: re-derived from the installed dependency tree, the committed artifacts and `package.json`'s `build` configuration, then checked by `licenses-audit.test.js`.

This is a practical engineering audit, not legal advice. Final licensing decisions should be reviewed by counsel.

This revision replaces the short AGPL posture note (2026-05-08) that the upstream v0.8.7 merge left in place of upstream's component audit. It starts from upstream's 0.8.7 audit (`git show 3a8c75e6:LICENSE_AUDIT.md`), re-reads each of its records against this tree, and adds the fork's own components: the committed Handshake helpers in `hns-bin/`, the committed V2Ray runtime in `dvpn-bin/`, the Agora Web SDK bundle, the dVPN SDK npm packages, and the fork's own `assets/hns/` and `scripts/jacktrip/` files. The upstream pins are unchanged from 0.8.7 and still match the recorded versions. The production npm tree grew from 273 to 299 unique packages, all of the 26 additions through the dVPN SDK and all permissive, and then to 300 when verified Spaces browsing added `@spacesprotocol/libveritas`.

`package.json` names version 0.7.15, the fork's next release number (no v0.7.15 tag exists yet), so the audit is baselined there rather than at upstream's 0.8.7.

---

## Verdict

Cleared for the Linux x64 evaluation deb. Every component in the tree is compatible with distributing the fork under AGPL-3.0-or-later, and every shipped binary, bundle and data file is classified, attributed and, where it is committed, bound to its exact bytes. `licenses-audit.json` records no blocker.

A package built from this tree was inspected against this inventory. The Linux x64 evaluation deb built by the Linux evaluation deb workflow (run 38852819019) from commit d8aad2be12599235190f64a7ba8fd84f9de27fa9, freedom-browser_0.7.15_amd64.deb with sha256 c9085a4877cc077d9ff1b3002d540bead8f05a981cf8813de5eafec85531ecf6, was extracted and compared on 2026-10-16. resources/ holds ant-bin, freedom-ipfs-node, radicle-bin, hns-bin, dvpn-bin, jacktrip-scripts, assets, ant.yaml, default-bookmarks.json, LICENSE, NOTICES, apparmor-profile and app.asar(.unpacked), all classified here or below; apparmor-profile is electron-builder's generated AppArmor profile for /opt/Freedom/freedom: first-party build output with no third-party content. There is no myotis-bin, arti-bin, geoip.dat or geosite.dat. hnsd, fingertipd, encrypted-validator.json, PROVENANCE.md and v2ray are byte-identical to the committed files, LICENSE and NOTICES are identical to the tree, and app.asar holds only src (no test files), node_modules and package.json. It carries src/renderer/vendor/AgoraRTC_N-4.24.0.js and @spacesprotocol/libveritas 0.4.5 (libveritas.js and libveritas_bg.wasm byte-identical to the locked package), and app.asar.unpacked holds only the Linux x64 better-sqlite3 prebuild of that package. The control file declares libunbound8 and libc6 (>= 2.36). The previous inspection, of the c51e4fe0 deb on 2026-10-15, missed that its app.asar also carried most of the repository (docs, ops, research, scripts, tests and fixtures, agent files): each platform's `files` list held only the better-sqlite3 exclusion, which electron-builder turns into an include-everything matcher. d8aad2be fixes the lists and `scripts/electron-builder-files.test.js` now fails on that configuration. This clears licensing for that evaluation build only, and `licenses-audit.json` records the scope, the inspected commit and what forces a new inspection (changes to the build configuration or extraResources, the helper bundles, the vendored files, NOTICES or LICENSE, or the production dependencies). It is not a public-release decision, and the fork's use of upstream's product name, app id and icons remains an open fork decision.

Two earlier items are closed. Copyright notices that name individual authors are now shipped: the workspace owner ruled that licence and NOTICE text the licences require is copied verbatim even where it names people, while nothing the fork writes itself does. The Handshake helpers and V2Ray ship their upstream licence files unedited in `hns-bin/linux-x64/licenses/` and `dvpn-bin/linux-x64/licenses/`, and `NOTICES` reproduces V2Ray's module copyright lines and the licence files of the libraries embedded in the Agora bundle verbatim. The licence terms behind V2Ray's GeoIP data no longer matter, because the data files no longer ship (see V2Ray).

| Category                                                          | Count       | Status                                                 |
| ----------------------------------------------------------------- | ----------- | ------------------------------------------------------ |
| Production npm packages (unique name@version)                     | 300         | See the distribution below                             |
| External binaries and native addons from upstream in `resources/` | 5           | Ant, freedom-ipfs, libradicle, Myotis, Arti            |
| Helpers committed by this fork in `resources/`                    | 3 binaries  | hnsd, fingertipd, V2Ray                                |
| Vendored renderer bundles in `src/renderer/vendor/`               | 5           | OpenLV, highlight.js, marked, DOMPurify, Agora Web SDK |
| Copyleft code incompatible with AGPL-3.0-or-later                 | 0           | None found                                             |
| GPL-3.0 ad-blocking data and scriptlets (`assets/adblock/`)       | 2 files     | Compatible with the fork's licence; shipped alongside  |
| Weak copyleft (MPL-2.0)                                           | 13 packages | Compatible via MPL-2.0 section 3.3                     |
| Weak copyleft (LGPL-3.0)                                          | 5 packages  | Compatible; kept relinkable in the OpenLV bundle       |

---

## Distribution Model

The fork's Linux target is a deb only (`build.linux.target`). No AppImage or pacman package is built from this tree. The macOS and Windows settings are retained from upstream and are described here as configured. A package carries:

- the Electron application, with Node modules bundled in `app.asar`;
- the committed vendor bundles under `src/renderer/vendor/`, shipped inside `app.asar` by the `src/**/*` files pattern;
- native addons unpacked from asar under `resources/`: `better-sqlite3`, `freedom_ipfs_native.node` (`resources/freedom-ipfs-node/`), `libradicle.node` (`resources/radicle-bin/`), and on macOS and Windows only `myotis-node.node` (`resources/myotis-node/`);
- external binaries in `resources/`:
  - Ant (`antd`, Swarm node), every package
  - Arti (Tor client) — macOS and Windows x64 only (see Arti below)
  - `myotis-supervisor`, compiled from upstream's own C sources (`src/main/myotis/native/`), macOS and Windows only
  - hnsd and fingertipd (`resources/hns-bin/`), Linux x64 only
  - V2Ray and its `licenses/` notice bundle (`resources/dvpn-bin/`), Linux x64 only
- the `assets/` tree, which holds the icons, the ad-blocking lists in `assets/adblock/` (fetched before packaging) and the fork's `assets/hns/` checkpoint and launcher;
- `scripts/jacktrip/` as `resources/jacktrip-scripts/`, the fork's own audio-routing script;
- on Windows, the Microsoft Visual C++ runtime DLLs that `scripts/after-pack.js` places beside each binary that imports them (#563); these are Distributable Code under the Microsoft Visual Studio licence terms and are recorded in `NOTICES`.

---

## The AGPL fork posture

The fork moved Freedom Browser from MPL-2.0 to AGPL-3.0-or-later in 2026-05 (`LICENSE`, `package.json`). Most of the code is still upstream's. Upstream licenses it under MPL-2.0 and none of it carries MPL's Exhibit B ("Incompatible With Secondary Licenses") notice, so MPL-2.0 section 3.3 lets the fork distribute it inside a larger work under a Secondary License, which includes the AGPL. The upstream files do not change licence by being merged: recipients must be told they are MPL-2.0 and how to get the MPL-2.0 text (section 3.1), and their source must be available (section 3.2(a)). Before this revision nothing in the shipped files said so, because `LICENSE` holds only the AGPL text. `NOTICES` now opens with an entry naming the upstream code, its licence, the MPL-2.0 text's location and the fork's own corresponding-source location.

The fork's own obligation is the AGPL's: anyone who receives a package, or interacts with the software over a network, must be able to obtain the corresponding source. The fork's repository is public (https://github.com/pirate-social-club/freedom-browser) and `NOTICES` names it. Build inputs the fork adds, such as the hnsd patch, live in that repository.

`README.md` and `CONTRIBUTING.md` now state the AGPL-3.0-or-later posture, with upstream code remaining MPL-2.0 and contributions taken under AGPL-3.0-or-later. One inconsistency remains a decision for the fork rather than a licence-text fix: the fork ships under upstream's product name, app id and icons, and its deb control file names upstream as Maintainer and Vendor (Freedom Team, browser@freedom.baby) with upstream's Homepage, while MPL-2.0 section 2.3 grants no trademark rights, and upstream's own records call the icons and artwork original Freedom Team work.

Every licence found in the tree is compatible with AGPL-3.0-or-later. Permissive licences (MIT, BSD, ISC, Apache-2.0, 0BSD, BlueOak, Python-2.0, Zlib, CC0) combine freely, Apache-2.0 included because AGPL-3.0 is GPLv3-family. LGPL-3.0 combines on its own terms, which the OpenLV arrangement keeps. GPL-3.0 code could combine under the GPLv3 and AGPLv3 section 13 provisions, so the uBlock files would be acceptable even if they were not a separate aggregate. CC BY-SA data ships alongside rather than combined.

JackTrip is not bundled. The fork manages user- or system-provided JackTrip binaries and ships only its own routing script. Before bundling any JackTrip artifact, record the artifact's exact source and licence here: upstream's signed macOS and Windows builds without the Classic GUI are expected to be MIT, its unsigned builds with the Classic GUI are GPL, and Linux packages must be checked per artifact.

---

## License Classification

Risk levels follow upstream's scheme. Green is permissive with no action beyond carrying the licence text. Yellow is permissive but needs explicit notice or attribution. Orange is copyleft or data terms that need careful handling. Red would be incompatible with distributing the fork under AGPL-3.0-or-later; nothing is red.

---

## Downloaded Runtime Artifacts

Versions here are the pinned values in the repository, not observed downloads; each names its pin so a drift is checkable. `licenses-audit.test.js` asserts that they match. All five pins are unchanged from upstream 0.8.7.

### Ant (antd, Swarm Node)

Ant comes from https://github.com/freedom-hq/ant at version `v0.5.61` (pin: `scripts/fetch-ant.js` `PINNED_RELEASE_TAG`). It is MIT OR Apache-2.0, with upstream shipping `LICENSE-MIT` and `LICENSE-APACHE`. It runs as a separate process reached over IPC, ships in every package, and is attributed in `NOTICES`. Risk: green.

### freedom-ipfs (Native IPFS Addon)

freedom-ipfs comes from https://github.com/solardev-xyz/freedom-ipfs at version `v0.4.5` (pin: `scripts/fetch-freedom-ipfs-native.js`). It is MIT OR Apache-2.0 and loads into the Electron main process as a native addon. Attributed in `NOTICES`. Risk: green.

### libradicle (Native Radicle Addon)

libradicle comes from https://github.com/solardev-xyz/libradicle at version `0.8.0` (pin: `src/shared/radicle-addon-version.js` `RADICLE_ADDON_VERSION`) and loads as a native addon. Upstream commits no licence file; the MIT OR Apache-2.0 claim rests on the `license` field of its `Cargo.toml`, verified upstream at tag `v0.8.0`. It statically links Radicle Heartwood, whose workspace `Cargo.toml` is also MIT OR Apache-2.0. Attributed in `NOTICES`; upstream should be asked to commit the licence texts. Risk: green.

### Myotis (Native Wallet-Engine Addon)

Myotis comes from https://github.com/biafra23/myotis at version `v0.1.14` (pin: `scripts/myotis-release.json` `releaseTag`). It is Apache-2.0 only and runs out of process as `myotis-node.node` under upstream's own supervisor.

Myotis ships in the macOS and Windows builds only.

The fork's Linux deb omits it, because `build.linux.extraResources` does not name `myotis-bin/` (commit adafb252). Upstream ships a `NOTICE` file, so Apache-2.0 section 4(d) requires its attribution text in any redistribution. `NOTICES` reproduces it verbatim; its copyright line names the Myotis author. Upstream's audit recorded that `NOTICE` as byte-identical across v0.1.10 to v0.1.14 (sha256 `ee84afd3b5c6a7c9d1bd9f1c22c915f86a8b42886e3eea8c7cad283603de53e1`). Re-read it on every version bump. Risk: yellow.

### Arti (Tor Client)

Arti comes from https://gitlab.torproject.org/tpo/core/arti (crates.io crate `arti`) at version `2.7.0` (pin: `scripts/fetch-arti.js` `PINNED_ARTI_VERSION`). It is MIT OR Apache-2.0; `LICENSE-MIT` reads "Copyright 2019-2025, The Tor Project, Inc." It runs as a separate process reached over SOCKS.

Arti ships in the macOS and Windows x64 builds only.

The fork's Linux deb omits it, because `build.linux.extraResources` does not name `arti-bin/`; no Windows ARM64 package is built. Arti is built with `cargo install arti --locked`, so the binary statically links the crate's whole dependency tree, which upstream distributes under permissive licences. Re-check the `Cargo.lock` licence set on every version bump. Attributed in `NOTICES`. Risk: green.

### AppImage runtime (not built by this fork)

Upstream 0.8.7's Linux AppImage starts with the static AppImage type-2 runtime (release 20251108), which links a patched libfuse 3.15.0 under LGPL-2.1; upstream's maintainer decided that pointing to the runtime's published source meets LGPL-2.1 section 6. The fork's Linux target is a deb only, so no artifact carries the runtime, and its attribution has been removed from `NOTICES`. If an AppImage target is restored, restore upstream's entry (`git show 3a8c75e6:NOTICES`) and the source pointer with it.

---

## Committed fork helpers

These are not fetched at build time. The exact files are committed under one directory per target, and only `linux-x64` exists, matching `src/shared/platform-capabilities.json`. They have no version pin, so their bytes are the pin: `licenses-audit.test.js` lists every file each directory may hold and fails unless each binary's and data file's sha256 matches the one recorded here and in `licenses-audit.json`.

### Handshake helpers (hnsd and fingertipd)

The Handshake helpers ship in Linux x64 packages only.

`hns-bin/linux-x64/` holds `hnsd`, `fingertipd`, two of the fork's own build records (`PROVENANCE.md` and `encrypted-validator.json`), and the `licenses/` notice bundle described below.

hnsd is `hns-bin/linux-x64/hnsd`, sha256 `d539d508d10773a89f4a4e900b3c2c87b38a130908049d0566a1d03473984a0f`. It is handshake-org/hnsd v2.0.0 at commit `a5c7c287e848f46d3e97f16b698e2027c8dc96c3` with the fork's patch `ops/hns-encrypted-transport/hnsd-encrypted.patch` (sha256 `810edac7e7b991cc9d6ab569ca648a58455b9a43cf09be43f3c6cfea5072de67`), built offline by hosted run 38709852038 in `debian:bookworm-slim`. The original and patched sources, the patch, the toolchain identity, the ELF observations and the artifact are retained under the staging root's `archive/freedom-installed-deb-hosted-acceptance-2026-10-02/integration-start/milestone-2-2026-10-15/run-38709852038/`, and the licence findings below were read from that retained source.

hnsd itself is MIT. Its build links `libhsk` and its vendored libuv statically (`hnsd_LDFLAGS = -static`, libtool static archives only), so the binary contains:

- libuv (vendored in `uv/`), MIT, with the parts libuv lists as externally maintained under BSD-2-Clause (`tree.h`), ISC (`inet_pton` and `inet_ntop`) and BSD-3-Clause (files used only on Windows and Android);
- libsecp256k1 (vendored in `src/secp256k1/`), MIT;
- code adapted from the LND brontide implementation (MIT), Picnic (MIT), easy-ecc (BSD-2-Clause), khash (MIT), chacha20-simple (ISC), poly1305-donna (MIT), RHash (a permissive grant with no notice condition), BLAKE2 (CC0-1.0, OpenSSL or Apache-2.0 at the user's option, used under Apache-2.0 as the checkpoint review chose) and tiny-bignum-c (public domain), each named in the header of the file that uses it.

Nothing copyleft is linked statically. The binary's only dynamic dependencies are `libunbound.so.8` and `libc.so.6` (it requires GLIBC_2.36). libunbound is BSD-3-Clause and at run time loads OpenSSL 3 (Apache-2.0) and libevent (BSD-3-Clause); glibc is LGPL-2.1-or-later. None of them is bundled: the deb declares `libunbound8` and `libc6 (>= 2.36)`, so the user's distribution supplies them and the user can replace them, and no LGPL relinking obligation attaches to the shipped file. Like any GCC build against glibc, the binary contains small start-up objects from glibc and libgcc, which carry licence exceptions for exactly that use; they were not inspected object by object.

fingertipd is `hns-bin/linux-x64/fingertipd`, sha256 `065e4f0d5c118213f09319998c94633033cae7f96dc6d714083208468225f766`. It is pirate-social-club/fingertipd at commit `21f044ebc830eed87e6851ed7216f9590f6f3df3`, MIT, built with Go 1.26.2 and CGO disabled into a static binary. `go version -m` lists exactly four modules: buffrr/letsdane v0.6.1 (Apache-2.0, no `NOTICE` file, so section 4(d) adds nothing and section 4(a) needs only the licence text), miekg/dns v1.1.63 (BSD-3-Clause), and golang.org/x/net v0.31.0 and x/sys v0.27.0 (BSD-3-Clause, The Go Authors). The Go 1.26.2 standard library is BSD-3-Clause under the same text, sha256 `911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad`. The module archives and their licence files were captured on 2026-10-04 under `archive/freedom-installed-deb-hosted-acceptance-2026-10-02/integration-start/fingertip-license-closure-2026-10-04/` for these same bytes. The fingertipd source names no other upstream. Its name echoes imperviousinc/fingertip (Apache-2.0), and no line-by-line comparison with that project was made.

The helpers' notices ship in `hns-bin/linux-x64/licenses/`, ported from the reviewed bundle on the shipped 0.7.15 checkpoint (commit `cb8539104811baba7cdfcdf38c741d820e8ff5fb`). Every file there is a byte-for-byte copy of an upstream file, recorded with its sha256 in `licenses/source-record.json`: hnsd's `LICENSE`, libuv's `LICENSE`, libsecp256k1's `COPYING`, the three BLAKE2 files whose headers carry its licence offer, Debian's copy of the Apache-2.0 text (sha256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`), and `source.tar`, the complete upstream hnsd source (sha256 `d5411e7bac5d0d78bffb392c3af2888abba966ae6e12b8d42ce984949be509b1`), which carries every embedded file header named above; and for fingertipd its MIT `LICENSE`, the licence, copyright and patent files of its four modules, and the Go 1.26.2 notices for the standard library and its vendored golang.org/x packages. The fingertipd part is unchanged, because its binary is. The hnsd part is updated for the new binary: the source archive is the same one (the retained source from run 38709852038 hashes identically), the patch is added as `licenses/hnsd/hnsd-encrypted.patch`, and the record names run 38709852038 and the patched files' digests (`src/rs.c` `3384db0c0981136f88e628e679381b00f92524d1c597d2b0d37480e456aba7fd`, `src/dns.c` `7a558b3369a569c7f2f5a6d65539169367a6b9b7b5cb97d11de098a50d917ecd`, recomputed by applying the patch to that source). The patch touches no file that carries a notice. `licenses-audit.test.js` fails unless every file in the bundle is the one the record names and the record names the shipped binaries. `NOTICES` summarises the same attribution and reproduces libuv's notice and the Go, BSD-2-Clause, ISC and Apache-2.0 texts. Risk: green.

### V2Ray (dVPN transport)

V2Ray ships in Linux x64 packages only.

`dvpn-bin/linux-x64/` holds the V2Ray runtime, `v2ray`, byte-identical to the copy in the official V2Ray v5.2.1 `v2ray-linux-64.zip` (archive sha256 `56eb8d4727b058d10f8ff830bb0121381386b0695171767f38ba410f2613fc9a`), and the `licenses/` notice bundle described below.

`v2ray` has sha256 `bf9699e6b3665f749b63bdead2e1a95a00b10d9901a9a952858b9e17d4bc43dd`. Its embedded build information names commit `42b166760b2ba8d984e514b830fcd44e23728e43`, the v5.2.1 tag, built by Go 1.19.4 with CGO disabled. V2Ray is MIT, "Copyright (c) 2015-2022 V2Fly Community", and the release archive ships no licence file. The binary statically links the Go 1.19.4 standard library (BSD-3-Clause, The Go Authors) and 52 Go modules. Each module's licence was read from its proxy.golang.org archive at the exact version: 25 are MIT, 13 BSD-3-Clause, 3 BSD-2-Clause, 8 Apache-2.0, and 3 combine licences (klauspost/compress is BSD-3-Clause AND Apache-2.0 AND MIT; go-toml v1.9.5 and gopkg.in/yaml.v3 are MIT AND Apache-2.0). None is copyleft and none is unidentified. Two Apache-2.0 modules ship `NOTICE` files, google.golang.org/grpc v1.51.0 and gopkg.in/yaml.v3 v3.0.1, and `NOTICES` reproduces both verbatim. `NOTICES` lists every module with its version and licence, and copies each module's copyright lines verbatim from its LICENSE file.

The modules' own notices also ship in `dvpn-bin/linux-x64/licenses/`. `v2ray/` holds every licence, copyright, notice and patent file at the top of each module's proxy.golang.org archive, copied unedited (72 files across V2Ray itself, its 52 modules, and Go 1.19.4's notices for the standard library and its vendored golang.org/x packages). `source-record.json` records each archive's sha256, each file's sha256 and the shipped binary's digest. Each of the 52 module archives was also checked against the `h1:` sum the binary embeds, and all match, so the notices come from exactly the module versions the binary was built from. `licenses-audit.test.js` fails unless every file in the bundle is the one the record names and the record names the shipped binary. Risk: yellow, for the `NOTICE` files.

V2Ray's two data files are no longer shipped. The release archive also carries `geoip.dat` and `geosite.dat`, and earlier integration builds shipped both. `geoip.dat` (sha256 `1af779bf9ba759be7590be3b3baf83d7e5c686b003f6f39dd3ab0e847eaedb72`, v2fly/geoip release 202301120046, CC-BY-SA-4.0) was converted from MaxMind GeoLite2 data, whose current End User License Agreement adds a 30-day update-and-destroy duty and a disclosure-consent duty beyond CC BY-SA 4.0. Whether those duties bind a redistributor was never settled, because the files turned out to be unused. On 2026-10-15 the shipped V2Ray 5.2.1 was checked at run time: it validated and started with the SDK-shaped configuration (routing by inboundTag only, no `geoip:` or `geosite:` rules) and no geo files present, and blue-js-sdk's preflight checks only for the `v2ray` binary. Both files were then removed from `dvpn-bin/linux-x64/` and `src/shared/platform-capabilities.json`, the Linux deb workflow fails if either appears in the package, and `licenses-audit.test.js` fails if either comes back unclassified. Re-attribute them, and settle the GeoLite terms, before shipping any geo data again.

---

## Vendored Renderer Bundles (`src/renderer/vendor/`)

These are pre-built third-party files committed into the repository. The npm-dependencies line in `NOTICES` does not cover them, so each needs its own attribution; missing that is how a GPL-3.0 library once shipped unnoticed.

| File                                               | Component                                                                | Version       | License                  | Risk   |
| -------------------------------------------------- | ------------------------------------------------------------------------ | ------------- | ------------------------ | ------ |
| `openlv.esm.js`                                    | OpenLV (`@openlv/{core,session,signaling,transport}`) and websocket-mqtt | 0.2.0 / 0.0.7 | LGPL-3.0-only / LGPL-3.0 | Orange |
| `highlight.min.js`, `hljs-github-{dark,light}.css` | highlight.js                                                             | 11.11.1       | BSD-3-Clause             | Green  |
| `marked.min.js`                                    | marked                                                                   | 15.0.7        | MIT                      | Green  |
| `purify.min.js`                                    | DOMPurify                                                                | 3.2.5         | MPL-2.0 OR Apache-2.0    | Green  |
| `AgoraRTC_N-4.24.0.js`                             | Agora Web SDK (`agora-rtc-sdk-ng`), added by this fork                   | 4.24.0        | MIT (registry metadata)  | Yellow |

### The LGPL question: OpenLV

`@openlv/*` and the websocket-mqtt signaling backend they pull in are LGPL-3.0, so LGPL-3.0 section 4 applies: a user must be able to relink the application against a modified version of the library. `scripts/bundle-openlv.js` meets this by construction. It emits one standalone ES module, `src/renderer/vendor/openlv.esm.js`, containing only upstream code, which the renderer loads by dynamic import (`src/renderer/lib/wallet/remote-session.js`). A user can replace that file inside `app.asar` or re-run `npm run vendor:openlv` against their own build, and `NOTICES` says so. Never inline the bundle into an app bundle or mix Freedom code into it; either would turn a met obligation into one the fork cannot meet. The AGPL does not change this, because the LGPL's own terms still apply to the library.

### Agora Web SDK

`AgoraRTC_N-4.24.0.js` (sha256 `f440fa2dbf56983fcc80a0443f2e4d2413aaee264c3a64a35d9e01f2b7e3c98b`) is byte-identical to `AgoraRTC_N-production.js` in the npm package `agora-rtc-sdk-ng@4.24.0` (registry integrity `sha512-2apG/07EtsuX21ncSF77q+dr6/kDgu9B/RpKtstCtaq46l4/Eraoecewi4zXRUCY3Im+8dzTIXx6jUwyPdxdHQ==`) and to `https://download.agora.io/sdk/release/AgoraRTC_N-4.24.0.js`. Only the fork's live-room page loads it.

Its licence rests on registry metadata alone. The package's `license` field says MIT, but the package ships no licence file, its repository (AgoraIO/agora-rtc-web) commits none, and the bundle's banner reads only "Copyright AgoraInc." with no licence name. That is why the test pins the bytes instead of reading a header. `NOTICES` attributes the bundle and points to the MIT text.

The minified bundle also embeds third-party libraries, identified from code and strings inside it. `NOTICES` reproduces each one's licence file verbatim from its npm package. Three versions are established, because the bundle states them. core-js-pure is 3.42.0: the bundle registers `{version: "3.42.0", mode: "pure"}` and links core-js's v3.42.0 licence. axios is 1.9.0, from its `VERSION` constant. ua-parser-js is 0.7.40, from its `VERSION` constant; that is the MIT-licensed 0.7 line, not the AGPL 2.x line.

Four versions are inferred, because the bundle does not state them. Each library's licence file is byte-identical across the whole candidate range, so the reproduced notice holds whichever version it is.

- webrtc-adapter (BSD-3-Clause), from its `shimGetParameters` and related shims: 7.6.2 to 9.0.6, the releases that contain all of them; 41 releases checked from 7.0.0.
- sdp (MIT), the SDP utilities adapter depends on, from its session boilerplate and RTP parsers: 2.0.0 to 3.2.2.
- pako (MIT, with zlib-derived code under Zlib), from its deflate and inflate identifiers and its zlib 1.2.12 mode numbering: 2.1.0 or 2.2.0.
- formdata-polyfill (MIT), from its banner and multipart encoder: 4.0.5 to 4.0.10, the releases that carry that banner.

Agora publishes no source map or dependency list, so smaller embedded code that left no recognisable trace could still be missing; a fingerprint sweep for some forty other common libraries found none. Agora should still be asked for a licence file and a third-party notice list.

### MPL-2.0 packages

Thirteen production packages are MPL-2.0: `@ghostery/adblocker` and its `@remusao/*` and `@ghostery/url-parser` helpers, `@ethereumjs/{rlp,tx,util}`, and DOMPurify under its MPL arm. None carries an Exhibit B notice (the installed tree was searched for one), so MPL-2.0 section 3.3 lets them sit inside the AGPL work. The fork consumes all of them unmodified, so no MPL source-disclosure obligation is triggered beyond what npm already ships.

---

## Electron Framework

Electron 44.9.3 (lockfile-resolved) is MIT and embeds Chromium, which contains hundreds of third-party components under their own licences. Risk: yellow, because it needs notice.

### Chromium's third-party notices

Electron generates every Chromium third-party notice into a single `LICENSES.chromium.html` in its dist directory, beside the executable. Freedom distributes that file with every package, and `NOTICES` names its location per platform:

| Platform | Location in the shipped artifact                        | How it gets there                                          |
| -------- | ------------------------------------------------------- | ---------------------------------------------------------- |
| Linux    | beside `freedom` (`/opt/Freedom/` in the deb)           | copied verbatim from the Electron dist by electron-builder |
| Windows  | beside `Freedom.exe` in the installation directory      | same                                                       |
| macOS    | `Freedom.app/Contents/Resources/LICENSES.chromium.html` | `package.json` `build.mac.extraResources`                  |

The macOS row is an explicit copy because electron-builder deletes the file on the macOS path (`unlinkIfExists(path.join(appOutDir, "LICENSES.chromium.html"))` in `app-builder-lib/out/electron/electronMac.js`), and even unremoved it would sit beside `Freedom.app` rather than inside it. `scripts/build.js` fails the build if `node_modules/electron/dist/LICENSES.chromium.html` is absent, and `licenses-audit.test.js` fails if the macOS `extraResources` entry is dropped.

---

## Native Addons

better-sqlite3 13.0.3 is MIT and embeds SQLite, which is in the public domain. Since #197 it ships N-API prebuilds. Risk: green.

node-hid 2.1.2, reached through `@ledgerhq/hw-transport-node-hid`, is MIT OR X11. Risk: green.

---

## Production Dependency License Distribution

This is a walk of `package.json` `dependencies` and `optionalDependencies` plus their transitive `dependencies`, `optionalDependencies` and `peerDependencies` in the installed tree, deduplicated by name@version, done exactly as `licenses-audit.test.js` walks it. It found 321 installed package directories and 299 unique packages before `@spacesprotocol/libveritas` was added (below). The optional and peer arms matter: npm installs both on a production install, and eight packages (`@peculiar/*`, `asn1js`, `pvtsutils`, `pvutils`, `webcrypto-core`, reached through `gun`'s optional `@peculiar/webcrypto`) ship without appearing in any `dependencies` chain.

The 26 packages the fork adds all arrive through `sentinel-ai-connect`, installed as blue-agent-connect 2.0.0 (MIT, "Copyright (c) 2026 Norse Labs"; GitHub's detector reports NOASSERTION only because the file adds a line saying it derives from blue-js-sdk). It brings blue-js-sdk 2.8.0 (MIT), eleven `@cosmjs/*` 0.39.0 packages and cosmjs-types (Apache-2.0), readonly-date-esm 2.0.0 (Apache-2.0), dotenv 16.6.1 (BSD-2-Clause), and socks-proxy-agent, xstream and their helpers (MIT). The `@cosmjs/*` packages ship no licence file, so `NOTICES` carries the Apache-2.0 text for them. readonly-date-esm is the only package in the tree with an Apache-2.0 `NOTICE` file, and `NOTICES` reproduces it.

Verified Spaces browsing adds `@spacesprotocol/libveritas` 0.4.5, the Spaces proof verifier, as a direct dependency with no dependencies of its own, which makes 300 unique packages. Its package.json declares no licence and its tarball ships no licence file, so the walk alone would read it as UNKNOWN; the licence is read from upstream instead, where the workspace `Cargo.toml` declares Apache-2.0 and the repository's `LICENSE` is the Apache License 2.0 at tag v0.4.5. `licenses-audit.test.js` accepts that reading for exactly this version and requires the matching record in `licenses-audit.json`, and `NOTICES` names the package and points to the Apache-2.0 text it reproduces. `libveritas_bg.wasm` is a wasm-bindgen build that statically links 109 crates from upstream's `Cargo.lock` (62 MIT OR Apache-2.0, 17 MIT, 14 Apache-2.0, 8 CC0-1.0, the rest MITNFA, BSD-3-Clause, Unicode-3.0 alongside MIT OR Apache-2.0, or a choice that includes Apache-2.0 or the Unlicense); `licenses-audit.json` lists them, and the 37 proc-macro crates and their dependencies that run only at build time. None is copyleft. Crates offering Apache-2.0, CC0-1.0 or the Unlicense are used under it, and none of them ships a NOTICE file. For the others `NOTICES` reproduces each licence file verbatim in its own section: the 17 MIT crates, hex_lit (MITNFA), subtle (BSD-3-Clause), unicode-ident's Unicode-3.0 licence and the MIT `COPYING` of the C libsecp256k1 that secp256k1-sys vendors. Six of the MIT crates and hex_lit ship no licence file; for those `NOTICES` states the `Cargo.toml` declaration.

| License                           | Count |
| --------------------------------- | ----- |
| MIT                               | 211   |
| Apache-2.0                        | 34    |
| ISC                               | 20    |
| MPL-2.0                           | 13    |
| BSD-3-Clause                      | 4     |
| LGPL-3.0-only                     | 4     |
| Apache-2.0 OR MIT                 | 3     |
| 0BSD                              | 3     |
| LGPL-3.0                          | 1     |
| MIT OR X11                        | 1     |
| MIT OR WTFPL                      | 1     |
| BSD-2-Clause OR MIT OR Apache-2.0 | 1     |
| Zlib OR MIT OR Apache-2.0         | 1     |
| Python-2.0                        | 1     |
| BlueOak-1.0.0                     | 1     |
| BSD-2-Clause                      | 1     |
| Total                             | 300   |

---

## Assets

Two paths put non-code files in the artifacts, and both are inventoried here. `build.extraResources` copies `assets/` whole: icons plus the CC BY-SA filter-list data in `assets/adblock/`, and the fork's `assets/hns/`. `build.files`' `src/**/*` pattern commits everything under `src/` into `app.asar`, media included, and `licenses-audit.test.js` fails on any file there that this section does not account for.

| Asset                                                                            | Ships via        | Type                                  | License                                                       |
| -------------------------------------------------------------------------------- | ---------------- | ------------------------------------- | ------------------------------------------------------------- |
| `assets/icon.png`, `assets/icon-6963.png`, `assets/icons/*.png`                  | `extraResources` | Icons                                 | Upstream Freedom Team work (see The AGPL fork posture)        |
| `assets/adblock/*` (EasyList family)                                             | `extraResources` | Filter-list data                      | GPLv3+ or CC BY-SA 3.0+, redistributed under the CC BY-SA arm |
| `assets/adblock/ublock-filters.txt`, `resources.json`, `COPYING.GPL-3.0.txt`     | `extraResources` | uBlock filters, scriptlets            | GPL-3.0 / GPL-3.0-or-later; see The GPL question              |
| `assets/hns/README.md`, `hnsd-encrypted`                                         | `extraResources` | The fork's provenance note, launcher  | AGPL-3.0-or-later, the fork's own                             |
| `assets/hns/checkpoint_main.dat`                                                 | `extraResources` | Handshake block headers 348000-348149 | Public chain data; no licence asserted                        |
| `src/renderer/pages/images/home.png` (2.65 MB), `freedom-logo-{black,white}.svg` | `app.asar`       | Internal-page artwork and wordmark    | Upstream Freedom Team work                                    |
| `src/renderer/assets/chains/*.png` (3)                                           | `app.asar`       | Chain marks                           | Third-party marks; see below                                  |
| `src/renderer/assets/tokens/*.png` (8)                                           | `app.asar`       | Token marks                           | Third-party marks; see below                                  |
| `src/main/myotis/native/*.c`                                                     | `app.asar`       | Myotis supervisor sources             | MPL-2.0, upstream's own, inside the AGPL work                 |

The filter lists (EasyList, EasyPrivacy, Fanboy Cookiemonster, Fanboy Annoyances) are dual-licensed data, not code. Freedom takes the CC BY-SA arm, which needs attribution only. They are attributed in `NOTICES`.

The ad-blocking lists are fetched by `npm run adblock:download` before packaging, and `scripts/check-binaries.js` refuses to package without them, so every package built from this tree carries them.

### The GPL question: uBlock Origin filters and scriptlets (#410)

Blocking YouTube's video ads needs scriptlets, and the rules that use them live in uBlock Origin's own lists, so two files in `assets/adblock/` are GPL-only. `ublock-filters.txt` is uBlock filters plus uBlock filters – Quick fixes from uBlockOrigin/uAssets (GPL-3.0); the build modifies it (evaluates `!#if` blocks, splices `!#include` files, concatenates the two lists) and says so in the file's header, as GPL-3.0 section 5(a) requires, and it is plain text and its own source. `resources.json` is uBlock Origin's scriptlets and redirect resources (GPL-3.0-or-later), shipped unmodified in the form @ghostery/adblocker publishes, pinned by tag (`v2.18.2`) and sha256 in `scripts/fetch-adblock-lists.js`; its script bodies are minified, so under GPL-3.0 section 6 it is object code, and `NOTICES` and the manifest name the exact corresponding source.

Upstream's position, decided by its maintainer in PR #412, is that these are separate works shipped next to Freedom: standalone files outside `app.asar`, read as data by the engine and injected into web pages, which is an aggregate under GPL-3.0 section 5. Brave and Ghostery ship uBlock's lists and scriptlets the same way. For this fork the question matters less, because GPL-3.0 code is compatible with AGPL-3.0-or-later even if combined. The obligations still hold and are met in this tree: the licence text ships (`COPYING.GPL-3.0.txt`), the copyright and the exact source are named in `NOTICES` and `assets/adblock/manifest.json`, and the list header carries the modification notice. The exact pins are recorded in `NOTICES`: `resources.json` (sha256 `e14b498f…`) comes from uBlock Origin 1.72.3rc4 (commit `de31aee0`, byte-identical in 1.73.0) via @ghostery/adblocker commit `e08ecf7f` and its asset build script at `v2.18.2`, and `ublock-filters.txt` comes from the uAssets `gh-pages` commit each build resolves. Re-derive the uBlock revision on every @ghostery/adblocker bump.

### First-party and upstream files

`src/renderer/pages/images/` is Freedom's own internal-page artwork and wordmark, and `src/main/myotis/native/` is Freedom's own Myotis supervisor sources. Both are upstream work under MPL-2.0 that ships inside the fork's AGPL work and needs no third-party notice beyond the upstream entry in `NOTICES`. They are listed because the audit claims to describe what the artifact contains. `assets/hns/` and `scripts/jacktrip/` are the fork's own. `checkpoint_main.dat` holds 150 public Handshake mainnet headers whose provenance is recorded in `assets/hns/README.md`.

### Open item: chain and token marks

The chain marks in `src/renderer/assets/chains/` and the token marks in `src/renderer/assets/tokens/` are third-party logos (Ethereum, Gnosis, Base, Swarm, MakerDAO, Circle, Tether, Monerium). Freedom ships them to identify the chain or token each labels, which is nominative use, and `NOTICES` says so and claims no ownership. Per-mark redistribution terms have not been confirmed against each project's brand guidelines. This is a yellow open item rather than a blocker: confirm before a final tag, or replace the marks with generic glyphs.

---

## Dev Dependencies (Not Bundled)

Dev dependencies are not shipped with the application and do not affect the licence of the distributed product. caniuse-lite is CC-BY-4.0, which would need attribution if distributed; it is not. The rest are MIT, ISC, BSD and Apache-2.0.

---

## Notice Requirements

`NOTICES` must carry attribution for:

1. the fork itself and the upstream Freedom Browser code it contains, with the MPL-2.0 notice and both source locations;
2. Electron, MIT, and the shipped location of Chromium's `LICENSES.chromium.html` on each platform;
3. Ant, MIT OR Apache-2.0;
4. freedom-ipfs, MIT OR Apache-2.0;
5. libradicle, MIT OR Apache-2.0;
6. Myotis, Apache-2.0, with the upstream `NOTICE` reproduced (macOS and Windows packages);
7. Arti, MIT OR Apache-2.0, Copyright 2019-2025 The Tor Project, Inc. (macOS and Windows packages);
8. hnsd and fingertipd, with everything they link statically (Linux x64 packages);
9. V2Ray, its Go modules, and the grpc and yaml.v3 `NOTICE` files (Linux x64 packages);
10. OpenLV and websocket-mqtt, LGPL-3.0, with relinking instructions;
11. highlight.js, BSD-3-Clause;
12. marked, MIT;
13. DOMPurify, MPL-2.0 OR Apache-2.0;
14. the Agora Web SDK, MIT per registry metadata;
15. @ghostery/adblocker, MPL-2.0;
16. the ad-blocking filter lists, CC BY-SA, and the uBlock files, GPL-3.0;
17. the chain and token marks under `src/renderer/assets/`;
18. all npm production dependencies, including the readonly-date-esm `NOTICE`, and `@spacesprotocol/libveritas`, which ships no licence text of its own;
19. the full texts of the licences whose terms require them and that no shipped package carries.

`licenses-audit.test.js` checks items 2 to 17 against what `package.json`'s `build` configuration, the committed helper directories and the `src/**/*` files pattern ship, and fails on anything new that has not been classified.

## License files shipped in the app

`build.extraResources` puts the licence texts themselves inside every artifact, so a user who has only the installed application can read them: `resources/LICENSE` holds the fork's AGPL-3.0-or-later text, `resources/NOTICES` holds this attribution set with the licence texts it reproduces, and `LICENSES.chromium.html` holds Chromium's notices at the per-platform path above.

---

## Copyleft Analysis

The fork is itself strong copyleft, so the question is compatibility, not avoidance. No component in the tree carries a licence the AGPL cannot accommodate.

Strong copyleft other than the fork's own licence is limited to the GPL-3.0 uBlock files in `assets/adblock/`, compatible with AGPL-3.0-or-later and in any case shipped as separate files. The EasyList-family lists are GPLv3+ or CC BY-SA 3.0+, redistributed under CC BY-SA. The GPL-3.0 QRious bundle upstream found and removed in 0.8.5 has not come back.

Weak copyleft is present and handled. The thirteen MPL-2.0 packages and the upstream code are covered by MPL-2.0 section 3.3. The five LGPL-3.0 packages (`@openlv/{core,session,signaling,transport}` and websocket-mqtt) stay one isolated, regenerable bundle so section 4 relinking is possible. The glibc that hnsd links is LGPL-2.1-or-later, but it is supplied by the user's system and not shipped. The LGPL-2.1 libfuse in upstream's AppImage runtime does not apply, because the fork builds no AppImage.

---

## Compatibility Matrix

| Dependency licence | Compatible with AGPL-3.0-or-later | Notes                                                           |
| ------------------ | --------------------------------- | --------------------------------------------------------------- |
| MIT, ISC, 0BSD     | Yes                               | Notice and permission text must accompany copies                |
| BSD-2/3-Clause     | Yes                               | Binary redistribution must reproduce the notice and conditions  |
| Apache-2.0         | Yes                               | GPLv3-family compatible; NOTICE files must be reproduced        |
| BlueOak-1.0.0      | Yes                               | Permissive                                                      |
| Python-2.0 (PSF)   | Yes                               | Permissive                                                      |
| CC0-1.0            | Yes                               | Public domain dedication                                        |
| CC-BY-SA-3.0       | Yes, as data                      | Attribution and share-alike on the data, not on the fork's code |
| MPL-2.0            | Yes                               | Section 3.3 Larger Work; upstream files stay MPL-2.0            |
| LGPL-3.0           | Yes                               | Library must stay replaceable (section 4)                       |
| GPL-3.0            | Yes                               | GPLv3 and AGPLv3 section 13                                     |
| CC-BY-4.0          | Yes                               | Attribution required, but only in dev dependencies              |

---

## Open items

`licenses-audit.json` records no blocker. The last one, inspecting a package built from this tree, was closed against the deb built from commit c51e4fe0 (see the verdict above).

Two recommended items are not blockers. Agora should be asked for a licence file and a third-party notice list, and libradicle's upstream should be asked to commit its licence texts.

### Checklist Before Release

- [x] `LICENSE` holds the AGPL-3.0-or-later text
- [x] `package.json` `license` field is `AGPL-3.0-or-later`
- [x] `README.md` and `CONTRIBUTING.md` agree with `LICENSE`
- [x] `NOTICES` names the upstream MPL-2.0 code and both source locations
- [x] `NOTICES` names every shipped binary, addon, vendor bundle and data file
- [x] Myotis's and readonly-date-esm's upstream `NOTICE` files and the grpc and yaml.v3 `NOTICE` files reproduced verbatim
- [x] LGPL relinking instructions present in `NOTICES`
- [x] No licence incompatible with AGPL-3.0-or-later in the packaged artifact
- [x] Electron's `LICENSES.chromium.html` ships in every artifact, macOS included
- [x] Committed helper bytes bound to both audit files
- [x] Handshake helpers' upstream notices and hnsd's source shipped unedited, bound by digest
- [x] V2Ray's module notices shipped unedited and bound by digest, and its and the Agora libraries' copyright lines reproduced in `NOTICES`
- [x] V2Ray's unused GeoIP/GeoSite data removed, which closes the GeoLite terms question
- [x] A package built from this tree inspected against this inventory

---

Re-derived from the installed tree on 2026-10-15 against `0.7.15`. Kept honest by `licenses-audit.test.js`.
