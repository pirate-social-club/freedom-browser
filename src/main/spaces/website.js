const net = require('net');

// A Space's website is a SIP-7 TXT record keyed `website` in the record set its
// owner signs. libveritas puts a set in `zone.records` only when the zone's
// current owner key signed it for this exact name; delegate-signed sets
// (`zone.delegate.value.records`) and on-chain data (`zone.fallback_records`)
// are deliberately not read. The record must hold exactly one https URL, with
// no credentials and a host name of at least two labels (no IP literal,
// localhost, .local or bare single label, which a local resolver or search
// domain could answer); a path is allowed. The owner's signature authenticates
// the address; Freedom then loads it like any typed https URL, so the server is
// authenticated by WebPKI, or by DANE through Freedom's Handshake resolver when
// the host is a Handshake name and that integration is on.
const MAX_URL_LENGTH = 2048;

function parseWebsiteUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH || value !== value.trim())
    return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || host.startsWith('[') || net.isIP(host)) return null;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return null;
  return url.href;
}

/** `{ url }` from an owner-signed record set, or `{ reason }` saying why there is none. */
function websiteFromZone(zone) {
  const records = Array.isArray(zone?.records) ? zone.records : [];
  const websites = records.filter((record) => record?.type === 'txt' && record.key === 'website');
  if (websites.length === 0) return { reason: 'NO_WEBSITE_RECORD' };
  const values = websites[0].value;
  if (websites.length !== 1 || !Array.isArray(values) || values.length !== 1) {
    return { reason: 'INVALID_WEBSITE_RECORD' };
  }
  const url = parseWebsiteUrl(values[0]);
  return url ? { url } : { reason: 'INVALID_WEBSITE_RECORD' };
}

module.exports = { parseWebsiteUrl, websiteFromZone };
