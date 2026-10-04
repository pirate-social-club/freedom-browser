# Bundled helper notices

These directories retain original license and attribution texts for the Linux
checkpoint's unchanged Kubo, V2Ray and Radicle binaries. Bee source evidence
remains in this repository, but its directory is excluded from the checkpoint
package with the omitted binary. Source records distinguish release-project sources, dependency archives and compiler
sources. Dependency and compiler notice inclusion is conservative: archives
can contain test, platform or build code absent from the executable.

Go dependency archives are checked against the module hashes read from each
binary. Compiler sources match official Go release checksums. Rust registry
archives match the pinned project's Cargo.lock checksums; Git archives use
its locked revision. These records establish source and notice identities.
They do not claim a reproducible rebuild of an unchanged release binary.

HNS helper notices and their separate source record are under
resources/hns-bin/licenses. Electron and Chromium retain their original
license files beside the installed executable. Application and dependency
licenses remain distinct.
