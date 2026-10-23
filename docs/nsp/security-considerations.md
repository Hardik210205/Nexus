# NSP security considerations

## Security profile

The running bridge-to-gateway profile is NSP/1 over TCP with TLS 1.3 and
mutual certificate authentication, implemented with Node.js TLS and Python's
`ssl` module. The gateway requires a configured CA, validates the client
certificate URI identity, and selects ALPN `nsp/1`; the bridge verifies the
gateway CA and hostname. There is no plaintext fallback.

The Arduino Uno remains on its local USB serial link and does not hold a
certificate or participate in TLS. The Python bridge host is the authenticated
client. The C++ codec remains a separate frame library and is not the runtime
TLS endpoint.

## Identity and authorization

- Use a locally or organizationally provisioned CA; never commit private keys.
- Map one exact URI subjectAltName to a device registry identity. Do not use a
  payload-supplied `deviceId`, certificate common name fallback, IP address,
  or serial-bridge label as cryptographic identity.
- The current gateway is configured for one exact identity
  (`NEXUS_NSP_DEVICE_ID`, default `arhb_uno_1`) and accepts registered event
  and status message types. It does not implement a dynamic device registry.
- Apply least privilege. Configuration update is disabled by default.
- A revocation process must deny new sessions and terminate active sessions
  promptly through notifications or bounded revalidation.
- Development CA/certificates are distinct from production; development
  credentials must not be used for deployed devices.

## Certificate handling and deployment

Keep server private keys readable only by the service account. The local
development certificate generator applies owner-only permissions on POSIX or
the current user's ACL on Windows. Keep CA private keys offline or in an
approved key-management system. Mount/rotate trust anchors and certificates
without exposing them to application logs, dashboards, or source control. The
service fails closed if required certificate files are unavailable.

Define issuance, identity mapping, renewal, rotation overlap, revocation,
expiry monitoring, backup, and device replacement procedures before
production. Decide CRL/OCSP versus short-lived certificates for the actual
deployment. Do not claim immediate revocation until active sessions are
actually terminated.

## Framing and parser safeguards

The runtime parser checks the NSP header, supported versions, registered
message types, reserved flags, extension shape, and lengths before processing.
It caps headers at 256 bytes, data payloads at 65,536 bytes, control payloads
at 4,096 bytes, and buffered connection data at 131,584 bytes. The listener
also caps concurrent connections and applies handshake and idle timeouts.
Unknown or malformed messages close the connection; rate limiting and
production fuzz/load testing are not implemented.

## Data handling and operational logs

Telemetry may reveal locations and road activity. Minimize event fields,
restrict database and dashboard access, define retention, protect backups,
and avoid logging complete payloads. Structured logs may include timestamps,
protocol, safe device identifier, connection/event correlation ID, error
category, outcome, and duration. Never log private key material, session
secrets, bearer tokens, raw authentication messages, or sensitive payload
content. Sanitize errors returned to unauthenticated clients.

The dashboard has no user authentication; its HTTP and Socket.IO interfaces
are restricted to loopback and local development origins. Do not expose them
directly to an untrusted network. NSP secures the bridge-to-gateway event
ingestion path, not dashboard user access or host security.

## Delivery and duplicate handling

TLS record protection is not a durable event queue. Give each logical event a
stable 128-bit ID and reuse it on retries. Atomically persist telemetry and a
device-scoped deduplication record; ACK only after commit. Define dedup
retention and monitor capacity. A duplicate received during the retention
window should return an ACK for the existing event without a second insert or
broadcast. State this guarantee narrowly; it is not end-to-end exactly-once.

## Secure error behavior

Use coarse registered error categories and correlation IDs. Never echo a
certificate, credential, secret, arbitrary malformed bytes, or private
database detail. Authentication failure must not reveal unnecessary identity
or trust-store details. Persistence errors must not be represented as a
successful ACK. A connection that fails mandatory security checks closes and
does not fall back to another protocol.

## Dependencies and update policy

The runtime uses platform TLS through Node.js and Python; the C++ frame codec
remains dependency-free. Keep Node.js and Python patched and review dependency
advisories routinely.
