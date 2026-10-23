# NSP troubleshooting

## Phase 2 build

| Symptom | Check |
| --- | --- |
| `cmake` not found | Install CMake 3.20+ and reopen the terminal; confirm `cmake --version` |
| Compiler lacks C++17 | Use MSVC 19.29+, GCC, or Clang with C++17 mode; inspect compiler errors |
| Configure fails | Confirm the selected CMake generator is installed and matches the compiler environment |
| `ctest` reports no tests | Configure with tests enabled (the project default) and rebuild |
| Fuzz target unavailable | Use a supported Linux Clang/libFuzzer toolchain; the current Windows MinGW Clang package does not support `-fsanitize=fuzzer`. The normal unit test target does not require fuzz support |

## Running NSP service

- **TLS handshake fails:** check system time, certificate validity, SAN,
  issuer chain, trust-anchor path, key/certificate match, ALPN `nsp/1`, TLS
  1.3 support, configured certificate paths, and Windows key ACLs. Never solve
  this by disabling verification. The local development profile must be set
  explicitly on both the gateway and bridge. Gateway logs now show the
  sanitized Node TLS error code in parentheses; use it to distinguish an
  absent/untrusted client certificate from a protocol or transport failure.
- **`NSP HELLO timeout`:** TLS was established but the client did not send a
  valid NSP HELLO before the connection went idle. Start the repository
  `serial_bridge.py` client and check its terminal for connection/configuration
  errors.
- **`idle timeout`:** an established NSP session sent no traffic for 60
  seconds. Confirm the bridge is reading Arduino serial and the recurring
  `GPS_STATUS` heartbeat is being forwarded.
- **Certificate identity rejected:** ensure the client certificate URI SAN
  exactly matches `NEXUS_NSP_DEVICE_ID` (default `arhb_uno_1`). The gateway
  requires ALPN `nsp/1` and a CA-trusted client certificate.
- **No GPS/event data:** check that the bridge owns the configured Arduino
  serial port and receives serial records. GPS status `NO_DATA` means no
  usable NMEA fix reached the firmware; NSP cannot create a GPS fix.
- **No ACK:** check the gateway process, NSP listener port, and SQLite errors.
  The bridge retries with the same event ID; do not generate a new ID for the
  same logical event.
- **Duplicate ACK:** a duplicate event ID with the same payload is
  acknowledged without another stored event or broadcast. Reusing an ID for
  a different payload is rejected.
- **Dashboard API fails:** the HTTP/Socket.IO server is loopback-only on port
  `3000`; the Vite development server proxies local API requests. HTTP event
  and GPS-status POSTs intentionally return `410`. Vite `ECONNREFUSED
  127.0.0.1:3000` means the gateway API is not running; it commonly follows
  stopping the gateway with Ctrl+C. Run gateway and Vite in separate
  terminals, and leave both running.
- **Frame rejected:** check protocol version, registered message type, frame
  bounds, and CBOR payload fields. Do not log private credentials or raw
  sensitive payloads.
