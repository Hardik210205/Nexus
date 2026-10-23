# Nexus current-state architecture

## Scope and evidence

This report records the baseline implementation inspected on 2026-10-22 before
the Phase 2 additions in this task. Source code and the checked-in SQLite
schema are authoritative. The root README was already modified in the
worktree before this task; its existing changes were retained and reviewed
rather than discarded. The Phase 2 additions are summarized at the end.

The legacy design PDF describes a broader protocol-agnostic gateway, MQTT,
CoAP, and other future components. Those are not present in the executable
source and are not counted as implemented here.

## Project and repository

Nexus is currently a small full-stack IoT prototype composed of three
independently run applications and an embedded sketch:

| Area | Location | Language/runtime | Entry point |
| --- | --- | --- | --- |
| Edge sensor | `arduino_edge_node/` | Arduino C++ (standard/toolchain not declared) | `arduino_edge_node.ino::setup/loop` |
| Serial adapter | repository root | Python (no version/dependency manifest) | `serial_bridge.py::main` |
| Gateway | `iot-gateway/apps/gateway-core/` | Node.js, Express 4, SQLite, Socket.IO | `server.js` |
| Dashboard | `iot-gateway/apps/dashboard/` | React 19, Vite 8, browser JavaScript | `index.html` → `src/main.jsx` → `src/App.jsx` |
| Documentation | `doc/`, `README.md` | Markdown, PDF, DOCX, Python helpers | N/A |

At baseline there was no root workspace/monorepo manager, CMake project, CI
configuration, deployment manifest, C++ test directory, or automated
application test script. Phase 2 now adds a standalone CMake project and C++
unit tests under `protocols/nsp/`; it does not add a legacy application test
suite. The two Node applications have separate `package.json` and lockfiles.

The local baseline environment had Node.js 20.20.0, npm 10.8.2, Python
3.10.11, SQLite 3.40.1, and a partial Visual Studio 2019 Build Tools
14.29.30133 installation; CMake and an MSVC compiler were not available to the
build. For Phase 2 verification, user-scoped CMake 4.4.4 and LLVM-MinGW
Clang 23.1.3 were installed. The C++ Debug build, CTest, and ASan/UBSan tests
pass with that Windows toolchain. MSVC, Linux, and fuzz execution remain
unverified. These are inspection-host observations, not project-pinned
versions.

### Direct JavaScript dependencies

Manifest ranges are distinct from lockfile-resolved versions:

| Application | Declared dependency | Manifest range | Lockfile version |
| --- | --- | --- | --- |
| Gateway | better-sqlite3 | `^13.0.3` | 13.0.3 |
| Gateway | cors | `^2.8.6` | 2.8.6 |
| Gateway | express | `^4.19.2` | 4.22.2 |
| Gateway | socket.io | `^4.8.3` | 4.8.3 |
| Dashboard | leaflet | `^1.9.4` | 1.9.4 |
| Dashboard | lucide-react | `^1.39.0` | 1.39.0 |
| Dashboard | react / react-dom | `^19.2.8` | 19.2.8 |
| Dashboard | react-leaflet | `^5.0.0` | 5.0.0 |
| Dashboard | recharts | `^3.10.1` | 3.10.1 |
| Dashboard | socket.io-client | `^4.8.3` | 4.8.3 |

### Gateway SQLite runtime update

After the baseline audit, the gateway replaced the `better-sqlite3` native
addon with Node's built-in `node:sqlite` `DatabaseSync` API. The gateway now
requires Node.js 22.13 or newer, retains SQLite/WAL persistence and the
existing database file/schema, and no longer needs a separately compiled
SQLite addon or Visual Studio C++ Build Tools. `npm ci` was verified with
Node.js 24.20.0 without a C++ toolchain. The original dependency table above
is a historical baseline snapshot, not the current gateway manifest.
| Dashboard (development) | Vite | `^8.2.2` | 8.2.2 |
| Dashboard (development) | `@vitejs/plugin-react` | `^6.1.0` | 6.1.1 |
| Dashboard (development) | Oxlint | `^1.79.0` | 1.80.0 |

Python imports `pyserial` and `cryptography`; root `requirements.txt` declares
their supported version ranges. The development certificate generator uses
`cryptography` to create a local CA and endpoint certificates. The firmware includes Arduino
`Wire`, `SoftwareSerial`, and standard C/C++ headers; board model, core
version, and library versions are not pinned.

## Runtime architecture and data flow

```text
MPU6050/GPS --> Arduino --USB serial CSV--> Python bridge
                                          -- NSP/1 over TLS 1.3 + mTLS -->
                                            gateway --SQLite commit
                                               |           |
                                           Socket.IO    local GET /api/events
                                               +------> React/Vite dashboard
```

1. Firmware samples MPU6050 acceleration and detects acceleration-change
   magnitude at or above `0.60 g`, after a 3-second warm-up, with a 2-second
   event cooldown. It verifies MPU identity and configuration readback before
   reporting the sensor ready. GPS fix state is not a prerequisite for event
   detection.
2. GPS NMEA GGA/RMC sentences arrive on `SoftwareSerial` RX pin 4 / TX pin 3
   at 9600 baud. A position is emitted only when both sentence types are valid
   and fresh within 5 seconds, the satellite count is positive, coordinates
   are in range, and the point is not `(0,0)`.
3. Firmware emits newline-terminated seven-field event CSV:
   `EVENT,eventNumber,latitude,longitude,satellites,gpsDate,gpsTime`, and a
   five-second status heartbeat:
   `GPS_STATUS,gpsStatus,satellites,sensorStatus`; `READY` requires successful
   MPU6050 setup and a valid sensor sample.
   Missing coordinates are empty fields; the event counter resets on device
   restart.
4. `serial_bridge.py` authenticates to the gateway with a CA-trusted client
   certificate using TLS 1.3, ALPN `nsp/1`, and NSP/1 CBOR frames. Its
   certificate URI SAN maps exactly to `arhb_uno_1`; the Uno does not implement
   TLS or store the key. Coordinates use signed degrees-times-10-million
   integers in CBOR.
   The bridge retries once in memory, not across restarts.
5. The gateway verifies the certificate chain and identity, negotiates NSP
   version 1.0, validates messages and payloads, and writes each event and
   device-scoped event-ID deduplication record in one SQLite transaction. It
   ACKs after commit and then emits `telemetry_update`. HTTP event/status
   writes return 410 to prevent an unauthenticated ingestion bypass.
6. Dashboard HTTP/Socket.IO bind to loopback and restrict Socket.IO origins to
   local development ports. The dashboard requests `/api/events` on load,
   connects to Socket.IO, merges
   and deduplicates received events in browser memory, and keeps at most 500.
   Only finite, in-range, non-zero coordinates appear on the Leaflet map.

## Existing interfaces

### HTTP

| Contract | Current behavior |
| --- | --- |
| `POST /api/telemetry` | HTTP 410; event writes require NSP TLS 1.3/mTLS |
| `GET /api/events?limit=N` | Newest first; default 100; limit clamped to 1–500; returns `{count,events}` |
| `GET /api/health` | Reports SQLite query and NSP listener state; degraded if the database or NSP listener is unavailable |
| `POST /api/gps-status` | HTTP 410; device status must use NSP |

The normalized event shape is `{id,source:{deviceId,protocol},type,payload,
timestamp}`. The persisted `event_type` is returned as top-level `eventType`.
NSP rows use `source_protocol=nsp`; existing rows retain
`source_protocol=serial-bridge`.

### Serial

The serial bridge accepts lines beginning `EVENT,` with exactly seven CSV
fields and forwards GPS and MPU6050 status as NSP DEVICE_STATUS. It skips
startup logs and preserves unavailable GPS coordinates as null in telemetry
events. The recurring status line makes sensor readiness observable even
though the bridge clears startup serial data after opening the port.

### Socket.IO

The gateway broadcasts committed events as `telemetry_update`; the local
dashboard server restricts origins to its configured development ports. NSP
currently authorizes one configured device identity, not a dynamic registry.

### SQLite

The checked-in database's current application table is:

```sql
CREATE TABLE telemetry_events (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  event_type TEXT,
  message_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  source_protocol TEXT NOT NULL DEFAULT 'serial-bridge'
);
```

This is the original event table plus the additive protocol-label column.
Gateway startup also creates `nsp_event_ids` with a device/event-ID primary
key for NSP deduplication. There is no migration framework or registry. The
database contained 203 rows at inspection. The `.db`, `.db-wal`, and `.db-shm`
files are tracked; preserve them and their history.

## Functional layers and important files

| Layer | Files / responsibility |
| --- | --- |
| Firmware sensor and transport | `arduino_edge_node/arduino_edge_node.ino` — MPU6050 I2C, GPS NMEA, motion decision, serial CSV |
| Serial-to-NSP adapter | `serial_bridge.py`, `nsp_client.py` — serial parsing, CBOR/frame encoding, TLS 1.3 client authentication |
| Gateway NSP runtime | `iot-gateway/apps/gateway-core/nsp-server.js`, `nsp-wire.js` — mTLS listener, frame/CBOR validation, NSP session and ACK |
| Gateway dashboard/persistence | `iot-gateway/apps/gateway-core/server.js` — loopback read API, SQLite transaction/dedup, Socket.IO |
| Browser UI | `iot-gateway/apps/dashboard/src/App.jsx` — history fetch, Socket.IO subscription, normalization/deduplication, overview/map/history/status views |
| Browser presentation | `src/App.css`, `src/index.css`, `index.html`, `vite.config.js` |
| Package/build config | Gateway and dashboard `package.json` plus lockfiles; dashboard has Vite/Oxlint scripts |
| Legacy design references | `doc/Hardware.docx`, `doc/IoT_Project_SADD.pdf`, `doc/pdf_output.txt` |

## Security and reliability constraints

- The bridge-to-gateway ingestion path requires TLS 1.3, ALPN `nsp/1`, a
  trusted client certificate, and an exact configured URI SAN. The gateway
  authorizes only one configured identity; dynamic enrollment, CRL/OCSP, and
  immediate revocation are not implemented.
- The Arduino Uno is not the TLS client. The Python bridge host holds the
  certificate and key; the local USB serial segment is not encrypted.
- The dashboard HTTP API binds to loopback, CORS is disabled for REST APIs,
  and Socket.IO restricts origins to local Vite ports. Dashboard users are
  not separately authenticated; do not expose these interfaces remotely.
- Event/status writes through legacy HTTP routes return 410. Payload schema
  checks apply to NSP messages.
- The bridge performs a bounded in-memory retry but has no durable outbox;
  power loss or restart can still lose an unacknowledged serial event.
- SQLite deduplication has no retention/cleanup policy. Database backup and
  recovery procedures are not configured.
- Socket.IO publishes accepted events to each allowed local dashboard client;
  there is no per-user authorization.
- The health endpoint checks database availability and NSP listener binding;
  the GPS-status heartbeat indicates whether bridge and sensor status is
  arriving. There are no metrics or separate readiness framework. Map tiles
  are fetched from OpenStreetMap.
- Parser and gateway mTLS integration tests exist. The C++ fuzz target has
  not been run; production load/fuzz testing and CI are not configured.
- Current database files are checked in, including WAL/SHM; treat as
  user/project data and do not rewrite them for NSP work.

The hardware notes list an ESP8266 NodeMCU, PIR, ultrasonic sensor, relay,
buzzer, buttons, and display, while the current sketch uses an MPU6050 and GPS
receiver. No board manifest resolves this discrepancy. The current
certificate-authenticated NSP endpoint therefore resides on the bridge host;
the UNO is only the serial sensor node.

## Integration seams

1. **Edge seam:** Arduino CSV → Python remains the local sensor link. The
   bridge now authenticates to NSP over TLS 1.3/mTLS; event/status HTTP POST
   routes are disabled rather than retained as an unauthenticated fallback.
2. **Protocol-to-event seam:** define a transport-neutral event model in the
   NSP service. Authenticated certificate identity, not untrusted message
   `deviceId`, is the source identity for NSP.
3. **Service-to-gateway seam:** the gateway's NSP listener normalizes only
   certificate-authenticated messages; the dashboard API is loopback-only.
4. **Persistence seam:** NSP event writes and deduplication IDs share a
   transaction before ACK. The migration is additive and preserves existing
   event rows; the bridge does not have a durable outbox.
5. **UI seam:** existing event schema and `telemetry_update` stay stable.
   Protocol/security operational views await real authenticated service
   status and sanitized counters; never return credentials to the browser.
6. **Transport security seam:** the Node.js gateway runtime provides bounded
   NSP framing and TLS/mTLS on the host. The standalone C++ codec is separate
   and is not loaded by Node. The Arduino Uno is not a TLS endpoint.

## Proposed incremental scope

Phase 1 recorded current-state evidence, target architecture, threat model,
wire protocol, test plan, dependency/risk assessment, and implementation
sequence. Phase 2 now delivers a dependency-free C++17 core library: explicit
bounded frame encode/decode, stream assembly, message-type validation, unit
tests, and an opt-in fuzz target. It does not open sockets, perform TLS, touch
the Node gateway, alter data, or claim an authenticated protocol service.

TLS 1.3/mTLS service, identity registry, durable deduplication, gateway IPC,
MQTT, CoAP, dashboard changes, deployment hardening, and performance claims
remain unimplemented until separately built and tested.
