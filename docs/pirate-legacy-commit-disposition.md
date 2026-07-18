# Pirate legacy commit disposition

This is the living parity ledger for the resync. Update it in every slice PR.
`ported` means the intent is represented on `resync/0.8`; `superseded` means
upstream or a later Pirate change replaced it; `dropped` requires a rationale.

The original divergence review described 72 commits. After reconciling the
stale local branch, Git identifies 50 unique, non-merge Pirate commits on
`backup/local-main-pre-reconcile-20260718` relative to current `upstream/main`.
The parity audit must reconcile that historical count before cutover; this
table intentionally tracks the recoverable unique set rather than inventing
rows for merge commits or patch-equivalent re-commits.

Resync-only runtime fixes are also recorded here. `78a4e73` added supervisor
coverage and fixed a dangling-restart defect: deliberate stop/disable now
cancels pending crash-backoff and restart-reset timers, so HNS cannot restart
itself after the user turns it off.

| Legacy | Intent | Slice | Disposition |
|---|---|---:|---|
| `5bfae86` | Restore Spaces TLS verification | Spaces | pending |
| `d151b3f` | Pin CI actions and artifact retention | Packaging | pending |
| `460e41b` | Clear moderate dependency findings | Packaging | pending |
| `a215254` | Clear high dependency findings | Packaging | pending |
| `9d3cf1b` | Privileged bridge lockdown (re-commit) | Security | ported (`211fd37`) |
| `4f13e2e` | Privileged bridge lockdown | Security | ported (`211fd37`) |
| `0e242cb` | Preserve tab URL state | Parity | pending |
| `a21d248` | Prefer bundled JackTrip | Live rooms | pending |
| `df59a86` | Home readiness and resolution stabilization | HNS routing | pending |
| `9425f15` | Share binary-download release environment | Packaging | pending |
| `344dd2e` | Pass release environment to Linux container | Packaging | pending |
| `9bf88bb` | Unblock platform builds | Packaging | pending |
| `5ed1d9c` | Satisfy dependency audit gate | Packaging | pending |
| `f7c85fe` | Reliable local HNS resolution | HNS routing | pending |
| `e3b58b9` | Ignore subframe navigation in address bar | Parity | pending |
| `76ea7d3` | Reroute JackTrip after Linux connect | Live rooms | pending |
| `be4ec03` | Route JackTrip host audio into Agora | Live rooms | pending |
| `d69c62f` | Remove unreachable live-room guard | Live rooms | pending |
| `b6f0278` | Use JackTrip-required runtime decision | Live rooms | pending |
| `6ea55bd` | Enforce duet producer roles | Live rooms | pending |
| `bf7a011` | Fix live-room launch bridge | Live rooms | pending |
| `02dd012` | Auto-start launched broadcasts | Live rooms | pending |
| `ec9ce02` | Prevent subframe failures replacing tabs | Parity | pending |
| `2eb2967` | Agora broadcaster controls | Live rooms | pending |
| `e55e98b` | Gate home navigation on resolver readiness | HNS routing | pending |
| `6b64ab2` | Preserve dVPN validation backlog | dVPN | pending |
| `f736b9e` | Supply-chain hardened CI | Packaging | pending |
| `59879f3` | Navigation IPC, internal pages, URL utilities | HNS routing | pending |
| `d610d44` | JackTrip integration and live-room API | Live rooms | pending |
| `58dd630` | AGPL package metadata | Foundation | superseded by current licensing structure |
| `3ba4efb` | Compact imported-HNS PAC routing | HNS routing | pending |
| `df7c5c9` | Prepare v0.7.8 | Release history | superseded |
| `0392fc2` | Spaces TLS bypass | Spaces | dropped; insecure and reverted in v0.7.11 |
| `7121ded` | Use canonical Spaces verifier | Spaces | pending |
| `436df66` | HNS resolver health diagnostics | HNS routing | pending |
| `9c19a8e` | Quiet repeated HNS runtime logs | HNS managers | pending |
| `4c2deac` | Use `app.pirate` home target | HNS routing | pending |
| `915417d` | Open Pirate root on app host | HNS routing | pending |
| `c740c2b` | Prepare v0.7.7 | Release history | superseded |
| `8205850` | Refresh imported HNS suffixes | HNS routing | pending |
| `39410e6` | Load HNS hosts over HTTPS | HNS routing | pending |
| `0eed90f` | Run release smoke directly | Packaging | pending |
| `96265a6` | Smoke-test release toolchain | Packaging | pending |
| `bb01b6f` | Bump to v0.7.4 | Release history | superseded |
| `9ee237c` | Resolve local binaries in direct scripts | Packaging | pending |
| `b2cd4fb` | Avoid npm argument forwarding in release builds | Packaging | pending |
| `aece9cf` | Clear lint and Actions warnings | Packaging | pending |
| `fd4aa86` | Prepare Sentinel dependency | dVPN | pending |
| `174a74a` | Mock Sentinel SDK in dVPN tests | dVPN | pending |
| `a41b979` | Harden dapp-provider boundaries | Security | ported (`211fd37`) |
