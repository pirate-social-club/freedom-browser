const fs = require('fs');
const { X509Certificate } = require('crypto');
const { isHnsHost } = require('../shared/hns-hosts');

const USE_CHROMIUM_VERIFICATION = -3;
const ACCEPT_CERTIFICATE = 0;

function loadCaFingerprint(pemPath, {
  readFile = fs.readFileSync,
  Certificate = X509Certificate,
} = {}) {
  if (!pemPath) throw new Error('Fingertip CA path is missing');
  const certificate = new Certificate(readFile(pemPath, 'utf8'));
  if (!certificate.fingerprint) throw new Error('Fingertip CA fingerprint is missing');
  return certificate.fingerprint;
}

function chainContainsFingerprint(certificate, trustedFingerprint) {
  const visited = new Set();
  let current = certificate;
  for (let depth = 0; current && depth < 10; depth += 1) {
    if (visited.has(current)) break;
    visited.add(current);
    if (current.fingerprint === trustedFingerprint) return true;
    current = current.issuerCert;
  }
  return false;
}

function createCertificateVerifyProc(trustedFingerprint) {
  if (!trustedFingerprint) throw new Error('Trusted Fingertip fingerprint is required');
  return (request, callback) => {
    const admittedHost = isHnsHost(request?.hostname || '');
    const pinnedChain = chainContainsFingerprint(request?.certificate, trustedFingerprint);
    callback(admittedHost && pinnedChain ? ACCEPT_CERTIFICATE : USE_CHROMIUM_VERIFICATION);
  };
}

function configureHnsCertificateVerifier(targetSession, pemPath, options) {
  if (!targetSession?.setCertificateVerifyProc) {
    throw new Error('Electron certificate verifier is unavailable');
  }
  const fingerprint = loadCaFingerprint(pemPath, options);
  targetSession.setCertificateVerifyProc(createCertificateVerifyProc(fingerprint));
  return fingerprint;
}

function clearHnsCertificateVerifier(targetSession) {
  targetSession?.setCertificateVerifyProc?.(null);
}

module.exports = {
  ACCEPT_CERTIFICATE,
  USE_CHROMIUM_VERIFICATION,
  chainContainsFingerprint,
  clearHnsCertificateVerifier,
  configureHnsCertificateVerifier,
  createCertificateVerifyProc,
  loadCaFingerprint,
};
