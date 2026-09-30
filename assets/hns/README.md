# Mainnet checkpoint provenance

checkpoint_main.dat is a release-pinned hnsd 2.0.0 checkpoint starting at
348000 and containing 150 headers through 348149. Its SHA-256 is
c23b485e961e406d9d302932feeb2aaea8f39c47001a04435c426c03414ceea1.
The runtime pin is in src/main/hns-checkpoint.js.

The public headers and previous cumulative work were obtained on 2026-09-30
through the existing operator mainnet observer's read-only RPC reader. The
observer reported blocks=349270, headers=349270, verificationprogress=1.
No wallet or RPC credential is included in this asset. All 150 hashes, proof
of work, links and cumulative-work increments were independently recomputed
from the pinned hnsd source at a5c7c287e848f46d3e97f16b698e2027c8dc96c3.
Block 348000 independently matches the public explorer at
https://3xpl.com/handshake/block/348000, hash
00000000000000082292696c035138cb5cbe7f4db9f167f179d3b330c17b6828.
The starting cumulative work is trusted to the existing fully verified
observer; the public explorer did not expose that field for a second check.

Checkpoint import trusts its anchor. It is not a substitute for validating
its provenance during review. The shipped daemon loaded this checkpoint and
then validated 1,125 additional headers received from an existing public
peer, reaching 349274 and synced=true within 35 seconds in one controlled
run. Two other runs with this checkpoint stalled before receiving headers.
Peer reachability still affects startup; no seed-list repair is established.

Fresh profiles receive this file only after its digest, network magic,
version, size and height pass validation. Existing profile checkpoints are
preserved. Nothing downloads a replacement checkpoint at runtime.
To refresh the asset, derive a complete window from a fully verified mainnet
observer, independently check hashes, work and a public chain anchor, repeat
the exact shipped-daemon comparison, and update the digest and height pins
with the asset in a reviewed source change. Never accept an unpinned network
checkpoint or change certificate policy as a sync fallback.
