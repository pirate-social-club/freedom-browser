const {
  parseSpacesHandleInput,
  normalizeSpaceHandle,
  applySpacesSuffix,
} = require('./spaces-handle');

describe('spaces-handle', () => {
  test('parses root and name handles with optional suffixes', () => {
    expect(parseSpacesHandleInput('@space')).toEqual({
      handle: '@space',
      suffix: '',
      displayValue: '@space',
    });
    expect(parseSpacesHandleInput('@Space/submit')).toEqual({
      handle: '@space',
      suffix: '/submit',
      displayValue: '@space/submit',
    });
    expect(parseSpacesHandleInput('void@space')).toEqual({
      handle: 'void@space',
      suffix: '',
      displayValue: 'void@space',
    });
    expect(parseSpacesHandleInput('void@space/path?q=1#top')).toEqual({
      handle: 'void@space',
      suffix: '/path?q=1#top',
      displayValue: 'void@space/path?q=1#top',
    });
    expect(parseSpacesHandleInput('spaces://void@space/foo')).toEqual({
      handle: 'void@space',
      suffix: '/foo',
      displayValue: 'void@space/foo',
    });
  });

  test('reconstructs http(s) userinfo URLs when the space label has no dot', () => {
    expect(parseSpacesHandleInput('http://void@space/foo')).toEqual({
      handle: 'void@space',
      suffix: '/foo',
      displayValue: 'void@space/foo',
    });
    expect(parseSpacesHandleInput('https://Void@Space/bar')).toEqual({
      handle: 'void@space',
      suffix: '/bar',
      displayValue: 'void@space/bar',
    });
  });

  test('rejects credential and dotted-space forms', () => {
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
  });

  test('normalizeSpaceHandle lowercases and rejects invalid input', () => {
    expect(normalizeSpaceHandle('Void@Space')).toBe('void@space');
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
