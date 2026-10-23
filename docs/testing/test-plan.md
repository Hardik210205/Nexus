# Nexus test plan

## Current coverage

Phase 1 found no application test files, test runner, CI workflow, or
gateway/dashboard test scripts. Phase 2 adds a CMake C++17 NSP core with a
focused CTest suite for byte encoding, limits, malformed frames, extensions,
and TCP stream segmentation/coalescing. Debug, Release, and ASan/UBSan builds
pass on Windows with Clang/MinGW 23.1.3; MSVC and Linux remain unverified.
The libFuzzer target was attempted but this Windows MinGW Clang does not
support `-fsanitize=fuzzer`, so fuzzing has not been completed. The NSP core
does not test a TLS service or gateway integration because neither exists yet.
The dashboard has `npm run lint` and `npm run build`; the gateway has
`npm start`. A successful build/lint is not a regression test.
The gateway now requires Node.js 22.13+ and uses Node's built-in `node:sqlite`;
its dependency installation does not require Visual Studio C++ Build Tools.

## Phase 2 acceptance tests

### Frame codec unit tests

- Encode a known v1.0 frame and compare exact expected big-endian bytes.
- Decode the same frame and verify all header fields, message ID, extension,
  and payload.
- Round-trip all registered types and minimum/maximum legal payload sizes.
- Reject invalid magic, unsupported major, unknown type, invalid header size,
  payload over limit, reserved nonzero fields, unknown flags, and illegal
  ACK_REQUIRED use.
- Reject truncated fixed header, truncated extension, truncated payload,
  duplicate extensions, and malformed extension length.
- Accept unknown non-critical extension and reject unknown critical extension.
- Exercise size/int arithmetic boundaries and verify no over-read or oversized
  allocation occurs.
- Run malformed input corpus under ASan/UBSan on supported compilers.

### Fuzzing

Add a libFuzzer target for frame decode and a deterministic seed corpus for
valid/invalid headers. A fuzz target is not evidence of completed fuzzing:
record compiler, sanitizer, duration, executions, and findings only after an
actual run. Ensure the core returns an error for malformed input without
crashing, reading out of bounds, or allocating based on an unchecked length.

## Later security and integration tests

- TLS 1.3 only; valid chain/SAN/ALPN accepted; missing, expired, invalid, and
  untrusted certificates denied.
- Disabled/revoked identities and unauthorized message types never reach
  ingestion.
- Incomplete TLS/HELLO, bad version, malformed CBOR/schema, oversized frames,
  connection cap, timeout, and repeated malformed traffic handled safely.
- Replay/duplicate application ID returns stable duplicate ACK and makes no
  duplicate row or broadcast.
- ACK emitted only after atomic telemetry+dedup commit; injected database
  failure emits no success ACK and no accepted event.
- Lost ACK/reconnect retries with the same event ID.
- Revocation terminates active sessions within documented/tested bounds.
- Logs and status responses never contain private keys, tokens, passwords,
  or raw authentication material.
- Process shutdown/restart, downstream service unavailable, and bounded
  buffering tested.

## Existing application regression gate

For the implemented local NSP gateway path, test:

1. Valid CA-signed server/client certificates, TLS 1.3, ALPN, NSP HELLO, and
   capability negotiation.
2. Missing/untrusted client certificate, wrong URI identity, malformed NSP
   frames, and invalid event payloads cannot reach ingestion.
3. Telemetry commit and device-scoped deduplication commit before ACK.
4. Same event ID/content returns a duplicate ACK without another insert;
   conflicting content is rejected.
5. Legacy HTTP telemetry/status writes return 410; dashboard APIs remain
   loopback-only.
6. `GET /api/events`, `GET /api/health`, and GPS status return the event list,
   SQLite/NSP listener state, and recent bridge GPS/sensor heartbeat.
7. Dashboard loads history, merges live events, and deduplicates them.
8. Map rejects invalid/out-of-range/(0,0) coordinates and accepts valid ones.

Existing database compatibility must be checked against a copy and compare
row counts/schema before and after. Never run destructive migration tests on
the tracked SQLite files. The gateway's built-in NSP integration tests use a
temporary test database and temporary development certificates.

## Commands

Phase 2:

```powershell
cmake -S protocols/nsp -B build/nsp -DCMAKE_BUILD_TYPE=Debug
cmake --build build/nsp --config Debug
ctest --test-dir build/nsp -C Debug --output-on-failure
```

Existing frontend:

```powershell
cd iot-gateway/apps/dashboard
npm run lint
npm run build
```

No security, database, gateway, or browser test command exists until those
test suites are added. Report missing tests as unverified, not as passing.
