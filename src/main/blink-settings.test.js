const fs = require('fs');
const path = require('path');
const {
  BLINK_SETTINGS_SWITCH,
  applyBlinkSettings,
  mergeBlinkSettings,
} = require('./blink-settings');

// A stand-in for app.commandLine that keeps one value per switch, as
// Chromium's CommandLine does.
function fakeApp(launched = {}) {
  const switches = new Map(Object.entries(launched));
  return {
    switches,
    commandLine: {
      getSwitchValue: jest.fn((name) => switches.get(name) ?? ''),
      appendSwitch: jest.fn((name, value) => switches.set(name, value)),
    },
  };
}

describe('applyBlinkSettings', () => {
  test('turns DNS prefetching off for every renderer', () => {
    const app = fakeApp();
    expect(applyBlinkSettings(app)).toBe('dnsPrefetchingEnabled=false');
    expect(BLINK_SETTINGS_SWITCH).toBe('blink-settings');
    expect(app.commandLine.appendSwitch).toHaveBeenCalledTimes(1);
    expect(app.switches.get('blink-settings')).toBe('dnsPrefetchingEnabled=false');
  });

  test('keeps settings already on the launch command line, since Chromium keeps one value', () => {
    const app = fakeApp({ 'blink-settings': 'imagesEnabled=false, hideScrollbars' });
    applyBlinkSettings(app);
    expect(app.switches.get('blink-settings')).toBe(
      'imagesEnabled=false,hideScrollbars,dnsPrefetchingEnabled=false'
    );
  });

  test('wins over a launch that asks for prefetching', () => {
    const app = fakeApp({ 'blink-settings': 'dnsPrefetchingEnabled=true,imagesEnabled=false' });
    applyBlinkSettings(app);
    expect(app.switches.get('blink-settings')).toBe(
      'dnsPrefetchingEnabled=false,imagesEnabled=false'
    );
  });

  test.each([undefined, '', ',,', ' , '])(
    'reads an empty or missing value %p as no settings',
    (value) => {
      expect(mergeBlinkSettings(value)).toBe('dnsPrefetchingEnabled=false');
    }
  );

  // Renderers read the switch when they start, so index.js must apply it
  // before anything waits for the app to be ready.
  test('index.js applies it before the app is ready', () => {
    const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
    const applied = source.indexOf("require('./blink-settings').applyBlinkSettings(app);");
    expect(applied).toBeGreaterThan(-1);
    for (const wait of ['app.whenReady(', "app.on('ready'", "app.once('ready'"]) {
      const first = source.indexOf(wait);
      if (first !== -1) expect(applied).toBeLessThan(first);
    }
  });
});
