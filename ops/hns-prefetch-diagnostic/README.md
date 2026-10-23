# HNS prefetch control diagnostic

The recurring CI failure loses the probe result after Jest reports its first
failed assertion. This experiment preserves the complete synthetic probe output,
exit status, runtime versions, lookup timing and phase timing. The original
assertions, guest order, fifteen-second round bounds and ninety-second child
timeout remain unchanged. The process helper belongs beside the integration
test because it owns only that test's children and temporary profiles.

The HNS prefetch diagnostic workflow runs six serial protected/control pairs on
Ubuntu 24.04 with locked Node 24.14.0 and Electron 44.9.3. Each pair has fresh
profiles and a separate evidence directory. Jest and all Electron descendants
share one CPU on CPU0, nice19, three GiB of memory and zero swap. The experiment
has a twenty-two-minute bound inside a thirty-five-minute job. Insufficient
setup time is a failure; it does not silently reduce the declared sample count.

There are no sample retries. Every outcome is retained, and any failure makes
the aggregate fail. Cleanup is verified between pairs; failed cleanup prevents
another browser from starting and records the remaining samples as not run.
The separate workflow name is not watched by the CI automatic-rerun workflow.
All six clean samples still leave the underlying instability unresolved. Choose
a further experiment from the captured evidence rather than treating no
recurrence as a repair.

The normal CI job also retains probe evidence in its existing artifact. Its
assertions and acceptance rules are unchanged. Only the separate diagnostic
additionally rejects nonzero probe exits and incomplete evidence.

The workflow is the runtime entrypoint. Do not run its browser workload on a
developer machine. Pure fixture checks launch no browser and are available with
`python3 -B -m unittest discover -s ops/hns-prefetch-diagnostic -p '*_test.py'`
and the `hns-discovery-probe-runner.test.js` Jest suite. The workflow uses no
staging service, real profile, wallet, credential or public namespace.
