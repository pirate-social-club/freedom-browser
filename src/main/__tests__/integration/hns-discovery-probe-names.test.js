const { under, expectedNameOf, namesSeen } = require('./hns-discovery-probe-names');

// The search suffixes two hosted runs appended, and the one LOCALDOMAIN gives
// a workstation run.
const SUFFIXES = [
  'sr20nakbdfluvhxierf11waqbf.phxx.internal.cloudapp.net',
  'r5jfbq0fo4iu1bw1mcehrg50ab.gx.internal.cloudapp.net',
  'searchprobe.example',
];

describe('probe name matching', () => {
  test('a name is under a root wherever the root sits among its labels', () => {
    const listed = under('hnsprobe');
    for (const name of ['hnsprobe', 'app.hnsprobe', 'a.b.hnsprobe', ...SUFFIXES.map((suffix) => `x.hnsprobe.${suffix}`)]) {
      expect(listed(name)).toBe(true);
    }
    for (const name of ['hnsprobes.example', 'xhnsprobe', 'hnsprobe-x.unlistedprobe', 'app.unlistedprobe']) {
      expect(listed(name)).toBe(false);
    }
    expect(under('pirate')(`fetch.pirate.${SUFFIXES[0]}`)).toBe(true);
  });

  test('an expected control name is seen bare or with any search suffix', () => {
    const expected = ['img-default.unlistedprobe', 'img-private.unlistedprobe'];
    expect(expectedNameOf('img-default.unlistedprobe', expected)).toBe('img-default.unlistedprobe');
    for (const suffix of SUFFIXES) {
      expect(expectedNameOf(`img-private.unlistedprobe.${suffix}`, expected)).toBe('img-private.unlistedprobe');
    }
    expect(expectedNameOf('img-default.unlistedprobes', expected)).toBeNull();
    expect(expectedNameOf('x.img-default.unlistedprobe', expected)).toBeNull();
  });

  test('the controls compare equal with or without suffixed retries, and anything else still shows', () => {
    const expected = ['img-default.unlistedprobe', 'img-private.unlistedprobe'];
    const hosted = [
      'img-default.unlistedprobe', `img-default.unlistedprobe.${SUFFIXES[0]}`,
      'img-private.unlistedprobe', `img-private.unlistedprobe.${SUFFIXES[0]}`,
    ];
    expect(namesSeen(hosted, expected)).toEqual(expected);
    expect(namesSeen(['img-private.unlistedprobe', 'img-default.unlistedprobe'], expected)).toEqual(expected);
    // Suffixed only, as a host that tries its search list first would send.
    expect(namesSeen(expected.map((name) => `${name}.${SUFFIXES[2]}`), expected)).toEqual(expected);
    // A missing control, or a lookup that is not a control, fails the comparison.
    expect(namesSeen(['img-default.unlistedprobe'], expected)).not.toEqual(expected);
    expect(namesSeen([...hosted, `app.hnsprobe.${SUFFIXES[0]}`], expected)).not.toEqual(expected);
  });
});
