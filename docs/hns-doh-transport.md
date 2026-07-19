# HNS DoH transport and validation boundary

Status: design requirement for Freedom Browser 0.8. This document defines the
security and availability properties that must be implemented before the HNS
DoH path is release-ready. It does not authorize copying code from the
PolyForm-licensed `hns-dane-browser` reference implementation.

## Problem

The bundled `hnsd` resolver reaches delegated authoritative nameservers over
UDP or TCP port 53. Networks that block or intercept outbound port 53 make that
path unavailable even when the HNS name, authoritative DNS, and HTTPS origin
are healthy. Freedom 0.7.11 then depends on two endpoints operated by the same
legacy DoH provider. An outage at that provider makes every non-SYNTH external
HNS name unavailable on such networks.

DoH is therefore a transport fallback and an availability dependency. It is
never an authority for HNS data.

## Security invariant

Freedom sends DNS wire-format queries with DNSSEC requested (`DO=1`) over
HTTPS and receives complete wire-format answers, including the records needed
to validate the response. Every answer used for HNS routing or TLS policy must
be validated locally against the HNS resource value anchored in Freedom's
locally held, validated Handshake chain state:

```text
local Handshake header/tree root
  -> verified HNS name resource
  -> DS
  -> child DNSKEY and RRSIG
  -> signed A/AAAA/CNAME/TLSA or authenticated denial
  -> TLSA-to-presented-certificate match
```

No AD bit, provider assertion, provider certificate, cached answer, or majority
agreement can replace this chain. A malicious DoH provider may omit, delay,
replay outside accepted DNSSEC validity, or refuse an answer. It must not be
able to forge an accepted address, denial, or TLSA record. Validation failure
is terminal for that response and must never degrade to WebPKI for an HNS DANE
origin whose policy requires TLSA.

SYNTH names are the transport-independent control: their address is derived
from locally verified HNS resource data and must not require authoritative DNS
or DoH.

## Provider model

- Configure at least two independently operated recursive HNS DoH endpoints.
- Treat provider order as an availability policy, not a voting or trust rule.
- Allow users to view, add, disable, remove, and reorder providers.
- Ship no provider whose hostname or bootstrap address requires the HNS path it
  is meant to recover.
- Authenticate endpoint transport with ordinary WebPKI and resolve its ICANN
  hostname without sending the HNS query to the operating-system resolver.
- Bound request size, response size, redirects, connection time, total time,
  CNAME depth, concurrent queries, and provider retries.
- Send the minimum DNS question required for the requested navigation. Do not
  send browser URLs, paths, profile identifiers, or unrelated names.
- Cache only locally validated results, respecting DNS TTL and RRSIG validity.
  Never share resolver cache entries across browser profiles.
- A Pirate-operated resolver may be one default, but must not be the sole
  bundled default or a hidden mandatory dependency.

Provider responses are evaluated independently. The first response that passes
the complete local validation policy may be used. An invalid response is a
provider failure, not evidence that the name is invalid. Authenticated denial
is accepted only when its DNSSEC denial proof validates locally.

## Native boundary

DoH belongs inside the native `fingertipd`/resolver boundary that already owns
HNS resolution and DANE enforcement. Electron supplies profile-scoped provider
configuration and renders typed status; it must not parse a DoH answer into a
trusted address or bypass native validation.

The daemon contract must expose enough typed state to distinguish:

- `dns_transport_blocked`: direct UDP/TCP port 53 is unavailable or intercepted;
- `doh_transport_unavailable`: all enabled DoH providers failed before a usable
  DNS response was obtained;
- `name_not_found`: locally verified current HNS non-inclusion or a validated
  delegated DNSSEC denial;
- `authoritative_unavailable`: the name/delegation exists but no authoritative
  answer was obtainable through enabled transports;
- `dnssec_validation_failed`: the response did not validate against the local
  chain anchor;
- `dane_validation_failed`: secure TLSA data did not match the presented TLS
  certificate or the required TLSA proof was absent.

The renderer may use friendlier prose, but it must preserve these distinctions
in diagnostics. Provider URLs, response bodies, full navigation URLs, and
profile identifiers must not appear in ordinary logs.

## Resolution order

1. Derive SYNTH answers directly from locally verified HNS resource data.
2. Query enabled recursive HNS DoH providers over 443 and locally validate the
   returned chain against locally anchored HNS delegation data.
3. If the enabled DoH providers are unavailable, try direct authoritative DNS
   over UDP/TCP port 53 when the current network permits it, applying the same
   local validation policy.
4. Fail closed with the typed terminal reason. Never fall through to system DNS
   or accept an unvalidated response.

An implementation may race independent DoH providers, and may race direct DNS
when policy permits, but the first response is usable only after complete local
validation. Network capability results require a bounded lifetime and must not
be treated as global across profiles or network changes.

## Acceptance tests

Release acceptance requires all of the following:

1. On a network where outbound UDP and TCP port 53 are blocked, `https://g/`
   resolves through DoH, its DNSSEC chain validates locally, its `3 1 1` TLSA
   matches the presented self-signed certificate SPKI, and HTTPS returns 200.
2. The same test rejects a forged A answer, forged TLSA, missing RRSIG, invalid
   RRSIG, mismatched DNSKEY/DS, expired signature, and TLS certificate mismatch.
3. A SYNTH fixture resolves with every port-53 and DoH transport disabled.
4. Failure of the first provider advances to an independent provider; failure
   of all providers produces `doh_transport_unavailable`.
5. A provider returning authenticated NXDOMAIN is accepted only after local
   denial validation; an unsigned or invalid denial is rejected.
6. Two simultaneous browser profiles can use different provider lists and do
   not share validated or negative cache entries.
7. The packet capture for the hostile-network test contains no outbound DNS on
   port 53 after the network is classified blocked, and no HNS query is sent to
   the operating-system resolver.
8. Existing hermetic delegated-DNSSEC and DANE mismatch tests remain green.

The live `g` values are test observations, not permanent pins. The test must
discover and validate the current chain rather than hardcode its A, DNSKEY, or
TLSA values. A controlled hermetic fixture remains the deterministic CI gate;
`g` is the independent mainnet acceptance gate.
