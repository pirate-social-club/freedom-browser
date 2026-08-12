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

    expect(template).toBe('${productName}.Setup.${version}.${ext}');
    expect(installerName).toBe(`Freedom.Setup.${packageJson.version}.exe`);
    expect(installerName).not.toMatch(/\s/);
  });

  test('Linux release downloads only Linux x64 runtime binaries', () => {
    const workflow = fs.readFileSync('.github/workflows/release.yml', 'utf8');
    const linuxBuild = packageJson.scripts['dist:linux:x64:docker'];

    expect(workflow).toContain('binary_target: linux-x64');
    expect(workflow).toContain('bee:download -- --target ${{ matrix.binary_target }}');
    expect(workflow).not.toContain('radicle:download -- --all');
    expect(linuxBuild).toContain('bee:download -- --target linux-x64');
    expect(linuxBuild).toContain('ipfs:download -- --target linux-x64');
    expect(linuxBuild).toContain('radicle:download -- --target linux-x64');
  });
});
