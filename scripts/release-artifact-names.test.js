const packageJson = require('../package.json');

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
});
