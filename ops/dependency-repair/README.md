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

Generation and installation are allowed only on a disposable hosted runner.
Local fixtures validate refusal logic without npm or a browser. The hosted
unit uses one CPU, CPU0, nice19, 3 GiB and no swap. Artifacts contain candidate
manifests, graph changes, public audit metadata and finite verification receipts.
Private command logs, full test objects, caches and installed trees stay on
the disposable runner. The workflow records unit/cgroup cleanup separately.

The first run uses a path-scoped pull-request event restricted to PR39's
same-repository integration branch. Checkout and receipt source both bind to
the exact pull-request head. Manual dispatch uses that branch after GitHub
admits the workflow on the default branch. No workflow writes back to Git.
