# License Audit Notes for Freedom Browser

**Current fork license:** AGPL-3.0-or-later
**Updated:** 2026-05-08

> This is practical engineering guidance, not legal advice. Final release
> decisions should still be reviewed by counsel.

## Current Posture

Freedom Browser has been moved from its previous MPL-2.0 distribution posture
to an AGPL-3.0-or-later fork posture. This aligns the Freedom fork with the
wider Pirate workspace and makes future GPL-compatible runtime integrations
less awkward.

The `LICENSE` file and `package.json` now identify the fork as
AGPL-3.0-or-later.

## JackTrip

The current JackTrip integration manages user/system-provided JackTrip binaries.
It does not bundle JackTrip itself.

Before bundling any JackTrip artifact, record the exact artifact source and
license here:

- Signed macOS/Windows JackTrip builds without Classic GUI are expected to be
  MIT per upstream JackTrip license notes.
- Unsigned GitHub builds that include Classic GUI are GPL per upstream JackTrip
  license notes.
- Linux packages or user-built binaries must be checked per distribution
  artifact.

## Distribution Notes

AGPL/GPL-family distribution obligations are now expected for this fork. Release
packaging should include:

- AGPL-3.0-or-later license text for Freedom Browser.
- Third-party notices for Electron, Chromium, bundled npm dependencies, and
  bundled node binaries.
- Exact notices and corresponding-source instructions for any future bundled
  GPL-family runtime component.

## Historical Note

The previous audit concluded that the original Freedom Browser distribution was
MPL-2.0 with only permissive runtime dependencies. That conclusion is historical
context only and no longer describes the intended license posture of this fork.
