const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Dev helper: write a bee-compatible config.yaml for the bundled antd node.
// Unlike bee, antd has no `init` subcommand — it self-initializes its identity
// (`identity.json`) on first start when no injected `keys/swarm.key` is
// present, so this script only needs to materialise the config file.
const SAMPLE_CONFIG = path.join(__dirname, '..', 'config', 'ant.yaml');
// Matches bee-manager's dev data dir so `npm run ant:start` runs against the
// same directory the app uses in development.
const DATA_DIR = path.join(__dirname, '..', 'ant-data');
const TARGET_CONFIG = path.join(DATA_DIR, 'config.yaml');

function generatePassword(length = 32) {
  return crypto.randomBytes(length).toString('hex');
}

function initAnt() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      console.log(`Created data directory: ${DATA_DIR}`);
    }

    if (fs.existsSync(TARGET_CONFIG)) {
      console.log('Ant is already initialized (config.yaml exists). Skipping.');
      return;
    }

    if (!fs.existsSync(SAMPLE_CONFIG)) {
      console.error('Sample ant.yaml not found in config/.');
      process.exit(1);
    }

    let configContent = fs.readFileSync(SAMPLE_CONFIG, 'utf-8');
    const password = generatePassword();

    configContent = configContent.replace(/DATA_DIR/g, DATA_DIR);
    configContent = configContent.replace(/PASSWORD/g, password);

    fs.writeFileSync(TARGET_CONFIG, configContent);
    console.log(`Initialized Ant config at ${TARGET_CONFIG}`);
    console.log('antd will create its node identity on first start.');
  } catch (err) {
    console.error('Failed to initialize Ant:', err);
    process.exit(1);
  }
}

initAnt();
