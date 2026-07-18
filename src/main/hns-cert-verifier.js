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

function leafMatchesHostAndValidity(request, {
  Certificate = X509Certificate,
  now = () => Date.now(),
} = {}) {
  try {
    const leaf = new Certificate(request?.certificate?.data);
    if (!leaf.checkHost(request?.hostname || '')) return false;
    const validFrom = Date.parse(leaf.validFrom);
    const validTo = Date.parse(leaf.validTo);
    const currentTime = now();
    return Number.isFinite(validFrom) && Number.isFinite(validTo) &&
      currentTime >= validFrom && currentTime <= validTo;
  } catch {
    return false;
  }
}

function leafIsSignedByPinnedCa(request, trustedCertificate, {
  Certificate = X509Certificate,
} = {}) {
  if (!trustedCertificate?.publicKey) return false;
  try {
    const leaf = new Certificate(request?.certificate?.data);
    return leaf.verify(trustedCertificate.publicKey) === true;
  } catch {
    return false;
  }
}

function createCertificateVerifyProc(trustedFingerprint, options) {
  if (!trustedFingerprint) throw new Error('Trusted Fingertip fingerprint is required');
  return (request, callback) => {
    const admittedHost = isHnsHost(request?.hostname || '');
    // Electron exposes both the presented leaf and Chromium's validated chain.
    // For an intentionally untrusted local CA, only the latter is guaranteed to
    // retain the root certificate needed for our explicit pin comparison.
    const pinnedChain = chainContainsFingerprint(request?.certificate, trustedFingerprint) ||
      chainContainsFingerprint(request?.validatedCertificate, trustedFingerprint);
    const pinnedSignature = leafIsSignedByPinnedCa(
      request,
      options?.trustedCertificate,
      options,
    );
    const validLeaf = leafMatchesHostAndValidity(request, options);
    callback(
      admittedHost && (pinnedChain || pinnedSignature) && validLeaf
        ? ACCEPT_CERTIFICATE
        : USE_CHROMIUM_VERIFICATION
    );
  };
}

function configureHnsCertificateVerifier(targetSession, pemPath, options) {
  if (!targetSession?.setCertificateVerifyProc) {
    throw new Error('Electron certificate verifier is unavailable');
  }
  const readFile = options?.readFile || fs.readFileSync;
  const Certificate = options?.Certificate || X509Certificate;
  const trustedCertificate = new Certificate(readFile(pemPath, 'utf8'));
  const fingerprint = trustedCertificate.fingerprint;
  if (!fingerprint) throw new Error('Fingertip CA fingerprint is missing');
  targetSession.setCertificateVerifyProc(createCertificateVerifyProc(fingerprint, {
    ...options,
    trustedCertificate,
  }));
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
  leafIsSignedByPinnedCa,
  leafMatchesHostAndValidity,
  loadCaFingerprint,
};
