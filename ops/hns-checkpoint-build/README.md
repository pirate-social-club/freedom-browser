# Checkpoint hnsd build

This workflow measures a dynamic system-library build of unchanged hnsd
v2.0.0, commit a5c7c287e848f46d3e97f16b698e2027c8dc96c3. Compilation uses
one CPU, 2 GiB without swap, an ordinary UID and no network. Preparation
installs tools in the digest-pinned Bookworm image. Debian package versions
and copyright texts are retained; repository packages are not claimed to be
immutable between runs.
The package inventory identifies installed build inputs but does not yet
establish corresponding source-package provenance for every system library.

The result is a proposed helper, not an accepted browser package. ELF SONAMEs
and symbol versions must determine the deb's actual runtime dependencies.
System shared libraries must not be copied into Freedom. Source, bundled-code
notices and the build recipe accompany the artifact. The old static helper's
acceptance does not cover these bytes. Clean Ubuntu 24.04 installation and a
complete new browser acceptance remain required before adopting the helper.

The workflow does not install npm dependencies, alter an audit policy, publish
a release or change VPN settings. It retains diagnostics even on failure.
