# Scoped Jest repair

This hosted workflow generates exact Jest and babel-jest 30.3.0 inputs
from the retained 30.2.0 lock. It refuses unrelated manifest or production graph
changes and requires every braces/micromatch package and incoming edge to be
gone. It runs lifecycle-disabled installation, lint and the entire existing
990-test Jest discovery. No application input, dependency override or audit
policy changes during generation. Download/build validation is separate.

The npm result and exact protected-entry restorations are retained separately.
Unrelated production and development entries are restored from the original
lock before validation, including original nested copies. A clean npm install
and explicit semantic-version checks must accept every incoming edge to those
entries before test success can validate the candidate.
Jest's JSX and TypeScript syntax plugins keep their newer Babel helpers in
nested copies, so other Babel consumers retain their original helper. Each
resolution is checked.

The full high-severity audit still runs. A successful refresh receipt means
the Jest repair validated; its full_audit_passed field records whether the
remaining downloader advisory still fails. The ordinary CI gate is unchanged.
There is no advisory exception. Source publication of a generated lock still
requires independent graph and receipt review before applying it.
Advisory dependency cycles are followed with a visited set; every finding
must still reach the known advisory. Unrooted cycles and missing references
are refused. A rooted cycle does not turn the failed full audit into a pass.

Generation and installation are allowed only on a disposable hosted runner.
Local fixtures validate refusal logic without npm or a browser. The hosted
unit uses one CPU, CPU0, nice19, 3 GiB and no swap. Artifacts contain candidate
manifests, graph changes, public audit metadata and finite verification receipts.
Private command logs, full test objects, caches and installed trees stay on
the disposable runner. The workflow records unit/cgroup cleanup separately.

Generation used a path-scoped pull-request event restricted to PR39's
same-repository integration branch, with checkout and receipt bound to its
exact head. That automatic trigger is retired after adoption because its
original baseline is obsolete. Historical run 37107456500 at 066cc653 retains
the accepted generator source and inputs. Manual reproduction must use that
historical pre-adoption source; the current installed lock is not a generation
baseline. No workflow writes back to Git. The complete audit command remains.

The workspace_owner approved the exact GHSA-ch52-4w7c-c8xp exception on
2026-10-03. The immutable policy records the approved proposal digest, exact
lock, all eight findings and their complete dependency records. The guard
accepts it only in CI's dependency-audit job before 2026-10-10 at 00:00 UTC.
Changed lock or manifest bytes, paths, records, finding identities, severity,
advisory ancestry, runtime reachability, malformed audit or expired approval
refuse the exception. Future policy changes require another owner decision.

CI still runs the complete `npm audit --audit-level=high --json`, retaining
the full output and actual exit code. Its job summary and separate verdict
show that the full audit failed when this exception is used. A green
development check under this policy provides no packaging or release
acceptance. Effective downloader/cache configuration, isolated ownership and
actual packaged exclusion evidence remain necessary before packaging. The
installed-browser, ordinary Mullvad, three-public-host and exact release
approval requirements remain. No broad development-dependency exclusion is
applied. Pure refusal fixtures use the accepted hosted audit as their input
and make no network requests.
