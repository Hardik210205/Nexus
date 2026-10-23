# NSP deployment guide

**Status:** NSP/1 over TLS 1.3/mTLS is integrated for the local Python bridge
and Node.js gateway. The standalone C++ frame library remains independently
buildable and is not loaded into the Node.js runtime.

## Run the integrated local service

Install the Python dependencies, then create ignored development-only
certificates:

```powershell
python -m pip install -r requirements.txt
python scripts\generate_nsp_dev_certs.py
```

Start the gateway, dashboard, and serial bridge in separate terminals:

```powershell
cd D:\Nexus\iot-gateway\apps\gateway-core
npm start
```

```powershell
cd D:\Nexus\iot-gateway\apps\dashboard
npm run dev
```

```powershell
cd D:\Nexus
$env:NEXUS_SERIAL_PORT = "COM3"
python serial_bridge.py
```

For local development, set `$env:NEXUS_NSP_PROFILE = "development"` in both
the gateway and bridge terminals. Production is the default profile and
requires explicitly provisioned credentials; it never falls back to the
development CA.

The gateway uses loopback HTTP `127.0.0.1:3000` for the dashboard and
loopback NSP TLS `127.0.0.1:3443` for the bridge. Remote bridge connections
require a DNS-valid production server certificate, separately provisioned
client credentials, a configured non-loopback `NEXUS_NSP_HOST`, and
`NEXUS_NSP_ALLOW_REMOTE=1`. Do not expose the dashboard HTTP server.
Certificates can be supplied through `NEXUS_NSP_CERT_DIR` or the explicit
`NEXUS_NSP_SERVER_CERT`, `NEXUS_NSP_SERVER_KEY`, `NEXUS_NSP_CLIENT_CA`,
`NEXUS_NSP_CA`, `NEXUS_NSP_CLIENT_CERT`, and `NEXUS_NSP_CLIENT_KEY` variables.

`POST /api/telemetry` and `POST /api/gps-status` return HTTP 410; accepted
telemetry and status must use NSP/mTLS. The database ACK is sent only after
the event and deduplication record commit.

Run the mTLS/NSP integration checks with:

```powershell
cd D:\Nexus\iot-gateway\apps\gateway-core
npm test
```

## Current Phase 2 build

Requirements:

- CMake 3.20 or newer.
- A C++17 compiler (Visual Studio 2019 16.11+ with MSVC 19.29, or a
  compatible GCC/Clang).
- No runtime third-party library for the frame core.

Build and test from the repository root:

```powershell
cmake -S protocols/nsp -B build/nsp -DCMAKE_BUILD_TYPE=Release
cmake --build build/nsp --config Release
ctest --test-dir build/nsp -C Release --output-on-failure
```

The build directory is generated output and should not be committed. Windows
Debug and Release builds, CTest, and ASan/UBSan tests were verified with CMake
4.4.4 and Clang/MinGW 23.1.3. MSVC and Linux builds remain unverified. The
optional libFuzzer target is platform/toolchain dependent and unsupported by
the tested Windows MinGW Clang package; it has not been run.

## Production hardening still required

- The NSP listener requires credentials at startup and fails closed. The
  current helper-generated CA is for local development only.
- The configured client URI SAN maps to one device ID; add a dynamic,
  auditable device registry before supporting multiple devices.
- Add CRL/OCSP or an equivalent revocation strategy, certificate rotation,
  online status checks, and termination of active revoked sessions.
- Add rate limiting, write deadlines/backpressure controls, operational
  monitoring, and capacity/load testing before internet-facing deployment.
- The bridge retries once in memory; durable outbox/restart handling is not
  implemented. The checked-in Arduino Uno is not a TLS endpoint.
- The dashboard HTTP and Socket.IO APIs remain local-only, loopback services.

## Database and compatibility

The NSP integration adds a protocol column and device-scoped event ID table
without deleting event rows. Back up the database before production rollout,
and retain the history API/Socket.IO event shape for the dashboard.
