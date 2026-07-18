# Fingertipd daemon contract

Status: normative for Freedom Browser `resync/hns-binaries`.

`fingertipd` is a profile-scoped loopback HTTPS proxy and supervisor for the
pinned `hnsd` binary. Freedom owns process lifecycle, allocates the resolver
ports, validates the emitted CA, and installs routing only after the daemon
reports readiness. The daemon must not contain a remote canary, telemetry, or
an implicit public resolver fallback.

## Invocation

Freedom executes `fingertipd` directly without a shell:

```text
fingertipd \
  -data-dir <absolute profile userData>/hns-data \
  -hnsd-path <absolute path>/hnsd \
  -root-addr 127.0.0.1:<allocated port> \
  -recursive-addr 127.0.0.1:<different allocated port>
```

All four flags are required. Unknown flags, missing values, non-absolute data
or binary paths, non-loopback resolver addresses, equal resolver ports, and
ports outside `1..65535` must fail before any listener or child is started.
Freedom preflights each resolver port for TCP and UDP availability, but the
daemon remains responsible for reporting bind failures.

The daemon chooses its own unused TCP proxy port on `127.0.0.1`. It must never
bind a wildcard, LAN, public, or IPv6 address in the Linux-x64 release.

## Data and CA

All persistent and runtime files belong under `-data-dir`. The daemon:

- creates the directory with owner-only permissions when absent;
- starts `hnsd` with its chain state under that directory;
- persists or creates the local CA private key with owner-read/write only;
- writes a PEM certificate atomically and reports its absolute path as
  `caPath` in the ready event;
- never prints the CA key, seed material, requested hostname, or full URL.

The reported CA path must resolve inside `-data-dir`; symlink escapes are not
allowed. Freedom pins the exact X.509 fingerprint, verifies the presented leaf
hostname and validity window, and clears the override when the daemon exits.
CA rotation therefore occurs by replacing the data-dir CA material and
restarting; Freedom stays fail-closed until it installs the new fingerprint.

## Hnsd supervision

`fingertipd` owns one `hnsd` child and passes the requested root and recursive
listen addresses to it. It must not use system port 53. Browser success
requires both UDP and TCP DNS service on the allocated addresses.

The release pins an exact upstream hnsd tag and source commit. The build must
be reproducible from that pin in a pinned Linux container; the browser never
downloads an unversioned `latest` artifact.

If `hnsd` fails to start, bind, or exits unexpectedly, `fingertipd` emits one
error event, exits non-zero, and does not restart the child internally. Freedom
is the sole restart/backoff owner.

## Proxy behavior

The proxy is an HTTP CONNECT/forward proxy suitable for Chromium PAC
`PROXY host:port` routing. It resolves names through the local hnsd recursive
endpoint and performs the letsdane HNS/DANE interception required to serve
HTTPS to Chromium using the data-dir CA. It must:

- accept connections only on its reported loopback address;
- reject malformed proxy authorities and non-HNS/non-ICANN hostnames according
  to the pinned letsdane policy;
- never fall back to system DNS or a public DoH resolver for HNS names;
- support HTTPS CONNECT and WebSocket upgrade traffic;
- avoid a `DIRECT` fallback when local HNS resolution is unavailable.

Freedom independently classifies admitted hostnames and keeps a black-hole PAC
installed while the service is not ready. The daemon is still required to
fail closed because it is a separately invokable trust boundary.

## Stdout protocol

Stdout is newline-delimited JSON only. Each line is one object. Human logs go
to stderr and must not contain names or URLs. Unknown JSON fields are allowed
for forward compatibility; event names and required fields below are stable.

### `ready`

Emitted exactly once, after hnsd DNS sockets, the proxy listener, and CA PEM
are usable:

```json
{"type":"ready","proxyAddr":"127.0.0.1:44041","caPath":"/absolute/profile/hns-data/ca.pem"}
```

`proxyAddr` is required and must be a loopback IPv4 host plus non-zero port.
`caPath` is required and follows the containment rules above. Readiness does
not claim chain synchronization; Freedom requires a later sync event before
admitting traffic.

### `sync`

Emitted on initial status and whenever height/readiness materially changes:

```json
{"type":"sync","height":123456,"synced":false,"progress":0.42}
```

- `height`: required non-negative safe integer;
- `synced`: required boolean; true only when the local resolver can answer the
  configured deterministic readiness fixture from its current chain state;
- `progress`: optional finite number in `0..1`, omitted when no trustworthy tip
  estimate is available.

`canaryReady` is not part of the new daemon contract. Freedom temporarily
accepts it for legacy compatibility, but the new implementation must emit
`synced` and must not contact a canary service.

### `error`

Emitted before a fatal exit when possible:

```json
{"type":"error","error":"hnsd recursive socket failed"}
```

The message is required, concise, contains no secret/name/URL, and is followed
by a non-zero process exit for fatal errors. Recoverable per-request failures
belong in proxy responses and stderr rate-limited diagnostics, not this event.

## Signals and exit codes

- `SIGTERM`: stop accepting proxy connections, terminate hnsd, wait for it,
  close listeners, then exit `0`; the grace period must be below Freedom's
  five-second SIGKILL escalation.
- `SIGINT`: same graceful path as SIGTERM for development use.
- parent disappearance or closed stdout: terminate the child and exit rather
  than orphaning hnsd.
- startup/configuration/child failure: exit non-zero.
- no internal daemonization, fork-to-background, or child restart loop.

Freedom treats an unexpected non-zero exit as restartable with capped
exponential backoff. A deliberate stop clears registry readiness, PAC routing,
and certificate trust before SIGTERM is sent.

## Release artifact contract

The first supported target is `linux-x64` only. A release contains:

```text
freedom-hns-linux-x64.tar.gz
SHA256SUMS
```

The archive contains executable files `fingertipd` and `hnsd` at its root.
`SHA256SUMS` covers the archive and both unpacked binaries. The release workflow
uses pinned action SHAs, a pinned Go version/container digest, the exact
letsdane commit, and the exact hnsd tag/commit. `scripts/fetch-hns.js` pins the
release tag and expected archive hash in the browser repository, verifies
before extraction, rejects extra/path-traversal entries, and stages only:

```text
hns-bin/linux-x64/fingertipd
hns-bin/linux-x64/hnsd
```

No unsupported-platform placeholder is considered a valid binary.

## Acceptance tests

The daemon repository must cover flag validation, path containment, stdout
schemas, loopback-only listeners, hnsd child failure, graceful signal cleanup,
and absence of orphaned children. Browser slice (c) closes only after:

1. a live TLS navigation succeeds through the staged proxy with hostname and
   certificate validation active;
2. two profile processes run independent data directories, hnsd children,
   proxy ports, PACs, and CA pins concurrently;
3. a hermetic fixture peer supplies deterministic CI sync/readiness; and
4. one manual mainnet header sync and `app.pirate` navigation is recorded with
   binary hashes and browser commit.
