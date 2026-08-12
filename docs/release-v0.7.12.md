# Freedom 0.7.12 release candidate

## Platform support

Bundled Handshake browsing and Sentinel dVPN are supported on Linux x64 only
for this patch release. macOS, Windows, and Linux ARM builds disable both
capabilities in the main process and Settings UI with an explicit explanation.

The authoritative support matrix is
`src/shared/platform-capabilities.json`. `scripts/check-binaries.js` enforces
every runtime artifact declared for a supported target.

## Release preflight

1. Configure the repository Actions secret `FREEDOM_HNS_SMOKE_EXTRA_HOST` with
   the third requested hostname. The value is intentionally absent from source,
   command output, and workflow logs.
2. Push the untagged `release/v0.7.12-rc` branch.
3. Dispatch the `Release` workflow against that branch.
4. Confirm source verification and every platform build succeed.
5. Confirm the Linux build runs the packaged HNS HTTPS smoke successfully for
   all three required hosts.
6. Download and inspect every artifact, including its version and declared
   platform capabilities.
7. Tag the unchanged, verified commit as `v0.7.12` and push the tag.

The workflow publishes only for a pushed `v*` tag. A manual dispatch builds the
release candidate without publishing it. macOS manual-dispatch artifacts are
unsigned and unnotarized; pushed tags still require all signing and
notarization credentials.

## Scope intentionally deferred

Changing Sentinel dVPN to fail closed on proxy failure is a separate product
and security decision. This patch does not change its PAC fallback behavior.
