# Changelog

All notable changes to Freedom will be documented in this file.

## [0.7.7] - 2026-05-02

### Fixed

- HNS address bar navigation now opens single-label roots over HTTPS.
- Imported HNS namespace suffixes are refreshed from Pirate's public namespace API so delegated imported-root subdomains route through the HNS proxy.

## [0.7.3] - 2026-04-24

### Security

- Hardened dApp wallet permissions so requests are attributed to the requesting webview instead of the active address bar, including stable permission keys for local IPFS, IPNS, Swarm, and Radicle gateway URLs.
- Added main-process permission checks before dApp transaction and signing IPC handlers can use a wallet index.
- Restricted Radicle rewrite bases to localhost/127.0.0.1, matching the Swarm and IPFS IPC validation boundary.

### Fixed

- Popup and custom-protocol navigation now route back to the owning browser window instead of the first unrelated Freedom window.
- `window.ethereum` is exposed synchronously from the webview preload so dApps can detect the provider during early page scripts.
- Chain changes now broadcast to all provider-enabled tabs instead of only the active tab.
- JSON-RPC proxy calls now use monotonic request IDs instead of millisecond timestamps.

## [0.7.1] - 2026-04-17

### Fixed

- Tagged GitHub releases now publish reliably without requiring a repository checkout in the publish job, and artifact uploads tolerate missing platform-specific globs while still producing `SHA256SUMS.txt` and the `latest-*.yml` updater manifests

## [0.7.0] - 2026-04-17

### Fixed

- Cross-architecture Radicle downloads now work in release builds so macOS and Linux packaging can fetch the correct bundled binaries during tagged releases

## [0.6.9] - 2026-04-17

### Fixed

- macOS `x64` release builds now run on `macos-14` and cross-compile successfully instead of depending on an unavailable Intel runner pool

## [0.6.8] - 2026-04-17

### Fixed

- Bundled Bee downloads in release builds now authenticate GitHub API requests to avoid rate-limit failures on macOS runners

## [0.6.7] - 2026-04-17

### Fixed

- Release workflow no longer relies on matrix-driven `shell` selection, using explicit Windows and Unix steps instead so tagged builds can pass GitHub workflow validation
- Release builds now fetch Bee, IPFS, and Radicle binaries before packaging, and the Linux Docker build reuses the checked-out `node_modules` tree instead of reinstalling inside the container
- Windows release packaging now normalizes tar extraction paths and uses `--force-local` so bundled protocol binaries unpack correctly under Git Bash

## [0.6.6] - 2026-04-17

### Changed

- Release publishing now uses the GitHub CLI with `GITHUB_TOKEN` instead of a third-party release action so tagged binary releases can run under stricter repository action policies

## [0.6.5] - 2026-04-17

### Changed

- Release and CI workflows now use GitHub-hosted runners again for Linux and Windows so tagged releases can publish reliably while keeping the Linux `AppImage`, `.deb`, Windows `.exe`, and macOS `.dmg` artifact matrix intact

## [0.6.4] - 2026-04-17

### Added

- Linux GitHub Releases now publish an `AppImage` alongside the existing `.deb` package for easier distro-agnostic installs

### Changed

- Release metadata and workflow asset publishing now include the Linux `AppImage` artifact and checksums

## [0.6.3] - 2026-04-17

### Added

- Bundled Handshake resolver/runtime with selective single-label proxying and adaptive homepage promotion from `pirate.sc` to `pirate/`
- Sentinel dVPN integration with encrypted wallet persistence, session budgeting, SOCKS proxy handoff, and packaged V2Ray runtime
- Tagged GitHub release builds for macOS, Linux x64, and Windows x64 artifacts

### Changed

- New-tab and home-page handling now treat `https://pirate.sc/` and `https://pirate/` as equivalent home states while promoting `pirate/` once HNS is ready
- CI and release workflows now use Blacksmith runners for Linux and Windows jobs while keeping macOS builds on GitHub-hosted runners

### Fixed

- HNS startup now avoids stale local resolver port collisions and falls back cleanly during sync
- `Cmd/Ctrl+W` closes only the active tab instead of double-firing and closing the window
- Settings modal layout, Sentinel wallet copy, and homepage upgrade behavior are stable again
- dVPN connects more reliably by forcing Node HTTP for SDK chain calls, increasing auto-select retries, and resolving VPN IP through the SOCKS proxy when the SDK leaves it blank
- Favicon fetching now passes WHATWG `URL` objects into Electron networking, removing the `DEP0169` `url.parse()` startup warning

### Security

- Service registry reset paths now preserve per-service fields instead of briefly dropping HNS and dVPN state shape on shutdown
- Home-page and HNS readiness gating now stay aligned with bundled HNS integration settings to avoid invalid single-label navigation states

## [0.6.2] - 2026-03-01

### Added

- Experimental support for Radicle (decentralized Git hosting) on macOS and Linux:
  - Enable or disable Radicle from Settings > Experimental
  - `rad://` URL handling across navigation and rewriting
  - Bundled Radicle node lifecycle management and packaging support
  - Integrated repo browser page and GitHub-to-Radicle import bridge
  - Automatic seeding of Freedom's canonical Radicle repository when running the bundled node
- Swarm encrypted reference support in navigation and URL rewriting (including 64- and 128-character hex references)

### Fixed

- `Cmd/Ctrl+L` now reliably focuses the address bar even when web content has focus
- Pressing `Cmd/Ctrl+L` and `Escape` now consistently closes open menus and clears stale focus highlights
- Pinned tabs can no longer be closed through keyboard-accelerator close-tab actions

### Security

- Validate protocol-specific identifiers in IPC handlers and URL rewriting to block malformed or malicious input

## [0.6.1] - 2026-02-08

First public open-source release.

### Added

- Keyboard shortcuts: Ctrl+PgUp/PgDn to switch tabs, Ctrl+Shift+PgUp/PgDn to reorder tabs, Ctrl+F4 to close tab, Ctrl+Shift+T to reopen closed tabs, Ctrl+Shift+B to toggle bookmark bar, F11 for fullscreen, F12 for devtools
- Bookmark bar toggle that persists to settings and always shows on new tab page
- About panel with version, copyright, credits, website, and app icon
- DNS-over-HTTPS resolvers (Cloudflare DoH, eth.limo) for reliable dnsaddr and DNSLink resolution
- ESLint, Prettier, and EditorConfig for consistent code formatting

### Changed

- Split reload into soft (Ctrl+R, uses cache) and hard (Ctrl+Shift+R, bypasses cache); toolbar reload button defaults to soft, Shift+click for hard
- Switch IPFS content discovery from DHT to delegated routing via cid.contact

### Fixed

- Address bar staying focused after selecting autocomplete suggestion
- Unreadable pages in dark mode — inject light background/text defaults for external pages that don't support dark mode
- ENS resolution reliability: replace broken RPC providers (llamarpc, ankr, cloudflare-eth → drpc, blastapi, merkle) and fix failed handle cleanup
- View-source address bar and title not updating correctly
- IPFS routing and DNSLink resolution on networks with broken or slow local DNS

### Security

- Add Content Security Policy headers to all internal HTML pages
- Validate IPFS CID format, IPNS names, and block malformed `bzz://` requests
- Harden webview preferences, restrict `freedomAPI` to internal pages only, tighten local API CORS and IPC base URLs, redact logged URLs
- Resolve all npm audit vulnerabilities (11 total: 10 high, 1 moderate)
- Updated dependencies: Electron 39→40, electron-builder 26.0→26.7, better-sqlite3 12.5→12.6, electron-updater 6.6→6.7

## [0.6.0] - 2026-01-01

First public preview (binary-only).
