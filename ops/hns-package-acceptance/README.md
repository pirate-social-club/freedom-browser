# Current Linux package acceptance

The manual hns-current-package-acceptance workflow installs the current lockfile and pinned diagnostic tools on a disposable hosted Ubuntu24 runner. Cold setup is bounded separately. Its one-CPU,2-GiB,no-swap,nice19 package exercise includes preparation, actual first-tab/readiness/Home observations, mandatory DNSSEC/DANE refusal and final controls, and cleanup within600seconds. Exact runtime and harness inputs are pinned by their manifests.

The workflow has contents-read permissions, uploads only whitelisted public receipts and creates no tag or release. Offline packaging compares source, assets, helper, Electron, native SQLite and Axios1.20.0 bytes. Missing resources, incomplete controls, unsupported namespaces/sandbox or incomplete cleanup fail. Fresh signed fixtures are queried read-only without SSH or provider mutation. Runtime private state is removed only after the dedicated cgroup is gone.

The warm renderer reload leaves helpers running and is not a full application restart. Manual remote navigation proves routing, not availability. The separate three-public-host diagnostic remains mandatory. Hosted egress does not prove local Mullvad compatibility; the local VPN stays unchanged. Source pins must be reviewed and resealed after any runtime change.

The Linux candidate is built as a deb without network access using the locked builder FPM distribution prepared and checksum-verified during cold setup. The disposable Ubuntu24 runner installs the actual deb with dpkg; no dependency repair/download is permitted in acceptance. The installed payload path set and bytes, generated maintainer scripts, AppArmor profile, native SQLite and Axios are checked. The generated named AppArmor profile grants userns and uses unconfined mode; attachment is not a general AppArmor confinement claim. The Ubuntu restriction remains1.

Runtime uses root-owned network/mount namespaces and an ordinary host UID through setpriv, with no outer or inner harness user namespace and no sandbox-disabling flag. Only browser profile/XDG/temporary state is owned by that UID; signing keys remain root-only. The ordinary user's actual passwd HOME is retained. After mandatory welcome observations, acceptance combines owned renderer PID/start-time, host-view UIDs and uid maps, zero effective capabilities, NoNewPrivs1, seccomp2 with an additional filter, user/PID namespace separation, named profile attachment, and Electron isolated-context sandbox/context-isolation proof. This combined proof replaces the earlier Python eligibility diagnostic; it does not claim a chrome://sandbox page was tested. All original DNSSEC/DANE negatives and final controls remain mandatory. Installed package/profile removal follows process cleanup only on the disposable runner.

This revision is prepared and statically reviewed only until bounded verification and actual hosted installed-deb acceptance finish. Local full lint/unit/binary gates and hostile proof-validator fixtures are required before publication.

Combined renderer OS and Electron isolated-context proof is mandatory both after welcome and after the final HNS controls, with distinct pre-security and final receipts. Package/profile removal is allowed only after every tracked owned process has stopped.

A failed offline build now retains the last 50 lines, bounded to a 64 KiB read, of offline-build.log as offline-build-error.log. This explicit publication exception applies only to credential-free package preparation before fixture generation. The system service receives a fixed environment without GitHub tokens or repository secrets, and checkout credentials are not persisted. FPM preflight, environment, browser, profile and fixture logs remain private. This records the actual unknown build error instead of relying solely on classifier markers.

Hosted run 36964864589 exposed FPM File.lchown failing with EINVAL while copying runner-owned icon metadata. A build user namespace mapping only root cannot represent that source owner. Packaging now uses only a network namespace, preserving host UID/GID mappings for FPM ownership copies while retaining no-network packaging. The root-owned preparation service was already required for installation; this does not change the ordinary browser UID, Chromium namespace sandbox, AppArmor profile or restriction value. Actual installed-deb acceptance remains required.

Automation uses the private work/ab socket directory. Before CLI use, a preflight records only its byte length and requires the pinned CLI 103-byte maximum. The former long directory/session path was 112 bytes; the private short directory gives 93 bytes. Finite manual-action diagnostics retain command phase, index, error class and numeric return code or errno without raw browser/fixture/error text. Installed-deb run 36965918474 proved packaging, installation, profile loading and initial/readiness/warm local-page observations, then failed before completing manual/Home and security acceptance. Exact failed command output was not retained; the overlong socket path is independently established from configuration and pinned binary strings.

Run36967757554 passed the complete welcome/manual/Home checks but refused the pre-security renderer OS proof. The former receipt retained only its stage. Failed proofs now retain safe main/renderer observations before verdicts, named predicate booleans and finite proc-read stage/error/errno. Executable identity, PID/starttime stability, UID, capability, NoNewPrivs, seccomp, namespace, profile and UID-map guards are unchanged and remain mandatory. No raw browser, context exception, path or fixture-key text is added.

Run 36969561390 completed all welcome controls but selected no renderer candidates using descendant command-line tokens, so no renderer sandbox state was tested. The proof now obtains renderer OS PIDs through the browser endpoint SystemInfo.getProcessInfo, requires that endpoint to report the launched browser PID, and binds every process to the exact service cgroup, installed executable and stable start time. Every original OS/Electron guard remains enforced. Empty, malformed, changed or disappearing inventories fail. The precise reason the literal command-line selection missed renderers remains unmeasured; pinned runtime protocol support is still to be demonstrated.

The revised context proof uses one browser endpoint bound to the launched PID and renderer inventory. It selects the exact installed UI URL and binds every other page/webview target to an actual UI webview by its current URL and webContents ID. Ambiguous duplicate URLs, missing guests and changing membership fail. Each target's Page.getFrameTree main frame must retain its frame ID, loader ID and URL. Runtime contexts are selected by that frame ID, with one default context and one Electron isolated context; unrelated child-frame contexts do not invalidate the count. Every evaluation uses the selected unique context ID. The proof observes distinct existing worlds and requires process and require to be absent in the page world. It creates no worlds and changes no preload, preferences or application bytes. All OS sandbox requirements remain enforced for every reported renderer before and after the security phases.

Runtime version evidence is now explicit: npm ci verifies the lockfile-pinned Electron package; its checksums authenticate the retained downloaded archive; the archive version and executable match the distribution; the packaged and installed executable hashes match that distribution. Both proof phases verify the installed digest and require each live executable to share its device/inode, alongside the existing path, PID/start-time and cgroup checks. The parsed user-agent Electron token is a non-authoritative observation only. This replaces the inaccessible global process.versions and process.sandboxed observations with the explicit binary provenance and actual OS sandbox evidence; context isolation remains an independent mandatory runtime proof.

Context failures retain fixed assertion/operation identifiers, selected target/frame/context IDs, finite counts and predicate booleans. CDP protocol errors retain only their numeric code; evaluation exceptions retain an allowlisted exception class. Raw exception messages, stacks, origins, URLs and user-agent strings are not published. URL digests permit identity comparisons without revealing page text. Hermetic protocol fixtures cover both targets, legitimate extra frames, missing/wrong/duplicate worlds, exposed Node globals, document/target changes, guest mismatches and diagnostic privacy. Archive fixtures cover corrupted or mismatched version and executable links. Actual hosted behavior remains unproved until a complete new installed-deb pass.

The world-selection rule follows the pinned [Electron 42.10.0 frame observer](https://github.com/electron/electron/blob/v42.10.0/shell/renderer/electron_render_frame_observer.cc#L114-L168): context isolation creates the named isolated world for a main frame. The probe observes that existing world and its distinct context identity. This is evidence of the effective isolation preference, not a general audit of every bridge API. Context destruction, clearing or replacement during observation also refuses the proof.


## Live a18n browser acceptance

Dispatch the existing package workflow with journey set to a18n to open the
working public staging hosts through the installed browser address control.
The default fixtures journey retains its existing security controls. The a18n
journey uses the same pinned application files, package installation, native
sandbox checks and owned-process cleanup, with no product or dependency change.
It is a fresh build of the accepted application inputs, not a reuse of a saved
installable package. The runtime source pins remain unchanged.

The public journey starts no fixture DNS or TLS server and installs no nftables
redirection. Normal OS resolution in the disposable namespace uses slirp's DNS
forwarder; the browser's real public HNS answers are not replaced. No host
mapping, certificate waiver, authenticated session or wallet call is used.
Both successful pages must render their expected community or member content
and return 200 in their actual webview. The unclaimed host must return 421.
Only finite identity predicates and navigation status are retained, alongside
the existing provenance, sandbox, resource and cleanup receipts.

The seven driver regressions reject wrong status or destination, absent
rendered content, claimed content on an unclaimed host, an unready resolver,
missing or duplicate webviews, a wrong or ambiguous installed UI target, and a URL changing during observation. These are driver checks. A complete hosted
run is still required to establish actual browser acceptance. This task does
not establish a browser upgrade, a new security release, local VPN behavior,
full application restart, Bob Extension acceptance or production readiness.

The a18n mode is a credential-free public diagnostic. It records the full
build dependency audit, admits only the two known advisories at original
pinned development-only paths, and requires a completely clean production
audit. Unknown findings and audit command or protocol failures refuse the
run. Before browser launch it inspects every actual installed ASAR entry and
unpacked path for braces and http-cache-semantics, including nested copies.
Receipts explicitly deny merge or release acceptance. This mode does not
clear the full audit; ordinary CI and the default fixtures journey retain
their strict full-audit gates.

The public diagnostic uses the official ipfs/kubo GitHub release archive
after the original distribution endpoint failed in run37105756502. Its
version, archive and original SHA512 are fixed and verified before
extraction. Cold receipts bind the original failure, both source URLs,
archive digest and extracted executable identity. Default fixtures keep
the original downloader. Product downloaders, dependency pins and native
expectations are unchanged.
