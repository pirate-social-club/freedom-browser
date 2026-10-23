# HNS prefetch control diagnostic

The recurring CI failure loses the probe result after Jest reports its first
failed assertion. This experiment preserves the complete synthetic probe output,
exit status, runtime versions, lookup timing and phase timing. The first two
observations preserved all original assertions and settings. The third tested
explicit control enablement and still failed. The fourth restored the original
control and added renderer observation. The fifth varies guest attachment as
described below; fifteen-second round bounds and ninety-second child timeout
remain unchanged.
The process helper belongs beside the integration
test because it owns only that test's children and temporary profiles.

The HNS prefetch diagnostic workflow now runs two serial batches, each of six
serial protected/control pairs, on
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

The first fixed experiment, run39989385524 at ec0f2014, failed pairs1,5,6 and
passed pairs2,3,4. Every failed pair lacked all six default first-page hints;
image controls loaded, second-round hints appeared, and protected probes passed.
This distinguishes the first navigation from later navigation but does not
identify the cause. All outcomes remain preserved without a selective rerun.

The next fixed six-pair experiment adds network observation only. Each probe
captures Chromium network metadata with netLog in default mode, with an eight
MiB stop threshold, and native completion messages from simple_network_hints_handler_impl at
verbosity2. This distinguishes missing requests from browser/resolver rejection
or cancellation before the DoH observer. Logging stops and flushes before the
result is emitted; missing, malformed, empty, unflushed or size-capped evidence
fails the diagnostic. Electron stops after exceeding its threshold, so this is
not a strict physical file-size cap. The assessor refuses every log at or above
eight MiB; twelve accepted logs per batch therefore total less than96MiB, and
the two batches less than192MiB. Raw rejected
files remain evidence and may exceed that total.
Native completion messages remain in the existing stderr evidence. Normal CI
does not enable this optional logging. All assertions, page contents, guest
creation/order, settings and runtime bounds remain unchanged. Instrumentation
may perturb a race; six passes without recurrence are inconclusive.

Electron documents the logging interface at
https://www.electronjs.org/docs/latest/api/net-log and the native logging flags
at https://www.electronjs.org/docs/latest/api/command-line-switches.
The completion log source for the packaged Chromium version is
https://github.com/chromium/chromium/blob/152.0.7977.167/components/network_hints/browser/simple_network_hints_handler_impl.cc.

The second fixed experiment, run39994603094 at65c58b01, passed pairs1 through5
and failed pair6. The failed first default-page hints have neither resolver
request events nor native completions, though their response headers arrive.
All protected probes pass; private first-page and both second-page requests
appear in the failed control. Cleanup passed and nothing was retried. This
places the missing observation before resolver handling, without identifying
its renderer, settings or IPC cause.

The third fixed six-pair experiment changes one control input: explicitly set
dnsPrefetchingEnabled=true before app readiness, instead of relying on the
unconfigured default. The protected probe still calls Freedom's real startup
settings and requires dnsPrefetchingEnabled=false. All twelve required default
control hints, image controls, private all-or-none qualification, page content,
guest order, theme changes, timeouts, resources and cleanup stay unchanged.
The launch-setting assertion now verifies the explicit positive-control value.
Network observation remains enabled for the diagnostic and off for ordinary CI.

Chromium152.0.7977.167 starts the underlying Blink setting as false, supplies
true in WebPreferences, and reapplies command-line settings after preferences.
Its explicit link-hint path checks that setting before requesting networking.
This makes implicit preference initialization a testable hypothesis; it does
not prove that it caused either captured failure. If the same absence recurs,
explicit enablement is insufficient. If all six pass, the result only supports
the hypothesis and does not establish a repair. Do not retry failed samples or
merge a repair claim from this one fixed sample. A correction still needs
independent review, a meaningful negative control and a predeclared repeated
verification plan.

The pinned primary sources for this hypothesis are
https://github.com/chromium/chromium/blob/152.0.7977.167/third_party/blink/renderer/core/frame/settings.json5,
https://github.com/chromium/chromium/blob/152.0.7977.167/third_party/blink/public/common/web_preferences/web_preferences.h,
https://github.com/chromium/chromium/blob/152.0.7977.167/third_party/blink/renderer/core/exported/web_view_impl.cc,
and https://github.com/chromium/chromium/blob/152.0.7977.167/third_party/blink/renderer/core/loader/preload_helper.cc.

The third fixed experiment, run39998846007 at262508ff, failed pairs1 and6
and passed pairs2 through5. Every control confirmed explicit enablement, but
the failed first-default hints again had no resolver requests or native
completions. All protected probes and cleanup passed. Explicit enablement is
therefore insufficient; this result does not establish the renderer's actual
setting or prove an initialization cause.

The fourth fixed six-pair experiment restores the original unconfigured
control from65c58b01 and adds renderer-side native hint-trigger observation.
Only the dedicated network diagnostic appends logDnsPrefetchAndPreconnect=true
to both startup cases; Freedom's protected setting remains false. A probe-only
helper beside the process helper attaches before web contents can navigate.
It collects only the pinned synthetic hint names, with contents identity and
elapsed time, at most64 messages and16 contents. Overflow, invalid/absent
capture, a protected trigger or missing second-default-page control triggers
fails diagnostic evidence qualification. Ordinary CI attaches no observer and
again uses the original unconfigured positive control.

Chromium's preload helper emits the native console message after its setting
and URL checks, before asking PrescientNetworking to send a request. Messages
for missing first-page hints would place the loss after that gate and before
browser resolver observation. No first-page messages with valid later capture
would place it before that trigger; they would not alone prove which check
failed. This is observation, not a repair. Six pairs, all mandatory DNS
assertions, pages, guest order, theme changes, timeouts, resources and cleanup
remain fixed. No sample is retried and no passing sample alone closes the task.

The console event interface is documented at
https://www.electronjs.org/docs/latest/api/web-contents#event-console-message.

The fourth fixed experiment, run40001567731 atc11cc800, failed pairs1,2,6.
Every control emitted all24 renderer trigger messages, including missing first
default-page hints; those names still had no resolver request or completion.
All protected probes and cleanup passed. The loss is after the renderer gate,
without identifying a specific IPC or guest-initialization cause.

The fifth experiment changes guest startup only in the dedicated diagnostic.
Both guests start at about:blank; after both did-attach-webview events arrive,
their first actual hint pages are loaded once in the existing default/private
order. There is no warm-up network request, arbitrary delay or hint retry.
The first and second hint documents, required DNS observations, theme updates,
private all-or-none rule, protected startup setting, original control setting,
round/child bounds, evidence caps and cleanup remain required. Ordinary CI
retains its original eager startup, so this is an experiment, not a repair.

Two predeclared serial batches of six pairs run, even if the first batch fails;
neither batch may be selectively retried or omitted. Each fresh hosted job has
the existing oneCPU/threeGiB/zero-swap and22minute experiment/35minute job bounds.
Attachment readiness and both first navigations must be proved in each probe;
a green Jest report cannot replace missing or failed startup evidence. Any
missing first default hint falsifies attachment alone as a sufficient repair.
All12 passing pairs would support this startup hypothesis, not establish the
underlying engine cause or clear a change to ordinary CI without review.

Electron44.9.3 constructs WebPrescientNetworkingImpl for the frame, and the
pinned Chromium implementation binds its handler through the frame's browser
interface broker. Those facts motivate testing attachment; they do not prove
that the earlier messages were lost there. Sources:
https://github.com/electron/electron/blob/v44.9.3/shell/renderer/renderer_client_base.cc,
https://github.com/chromium/chromium/blob/152.0.7977.167/components/network_hints/renderer/web_prescient_networking_impl.cc,
https://github.com/chromium/chromium/blob/152.0.7977.167/components/network_hints/browser/simple_network_hints_handler_impl.cc.
