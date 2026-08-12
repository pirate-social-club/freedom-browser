# HNS Linux x64 binary provenance

- Helper release: `pirate-social-club/fingertipd@v0.1.12`
- Helper source commit: `c1826e169b7b3d798b211a5b7f5e43e7172273d4`
- Helper build workflow: `pirate-social-club/fingertipd` run `30103220904`
- Helper release archive SHA-256: `f55080f2fe0b810f82533d5a743291a02ee0545c369ab3da0e7926b13de2c9a8`
- hnsd release: `handshake-org/hnsd@v2.0.0`
- hnsd source commit: `a5c7c287e848f46d3e97f16b698e2027c8dc96c3`
- hnsd rebuild baseline: `debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241`
- hnsd link policy: fully static (`libtool -all-static`), including the `libunbound` dependency closure

The hnsd binary from the helper release was dynamically linked against
`libunbound.so.8` and glibc 2.38 despite the release workflow's static-build
intent. Freedom rebuilds the same pinned hnsd source as a self-contained
artifact so it works on clean Linux systems.

## Shipped files

```text
486ae257f5f94d9594dbcbf2252004eea6b2cfc37ef1ec1280fa05658a918582  fingertipd
881ba4728f3e36a2015185f8cfa478d718260eaf7f406404af386b0ed4d863af  hnsd
```

The helper hash was verified against the `SHA256SUMS` asset attached to the
`v0.1.12` GitHub release. The hnsd hash identifies Freedom's static rebuild of
the upstream source and commit listed above.
