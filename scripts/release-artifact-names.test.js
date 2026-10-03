const packageJson = require('../package.json');
const fs = require('fs');

function renderArtifactName(template, extension) {
  return template
    .replace('${productName}', packageJson.build.productName)
    .replace('${version}', packageJson.version)
    .replace('${ext}', extension);
}

describe('release artifact names', () => {
  test('Windows installer name is stable through GitHub upload', () => {
    const template = packageJson.build.nsis.artifactName;
    const installerName = renderArtifactName(template, 'exe');

    expect(template).toBe('${productName}-Setup-${version}.${ext}');
    expect(installerName).toBe(`Freedom-Setup-${packageJson.version}.exe`);
    expect(installerName).not.toMatch(/\s/);
  });

  test('Linux release downloads only Linux x64 runtime binaries', () => {
    const workflow = fs.readFileSync('.github/workflows/release.yml', 'utf8');
    const linuxBuild = packageJson.scripts['dist:linux:x64:docker'];

    expect(workflow).toContain('binary_target: linux-x64');
    expect(workflow).toContain('ant:download -- --target ${{ matrix.binary_target }}');
    expect(workflow).not.toContain('radicle:download -- --all');
    expect(linuxBuild).toContain('ant:download -- --target linux-x64');
    expect(linuxBuild).toContain('ipfs:download -- --target linux-x64');
    expect(linuxBuild).toContain('radicle:download -- --linux --x64');
    expect(linuxBuild).toContain('MYOTIS_DOWNLOAD_TARGET=linux-x64');
    expect(workflow).toContain('ipfs_target: darwin-x64');
    expect(workflow).toContain('ipfs_target: win32-x64');
    expect(workflow).toContain('npm run ipfs:download -- --target ${{ matrix.ipfs_target }}');
    expect(workflow).toContain('npm run radicle:download -- ${{ matrix.radicle_flags }}');
  });
});
