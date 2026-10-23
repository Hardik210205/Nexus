# Nexus — Network Exchange for Unified Systems

Nexus is a telemetry application with an Arduino/MPU6050 sensor, GPS receiver,
Python USB-serial bridge, Node.js gateway, PostgreSQL event history, and React
dashboard. The current bridge-to-gateway telemetry path uses NSP/1 over
TLS 1.3 with mutual certificate authentication. The UNO keeps its local
serial link; the certificate identity is held by the bridge host.

**Implementation status:** the local NSP runtime, TLS/mTLS certificate
validation, CBOR/frame checks, event persistence, and event-ID deduplication
are implemented. The standalone C++17 frame codec remains a separate
experimental library. Production certificate lifecycle, dynamic device
registry/revocation, durable bridge queue, MQTT, and CoAP remain out of scope.
The dashboard API is loopback-only; unauthenticated HTTP event-ingestion
routes return `410`. See [the current-state audit](docs/architecture/current-state.md),
[target architecture](docs/architecture/target-architecture.md), and
[NSP deployment guide](docs/nsp/deployment-guide.md).

## Project vision and protocol status

| Capability | Status |
| --- | --- |
| Arduino motion/GPS sensing, serial CSV | Implemented; board/toolchain are not pinned |
| Python serial-to-NSP bridge | Implemented; bounded in-memory retry, no durable queue |
| NSP/1 TCP with TLS 1.3/mTLS | Implemented for one configured bridge identity |
| PostgreSQL persistence and Socket.IO | Implemented for production; SQLite fallback for local development |
| React operations, history, map, and status views | Implemented |
| NSP/1 protocol specification | Implemented local runtime profile; production extensions remain |
| C++17 frame/stream codec and CMake tests | Implemented as a separate codec library |
| Device authorization, transactional dedup/ACK | Single configured certificate identity; commit-before-ACK |
| MQTT and CoAP adapters | Planned; no adapters currently exist |
| Production security lifecycle, protocol dashboards, deployment hardening | Planned |

NSP is designed as an application framing/message layer. TLS 1.3 is the
initial secure TCP carrier; MQTT and CoAP remain separate adapters with their
own transport/security profiles. See the [NSP specification](docs/nsp/protocol-specification.md)
and [threat model](docs/nsp/threat-model.md) for intended properties and
limitations.

## NSP core development

The standalone NSP frame core requires CMake 3.20+ and a C++17 compiler.
Build and test it independently from the existing Node applications; see the
[NSP core guide](protocols/nsp/README.md) for the verified Windows Clang
invocation:

```powershell
cmake -S protocols/nsp -B build/nsp -DCMAKE_BUILD_TYPE=Debug
cmake --build build/nsp --config Debug
ctest --test-dir build/nsp -C Debug --output-on-failure
```

Windows Debug and Release builds, CTest, and ASan/UBSan tests were verified
with CMake 4.4.4 and Clang/MinGW 23.1.3. MSVC and Linux builds remain
unverified. The optional libFuzzer target requires a supported Clang platform;
the tested Windows MinGW toolchain does not support it, and fuzzing has not
been run.

When running tests from a Windows LLVM-MinGW build, add the toolchain's `bin`
directory to `PATH` in the same PowerShell session so Windows can find the
compiler runtime DLLs:

```powershell
$env:PATH = "$toolRoot\bin;$env:PATH"
ctest --test-dir build/nsp-clang -C Debug --output-on-failure
```

The frame library does not add a TCP listener or TLS by itself. Do not
interpret a passing codec test as evidence of authentication, authorization,
secure deployment, MQTT/CoAP support, or production readiness.

Nexus is an **Adaptive Road Hazard Beacon (ARHB)** telemetry application.
Arduino motion/GPS records pass over USB serial to a Python bridge; the bridge
uses NSP/1 over TLS 1.3/mTLS to send authenticated events to the Node.js
gateway, which stores them in PostgreSQL in production and publishes them to the local React
dashboard over Socket.IO.

This document describes the implementation present in this repository. The
separate architecture and hardware documents in [`doc/`](doc/) are background
materials; where they differ from the source code, the source code is the
current implementation reference.

## Project status

| Capability | Current status |
| --- | --- |
| MPU6050 motion sensing and event detection | Implemented in Arduino firmware |
| GPS NMEA input and event coordinates | Implemented in Arduino firmware |
| USB serial event transport | Implemented |
| Python serial-to-NSP bridge | Implemented; in-memory bounded retry only |
| NSP TLS 1.3/mTLS ingestion | Implemented for one configured device identity |
| SQLite event persistence and history API | Implemented |
| Socket.IO event broadcast | Implemented |
| React operations dashboard and GPS map | Implemented |
| NSP/1 framing and experimental C++ frame core | Implemented; Node runtime has its own wire codec |
| MQTT, CoAP, device registry, and rule engine | Not implemented |
| Production certificate lifecycle, dynamic device registry/revocation | Not implemented |

## Architecture

```text
 MPU6050 accelerometer        GPS receiver
          │ I²C                  │ SoftwareSerial
          └──────── Arduino Uno ─┘
                       │ USB serial, 9600 baud
                       │ EVENT,... (CSV, newline terminated)
                       ▼
              serial_bridge.py (Python)
                       │ NSP/1 over TCP + TLS 1.3 mTLS
                       ▼
         gateway-core (Node.js)
          ├─ NSP listener :3443 (mTLS)
          ├─ local dashboard API :3000
          │        ├─ SQLite persistence
          │        └─ Socket.IO → React dashboard (Vite)
```

The gateway is the persistence and fan-out boundary. PostgreSQL is the
production database; SQLite remains an automatic local-development fallback
when `DATABASE_URL` is not set. The bridge handles the
hardware-facing serial format; the dashboard consumes gateway HTTP and
Socket.IO interfaces rather than reading serial data directly.

## Quick start on Windows

Run the gateway, dashboard, and serial bridge in three separate PowerShell
terminals. Start them in this order so the gateway is ready before the bridge
connects:

### 1. Install prerequisites

- Node.js `22.13.0` or newer
- Python 3
- Arduino IDE, if uploading the firmware
- Arduino Uno with the MPU6050 and GPS receiver connected

From the repository root (`D:\IoT_Project`), install dependencies:

```powershell
python -m pip install -r requirements.txt

cd D:\IoT_Project\iot-gateway\apps\gateway-core
npm install

cd D:\IoT_Project\iot-gateway\apps\dashboard
npm install
```

### 2. Create local development certificates

Run this once from the repository root. The generated files are stored under
`.local\nsp-certs\`, which is ignored by Git:

```powershell
cd D:\IoT_Project
python scripts\generate_nsp_dev_certs.py
```

### 3. Start the gateway

```powershell
cd D:\IoT_Project\iot-gateway\apps\gateway-core
$env:NEXUS_NSP_PROFILE = "development"
npm start
```

The gateway starts the dashboard API on `http://127.0.0.1:3000` and the
authenticated NSP listener on `127.0.0.1:3443`.

### 4. Start the dashboard

```powershell
cd D:\IoT_Project\iot-gateway\apps\dashboard
npm run dev
```

Open the URL printed by Vite, normally
`http://localhost:5173`. The dashboard receives new events through Socket.IO
and also periodically refreshes event history and GPS status from the
gateway, so a browser refresh is not required.

### 5. Start the serial bridge

Close Arduino Serial Monitor first because the bridge must exclusively own the
Arduino COM port. Replace `COM3` with the actual port when necessary:

```powershell
cd D:\IoT_Project
$env:NEXUS_NSP_PROFILE = "development"
$env:NEXUS_SERIAL_PORT = "COM3"
python serial_bridge.py
```

When the bridge is connected, the dashboard **System status** page reports the
GPS receiver state:

- `FIX` — valid GPS coordinates are available.
- `NO FIX` — GPS data is arriving, but a usable fix is not available yet.
- `NO DATA` — no recent NMEA data was received.
- `STALE` — the last bridge heartbeat is older than the dashboard timeout.

The map displays coordinates only for motion events recorded while a valid GPS
fix exists. It does not continuously track the receiver.

### Stop the services

Press `Ctrl+C` in each terminal. The gateway stores events in
`iot-gateway\apps\gateway-core\arhb_events.db`; do not delete this file if
event history must be retained.

## Components

### Arduino edge node

Source: [`arduino_edge_node.ino`](arduino_edge_node/arduino_edge_node.ino)

The firmware uses the Arduino `Wire` library to communicate with an MPU6050 at
I²C address `0x68`. It configures the accelerometer for ±2 g, reads the
accelerometer registers, and calculates the magnitude of the change between
consecutive acceleration samples:

```text
changeG = sqrt((ax - previousAx)² + (ay - previousAy)² + (az - previousAz)²)
```

An event is emitted when `changeG` is at least `0.60 g`, after a 3-second
sensor warm-up and no more frequently than once every 2 seconds. The loop
samples at approximately 10 ms intervals. Firmware verifies the MPU6050
identity and configuration readback before reporting it ready; I2C samples
are decoded as signed 16-bit values. These are source constants, not
runtime-configurable settings.

GPS input is read with `SoftwareSerial` using Arduino pin 4 as RX and pin 3 as
TX, at 9600 baud. The firmware parses NMEA GGA and RMC sentences. It considers
a fix usable only when both sentence types are valid and fresh (within
5 seconds), the satellite count is positive, the coordinates are in range, and
the position is not `(0, 0)`. Motion detection does not depend on GPS; an event
can be emitted without coordinates.

At startup, the firmware writes status lines including `ARHB_READY`. Every
five seconds it reports
`GPS_STATUS,FIX|NO_FIX|NO_DATA,satellites,READY|ERROR` over USB serial; the
sensor status is `READY` only after MPU6050 identity/configuration checks and
a successful recent sample. The bridge forwards this heartbeat over NSP,
allowing the dashboard to detect a missing/stale bridge and sensor failures. The
board's built-in LED blinks while a fresh GPS fix is valid and stays off when
there is no current fix. `FIX` means recent GGA and RMC
sentences both supplied valid coordinates; `NO_FIX` means NMEA sentences
arrived but that condition is not met; `NO_DATA` means no NMEA sentence arrived
recently. Each detected motion event is written as one newline-terminated CSV
record:

```text
EVENT,<eventNumber>,<latitude>,<longitude>,<satellites>,<gpsDate>,<gpsTime>
```

When GPS is unavailable, latitude and longitude are empty fields. The event
number is incremented on the device for each detected event. GPS date and time
are derived from RMC data.

### Python serial bridge

Source: [`serial_bridge.py`](serial_bridge.py)

The bridge opens the configured serial port at 9600 baud, waits for the
Arduino reset interval, then forwards GPS status and motion events. It ignores
the `ARHB_READY` marker and preserves motion events when GPS coordinates are
unavailable.

The Uno does not run TLS. Its USB-serial-connected Python bridge holds the
device certificate/private key and establishes NSP/1 over TLS 1.3 mutual
authentication to the gateway. The gateway checks the CA chain, `nsp/1` ALPN,
and exact certificate URI identity
`spiffe://nexus.local/device/arhb_uno_1`; payload fields cannot claim another
identity. The bridge also verifies the gateway certificate and hostname. The
certificate identifies the bridge host, not a key stored on the Arduino.

GPS coordinates are carried as deterministic signed E7 integers (degrees
multiplied by ten million) in the CBOR payload as `latitudeE7` and
`longitudeE7`, then converted into the existing JSON shape by the gateway.
Each event gets a cryptographically random ID that remains stable for a
bounded retry. The event and deduplication record are committed together
before acknowledgement and broadcast. Delivery does not have a durable queue
across process/power loss.

Set `NEXUS_SERIAL_PORT` to the Arduino COM port (default `COM3`). NSP defaults
to `localhost:3443`; configure with `NEXUS_NSP_HOST`, `NEXUS_NSP_PORT`, and
`NEXUS_NSP_DEVICE_ID`. Certificate paths default to ignored
`.local/nsp-certs/` only when `NEXUS_NSP_PROFILE=development` is explicitly
set; otherwise production requires explicitly configured certificates. Paths
can be overridden with `NEXUS_NSP_CERT_DIR`, `NEXUS_NSP_CA`,
`NEXUS_NSP_CLIENT_CERT`, and `NEXUS_NSP_CLIENT_KEY`. Close Arduino Serial
Monitor while the bridge owns the port.

### Gateway core

Source: [`server.js`](iot-gateway/apps/gateway-core/server.js)
Manifest: [`package.json`](iot-gateway/apps/gateway-core/package.json)

The Node.js gateway runs NSP/TLS 1.3/mTLS on port `3443`; its dashboard
HTTP/Socket.IO server binds to loopback port `3000`. It provides:

| Method and path | Purpose |
| --- | --- |
| `POST /api/telemetry` | Rejected with HTTP `410`; event ingestion must use authenticated NSP |
| `GET /api/events` | Return stored events, newest first |
| `GET /api/health` | Check the configured database and NSP listener; reports degraded state if either is unavailable |
| `GET /api/gps-status` | Return the latest bridge GPS/sensor heartbeat and receive time |
| `POST /api/gps-status` | Rejected with HTTP `410`; device status must use authenticated NSP |

The NSP listener requires TLS 1.3, `nsp/1` ALPN, a CA-trusted client
certificate, and the configured certificate URI identity. It validates
registered message types and payloads. HTTP event/status writes cannot bypass
NSP. Telemetry and the device-scoped event-ID deduplication record are
committed together before ACK or Socket.IO broadcast. The database is opened at
In production, the gateway uses PostgreSQL and creates its schema and indexes
on startup. Local development and tests use
`iot-gateway/apps/gateway-core/arhb_events.db` when `DATABASE_URL` is absent;
the gateway enables SQLite write-ahead logging and applies additive
protocol/NSP event-ID migrations without discarding existing rows.

The stored table contains:

| Column | Meaning |
| --- | --- |
| `id` | Gateway-generated UUID; primary key |
| `device_id` | Device identifier from the request |
| `event_type` | Event subtype, or `NULL` |
| `message_type` | Request `type` |
| `payload_json` | JSON encoding of the remaining request fields |
| `timestamp` | Gateway receive time in ISO-8601 format |

`GET /api/events` accepts an optional integer `limit`. Its default is 100; the
gateway clamps the value to the range 1–500. The response contains `count` and
an `events` array. Each event includes `id`, `source`, `type`, `eventType`,
`payload`, and `timestamp`.

The successful ingestion response uses HTTP `201` and includes `status`,
`internalId`, and `stored`. Missing required fields result in HTTP `400`;
database errors result in HTTP `500`. Accepted events are broadcast to all
connected Socket.IO clients using the `telemetry_update` event. The gateway
does not currently filter subscribers by device.

The health endpoint runs `SELECT 1` against the configured database and includes a `checkedAt`
timestamp. A successful check returns HTTP `200` with `status: "ok"` and
`database: "connected"`; a failed database check is logged and returns HTTP
`503` with `status: "degraded"` and `database: "unavailable"`. This is a
basic liveness check, not a comprehensive readiness or operational monitoring
system.

### Dashboard

Sources: [`App.jsx`](iot-gateway/apps/dashboard/src/App.jsx),
[`App.css`](iot-gateway/apps/dashboard/src/App.css),
[`main.jsx`](iot-gateway/apps/dashboard/src/main.jsx)
Manifest: [`package.json`](iot-gateway/apps/dashboard/package.json)

The dashboard is a React application served during development by Vite. It
loads recent events from `GET /api/events` and connects to Socket.IO for live
`telemetry_update` events. The UI merges the history response with live
events, normalizes payload fields, removes duplicates, and retains up to 500
events in browser memory. The displayed count is the number currently loaded,
not a database-wide total.

The dashboard has four views:

- **Operations overview** — loaded event counts, GPS-positioned counts, latest
  event, and a short live event feed with an initial-data empty state.
- **Live event map** — maps records with valid coordinates using Leaflet and
  OpenStreetMap tiles.
- **Event history** — event table and live feed, with GPS-availability and
  event-type filters.
- **System status** — periodic gateway/database health checks, Socket.IO
  connection state, saved-history availability, and a manual refresh action.
  Gateway health and live-stream health are reported separately; map tile
  availability is not checked.

Coordinates are mapped only when they are finite, within latitude/longitude
ranges, and not `(0, 0)`. Events without valid coordinates remain visible in
the stream and history but are not plotted. Map tiles and external map links
require internet access. Dashboard history is loaded from the gateway on page
load; the currently displayed and live-merged set is limited to 500 events.

## Interfaces and data contracts

### Bridge to gateway

The bridge sends NSP/1 frames over mutually authenticated TLS 1.3 to
`localhost:3443` using ALPN `nsp/1`. Its CBOR application envelope identifies
the registered device using the certificate URI SAN, not a payload-supplied
identity. the telemetry payload carries GPS coordinates as signed E7 integers (degrees
multiplied by ten million; `latitudeE7`, `longitudeE7`); the gateway converts them into
the JSON numbers used by the dashboard:

```text
{
  0: "nexus.event",
  1: 1,
  2: "arhb_uno_1", // checked against the authenticated certificate identity
  3: <16-byte random application event ID>,
  4: "road_hazard_motion",
  7: {
    "eventNumber": 12,
    "latitudeE7": 377749000,
    "longitudeE7": -1224194000,
    "satellites": 7,
    "gpsDate": "2026-10-22",
    "gpsTime": "08:48:31"
  }
}
```

When GPS is unavailable both coordinate values are `null`. The server sends
an ACK only after saving the event and its deduplication ID in the same
SQLite transaction. The retry reuses the application event ID.

### Gateway event

After accepting the request, the gateway creates the normalized event:

```json
{
  "id": "gateway-generated-uuid",
  "source": {
    "deviceId": "arhb_uno_1",
    "protocol": "nsp"
  },
  "type": "telemetry",
  "eventType": "road_hazard_motion",
  "payload": {
    "eventNumber": 12,
    "latitude": 37.7749,
    "longitude": -122.4194,
    "satellites": 7,
    "gpsDate": "2026-10-22",
    "gpsTime": "08:48:31"
  },
  "timestamp": "2026-10-22T08:48:31.000Z"
}
```

The same event shape is returned by `GET /api/events` (within its `events`
array) and emitted to Socket.IO clients as `telemetry_update`. The timestamp is
assigned by the gateway when it receives the request; `gpsDate` and `gpsTime`
describe the device's GPS time.

## Repository layout

```text
Nexus/
├── arduino_edge_node/
│   └── arduino_edge_node.ino       Arduino motion/GPS firmware
├── doc/
│   ├── Hardware.docx               Hardware reference notes
│   ├── IoT_Project_SADD.pdf        Original architecture/design document
│   ├── pdf_output.txt              Extracted PDF text
│   ├── read_docx.py                DOCX text extraction helper
│   └── read_pdf.py                 PDF text extraction helper
├── iot-gateway/
│   └── apps/
│       ├── gateway-core/
│       │   ├── arhb_events.db      SQLite event history
│       │   ├── package.json        Gateway dependencies and start script
│       │   └── server.js           HTTP API, persistence, Socket.IO
│       └── dashboard/
│           ├── package.json        Dashboard dependencies and scripts
│           ├── index.html          Vite HTML entry
│           ├── vite.config.js      Vite React configuration
│           └── src/
│               ├── App.jsx         Dashboard views and event handling
│               ├── App.css         Dashboard styles
│               ├── index.css       Global style reset
│               └── main.jsx        React application entry
├── nsp_client.py                   NSP/1 TLS 1.3/mTLS bridge client
├── serial_bridge.py                Serial-to-NSP adapter
└── README.md                       This document
```

## Local development on Windows

### Prerequisites

- Node.js 22.13+ and npm, for the gateway and dashboard. The gateway uses
  Node's built-in SQLite module, so installing its dependencies does not
  require a separate C++ toolchain.
- Python 3, plus `pyserial` and `cryptography`, for the serial bridge and local
  development certificate generation.
- Arduino IDE and a compatible board for firmware upload and hardware tests.
- The MPU6050 and GPS receiver connected to the board.

The repository has separate npm manifests for the gateway and dashboard and
a root `requirements.txt` for the Python bridge. Firmware dependencies are
Arduino core libraries `Wire`, `SoftwareSerial`, and standard C/C++ headers.

Install the Python bridge packages:

```powershell
python -m pip install -r requirements.txt
```

Create local development-only certificates before starting the gateway:

```powershell
cd D:\IoT_Project
python scripts\generate_nsp_dev_certs.py
```

This writes a local CA, gateway certificate, and `arhb_uno_1` client
certificate under `.local\nsp-certs\`, which is ignored by Git. Keep the CA
private key local. Local run terminals must explicitly set
`NEXUS_NSP_PROFILE=development`; production defaults to fail-closed and
requires operator-provisioned CA-issued certificates.

Install each JavaScript application's dependencies:

```powershell
cd D:\IoT_Project\iot-gateway\apps\gateway-core
npm install

cd D:\IoT_Project\iot-gateway\apps\dashboard
npm install
```

Upload `arduino_edge_node/arduino_edge_node.ino` to the board. Check the
firmware pin assignments against the hardware documentation and wiring. For
the GPS SoftwareSerial connection, Arduino RX is pin 4 and Arduino TX is pin
3. Set `NEXUS_SERIAL_PORT` to the board's COM port if it is not `COM3`.

The GPS parser is included in the `.ino` file, so the sketch has no extra
local header dependencies. In Arduino IDE, open the repository sketch directly
from `D:\IoT_Project\arduino_edge_node\arduino_edge_node.ino`.

The gateway listens on port `3000` by default. To use another port, set
`PORT` in the gateway terminal before starting it. The NSP listener uses port
`3443` by default; it and the dashboard API bind to loopback. The Vite
development server proxies dashboard API and Socket.IO requests to
`http://127.0.0.1:3000` by default. Do not expose the local dashboard API to
the network. To expose the NSP listener to a remote bridge, install a
production server certificate valid for the DNS name the bridge uses, set
`NEXUS_NSP_HOST` and `NEXUS_NSP_ALLOW_REMOTE=1`, provision the client
certificate out of band, and configure host/firewall controls.

For production, set `DATABASE_URL` to a PostgreSQL connection string. The
gateway creates its required tables and indexes on startup. Set
`DATABASE_SSL=require` when the PostgreSQL provider requires TLS. If
`DATABASE_URL` is not set, the gateway uses the local SQLite database for
development and tests.

The gateway loads environment variables from
`iot-gateway/apps/gateway-core/.env`. Create that file beside the gateway
`package.json` for local development:

```dotenv
NEXUS_NSP_PROFILE=development
DATABASE_URL=postgresql://user:password@localhost:5432/nexus
DATABASE_SSL=disable
NEXUS_SERIAL_PORT=COM3
```

Do not commit `.env`; it is for local secrets only. For hosted deployment,
configure the same values in the platform's secret/environment-variable
settings instead of uploading the file.

The Vite dashboard uses a separate file,
`iot-gateway/apps/dashboard/.env.local`, for browser-safe values:

```dotenv
VITE_GATEWAY_URL=http://127.0.0.1:3000
```

Never put database passwords, private keys, or client certificates in the
dashboard `.env.local` file because `VITE_*` values are exposed to the browser.

To copy existing local SQLite history into PostgreSQL before switching the
gateway, set both variables and run:

```powershell
cd D:\IoT_Project\iot-gateway\apps\gateway-core
$env:NEXUS_DB_PATH = "D:\IoT_Project\iot-gateway\apps\gateway-core\arhb_events.db"
$env:DATABASE_URL = "postgresql://user:password@host:5432/nexus"
$env:DATABASE_SSL = "require"
npm run migrate:postgres
```

Use a secret-managed connection string instead of putting a real password in
PowerShell history for shared or production environments.

Run the gateway, dashboard, and bridge in three separate PowerShell
terminals. Do not append the activation or execution-policy commands to
`npm start`; the gateway does not need the Python virtual environment:

```powershell
cd D:\IoT_Project\iot-gateway\apps\gateway-core
$env:NEXUS_NSP_PROFILE = "development"
npm start
```

```powershell
cd D:\IoT_Project\iot-gateway\apps\dashboard
npm run dev
```

```powershell
cd D:\IoT_Project
$env:NEXUS_NSP_PROFILE = "development"
$env:NEXUS_SERIAL_PORT = "COM3" # replace with the Arduino COM port
python serial_bridge.py
```

Open the local URL printed by Vite (normally `http://localhost:5173`). The
dashboard API listens only on `127.0.0.1:3000` and authenticated NSP listens
on `127.0.0.1:3443`. The Arduino Serial Monitor must not be connected while
the Python bridge is using the serial port.

The dashboard's **System status** page shows the GPS receiver status. `FIX`
means the firmware is receiving usable GPS sentences; `NO FIX` means data is
arriving but the receiver has not obtained a valid fix; `NO DATA` suggests
checking receiver power, shared ground, GPS TX → Arduino D4, and baud rate.
After a `FIX`, the map gets a location only when a motion event is detected;
the application does not continuously track or plot the GPS receiver.

### Test secure ingestion without hardware

The gateway test suite creates temporary test certificates, connects using
TLS 1.3/mTLS, negotiates NSP, submits and retries an event, and rejects a
client without a certificate:

```powershell
cd D:\IoT_Project\iot-gateway\apps\gateway-core
npm test
```

The suite does not modify the application's database or leave credentials in
the repository.

### Available project scripts

| Component | Command | Purpose |
| --- | --- | --- |
| Gateway | `npm start` | Start the Express/Socket.IO server |
| Gateway | `npm test` | Test NSP framing, TLS/mTLS, event acknowledgement and deduplication |
| Dashboard | `npm run dev` | Start the Vite development server |
| Dashboard | `npm run build` | Build static dashboard assets |
| Dashboard | `npm run lint` | Run Oxlint |
| Dashboard | `npm run preview` | Preview a built dashboard |

Run the GPS parser, bridge parsing, and NSP wire tests from the repository root:

```powershell
g++ -std=c++17 -Wall -Wextra -Werror arduino_edge_node\tests\gps_nmea_test.cpp -o $env:TEMP\nexus-gps-nmea-test.exe
& $env:TEMP\nexus-gps-nmea-test.exe
python -m unittest discover -s tests -v
```

## Configuration and operational constraints

## VPS deployment with the existing NSP/TCP protocol

The current protocol can be deployed without changing the Python bridge by
running the gateway on a Linux VPS with Docker. The VPS must expose:

- TCP `3443` for the TLS 1.3/mTLS NSP listener.
- HTTP `3000` only locally; expose it publicly through HTTPS using a reverse
  proxy such as Caddy or Nginx.

Use a managed PostgreSQL provider for `DATABASE_URL`. Do not use the
development certificates generated by `scripts\generate_nsp_dev_certs.py` in
production. Provision a DNS-valid server certificate and a client certificate
for the bridge.

Build and run the gateway on the VPS:

```bash
cd /opt/nexus/iot-gateway/apps/gateway-core
docker build -t nexus-gateway .
docker run -d --name nexus-gateway --restart unless-stopped \
  -p 3000:3000 -p 3443:3443 \
  --env-file /etc/nexus/gateway.env \
  -v /etc/nexus/certs:/run/nexus/certs:ro \
  nexus-gateway
```

The production environment file should contain values similar to:

```dotenv
NODE_ENV=production
PORT=3000
HTTP_HOST=0.0.0.0
HTTP_ALLOW_REMOTE=1
NEXUS_NSP_PROFILE=production
NEXUS_NSP_ENABLED=1
NEXUS_NSP_HOST=0.0.0.0
NEXUS_NSP_PORT=3443
NEXUS_NSP_ALLOW_REMOTE=1
DATABASE_URL=postgresql://user:password@managed-postgres-host:5432/nexus
DATABASE_SSL=require
DASHBOARD_ORIGINS=https://your-dashboard.vercel.app
NEXUS_NSP_SERVER_CERT=/run/nexus/certs/server-cert.pem
NEXUS_NSP_SERVER_KEY=/run/nexus/certs/server-key.pem
NEXUS_NSP_CLIENT_CA=/run/nexus/certs/ca-cert.pem
```

Restrict VPS firewall access to TCP `3443` from the bridge network where
possible. Put the HTTP gateway behind HTTPS and set the Vercel dashboard
`VITE_GATEWAY_URL` to that HTTPS URL. The bridge's NSP endpoint must use the
VPS DNS name and port `3443`.

For Vercel, set the project root to `iot-gateway/apps/dashboard`, build with
`npm run build`, publish `dist`, and define
`VITE_GATEWAY_URL=https://gateway.example.com`. Add the final Vercel domain
to `DASHBOARD_ORIGINS` on the VPS and restart the gateway after changing it.

For a normal Render HTTP Web Service without a public raw TCP endpoint, set
`NEXUS_NSP_ENABLED=0`. The HTTP API and dashboard can run in this mode, but
the current NSP bridge cannot send telemetry until a TCP-capable endpoint or
an HTTPS/WSS ingestion transport is provided.

The current deployment settings are:

| Setting | Current value/location |
| --- | --- |
| Serial device | `NEXUS_SERIAL_PORT` environment variable; defaults to `COM3` |
| Serial baud rate | `9600` in firmware and bridge |
| NSP profile | `NEXUS_NSP_PROFILE`; defaults to `production` (no development-certificate fallback) |
| NSP listener | `NEXUS_NSP_HOST` / `NEXUS_NSP_PORT`; defaults to loopback `localhost:3443` |
| NSP device identity | `NEXUS_NSP_DEVICE_ID`; defaults to `arhb_uno_1` |
| NSP certificates | `NEXUS_NSP_CERT_DIR` or `NEXUS_NSP_SERVER_CERT`, `NEXUS_NSP_SERVER_KEY`, `NEXUS_NSP_CLIENT_CA`, `NEXUS_NSP_CA`, `NEXUS_NSP_CLIENT_CERT`, and `NEXUS_NSP_CLIENT_KEY` |
| Dashboard HTTP API | `HTTP_HOST` / `PORT`; defaults to `127.0.0.1:3000` |
| Production database | `DATABASE_URL` PostgreSQL connection string; required for hosted deployment |
| Database TLS | `DATABASE_SSL=require` for providers requiring encrypted PostgreSQL connections |
| Local database fallback | `NEXUS_DB_PATH`; used only when `DATABASE_URL` is not set |
| Dashboard dev proxy target | `NEXUS_GATEWAY_URL`; defaults to `http://127.0.0.1:3000` |
| Dashboard gateway URL | `VITE_GATEWAY_URL` build-time variable; unset means same-origin API |

The NSP service is a local implementation, not yet a production device-
management or internet-facing platform. In particular:

- The development CA/client/server private keys must remain under ignored
  `.local/` and are used only with explicit `NEXUS_NSP_PROFILE=development`;
  use separately provisioned production certificates and protect
  their keys with platform ACLs.
- The runtime authorizes one configured certificate URI identity; dynamic
  device enrollment, revocation, and online certificate-status checking are
  not implemented.
- The bridge retries once in memory but has no durable queue after process or
  power loss.
- Dashboard HTTP/Socket.IO bind to loopback and accept only local dashboard
  origins; they are not for remote access.
- Exposing NSP to a remote bridge requires a real DNS-valid server
  certificate, `NEXUS_NSP_HOST`, `NEXUS_NSP_ALLOW_REMOTE=1`, out-of-band
  client provisioning, firewall rules, and monitoring.
- The database has no configured retention or archival policy.
- The health endpoint checks the gateway process and database query only; there
  is no metrics or full readiness framework.
- The dashboard depends on external OpenStreetMap tile and link services for
  geographic features.
- Focused parser, NSP wire, and gateway mTLS integration tests are present;
  CI configuration and production-scale security testing are not.

See the [usability test plan](docs/USABILITY_TEST_PLAN.md) for concrete
operator workflows, current capability boundaries, and test results. Workflows
marked `NOT RUN` require manual execution; their expected results are not
evidence of a pass.

For the Render and Vercel deployment procedure, see the
[Render + Vercel deployment guide](docs/deployment-render-vercel.md).

Do not expose this prototype directly to the public internet without adding
appropriate access controls, transport security, validation, and operational
protections.

## Design direction

The repository's original design document discusses a broader protocol
gateway. The current GPS/motion path uses serial CSV, NSP/TLS 1.3/mTLS,
PostgreSQL persistence in production, SQLite for local development, Socket.IO
delivery, and a local dashboard. MQTT/CoAP
adapters, dynamic device management, configurable rules, and production
operations remain future work unless implemented in source.

## Source and background documents

- Firmware: [`arduino_edge_node.ino`](arduino_edge_node/arduino_edge_node.ino)
- Serial adapter: [`serial_bridge.py`](serial_bridge.py)
- Gateway API and persistence: [`server.js`](iot-gateway/apps/gateway-core/server.js)
- Dashboard behavior: [`App.jsx`](iot-gateway/apps/dashboard/src/App.jsx)
- Hardware reference: [`Hardware.docx`](doc/Hardware.docx)
- Original design: [`IoT_Project_SADD.pdf`](doc/IoT_Project_SADD.pdf)
