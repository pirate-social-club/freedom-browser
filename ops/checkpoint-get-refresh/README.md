# Checkpoint downloader repair

This generator proposes only the Builder 26.15.3 dependency override to the
existing Get 5.1.0. It requires unchanged production records, removal of Got,
cacheable-request and http-cache-semantics, cold installation, a real Node 24
import and a full clean audit. Generated inputs require independent review.
The workflow does not write back to Git or build a browser.

The supported packaging recipe must prepare FPM directly with Get 5 and
system 7z, retain its existing checksum, and use explicit CUSTOM_FPM_PATH and
electronDist. Native resources must be prepared before packaging. The entire
deb build stays in a network namespace without an external route; missing
inputs fail. Existing PNG icons avoid the optional icon-tool downloader.

This does not establish compatibility of Builder's ordinary online downloader
with Get 5's timeout or proxy interface, or validate other platforms. It does
not waive licensing, installed acceptance, the public-host gate or release
approval. The baseline-bound generator is retired after lock adoption.
