const manifest = require('./platform-capabilities.json');

const PLATFORM_NAMES = Object.freeze({
  darwin: 'mac',
  linux: 'linux',
  win32: 'win',
});

function normalizePlatform(platform = process.platform) {
  return PLATFORM_NAMES[platform] || platform;
}

function getTarget(platform = process.platform, arch = process.arch) {
  return `${normalizePlatform(platform)}-${arch}`;
}

function getCapabilityDefinition(capability) {
  const definition = manifest.capabilities[capability];
  if (!definition) {
    throw new Error(`Unknown platform capability: ${capability}`);
  }
  return definition;
}

function getCapabilityStatus(capability, platform = process.platform, arch = process.arch) {
  const definition = getCapabilityDefinition(capability);
  const target = getTarget(platform, arch);
  const supported = definition.supportedTargets.includes(target);

  return {
    capability,
    displayName: definition.displayName,
    target,
    supported,
    unsupportedReason: supported ? null : definition.unsupportedReason,
  };
}

function getCapabilityBinaries(capability, platform = process.platform) {
  const definition = getCapabilityDefinition(capability);
  const normalizedPlatform = normalizePlatform(platform);
  return definition.binaries[normalizedPlatform] || definition.binaries.default || [];
}

module.exports = {
  getCapabilityBinaries,
  getCapabilityDefinition,
  getCapabilityStatus,
  getTarget,
  manifest,
  normalizePlatform,
};
