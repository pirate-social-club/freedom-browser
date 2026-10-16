// One GET for the Spaces resolver, through the fetch it is given (in the app,
// the requesting window's Electron session, so the request follows that
// session's proxy routing like a page load). Cookies are never sent, redirects
// are refused, nothing is cached, the answer must be a 200, and the body is
// read up to `limit` bytes and no further.
const DEFAULT_TIMEOUT_MS = 10000;

const failure = (message, cause) => new Error(message, cause ? { cause } : undefined);

async function fetchBytes(fetchImpl, url, { limit, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reader = null;
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
    });
    if (response.status !== 200) {
      response.body?.cancel?.().catch(() => {});
      throw failure(`HTTP ${response.status}`);
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > limit) {
      response.body?.cancel?.().catch(() => {});
      throw failure('response too large');
    }
    const chunks = [];
    let size = 0;
    if (response.body) {
      reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw failure('response too large');
        chunks.push(Buffer.from(value));
      }
      reader = null;
    }
    return { headers: response.headers, bytes: Buffer.concat(chunks) };
  } catch (err) {
    reader?.cancel().catch(() => {});
    if (controller.signal.aborted) throw failure('timed out', err);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchBytes, DEFAULT_TIMEOUT_MS };
