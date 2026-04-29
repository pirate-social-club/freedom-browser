#!/usr/bin/env node

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const IP_CHECK_URL = process.env.SENTINEL_IP_CHECK_URL || 'https://api.ipify.org?format=json';
const GB = Math.max(1, parseInt(process.env.SENTINEL_SMOKE_GB || '1', 10) || 1);
const MAX_ATTEMPTS = Math.max(1, parseInt(process.env.SENTINEL_SMOKE_MAX_ATTEMPTS || '3', 10) || 3);

function findV2Ray() {
  if (process.env.SENTINEL_V2RAY_PATH) {
    return process.env.SENTINEL_V2RAY_PATH;
  }

  const binary = process.platform === 'win32' ? 'v2ray.exe' : 'v2ray';
  const platformMap = { darwin: 'mac', linux: 'linux', win32: 'win' };
  const platform = platformMap[process.platform] || process.platform;
  const candidates = [
    path.join(__dirname, '..', 'dvpn-bin', `${platform}-${process.arch}`, binary),
    path.join(__dirname, '..', 'node_modules', 'sentinel-ai-connect', 'node_modules', 'sentinel-dvpn-sdk', 'bin', binary),
    path.join(__dirname, '..', 'node_modules', 'sentinel-dvpn-sdk', 'bin', binary),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

async function getIpDirect() {
  const response = await fetch(IP_CHECK_URL);
  if (!response.ok) {
    throw new Error(`IP check failed: HTTP ${response.status}`);
  }
  const text = await response.text();
  try {
    return JSON.parse(text).ip || text.trim();
  } catch {
    return text.trim();
  }
}

async function getIpViaSocks(port) {
  const { stdout } = await execFileAsync('curl', [
    '--silent',
    '--show-error',
    '--fail',
    '--max-time',
    '20',
    '--socks5-hostname',
    `127.0.0.1:${port}`,
    IP_CHECK_URL,
  ]);
  try {
    return JSON.parse(stdout).ip || stdout.trim();
  } catch {
    return stdout.trim();
  }
}

async function main() {
  const mnemonic = process.env.SENTINEL_TEST_MNEMONIC;
  if (!mnemonic) {
    throw new Error('SENTINEL_TEST_MNEMONIC is required for funded Sentinel smoke tests');
  }

  const v2rayExePath = findV2Ray();
  if (!v2rayExePath) {
    throw new Error('V2Ray binary not found. Set SENTINEL_V2RAY_PATH or install dvpn-bin.');
  }

  const sdk = await import('sentinel-ai-connect');
  const wallet = await sdk.importWallet(mnemonic);
  const directIp = await getIpDirect();
  const balance = await sdk.getBalance(mnemonic);
  const estimate = await sdk.estimateCost({ gigabytes: GB });
  const requiredUdVpn = estimate?.grandTotal?.udvpn || estimate?.total?.udvpn || estimate?.perGb?.udvpn || 0;

  if (!balance.funded || Number(balance.udvpn || 0) < requiredUdVpn) {
    throw new Error(
      `Insufficient Sentinel balance for ${GB} GB. Balance=${balance.p2p} required=${requiredUdVpn} udvpn`
    );
  }

  let session = null;
  try {
    session = await sdk.connect({
      mnemonic,
      protocol: 'v2ray',
      fullTunnel: false,
      systemProxy: false,
      gigabytes: GB,
      maxAttempts: MAX_ATTEMPTS,
      v2rayExePath,
    });

    const routedIp = session.ip || await getIpViaSocks(session.socksPort);
    if (!routedIp) {
      throw new Error('Connected but could not resolve routed IP');
    }
    if (routedIp === directIp) {
      throw new Error(`Connected but routed IP did not change (${routedIp})`);
    }

    console.log(JSON.stringify({
      success: true,
      address: wallet.address,
      balance: balance.p2p,
      estimate: estimate?.grandTotal?.p2p || estimate?.total?.p2p || estimate?.perGb?.p2p || null,
      directIp,
      routedIp,
      sessionId: String(session.sessionId),
      socksPort: session.socksPort,
      nodeAddress: session.nodeAddress,
    }, null, 2));
  } finally {
    if (session?.sessionId) {
      await sdk.disconnect(session.sessionId).catch(() => {});
    }
  }
}

main().catch((err) => {
  console.error(err && (err.stack || err.message || err));
  process.exit(1);
});
