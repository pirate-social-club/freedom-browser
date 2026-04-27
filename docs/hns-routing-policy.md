# HNS Routing Policy

Freedom treats single-label hostnames as the canonical Handshake browsing path.

Examples:
- `pirate/`
- `app/`

For convenience, Freedom also supports a small allowlist of dotted public HNS suffixes. The source of truth is:

- [src/shared/hns-hosts.js](/home/t42/Documents/pirate-workspace/freedom-browser/src/shared/hns-hosts.js)

Current defaults:
- single-label names: routed to HNS
- `*.pirate`: routed to HNS

Non-goals of the default policy:
- Freedom does not route every unknown dotted TLD to HNS first.
- Freedom does not treat ICANN domains as HNS candidates.

ENS precedence:
- ENS-style names such as `.eth` and `.box` are handled separately.
- HNS heuristics must not intercept ENS resolution paths.

Operational rules:
- Main-process PAC routing and renderer-side error classification must use the same HNS host detection rule.
- Adding a new dotted HNS suffix requires updating `src/shared/hns-hosts.js` and rerunning tests.
- Changing the default to “route unknown TLDs to HNS first” would be a separate product decision.
