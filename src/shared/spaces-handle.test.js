const {
  parseSpacesHandleInput,
  normalizeSpaceHandle,
  applySpacesSuffix,
} = require('./spaces-handle');

describe('spaces-handle', () => {
  test('parses root and name handles with optional suffixes', () => {
    expect(parseSpacesHandleInput('@space')).toEqual({
      handle: '@space',
      requestHost: '@space',
      suffix: '',
      displayValue: '@space',
    });
    expect(parseSpacesHandleInput('@Space/submit')).toEqual({
      handle: '@space',
      requestHost: '@space',
      suffix: '/submit',
      displayValue: '@space/submit',
    });
    expect(parseSpacesHandleInput('void@space')).toEqual({
      handle: 'void@space',
      requestHost: 'void@space',
      suffix: '',
      displayValue: 'void@space',
    });
    expect(parseSpacesHandleInput('void@space/path?q=1#top')).toEqual({
      handle: 'void@space',
      requestHost: 'void@space',
      suffix: '/path?q=1#top',
      displayValue: 'void@space/path?q=1#top',
    });
    expect(parseSpacesHandleInput('spaces://void@space/foo')).toEqual({
      handle: 'void@space',
      requestHost: 'void@space',
      suffix: '/foo',
      displayValue: 'void@space/foo',
    });
  });

  test('splits dotted left-hand names at the leftmost dot', () => {
    expect(parseSpacesHandleInput(
      'npub17paskt3gfvl3gjru5lfhnnlgjqms3g9z973slper6vmk4u2u7lhq0awul4.extra@space'
    )).toEqual({
      handle: 'extra@space',
      requestHost: 'npub17paskt3gfvl3gjru5lfhnnlgjqms3g9z973slper6vmk4u2u7lhq0awul4.extra@space',
      suffix: '',
      displayValue: 'npub17paskt3gfvl3gjru5lfhnnlgjqms3g9z973slper6vmk4u2u7lhq0awul4.extra@space',
    });
    expect(parseSpacesHandleInput('www.npub1abc.extra@space/docs')).toEqual({
      handle: 'npub1abc.extra@space',
      requestHost: 'www.npub1abc.extra@space',
      suffix: '/docs',
      displayValue: 'www.npub1abc.extra@space/docs',
    });
    expect(parseSpacesHandleInput(
      'http://npub17paskt3gfvl3gjru5lfhnnlgjqms3g9z973slper6vmk4u2u7lhq0awul4.extra@space/foo'
    )).toEqual({
      handle: 'extra@space',
      requestHost: 'npub17paskt3gfvl3gjru5lfhnnlgjqms3g9z973slper6vmk4u2u7lhq0awul4.extra@space',
      suffix: '/foo',
      displayValue: 'npub17paskt3gfvl3gjru5lfhnnlgjqms3g9z973slper6vmk4u2u7lhq0awul4.extra@space/foo',
    });
  });

  test('reconstructs http(s) userinfo URLs when the space label has no dot', () => {
    expect(parseSpacesHandleInput('http://void@space/foo')).toEqual({
      handle: 'void@space',
      requestHost: 'void@space',
      suffix: '/foo',
      displayValue: 'void@space/foo',
    });
    expect(parseSpacesHandleInput('https://Void@Space/bar')).toEqual({
      handle: 'void@space',
      requestHost: 'void@space',
      suffix: '/bar',
      displayValue: 'void@space/bar',
    });
  });

  test('rejects credential, dotted-space, and empty-label forms', () => {
    expect(parseSpacesHandleInput('alice:secret@space')).toBeNull();
    expect(parseSpacesHandleInput('http://alice:secret@space/')).toBeNull();
    expect(parseSpacesHandleInput('user@example.com')).toBeNull();
    expect(parseSpacesHandleInput('http://user@example.com/')).toBeNull();
    expect(parseSpacesHandleInput('void@space.tld')).toBeNull();
    expect(parseSpacesHandleInput('@space.tld')).toBeNull();
    expect(parseSpacesHandleInput('@')).toBeNull();
    expect(parseSpacesHandleInput('@@space')).toBeNull();
    expect(parseSpacesHandleInput('@space path')).toBeNull();
    expect(parseSpacesHandleInput('https://pirate.sc/c/@space')).toBeNull();
    expect(parseSpacesHandleInput('.extra@space')).toBeNull();
    expect(parseSpacesHandleInput('extra.@space')).toBeNull();
    expect(parseSpacesHandleInput('www..extra@space')).toBeNull();
  });

  test('normalizeSpaceHandle lowercases and returns the lookup handle', () => {
    expect(normalizeSpaceHandle('Void@Space')).toBe('void@space');
    expect(normalizeSpaceHandle('Npub1ABC.Extra@Space')).toBe('extra@space');
    expect(() => normalizeSpaceHandle('user@example.com')).toThrow(/dotted space/);
  });

  test('applySpacesSuffix joins proxy bases', () => {
    expect(applySpacesSuffix('http://127.0.0.1:9/void%40space/', '/docs')).toBe(
      'http://127.0.0.1:9/void%40space/docs'
    );
    expect(applySpacesSuffix('http://127.0.0.1:9/void%40space/', '?q=1')).toBe(
      'http://127.0.0.1:9/void%40space?q=1'
    );
  });
});
