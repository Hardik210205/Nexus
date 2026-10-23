# NSP device provisioning

**Status:** Local development certificate generation and one configured
certificate identity are implemented. There is no production CA integration,
enrollment endpoint, dynamic registry, or revocation workflow.

## Identity model

The gateway accepts one configured device identity, `arhb_uno_1`, mapped to
the exact URI SAN `spiffe://nexus.local/device/arhb_uno_1`. Identity comes
from the trusted mTLS client certificate, never from an event payload. The
certificate/private key is held by the PC running the Python bridge; the
Arduino Uno remains connected over local USB serial and does not hold TLS
credentials.

## Local development certificates

Run `python scripts\generate_nsp_dev_certs.py` from the repository root. The
helper creates a local CA, server certificate, and `arhb_uno_1` client
certificate in `.local\nsp-certs\`. It protects private-key files with
owner-only ACLs on Windows (or mode `0600` on POSIX), and refuses to overwrite
existing files. This path is git-ignored. The gateway and bridge use it only
when `NEXUS_NSP_PROFILE=development` is explicitly set; production fails
closed unless certificate paths are supplied. Set `NEXUS_NSP_CERT_DIR` or
the per-file variables to use another location.

Keep development keys local and do not distribute them through source control,
chat, logs, dashboard responses, or ordinary configuration files. Delete and
reissue all development certificates if the CA private key is exposed.

## Production requirements

- Use an approved CA/PKI and authenticated out-of-band provisioning.
- Provision a DNS-valid server certificate and unique mTLS client
  certificates. Configure `NEXUS_NSP_SERVER_CERT`, `NEXUS_NSP_SERVER_KEY`,
  `NEXUS_NSP_CLIENT_CA`, `NEXUS_NSP_CA`, `NEXUS_NSP_CLIENT_CERT`, and
  `NEXUS_NSP_CLIENT_KEY`; do not copy development keys to production.
- The current runtime maps one exact identity using `NEXUS_NSP_DEVICE_ID`;
  implement and test a dynamic registry before multi-device deployment.
- Node's TLS integration currently does not check CRL/OCSP revocation. Define
  certificate renewal, trust-anchor rollover, expiry alerting, revocation,
  active-session termination, and lost-key recovery before production.
- Define secure key storage for each hardware class. Do not assume an Arduino
  Uno can securely hold or use a gateway TLS credential.
- Keep private keys out of the database; restrict access to registry and
  provisioning operations and audit them.

## Fail-closed behavior and limitations

TLS is restricted to version 1.3 and ALPN `nsp/1`. The server validates the
client certificate chain and checks its exact URI SAN. The Python bridge
validates the server chain and hostname. Unknown/expired certificates and
identity mismatches cannot submit events. Dynamic revocation and terminating
existing sessions for a disabled device are not implemented, so the current
single-device development service is not a production enrollment system.
