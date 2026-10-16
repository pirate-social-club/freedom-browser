const { fetchBytes } = require('./transport');

const streamOf = (...chunks) =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
      controller.close();
    },
  });

describe('Spaces transport', () => {
  test('returns the body and headers of a 200, asking for no cookies, redirects or cache', async () => {
    const fetch = jest.fn(async () => new Response('abc', { headers: { 'x-anchor-height': '1' } }));
    const { bytes, headers } = await fetchBytes(fetch, 'https://relay.test/anchors', { limit: 3 });
    expect(bytes.toString()).toBe('abc');
    expect(headers.get('x-anchor-height')).toBe('1');
    expect(fetch).toHaveBeenCalledWith('https://relay.test/anchors', {
      signal: expect.any(AbortSignal),
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
    });
  });

  test('refuses anything but a 200', async () => {
    const fetch = async () =>
      new Response('moved', { status: 302, headers: { location: 'https://elsewhere.test/' } });
    await expect(fetchBytes(fetch, 'https://relay.test/', { limit: 100 })).rejects.toThrow(
      'HTTP 302'
    );
  });

  test('refuses a declared length over the limit without reading the body', async () => {
    const fetch = async () => new Response('0123456789', { headers: { 'content-length': '10' } });
    await expect(fetchBytes(fetch, 'https://relay.test/', { limit: 9 })).rejects.toThrow(
      'response too large'
    );
  });

  test('stops reading a streamed body at the limit', async () => {
    const fetch = async () => new Response(streamOf([1, 2, 3], [4, 5, 6], [7]));
    await expect(fetchBytes(fetch, 'https://relay.test/', { limit: 6 })).rejects.toThrow(
      'response too large'
    );
    await expect(fetchBytes(fetch, 'https://relay.test/', { limit: 7 })).resolves.toMatchObject({
      bytes: Buffer.from([1, 2, 3, 4, 5, 6, 7]),
    });
  });

  test('gives up after the deadline', async () => {
    const fetch = (url, { signal }) =>
      new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason))
      );
    await expect(
      fetchBytes(fetch, 'https://relay.test/', { limit: 1, timeoutMs: 20 })
    ).rejects.toThrow('timed out');
  });
});
