# HNS Linux x64 binary provenance

The helper is built from reviewed source pirate-social-club/fingertipd commit 21f044ebc830eed87e6851ed7216f9590f6f3df3. It follows shipped source c1826e169b7b3d798b211a5b7f5e43e7172273d4 and includes authenticated-address validation and transport-policy repair. This is an exact local verified-source build, not an artifact attributed to the prior v0.1.12 release or its archive checksum. No new helper tag is claimed.

The compiler is Go 1.26.2 on Linux amd64, with CGO_ENABLED=0, GOMAXPROCS=1, GOMEMLIMIT=650MiB, GOFLAGS=-p=1, GOPROXY=off and GOTOOLCHAIN=local. The build command is go build -buildvcs=false -trimpath -ldflags='-s -w -buildid=' -o fingertipd . from the clean exact source. The binary is static ELF64 x86-64 and stripped. Dependency files are unchanged. Hosted Go 1.24.6 source compatibility CI passes at this commit; that hosted compiler did not produce this binary.

The exact helper bytes passed packaged DNSSEC/DANE security acceptance and initial/final controls in a disposable byte-compared Freedom 43503816528243e530347dbc98a979c5228c4765 package on 2026-09-30. Retained public evidence is agentStagingRoot/archive/fingertipd-packaged-security-pass-2026-09-30. No private key or full profile is part of this artifact.

The hnsd source is handshake-org/hnsd v2.0.0 at a5c7c287e848f46d3e97f16b698e2027c8dc96c3. Hosted run 37184107654 rebuilt it in debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241, with an ordinary UID and no network during compilation. This replaces the former static daemon. Its direct system dependencies are libunbound.so.8 and libc.so.6; its own maximum required glibc symbol version is 2.36. Ubuntu's libunbound package has separate transitive requirements. The deb declares libunbound8 and libc6 (>= 2.36), while retaining Electron's existing runtime dependencies. System libraries are not bundled.

The licenses directory retains the full hnsd source archive, project/libuv/secp256k1 notices and BLAKE2b headers under the offered Apache 2.0 option. The source archive preserves libuv's embedded ISC/BSD and other crypto notices. It also carries the unchanged fingertip helper's project, Go-module and standard-library notices. source-record.json binds those materials to exact source and binary identities. The import itself did not execute either helper; new installed acceptance remains required.

## Shipped files

```text
065e4f0d5c118213f09319998c94633033cae7f96dc6d714083208468225f766  fingertipd
ed2e2f8f22b60fa3e17a8a74445174540d6b4f1903d5849c9e27baee120182d2  hnsd
```

Handshake browsing is supported on Linux x64 only by the existing capability manifest. Other shipping browser platforms do not ship these helper artifacts or enable Handshake browsing. This artifact change does not add platform support, enable validating DoH or relax DNSSEC/DANE.
