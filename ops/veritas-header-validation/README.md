# Bitcoin mainnet header conformance

The pinned Yuki acceptance paths lack complete contextual difficulty checks.
This disconnected Rust component prepares a defensive replacement: every header
must extend its actual parent with the exact height-dependent bits, valid target
and proof of work, median and future timestamps, and activated minimum version.
Missing context is refused. Retarget elapsed time uses signed subtraction before
clamping, avoiding the unsigned subtraction in rust-bitcoin's higher-level helper.

BoundHistory checks a contiguous ancestry window backwards against an explicit
tip hash. The caller must independently trust that hash and height, through a
reviewed checkpoint policy or previously validated state. The constructor does
not approve a checkpoint or validate the earlier chain. For a fork, the window
must end at its stem. Validation stages headers locally and returns the entire
segment only on success. Work selection and persistent state remain the caller's
responsibility. Future-time failures are retryable with a trusted clock.

The seventeen Rust tests use Bitcoin Core v29.0 retarget expectations and 2,019
historical headers from heights 30240 through 32258. They cover the first changed
mainnet retarget at 32256, every two-part split of the eight-header segment,
missing history, context tampering, branch boundaries, exact difficulty changes,
target encoding, timestamps, minimum versions, PoW and immutable failure. The
public ledger data is conformance evidence, not an approved Freedom checkpoint.
Its hashes and parent links were recomputed during acquisition and source review.

Consensus references are [Bitcoin Core difficulty rules](https://github.com/bitcoin/bitcoin/blob/v29.0/src/pow.cpp),
[contextual header rules](https://github.com/bitcoin/bitcoin/blob/v29.0/src/validation.cpp#L3857-L3902),
[published retarget expectations](https://github.com/bitcoin/bitcoin/blob/v29.0/src/test/pow_tests.cpp)
and [rust-bitcoin 0.32.8 arithmetic](https://github.com/rust-bitcoin/rust-bitcoin/blob/bitcoin-0.32.8/bitcoin/src/pow.rs).
Tests reuse numeric expectations and independently acquired ledger bytes.

The hosted workflow acquires the reviewed Veritas source and exact Cargo.lock,
fetches only that pinned dependency graph, and derives the component's lockfile
offline. Every registry name, version, source and integrity must match an entry
in the original lockfile. A changed dependency, path or Git source is refused.
Compilation then uses the frozen lock and read-only component inputs. The
generated component lock and compiler identities are retained in the receipt.

Compilation and tests use the accepted Linux feasibility lifecycle controller,
a separate identity, private networking, hidden home directories, no capabilities,
no privilege escalation, two CPU cores of quota, 4 GiB memory and no swap. Each
stage stops and proves its cgroup empty. The compiled test executable is copied
to a runner-owned read-only inspection directory before execution. Evidence
retains source hashes, dependency identities, logs, binary digest, service limits,
cleanup and a manifest. Forced termination can still prevent a complete receipt.

Local verification runs only Python provenance fixtures, syntax and repository
lint under the conservative resource envelope. Rust compilation and execution
stay on GitHub. No current Yuki acceptance path, Bitcoin peer, Spaces service or
browser is invoked by this workflow.

A pass proves this component's conformance cases. Yuki integration must still
validate forks before work comparison or mutation, authenticate checkpoint history,
validate persisted state, and implement rollback and continuing freshness gates.
Full block/state validity, synchronization, restart, Mullvad routing and secure
installed-browser navigation remain unproven. This component grants no anchor
authority and changes no application behavior or release policy.

## License

The standalone Rust validator, its tests and this component documentation are
available under either the MIT license or the Apache License, Version 2.0, at
the recipient's option. See LICENSE-MIT and LICENSE-APACHE. The Cargo package
includes those files, its Rust source and the conformance fixtures.

The Python acceptance harness and GitHub workflow retain Freedom's repository
license. Freedom's application license remains AGPL-3.0-or-later. Dependencies
and third-party material retain their own terms and attribution. Consensus
references, numeric expectations and public ledger data remain identified
above and in the fixture provenance; this grant does not replace their terms.
