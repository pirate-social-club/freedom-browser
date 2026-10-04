# Shared request dispatcher provenance

The main-process dispatcher and its initial tests come from upstream stable v0.8.6, commit `0934f1d5485d4d805a8a785ab17d33d88a22eeef`, in [solardev-xyz/freedom-browser](https://github.com/solardev-xyz/freedom-browser/tree/0934f1d5485d4d805a8a785ab17d33d88a22eeef). Those two files retain MPL-2.0 notices and are available under [MPL-2.0](https://mozilla.org/MPL/2.0/). Freedom's application declaration remains AGPL-3.0-or-later.

The adaptation adds explicit session scoping, one-time attachment and a synchronous request-policy check. Consumers keep upstream registration order, header chaining and notification fan-out. All consumers must register before the first session attaches. API diagnostics remain scoped to their enrolled session and approved API hosts.

A guarded session supplies `getRequestPolicy`, returning a synchronous snapshot with a Boolean `allowed` and a nonnegative safe integer `generation`. The caller must advance the generation whenever routing or its permission changes, including a temporary withdrawal followed by recovery. The dispatcher checks it before consumers run and before each callback. A missing, malformed, asynchronous, throwing, withdrawn or changed snapshot cancels the request. A guard cannot be removed by reattaching the same session. Guards are independent of consumer exclusion and attach even with no consumers.

This dispatcher supports request cancellation. It does not stop established streams, validate native proxy changes or quarantine a session automatically. The proxy controller must supply the policy and prove connection shutdown before that containment can be claimed. No renderer IPC or new dependency is added; interception remains owned by the main process.
