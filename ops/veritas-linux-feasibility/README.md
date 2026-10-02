# Veritas Linux feasibility

This hosted job builds the pinned Veritas Rust CLI for Ubuntu 24.04 x86-64.
It retains the exact source archive and Cargo.lock identities, Rust manifest,
compiler versions and executable hashes, build logs, ELF and linkage reports,
offline help output and the resulting binary. The artifact manifest binds the
retained files. The workflow checks out the candidate with read-only permissions
and does not persist GitHub credentials.

Dependency acquisition is followed by a frozen build with two jobs, two CPU
cores of quota, 4 GiB memory, no swap and a thirty-minute compilation deadline.
Compilation and executable inspection use a separate identity, a private network,
hidden home directories and no privilege escalation. Each stage stops and proves
its cgroup empty before the next. The inspection copy is owned by the runner and
mounted read-only to the build identity. The final copied artifact must retain
the original executable digest. Cleanup failures remain failures in the receipt.

The sixty-minute job limit leaves time for toolchain installation, dependency
acquisition, bounded inspection, cleanup and artifact upload. A forced runner
termination can still prevent a final receipt; absence of the receipt is not a
pass. The effective service properties must be reviewed alongside the result.

The CLI is invoked only with --help, which exits before creating the application.
This job does not start Bitcoin or Spaces services, select a checkpoint, derive
an anchor, resolve a name or open a browser. A pass establishes Linux build and
basic executable feasibility. Synchronization, consensus bootstrap, freshness,
restart, security refusals, VPN behavior and installed-browser navigation remain
separate acceptance work. The output is an experimental build artifact, not a
Freedom release asset or a verified browsing helper.

Rustup performs its normal distribution checks. The pinned official manifest is
retained separately, together with installed cargo/rustc hashes. This is not an
archive-to-installed compiler byte-equivalence proof.
