# Nexus implementation plan

## Phase 1 — Audit and design (this increment)

- Record current runtime boundaries, interfaces, database schema, data flow,
  existing security gaps, documentation drift, and integration seams.
- Define the target adapter pipeline, NSP version/framing/message schema,
  TLS 1.3/mTLS profile, authorization boundary, replay/dedup/ACK contract,
  and rollout sequence.
- Create threat, test, deployment, provisioning, troubleshooting, and
  benchmark-methodology documents.
- Record compatibility and dependency risks. Do not modify the existing
  SQLite database or replace the legacy HTTP path.

**Acceptance:** current/target architecture and NSP draft are in the
repository, requirements clearly marked implemented vs planned, plan is
phased, and no unsupported test/performance/security claim is made.

## Phase 2 — Standalone NSP core (start after Phase 1 docs)

- Create a portable CMake C++17 project independent of application
  dependencies.
- Implement explicit big-endian fixed-header/frame encoding and decoding,
  bounded lengths, registered type/flag checks, extension handling, and
  error results.
- Add unit tests for exact bytes, round trips, malformed/truncated input,
  limit boundaries, and reserved fields.
- Add optional libFuzzer entry point when a supported Clang toolchain is
  available; run tests and sanitizers where the environment supports them.
- Do not add sockets, TLS, certificate provisioning, DB changes, or an
  unauthenticated endpoint.

**Acceptance:** CMake build and unit tests pass on a Windows C++17 toolchain;
MSVC and Linux CI builds are required before claiming those compiler/platform
combinations; parser is bounded and test-covered.

## Phase 3 — Secure TCP/TLS service

- Select/pin maintained OpenSSL 3.x release after license/platform/security
  review; require TLS 1.3, mTLS, chain/SAN validation, ALPN, no fallback.
- Implement bounded TCP service with validated configuration, identity
  registry lookup, authorization, timeouts, connection limits, structured
  redacted logging, readiness, and revocation behavior.
- Add TLS negative tests (untrusted/expired/missing/revoked identity), malformed
  traffic, concurrency limits, and interrupted-handshake tests.

**Gate:** no telemetry accepted without authenticated authorized identity;
no insecure fallback; operational cert workflow documented.

## Phase 4 — Gateway ingestion and durable delivery

- Define private loopback/IPC contract with Node and production/dev binding
  policies; do not bypass NSP through public `/api/telemetry`.
- Add versioned transactional SQLite migrations with device-scoped event ID
  deduplication; preserve existing telemetry schema/history and add no private
  credential storage.
- Normalize NSP messages into the existing event shape and broadcast only
  after database commit; ACK only after atomic event+dedup commit.
- Test duplicate retries, lost ACK, DB failures, restart, and HTTP/API/
  Socket.IO/dashboard compatibility.

## Phase 5 — First secure adapter acceptance milestone

- Verify authorized NSP telemetry arrives in SQLite and the existing
  dashboard.
- Verify unauthorized, invalid, replay-conflicting, and malformed input is
  not accepted or broadcast.
- Keep serial bridge/HTTP compatibility available and document security
  boundaries per deployment mode.

## Phases 6–10 — Extensions and release hardening

6. MQTT through a maintained client/broker with TLS/auth/ACL/topic/retained
   message/QoS behavior defined and tested.
7. Evaluate maintained CoAP implementation and explicitly choose UDP/DTLS or
   OSCORE; defer rather than shipping an insecure placeholder.
8. Add device registry and dashboard protocol/device/security views only with
   authenticated administrative authorization and sanitized output.
9. Run threat-driven tests, fuzzing, sanitizers, dependency review, migration
   recovery tests, secret audit, rate/connection limits, and backup/retention
   validation.
10. Build a repeatable benchmark harness and publish measured environment,
    raw results, limitations, and reproducible commands.

## Dependency and compatibility assessment

| Area | Decision / risk |
| --- | --- |
| Phase 2 C++ | Standard library only; require C++17 and CMake 3.20+; MSVC 2019 16.11+ and Linux compiler toolchain need verification |
| TLS | OpenSSL 3.x proposed for service phase only; verify licensing, supported platforms, TLS 1.3, maintenance/security advisories, and pin update process before adoption |
| CBOR | Deterministic CBOR per RFC 8949; evaluate a maintained C++ codec for strict canonical/schema checks before message-codec phase |
| MQTT | Choose a maintained MQTT library and broker topology later; no dependency until feature scope/security profile is decided |
| CoAP | Evaluate library and actual DTLS/OSCORE support later; no placeholder dependency |
| SQLite migration | Existing database has telemetry schema and 203 rows; preserve. Future migration must be additive, transactional, tested on a copy, and reversible or have a documented forward-recovery plan |
| Legacy ingress | Current route unauthenticated and compatible; hardening could break bridge clients, so production restriction/auth change requires explicit mode, migration plan, and regression tests |
| Device hardware | Hardware docs and current sketch disagree about board/sensors; confirm target before declaring embedded compatibility |
| Dashboard | Existing React routes are internal state views; no route framework, auth, or protocol status API exists; add UI only after a real sanitized API |
| Operations | No tests, CI, deployment, metrics, TLS service, certificate enrollment, or benchmark currently exists; do not imply readiness |

## Initial changed-scope rule

Phase 2 touches only `protocols/nsp/`, this documentation, the root README
vision/status section, and `.gitignore` for generated build output. It does
not edit Arduino firmware, Python bridge behavior, existing gateway routes,
dashboard behavior, or tracked SQLite files.
