const fs = require('fs');
const path = require('path');
const os = require('os');
const { runSmoke } = require('./hns-packaged-smoke');

async function main() {
  const group = fs.readFileSync('/proc/self/cgroup', 'utf8').split('\n')
    .find((line) => line.startsWith('0::')).slice(3);
  const expected = '/system.slice/' + process.env.FREEDOM_DIAGNOSTIC_UNIT + '.service';
  if (group !== expected) throw new Error('Diagnostic cgroup mismatch');
  const cgroup = path.join('/sys/fs/cgroup', group);
  const read = (name) => fs.readFileSync(path.join(cgroup, name), 'utf8').trim();
  const resources = {
    cpu: read('cpu.max'), memory: read('memory.max'), swap: read('memory.swap.max'),
    affinity: fs.readFileSync('/proc/self/status', 'utf8').split('\n')
      .find((line) => line.startsWith('Cpus_allowed_list:')).split(':')[1].trim(),
    nice: os.getPriority(0),
  };
  const [quota, period] = resources.cpu.split(' ');
  if (!Number.isFinite(Number(quota)) || Number(quota) <= 0 ||
      !Number.isFinite(Number(period)) || Number(period) <= 0 || Number(quota) / Number(period) > 1 ||
      !Number.isFinite(Number(resources.memory)) || Number(resources.memory) <= 0 || Number(resources.memory) > 536870912 || resources.swap !== '0' ||
      resources.affinity !== '0' || resources.nice !== 19) {
    throw new Error('Diagnostic resource limits not enforced');
  }
  console.log(JSON.stringify({ type: 'effective-resource-preflight', resources }));
  const snapshot = () => {
    try {
      console.log(JSON.stringify({ type: 'resource-receipt',
        peak: read('memory.peak'), events: read('memory.events'), swapPeak: read('memory.swap.peak') }));
    } catch {
      process.exitCode = 1;
      console.log('Resource receipt unavailable');
    }
  };
  snapshot();
  const timer = setInterval(snapshot, 5000);
  let interrupted = false;
  const terminate = () => {
    interrupted = true;
    snapshot();
    process.exitCode = 1;
    // systemd kills the complete cgroup at its fixed stop timeout.
  };
  process.once('SIGTERM', terminate);
  try {
    await runSmoke({ resourcesDir: process.env.FREEDOM_DIAGNOSTIC_RESOURCES, timeoutMs: 240000 });
  } catch {
    process.exitCode = 1;
    console.log('Required public-host diagnostic failed; inspect indexed categories above');
  } finally {
    clearInterval(timer);
    process.off('SIGTERM', terminate);
    snapshot();
    if (interrupted) process.exitCode = 1;
  }
}
if (require.main === module) main().catch(() => {
  // Never print raw configuration, environment, stack or requested hostname.
  console.log('Diagnostic preflight failed');
  process.exitCode = 1;
});

module.exports = { main };
