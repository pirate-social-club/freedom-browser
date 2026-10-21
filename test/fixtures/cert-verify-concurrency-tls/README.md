# Certificate verifier concurrency TLS fixture

`cert-verify-test.{crt,key}` is a throwaway self-signed P-256 certificate for
the HTTPS origin in
`src/main/__tests__/integration/cert-verify-concurrency-electron-probe.js`
(SAN `*.certprobe.test`, valid for 100 years). It guards nothing: the probe
trusts it only inside its own Electron process, through
`setCertificateVerifyProc` on an in-memory session. It lives outside `src/`
so packaged builds never contain it.

Regenerate with:

```sh
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 36500 \
  -subj "/CN=certprobe.test" \
  -addext "subjectAltName=DNS:*.certprobe.test" \
  -keyout cert-verify-test.key -out cert-verify-test.crt
```
