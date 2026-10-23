# Nexus Secure Protocol (NSP) — initial specification

**Status:** version 1.0 implementation profile for the local Python bridge and
Node.js gateway. The runtime includes TLS 1.3/mTLS, NSP framing, CBOR payload
validation, a single configured certificate identity, transactional
deduplication, and durable event acknowledgements. Dynamic device enrollment,
revocation, and production certificate lifecycle remain unimplemented. The
standalone C++ codec remains a separate frame implementation.

## 1. Purpose and layering

NSP is an application framing and message protocol for authenticated device
events. It does not replace IP, TCP, UDP, Ethernet, Wi-Fi, TLS, MQTT, or CoAP.
The initial profile runs NSP over TCP protected by TLS 1.3. MQTT and CoAP
remain separate protocol adapters feeding the same normalized event model.

The transport security baseline is TLS 1.3 (RFC 8446), with mutual TLS for the
initial device profile. The current gateway uses Node.js TLS. Require certificate
chain and hostname/identity validation and ALPN `nsp/1`; plaintext, TLS
versions below 1.3, unauthenticated fallback, and certificate-verification
disablement are forbidden. A server must fail startup if mandatory TLS
configuration is unavailable.

The Uno communicates with the Python bridge over its existing USB serial
connection. The TLS client certificate/private key is held by the bridge host,
not stored or processed by the Uno. The certificate URI identity is
`spiffe://nexus.local/device/arhb_uno_1`; a production-capable device would
need a separate enrollment identity and suitable key-storage hardware.

TLS protects a connection, not database effects. Application IDs, retry,
duplicate, authorization, and durable-ACK behavior are separately defined
below.

## 2. Version and negotiation

- Protocol identifier: ASCII `NSP`; wire magic is the four bytes `4E 53 50 00`
  (`NSP` followed by NUL).
- Major version: `1`. Minor version: `0`.
- Every frame includes major and minor version bytes.
- Major mismatch is fatal: close the TLS connection without interpreting the
  payload. The v1.0 codec accepts only minor version 0. Future minor versions
  may be additive only; their clients and servers must explicitly negotiate
  support before accepting them. Unknown non-critical extensions may be
  ignored by application logic; the current codec preserves their bytes.
- HELLO advertises an ordered list of supported `(major,minor)` pairs,
  capabilities, and client software information. The server selects exactly
  one supported pair in HELLO response/capability negotiation. The selected
  major/minor must match the enclosing frame version. Do not infer support
  from a client-supplied identity.
- The application exchange occurs only after TLS handshake and successful
  peer certificate validation. In a later service, the peer must map to an
  active device registry entry before telemetry is authorized.

## 3. Frame format

All multi-byte integers are unsigned big-endian (network byte order). No C/C++
native struct layout is transmitted. The fixed header is 32 bytes:

| Offset | Size | Field | Version 1.0 rule |
| --- | ---: | --- | --- |
| 0 | 4 | Magic | Exactly `NSP\0` |
| 4 | 1 | Major | `1` |
| 5 | 1 | Minor | `0` initially; negotiated extension rules apply |
| 6 | 1 | Message type | Registered values in §4 |
| 7 | 1 | Flags | Bit 0 `ACK_REQUIRED`; all other bits reserved and zero |
| 8 | 2 | Header length | 32–256 inclusive |
| 10 | 2 | Reserved | Must be zero |
| 12 | 4 | Payload length | 0–65,536 inclusive |
| 16 | 16 | Message ID | Nonzero 128-bit ID; opaque bytes |

Header extension bytes occupy `[32, header_length)`. Each extension is:
`type:u16`, `length:u16`, `value:length bytes`. Type bit 15 is the critical
bit; remaining 15 bits are the extension ID. Duplicate extension IDs are
invalid. Unknown non-critical extensions are skipped; unknown critical
extensions are rejected. A known extension must satisfy its registered
length and uniqueness requirements. No padding is required.

The payload immediately follows the header and is exactly `payload_length`
bytes. TCP reads may split or coalesce frames; transport code must implement
incremental assembly without allocating from an unchecked peer length.

Limits:

- Maximum header: 256 bytes.
- Maximum payload: 65,536 bytes.
- Maximum frame: 65,792 bytes.
- Maximum buffered, unprocessed bytes per connection: 131,584 bytes (two
  maximum frames); service must stop reading or reject/close before exceeding
  this limit.
- HELLO, AUTHENTICATION_RESULT, CAPABILITY_NEGOTIATION, ACKNOWLEDGEMENT,
  ERROR, HEARTBEAT, and GOODBYE payloads are limited to 4,096 bytes.
- A telemetry DEVICE_STATUS or PROTOCOL_EXTENSION payload must stay within the
  general payload limit and policy-defined schema limits.

Frame errors are fatal to the current connection: invalid magic, unsupported
major, invalid message type, bad reserved bits/flags, header outside bounds,
impossible/truncated lengths, duplicate/invalid extension, or resource limit
exceeded. Do not attempt stream resynchronization on arbitrary untrusted data.
When the frame is trustworthy enough to respond, the service may return a
sanitized ERROR category before closing; malformed/untrusted text and secret
material are not echoed.

## 4. Message registry and session state

Message type numbers:

| Value | Name | Valid state | Purpose / status |
| ---: | --- | --- | --- |
| `0x01` | HELLO | TLS established, before app negotiation | Version/capability offer |
| `0x02` | AUTHENTICATION_RESULT | Server → client after identity check | Sanitized result; no credential material |
| `0x03` | CAPABILITY_NEGOTIATION | HELLO exchange | Select version/features |
| `0x10` | TELEMETRY | Authenticated and authorized | Event submission |
| `0x11` | ACKNOWLEDGEMENT | Authenticated session | Durable or duplicate event result |
| `0x12` | ERROR | Any established NSP application state | Sanitized error code |
| `0x13` | HEARTBEAT | Authenticated session | Liveness; not telemetry |
| `0x14` | GOODBYE | Authenticated session | Graceful close |
| `0x15` | DEVICE_STATUS | Authenticated and authorized | Device status report |
| `0x16` | CONFIGURATION_UPDATE | Reserved / disabled | No configuration mutation in v1 |
| `0x7F` | PROTOCOL_EXTENSION | Negotiated extension only | Explicitly registered extensions |

A client sends HELLO once. The server responds with negotiated capabilities
and authentication result. Telemetry and device status before authenticated
authorization are rejected and never ingested. ACK, heartbeat, error, and
goodbye are control messages; ACK_REQUIRED is valid only for TELEMETRY and
DEVICE_STATUS. Unregistered message types are fatal. CONFIGURATION_UPDATE is
not enabled by registration and must not become executable solely because a
type number is reserved.

State transitions:

```text
TCP connected -> TLS 1.3 + mTLS verified -> HELLO/version negotiation
  -> identity active + capability authorized -> application session
  -> GOODBYE or timeout/error -> closed
```

Interrupted TLS/HELLO exchanges close without application ingestion. An
authentication/policy failure must never fall back to serial identity,
anonymous, plaintext, or a weaker certificate profile.

## 5. Payload encoding and common envelope

Payloads use deterministic CBOR as specified by RFC 8949 §4.2. The wire
envelope is a CBOR map with integer keys to avoid text-key ambiguity and reduce
overhead. Receivers reject indefinite-length items, duplicate keys, invalid
UTF-8 in text, trailing bytes, excess nesting, excessive map/array entries,
and non-deterministic encodings for signed/canonical comparisons. The
application payload remains separate from this envelope.

Common envelope keys:

| Key | Required | Value |
| ---: | --- | --- |
| `0` | yes | Text `nexus.event` |
| `1` | yes | Unsigned schema version (`1` initially) |
| `2` | yes | Device identity text; must exactly match authenticated registry identity |
| `3` | yes | 16-byte application event ID |
| `4` | yes | Message/event type text from the authorized registry |
| `5` | optional | Device timestamp text in RFC 3339 UTC form, or null |
| `6` | optional | 16-byte correlation/trace ID |
| `7` | yes | Application payload map |

Gateway receive time is assigned by the gateway; it is not trusted from the
device. The event model maps to the existing app as `id` (gateway event ID),
`source.deviceId` (authenticated identity), `source.protocol` (`nsp`),
`type`, `eventType`, `payload`, and `timestamp` (gateway UTC receive time).

The standalone C++ frame core treats payload bytes as opaque. The running
Node.js NSP service parses deterministic CBOR and validates the event/status
envelope before ingestion.

The current telemetry payload contains `eventNumber`, `satellites`,
`latitudeE7`, `longitudeE7`, `gpsDate`, and `gpsTime`. Coordinates are signed
integer degrees multiplied by ten million (or both null when unavailable);
the gateway converts them into the existing JSON latitude/longitude fields.
Device status uses the `device_status` event type and a payload containing
`status` (`FIX`, `NO_FIX`, or `NO_DATA`), `satellites`, and optional
`sensorStatus` (`UNKNOWN`, `READY`, or `ERROR`); `READY` means the firmware
initialized the MPU6050 and recently read a valid sample. Status heartbeats
update the gateway's in-memory device-status record and are broadcast to the
dashboard; they are not durable telemetry events.

The active local exchange uses integer-keyed maps: HELLO key `0` is
`nexus.hello`, key `1` lists offered `[major,minor]` pairs, and key `2` lists
message types. AUTHENTICATION_RESULT returns key `0` success and key `1` the
authenticated identity. CAPABILITY_NEGOTIATION returns selected major/minor
at keys `0`/`1` and enabled message names at key `2`. A telemetry ACK has key
`0` = `nexus.ack`, key `1` = application event ID, key `2` = stable gateway
event ID, and key `3` = duplicate flag.

## 6. Message IDs, retries, ACKs, and deduplication

The 16-byte frame message ID identifies one NSP frame. The envelope event ID
identifies one logical telemetry event and remains unchanged across retries.
They are distinct. A reconnect/retry gets a new frame message ID but retains
the event ID.

Clients generate event IDs with a cryptographically secure random UUIDv4 (or
another registered 128-bit unique ID scheme). The current Arduino counter
resets and MUST NOT be treated as globally unique. The bridge generates the
event ID once per parsed input and retains it across its bounded in-memory
retry; restarting the bridge before durable queueing can still lose an event.

For telemetry with ACK_REQUIRED:

1. Authenticate and authorize the device and event type.
2. Validate the frame, CBOR, identity binding, and event schema.
3. In one SQLite transaction, insert the telemetry event and unique
   `(authenticated_device_id,event_id)` deduplication record.
4. Commit, then send ACK with the result and stable event reference.
5. On a duplicate key with identical accepted identity, return a duplicate ACK
   referencing the original event; do not reinsert or rebroadcast.
6. A mismatched identity or conflicting event content under an existing ID is
   rejected and audited without exposing other device data.
7. On transaction failure, send no success ACK and do not broadcast.

ACK does not mean a browser rendered the event or that every client received
Socket.IO delivery. Retry is at-least-once transmission with idempotent effects
within the database transaction and dedup retention window. It is not
end-to-end exactly-once delivery. Retention/cleanup and behavior for retries
after expiry must be specified before service rollout.

## 7. Errors and resource policy

Error payloads contain a registered numeric category, retryability flag, and
optional correlation ID. They do not echo raw payload, credentials, private
certificate data, or TLS internals. Authentication failure, authorization
denial, malformed frame, unsupported version, rate/limit rejection,
duplicate/conflict, and persistence failure are distinguishable to operators
through sanitized logs, not necessarily to unauthenticated peers.

The runtime enforces 128 concurrent connections, a 5-second TLS/HELLO
handshake timeout, a 60-second idle timeout, a bounded pending-processing
queue, and the per-frame/per-connection byte limits in §3. Rate limits and
production capacity measurements remain outstanding.

## 8. TLS credentials and lifecycle

Development certificates are generated locally using the repository's
development-only helper and private CA. Production device certificates are
provisioned out of band.
The device registry stores identity, certificate metadata/fingerprint,
enabled/revoked status, protocol and message permissions, timestamps, and
policy—not private keys or plaintext shared secrets.

Rotate server/device certificates with overlap for trust anchors as needed.
Revoke a device by preventing new handshakes and closing its active sessions
through a revocation notification or bounded revalidation. The exact CRL/OCSP
or short-lived certificate policy remains a deployment decision. Never
silently substitute a shared unauthenticated profile for a certificate that
cannot be validated.

## 9. Compatibility and conformance

The legacy HTTP endpoints, SQLite telemetry table, event-history response,
Socket.IO `telemetry_update`, and dashboard are outside the NSP wire protocol
and remain compatibility requirements. Serial input remains newline-delimited
CSV. NSP must enter through a separate authenticated adapter/service.

The gateway tests exercise TLS 1.3/mTLS and ALPN, NSP negotiation, event
acknowledgements, duplicate delivery, and rejection of clients without a
trusted certificate. Full production conformance still requires expired/wrong
CA and wrong identity tests, fuzzing, revocation behavior, load limits, and
durable-queue/restart tests. The C++ codec alone does not confer transport
security, identity, authorization, or deployment readiness.
