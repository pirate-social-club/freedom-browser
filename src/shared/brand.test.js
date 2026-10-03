const brand = require('./brand.json');
const pkg = require('../../package.json');

describe('brand.json', () => {
  test('stays in sync with package.json#build.productName and appId', () => {
    // Runtime code reads brand.json because electron-builder strips the
    // `build` section from the packaged package.json. These values must match
    // so dev (which could read either) and packaged builds agree.
    expect(brand.productName).toBe(pkg.build.productName);
    expect(brand.appId).toBe(pkg.build.appId);
  });
});
