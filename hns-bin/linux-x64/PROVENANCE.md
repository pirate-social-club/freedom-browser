# HNS Linux x64 binary provenance

The helper is built from reviewed source pirate-social-club/fingertipd commit 21f044ebc830eed87e6851ed7216f9590f6f3df3. It follows shipped source c1826e169b7b3d798b211a5b7f5e43e7172273d4 and includes authenticated-address validation and transport-policy repair. This is an exact local verified-source build, not an artifact attributed to the prior v0.1.12 release or its archive checksum. No new helper tag is claimed.

The compiler is Go 1.26.2 on Linux amd64, with CGO_ENABLED=0, GOMAXPROCS=1, GOMEMLIMIT=650MiB, GOFLAGS=-p=1, GOPROXY=off and GOTOOLCHAIN=local. The build command is go build -buildvcs=false -trimpath -ldflags='-s -w -buildid=' -o fingertipd . from the clean exact source. The binary is static ELF64 x86-64 and stripped. Dependency files are unchanged. Hosted Go 1.24.6 source compatibility CI passes at this commit; that hosted compiler did not produce this binary.

The exact helper bytes passed packaged DNSSEC/DANE security acceptance and initial/final controls in a disposable byte-compared Freedom 43503816528243e530347dbc98a979c5228c4765 package on 2026-09-30. Retained public evidence is agentStagingRoot/archive/fingertipd-packaged-security-pass-2026-09-30. No private key or full profile is part of this artifact.

The hnsd source is handshake-org/hnsd v2.0.0 at a5c7c287e848f46d3e97f16b698e2027c8dc96c3. Successful hosted run 38709852038 built it without network access from debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241. The exact patch SHA256 is 810edac7e7b991cc9d6ab569ca648a58455b9a43cf09be43f3c6cfea5072de67. It enables outbound libunbound TCP, returns SERVFAIL for bogus DNSSEC results, and sets TC on incomplete final replies.

The reviewed native binary is x86-64 PIE with direct dependencies libunbound.so.8 and libc.so.6, requiring GLIBC_2.36. The Linux deb declares libunbound8 and libc6 >= 2.36; system libraries are not bundled. The build's original and patched source, patch, compiler, package/license inventory, ELF observations, runtime linkage and exact artifact ZIP are retained under agentStagingRoot/archive/freedom-installed-deb-hosted-acceptance-2026-10-02/integration-start/milestone-2-2026-10-15/run-38709852038. Both coordinator and independent review verified the source, patch, manifest and native bytes.

All six hosted native fixtures passed: valid signed A/TLSA; bogus DNSKEY and address refusal with an unaffected valid AAAA; a 7052-byte intermediate DNSKEY response using relay TCP; oversized final UDP refusal; and both SIGTERM and SIGKILL helper/native custody closure. Service, cgroup and container cleanup passed. These fixtures inject DNS wire replies at the HTTPS request boundary. They do not establish live HTTPS, installed browser, restart or Mullvad acceptance, which remain separate gates.

## Shipped files

```text
065e4f0d5c118213f09319998c94633033cae7f96dc6d714083208468225f766  fingertipd
d539d508d10773a89f4a4e900b3c2c87b38a130908049d0566a1d03473984a0f  hnsd
```

Handshake browsing is supported on Linux x64 only by the existing capability manifest. Other shipping browser platforms do not ship these helper artifacts or enable Handshake browsing. This artifact change adds encrypted delegated DNS beneath owned local validation. It does not add platform support or permit a fallback without local DNSSEC/DANE authentication. The sibling encrypted-validator.json and runtime source pin bind the source, patch and native digest.

## Amendment, 2026-10-21

This note amends the dependency sentence in the hnsd record above, which says the Linux deb declares libc6 >= 2.36, and leaves the reviewed text as it was. hnsd's own requirement is unchanged at GLIBC_2.36. The Linux deb now declares libc6 >= 2.39, because the bundled freedom-ipfs addon needs GLIBC_2.39 and the source-built usb addon GLIBC_2.38, and it also declares libudev1, libasound2t64 | libasound2 (>= 1.0.17) and libgbm1, which the browser binary links. The helper binaries and their digests are unchanged.
