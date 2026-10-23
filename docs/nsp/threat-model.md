# NSP threat model

## Scope and assumptions

This model covers the running NSP/1 TCP/TLS 1.3 mutual-authenticated
bridge-to-gateway service, SQLite event acceptance, and the existing
application boundary. The C++ codec remains an offline frame library; the
Node.js gateway and Python bridge implement the active secure transport.

Assume an attacker can observe, inject, modify, replay, truncate, delay, and
flood network traffic; submit malformed frames; connect as an untrusted
client; exploit credentials they steal; or control the serial bridge. Also
assume the host operating system and cryptographic library are kept patched.

**Cryptography cannot protect a device whose secrets or execution environment
have already been fully compromised.** A compromised gateway can read
plaintext, change policy, falsify audit records, and misuse database access;
NSP does not defend against a fully compromised gateway.

## Assets

- Integrity, confidentiality, and availability of telemetry.
- Device identities, private keys, trust anchors, and registry policy.
- Historical SQLite telemetry and deduplication state.
- Correct association between an authenticated device and an accepted event.
- Availability of the gateway, storage, Socket.IO stream, and dashboard.
- Security audit records and operational state.

## Trust boundaries

1. Sensor bus and MCU firmware.
2. USB serial and local Python bridge.
3. Python bridge ↔ NSP TCP/TLS endpoint on the gateway.
4. Gateway ↔ SQLite / local Socket.IO clients.
5. Dashboard browser ↔ loopback gateway and third-party OpenStreetMap tiles.

The bridge host is the authenticated endpoint; the Uno-to-bridge USB serial
segment is not encrypted. Legacy HTTP telemetry/status writes return 410.
Dashboard HTTP and Socket.IO are loopback-only and do not authenticate users.

## Threats and controls

| Threat | Impact | Control | Coverage / residual risk |
| --- | --- | --- | --- |
| Passive network interception | Telemetry or identity exposure | TLS 1.3 with validated peer/server certificates | Mitigated on bridge-to-gateway NSP links; local USB serial and local dashboard HTTP are not encrypted |
| Active modification / injection | False events or altered payload | TLS record integrity; authenticated identity; schema validation; policy check | Mitigated on authenticated NSP session; compromised endpoint remains trusted |
| Replay of protected network records | Duplicate/stale events | TLS record sequence protection plus event ID, device-scoped unique DB key, idempotent ACK | TLS is not application exactly-once; dedup is bounded by retention and transaction availability |
| Unauthorized device | Telemetry injection | Mutual TLS, exact URI SAN match to one configured device identity, message allowlist/schema | Mitigated for the configured identity; no dynamic registry or multi-device policy |
| Compromised/stolen credential | Device impersonation | Per-file owner ACLs for dev keys; production CA provisioning/rotation | Development key access is restricted, but runtime revocation/CRL/OCSP and active-session closure are not implemented |
| Malformed packet / parser bug | Crash, incorrect parse | Bounded Node NSP framing, strict deterministic CBOR/schema validation, integration tests | Partial; fuzzing and broader malformed-frame tests remain |
| Oversized message / buffer abuse | Memory exhaustion | 65,536-byte payload cap, 256-byte header cap, 131,584-byte connection buffer cap | Mitigated by runtime parser; parser and socket read boundaries still need broader fuzz/load testing |
| Connection flooding / DoS | Resource starvation | Connection cap, 5-second handshake, 60-second idle, bounded frame/processing buffers | Partially mitigated; no rate limiting, volumetric DoS outside application control |
| Duplicate events | Repeated effects/history | Stable event UUID and transactional device/event uniqueness; ACK only after commit | Within chosen retention/transaction boundary; not exactly once end-to-end |
| Clock drift / false device time | Misordered or misleading events | Gateway receive time is authoritative; device time optional and separately labeled | Does not correct device clock; GPS time may be absent/stale |
| Device disconnection / lost ACK | Lost or repeated event | One in-memory bridge retry with stable event ID and transactional server dedup | No durable queue; process/power loss can drop an event |
| Interrupted handshake / restart | Partial session or false acceptance | Close incomplete handshakes; no app ingestion before auth; reconnect safely | Mitigated by design; operational restart and cert reload need tests |
| Gateway restart / database failure | Lost ACK or unavailable writes | Transactional store; readiness check; client retry/dedup; backup/recovery plan | Partial; recovery and WAL backup/retention not implemented |
| Malicious protocol client | Auth bypass or unsafe operation | Exact certificate URI identity, frame/message/payload allowlists, no configuration update | Implemented for one configured identity; wrong-identity rejection is tested, but broader malformed-input coverage remains |
| Denial of service | Unavailable gateway | Bounds, timeouts, connection limits, rate limiting, monitoring and capacity planning | Partial; cannot prevent upstream or host-level saturation |
| Compromised gateway | All application data and policy compromised | Host hardening, least privilege, restricted DB/file access, backups, external audit | Outside NSP cryptographic boundary |
| Public dashboard / Socket.IO exposure | Telemetry disclosure or broad fan-out | Loopback-only HTTP and local Vite-origin allowlist | Dashboard has no user authentication and is not safe to expose remotely |
| Malicious local HTTP client / bridge | Spoofed serial events | HTTP telemetry/status POSTs return 410; event writes require NSP/mTLS | Remote legacy-ingestion bypass disabled; local host/bridge compromise remains |

## Security invariants

- No telemetry is accepted before TLS 1.3, peer certificate validation,
  exact configured URI identity match, and schema validation.
- The authenticated identity overrides or must exactly match any message
  `device_id`.
- TLS certificate verification is never disabled; failed verification closes
  the session without fallback.
- No ACK claims durable acceptance before the SQLite event and dedup record
  commit atomically.
- No private key, certificate private material, bearer token, plaintext
  credential, raw TLS secret, or sensitive payload is logged or returned by
  the dashboard.
- Untrusted lengths are validated before allocation; resource caps apply per
  frame, connection, and queued processing.
- Configuration mutation is disabled in the first protocol version.

## Out of scope / residual risk

Physical tampering, sensor spoofing, compromised MCU/bridge/gateway, hostile
host administrators, upstream volumetric DoS, operating-system/kernel
vulnerabilities, third-party tile availability/privacy, and correctness of
real-world road-hazard interpretations are not solved by NSP. Hardware secure
boot, secure element, production enrollment, deployment network segmentation,
backups, and certificate operations require separate engineering.

## Validation status and remaining work

Current tests exercise TLS 1.3/mTLS plus ALPN, NSP negotiation, rejection of
missing and wrong-identity client certificates, telemetry persistence, GPS
status, duplicate delivery, and HTTP-ingestion bypass rejection. Broader
coverage is still needed for expired certificates, malformed/truncated/
oversized frames, database failures/lost ACKs, restart behavior, load/fuzz
limits, and secret-free operational logging. Production revocation behavior,
durable retry queues, and user authentication for the dashboard remain
unimplemented.
