# Nexus target architecture

## Goal

Evolve the existing ARHB telemetry application into a multi-protocol
communication platform while preserving SQLite event history, Socket.IO
event semantics, and dashboard read flows. Network security is enforced at
the transport/protocol boundary and authorization is checked independently of
successful decryption. The current secure baseline is NSP/1 over TLS 1.3
between the Python bridge and Node gateway; this document also covers future
multi-device and MQTT/CoAP capabilities that are not yet implemented.

## Logical layers

```text
Devices and sensors
  | USB serial / MQTT / CoAP / NSP over TCP+TLS
  v
Protocol adapters (Python serial-to-NSP bridge; future MQTT/CoAP services)
  v
Authenticated NSP identity + current single-device policy
  v
Bounded parse -> protocol validation -> normalized event
  v
Idempotent transactional ingestion
  +--> existing SQLite telemetry_events (history retained)
  +--> deduplication/device/audit state (versioned migrations)
  +--> Socket.IO telemetry_update
  v
Existing React dashboard (later protocol/device/security views)
```

The common event pipeline is application logic. It must not import transport
libraries or assume a particular adapter. Each adapter supplies its
authenticated principal separately from untrusted message fields and maps
protocol-specific errors into a documented result category.

## Deployment boundaries

### Existing components retained

- Arduino continues MPU6050 motion detection and GPS parsing over local serial.
- Python bridge reads Arduino serial CSV and forwards to the separate NSP
  listener using its client certificate; the Uno remains on the local serial
  link and does not hold TLS credentials.
- Node/Express continues to serve `/api/telemetry`, `/api/events`,
  `/api/health`, and Socket.IO for the existing dashboard. Event/status POSTs
  to the legacy HTTP API are disabled to prevent an NSP authentication bypass.
- SQLite remains the persistence boundary; add only versioned additive schema
  changes and transactional migrations. Never discard current event rows.

### New NSP components, staged

1. `protocols/nsp/` is a standalone C++17 library, independent of Express,
   SQLite, Socket.IO, browser code, and operating-system sockets.
2. A later gateway-side executable links the library and provides TCP with
   TLS 1.3, mutual certificate authentication, explicit limits, and a
   loopback-only private gateway integration.
3. NSP services are hosted on a gateway-capable machine (Windows/Linux),
   never presumed to run on the current Arduino/Uno-class device.
4. TLS, sockets, device registry, database bridge, MQTT, and CoAP are separate
   modules with independent tests and configuration. Phase 2 introduces none
   of these runtime dependencies.

## NSP transport and security profile

- Initial carrier: TCP protected by TLS 1.3 (RFC 8446), negotiated with
  ALPN `nsp/1`; no plaintext mode or silent downgrade.
- Initial device authentication: mutual TLS. Validate the complete chain to a
  configured trust anchor and map one exact URI subjectAltName to a device
  identity. A valid TLS certificate alone does not establish operation
  authorization.
- The device registry later maps certificate identity to active status,
  permitted protocols, message types, and policy. Revoked identity blocks new
  sessions; active-session termination needs an explicit revocation signal or
  bounded revalidation.
- The NSP library provides framing and typed message rules, not cryptography.
  TLS provides channel confidentiality/integrity and peer authentication;
  there is no additional message cipher in the initial profile.
- Application event identifiers and database uniqueness provide retry
  deduplication; TLS record replay protection is not exactly-once application
  delivery.

## Adapter/event contract

The future internal event has:

```text
event_id: 128-bit stable identifier
device_id: authenticated registry identity
protocol: adapter identifier (serial-bridge, nsp, mqtt, coap)
message_type: registered application category
event_type: optional subtype
device_time: optional validated device timestamp
received_at: gateway-generated UTC timestamp
payload: validated bounded object
trace_id: optional non-authoritative correlation identifier
```

Normalize without trusting a payload identity over a verified transport
identity. Preserve the dashboard fields `id`, `source.deviceId`,
`source.protocol`, `type`, `eventType`, `payload`, and `timestamp`. HTTP
compatibility behavior remains unchanged until a separate explicit,
regression-tested security migration.

### Delivery and persistence

- NSP HELLO, authentication result, and capability negotiation occur only
  after TLS is established. No application message precedes successful
  identity authentication and authorization.
- A telemetry ACK means the gateway committed both the telemetry and its
  `(device_id,event_id)` deduplication key in a single SQLite transaction.
- A duplicate retry returns a duplicate ACK for the existing accepted event;
  it does not create another logical event or broadcast a second event.
- If persistence fails, no success ACK is sent. If the ACK is lost after
  commit, retry is safe only while the deduplication record is retained.
- This gives at-least-once transmission with idempotent effects inside a
  defined database transaction and retention window, not exactly-once delivery
  across the full network.
- Event and dedup retention, cleanup, indexing, rollback, and backup policy
  must be selected and tested before persistence migrations are deployed.

## Additional protocols

- **USB serial + NSP:** implemented path from the Uno through the Python
  bridge, with TLS/mTLS and NSP framing between the bridge and gateway. Serial
  itself remains local transport and does not authenticate device identity.
  Legacy HTTP event/status POSTs return `410`; they are not an ingestion
  compatibility path.
- **MQTT:** future adapter using a maintained MQTT client and an explicitly
  chosen external broker or gateway-hosted broker; broker TLS/auth/ACL,
  topic ownership, retained messages, QoS, and dedup behavior must be
  specified. MQTT is an application protocol, not a transport equivalent to
  NSP.
- **CoAP:** future evaluated adapter using a maintained implementation.
  Choose UDP/DTLS or OSCORE only after defining the threat model and validating
  library support; do not claim security by default.
- No adapter is implemented or production-ready merely because it appears in
  the legacy architecture PDF.

## Private gateway interface

The running NSP listener uses the Node gateway's validated ingestion path
directly; it does not create a separate private HTTP interface. Legacy
unauthenticated HTTP event/status writes return `410`, so they cannot bypass
NSP authentication. If the service is later split into a separate process,
use a strictly loopback-bound private interface or OS-level IPC identity with
schema validation, size/time limits, and an allowlisted event source.

Use asynchronous Node handling or a separate process boundary; never block the
Express event loop on a long-running C++ operation. Define startup readiness,
shutdown, timeout, restart, and error propagation contracts before wiring the
processes together.

## Configuration and operations

The running NSP service requires TLS certificate/key/trust paths and accepts
validated host, port, identity, frame/buffer limits, connection limits, and
handshake/idle timeouts. It supports one configured identity and has no
dynamic device registry or deduplication-retention policy. Production
certificates are provisioned out of band; missing required TLS material is a
startup failure, not a plaintext fallback.

Logs must be structured and redact payloads and credentials. Health must
separate liveness from readiness, with readiness covering TLS configuration,
registry access, and durable gateway storage. Metrics must be implemented
before being shown in the dashboard.

## Compatibility and risk decisions

| Risk | Decision / required evidence |
| --- | --- |
| Historical database alteration | Keep current rows; additive, versioned transactional migrations only; test on a copy |
| Legacy route bypass | Event/status HTTP POSTs return 410; regression-tested so ingestion requires NSP authentication |
| Arduino resource limits | Keep sensing firmware unchanged; host TLS on a gateway computer |
| Conflicting board documentation | Confirm exact board and pins before claiming firmware portability |
| C++ toolchain missing on current host | Add CMake; prove local MSVC 2019 C++17 build, then verify Linux CI separately |
| Untrusted serial identity | Treat current device ID as a label; NSP identity must derive from a verified certificate |
| Database duplicate semantics | Require event UUID + device-scoped unique key and atomic durable ACK in the later integration phase |
| New external libraries | Phase 2 has no runtime dependency; evaluate/lock OpenSSL 3.x for TLS only in the service phase |
| MQTT/CoAP security | Defer implementation until deployment/security profile and maintained client choice are tested |
| Availability/performance | Measure reproducibly; do not claim throughput, latency, or production readiness before evidence |

## Explicit non-goals for the first increment

Phase 2 does not add a listener, TLS, certificates, device registry, Node IPC,
database changes, dashboard views, MQTT/CoAP, or benchmark results. It delivers
only a portable protocol-core boundary and verifiable, bounded frame parsing.
