const validate = require('./checkpoint-offline-build');

function prepared() {
  return {
    context: { electronPlatformName: 'linux', arch: 1, packager: { config: {
      npmRebuild: false, nodeGypRebuild: false, downloadAlternateFFmpeg: false,
      electronDist: '/prepared/electron',
    } } },
    options: { platform: 'linux', interfaces: { lo: [] },
      env: { CUSTOM_FPM_PATH: '/prepared/fpm' },
      fs: { statSync: jest.fn(() => ({ isFile: () => true })),
        readlinkSync: (name) => name.includes('/self/') ? 'net:[2]' : 'net:[1]' } },
  };
}

test('accepts prepared offline Linux x64 packaging', () => {
  const { context, options } = prepared();
  expect(() => validate(context, options)).not.toThrow();
});

test('refuses an external interface even without assigned addresses', () => {
  const { context, options } = prepared();
  options.interfaces.eth0 = [];
  expect(() => validate(context, options)).toThrow('network namespace');
});

test.each(['npmRebuild', 'nodeGypRebuild', 'downloadAlternateFFmpeg'])('refuses enabled %s', (key) => {
  const { context, options } = prepared();
  context.packager.config[key] = true;
  expect(() => validate(context, options)).toThrow('prepared native inputs');
});

test('refuses missing prepared FPM instead of falling back to download', () => {
  const { context, options } = prepared();
  delete options.env.CUSTOM_FPM_PATH;
  expect(() => validate(context, options)).toThrow('FPM');
});

test('refuses the host namespace even if interfaces appear absent', () => {
  const { context, options } = prepared();
  options.fs.readlinkSync = () => 'net:[1]';
  expect(() => validate(context, options)).toThrow('separate network namespace');
});

test('refuses another platform before accepting prepared inputs', () => {
  const { context, options } = prepared();
  context.electronPlatformName = 'darwin';
  expect(() => validate(context, options)).toThrow('Linux x64');
});
