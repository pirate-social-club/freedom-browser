# Linux evaluation distribution

The next candidate is Freedom Browser 0.7.17, Debian version `1:0.7.17`, for
the manual `pirate-evaluation-linux-x64` channel. The proposed public identity
is the immutable prerelease `evaluation-0.7.17`. Preparing this source does not
publish that release or authorize its tag. Publication follows approval of the
exact inspected and installed-tested artifact. The existing `evaluation-0.7.16`
release and its assets remain unchanged.

The package remains `freedom-browser`, the executable remains `freedom`, and
the installation remains `/opt/Freedom`. The application ID remains
`baby.freedom.browser`, the product name remains `Freedom`, and the desktop
file remains `freedom.desktop`. Linux retains the `freedom` application name
used for existing profile paths. Changing to `sc.pirate.freedom` requires a
separate profile and desktop integration qualification.

Package metadata identifies Pirate Social Club as the maintainer. The fork
[repository](https://github.com/pirate-social-club/freedom-browser) is the
homepage, and its [issue tracker](https://github.com/pirate-social-club/freedom-browser/issues)
is the support contact. No support mailbox is asserted. Linux sets its
maintainer explicitly instead of inheriting the upstream author's email.

Automatic updating remains disabled. The updater creates no feed client,
downloads no update and performs no installation. This manual channel is a
distribution policy, not a claim that DEB auto-updates are unsupported. A
future automatic channel needs separate qualification of artifact trust,
traffic routing, elevation, shutdown, recovery and explicit opt-in.

The Linux evaluation workflow builds the exact source head with the lockfile,
inspects the resulting package and retains its checksums. It publishes no
release. Version and metadata changes require a fresh build and installed
acceptance; relabeling the previously accepted 0.7.16 artifact is invalid.
Acceptance includes all nine existing Linux gates and the new wallet
requester, ENS recipient-name and Radicle padding cases. The accepted installed
baseline remains 6c968a49 until that successor completes acceptance.
