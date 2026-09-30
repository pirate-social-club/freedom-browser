# Current Linux package acceptance

The manual hns-current-package-acceptance workflow installs the current lockfile and pinned diagnostic tools on a disposable hosted Ubuntu24 runner. Cold setup is bounded separately. Its one-CPU,2-GiB,no-swap,nice19 package exercise includes preparation, actual first-tab/readiness/Home observations, mandatory DNSSEC/DANE refusal and final controls, and cleanup within600seconds. Exact runtime and harness inputs are pinned by their manifests.

The workflow has contents-read permissions, uploads only whitelisted public receipts and creates no tag or release. Offline packaging compares source, assets, helper, Electron, native SQLite and Axios1.20.0 bytes. Missing resources, incomplete controls, unsupported namespaces/sandbox or incomplete cleanup fail. Fresh signed fixtures are queried read-only without SSH or provider mutation. Runtime private state is removed only after the dedicated cgroup is gone.

The warm renderer reload leaves helpers running and is not a full application restart. Manual remote navigation proves routing, not availability. The separate three-public-host diagnostic remains mandatory. Hosted egress does not prove local Mullvad compatibility; the local VPN stays unchanged. Source pins must be reviewed and resealed after any runtime change.
