const { parseWebsiteUrl, websiteFromZone } = require('./website');
const { parseSpaceHandle } = require('./names');

const txt = (key, value) => ({ type: 'txt', key, value });

describe('Spaces website record', () => {
  test.each([
    ['https://example.com', 'https://example.com/'],
    ['https://pirate.sc/c/@yahoo', 'https://pirate.sc/c/@yahoo'],
    ['https://app.pirate/', 'https://app.pirate/'],
    ['https://EXAMPLE.com:8443/a?b#c', 'https://example.com:8443/a?b#c'],
    ['https://bücher.example/', 'https://xn--bcher-kva.example/'],
  ])('accepts %s', (value, href) => {
    expect(parseWebsiteUrl(value)).toBe(href);
  });

  test.each([
    'http://example.com/',
    'ftp://example.com/',
    'https://user:secret@example.com/',
    'https://user@example.com/',
    'https://127.0.0.1/',
    'https://0x7f.1/',
    'https://[::1]/',
    'https://localhost/',
    'https://api.localhost/',
    'https://printer.local/',
    'https://intranet/',
    'https://pirate/',
    ' https://example.com/',
    'https://example.com/ ',
    'example.com',
    `https://example.com/${'a'.repeat(2048)}`,
    42,
  ])('refuses %s', (value) => {
    expect(parseWebsiteUrl(value)).toBeNull();
  });

  test('reads only the owner-signed TXT website record', () => {
    expect(websiteFromZone({ records: [txt('website', ['https://example.com/'])] })).toEqual({
      url: 'https://example.com/',
    });
    expect(
      websiteFromZone({
        records: [],
        fallback_records: [txt('website', ['https://example.com/'])],
        delegate: {
          status: 'exists',
          value: { records: [txt('website', ['https://example.com/'])] },
        },
      })
    ).toEqual({ reason: 'NO_WEBSITE_RECORD' });
    expect(
      websiteFromZone({
        records: [{ type: 'addr', key: 'website', value: ['https://example.com/'] }],
      })
    ).toEqual({
      reason: 'NO_WEBSITE_RECORD',
    });
    expect(websiteFromZone({ records: [txt('website', [])] })).toEqual({
      reason: 'INVALID_WEBSITE_RECORD',
    });
    expect(websiteFromZone({})).toEqual({ reason: 'NO_WEBSITE_RECORD' });
  });
});

describe('Spaces names', () => {
  test.each([
    ['@yahoo', { handle: '@yahoo', space: '@yahoo', member: null }],
    ['  @Yahoo ', { handle: '@yahoo', space: '@yahoo', member: null }],
    ['member@yahoo', { handle: 'member@yahoo', space: '@yahoo', member: 'member' }],
    ['@xn--bcher-kva', { handle: '@xn--bcher-kva', space: '@xn--bcher-kva', member: null }],
    [
      `@${'a'.repeat(62)}`,
      { handle: `@${'a'.repeat(62)}`, space: `@${'a'.repeat(62)}`, member: null },
    ],
  ])('parses %s', (input, parsed) => {
    expect(parseSpaceHandle(input)).toEqual(parsed);
  });

  test.each([
    'yahoo',
    '@',
    '@-a',
    '@a-',
    '@a--b',
    '@xn--',
    '@a_b',
    '@a.b',
    '@ä',
    `@${'a'.repeat(63)}`,
    'a@b@c',
    '@a/b',
    null,
  ])('refuses %s', (input) => {
    expect(parseSpaceHandle(input)).toBeNull();
  });
});
