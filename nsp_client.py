import os
import socket
import ssl
import struct
import time
import uuid
from pathlib import Path


MESSAGE_HELLO = 0x01
MESSAGE_AUTHENTICATION_RESULT = 0x02
MESSAGE_CAPABILITY_NEGOTIATION = 0x03
MESSAGE_TELEMETRY = 0x10
MESSAGE_ACKNOWLEDGEMENT = 0x11
MESSAGE_ERROR = 0x12
MESSAGE_DEVICE_STATUS = 0x15
ACK_REQUIRED = 0x01
MAXIMUM_PAYLOAD_LENGTH = 65536


def _encode_length(major, value):
    if value < 24:
        return bytes([(major << 5) | value])
    if value <= 0xFF:
        return bytes([(major << 5) | 24, value])
    if value <= 0xFFFF:
        return bytes([(major << 5) | 25]) + struct.pack(">H", value)
    if value <= 0xFFFFFFFF:
        return bytes([(major << 5) | 26]) + struct.pack(">I", value)
    if value <= 0xFFFFFFFFFFFFFFFF:
        return bytes([(major << 5) | 27]) + struct.pack(">Q", value)
    raise ValueError("CBOR integer is too large")


def encode_cbor(value):
    if value is None:
        return b"\xf6"
    if value is False:
        return b"\xf4"
    if value is True:
        return b"\xf5"
    if isinstance(value, bytes):
        return _encode_length(2, len(value)) + value
    if isinstance(value, str):
        encoded = value.encode("utf-8")
        return _encode_length(3, len(encoded)) + encoded
    if isinstance(value, int):
        if value >= 0:
            return _encode_length(0, value)
        return _encode_length(1, -1 - value)
    if isinstance(value, float):
        if not (float("-inf") < value < float("inf")):
            raise ValueError("CBOR float must be finite")
        return b"\xfb" + struct.pack(">d", value)
    if isinstance(value, (list, tuple)):
        return _encode_length(4, len(value)) + b"".join(encode_cbor(item) for item in value)
    if isinstance(value, dict):
        entries = [(encode_cbor(key), encode_cbor(item)) for key, item in value.items()]
        entries.sort(key=lambda entry: (len(entry[0]), entry[0]))
        return _encode_length(5, len(entries)) + b"".join(
            encoded_key + encoded_item for encoded_key, encoded_item in entries
        )
    raise TypeError(f"Unsupported CBOR value: {type(value).__name__}")


def decode_cbor(data):
    offset = 0

    def read_length(additional):
        nonlocal offset
        if additional < 24:
            return additional
        widths = {24: 1, 25: 2, 26: 4, 27: 8}
        width = widths.get(additional)
        if width is None or offset + width > len(data):
            raise ValueError("Malformed or truncated CBOR length")
        value = int.from_bytes(data[offset:offset + width], "big")
        offset += width
        if value < {1: 24, 2: 0x100, 4: 0x10000, 8: 0x100000000}[width]:
            raise ValueError("Non-canonical CBOR integer")
        return value

    def read_value(depth=0):
        nonlocal offset
        if depth > 8 or offset >= len(data):
            raise ValueError("Truncated or deeply nested CBOR value")
        initial = data[offset]
        offset += 1
        major, additional = initial >> 5, initial & 0x1F
        if major == 7:
            if initial == 0xF4:
                return False
            if initial == 0xF5:
                return True
            if initial == 0xF6:
                return None
            if initial == 0xFB:
                if offset + 8 > len(data):
                    raise ValueError("Truncated CBOR float")
                value = struct.unpack(">d", data[offset:offset + 8])[0]
                offset += 8
                if not (float("-inf") < value < float("inf")):
                    raise ValueError("CBOR float must be finite")
                return value
            raise ValueError("Unsupported CBOR simple value")

        length = read_length(additional)
        if major == 0:
            return length
        if major == 1:
            return -1 - length
        if major in (2, 3):
            if length > len(data) - offset:
                raise ValueError("Truncated CBOR string")
            value = data[offset:offset + length]
            offset += length
            return value if major == 2 else value.decode("utf-8")
        if major == 4:
            if length > 256:
                raise ValueError("CBOR array exceeds supported limit")
            return [read_value(depth + 1) for _ in range(length)]
        if major == 5:
            if length > 256:
                raise ValueError("CBOR map exceeds supported limit")
            result = {}
            for _ in range(length):
                key = read_value(depth + 1)
                if key in result:
                    raise ValueError("Duplicate CBOR map key")
                result[key] = read_value(depth + 1)
            return result
        raise ValueError("Unsupported CBOR value")

    value = read_value()
    if offset != len(data):
        raise ValueError("Trailing bytes after CBOR value")
    if encode_cbor(value) != data:
        raise ValueError("CBOR value is not deterministic")
    return value


def encode_frame(message_type, flags, payload, message_id=None):
    if len(payload) > MAXIMUM_PAYLOAD_LENGTH:
        raise ValueError("NSP payload is too large")
    message_id = message_id or uuid.uuid4().bytes
    if len(message_id) != 16 or not any(message_id):
        raise ValueError("NSP message ID must be a non-zero 16-byte value")
    header = struct.pack(
        ">4sBBBBHHI16s",
        b"NSP\x00",
        1,
        0,
        message_type,
        flags,
        32,
        0,
        len(payload),
        message_id,
    )
    return header + payload


def encode_telemetry_payload(event):
    payload = {
        key: value
        for key, value in event.items()
        if key not in {"deviceId", "type", "eventType", "latitude", "longitude"}
    }
    latitude = event.get("latitude")
    longitude = event.get("longitude")
    payload["latitudeE7"] = round(latitude * 1e7) if latitude is not None else None
    payload["longitudeE7"] = round(longitude * 1e7) if longitude is not None else None
    return payload


def _read_exact(connection, length):
    chunks = bytearray()
    while len(chunks) < length:
        chunk = connection.recv(length - len(chunks))
        if not chunk:
            raise ConnectionError("NSP peer closed the TLS connection")
        chunks.extend(chunk)
    return bytes(chunks)


def _read_frame(connection):
    header = _read_exact(connection, 32)
    magic, major, minor, message_type, flags, header_length, reserved, payload_length, message_id = (
        struct.unpack(">4sBBBBHHI16s", header)
    )
    if (
        magic != b"NSP\x00"
        or major != 1
        or minor != 0
        or reserved != 0
        or header_length != 32
        or not any(message_id)
        or payload_length > MAXIMUM_PAYLOAD_LENGTH
        or message_type not in {
            MESSAGE_AUTHENTICATION_RESULT,
            MESSAGE_CAPABILITY_NEGOTIATION,
            MESSAGE_ACKNOWLEDGEMENT,
            MESSAGE_ERROR,
        }
        or flags != 0
        or payload_length > 4096
    ):
        raise ValueError("Invalid NSP response frame")
    payload = _read_exact(connection, payload_length)
    return message_type, flags, decode_cbor(payload)


class NspClient:
    def __init__(self):
        profile = os.environ.get("NEXUS_NSP_PROFILE", "production")
        if profile not in {"development", "production"}:
            raise ValueError("NEXUS_NSP_PROFILE must be development or production")
        certificate_directory = os.environ.get("NEXUS_NSP_CERT_DIR")
        if certificate_directory is None and profile == "development":
            certificate_directory = Path(__file__).resolve().parent / ".local" / "nsp-certs"
        if certificate_directory is None and not all(os.environ.get(name) for name in (
            "NEXUS_NSP_CA",
            "NEXUS_NSP_CLIENT_CERT",
            "NEXUS_NSP_CLIENT_KEY",
        )):
            raise ValueError(
                "Production requires NEXUS_NSP_CA, NEXUS_NSP_CLIENT_CERT, "
                "and NEXUS_NSP_CLIENT_KEY, or an explicit NEXUS_NSP_CERT_DIR"
            )
        certificate_directory = Path(certificate_directory) if certificate_directory else None
        self.host = os.environ.get("NEXUS_NSP_HOST", "localhost")
        self.port = int(os.environ.get("NEXUS_NSP_PORT", "3443"))
        self.device_id = os.environ.get("NEXUS_NSP_DEVICE_ID", "arhb_uno_1")
        ca_file = os.environ.get(
            "NEXUS_NSP_CA",
            certificate_directory / "ca-cert.pem" if certificate_directory else None,
        )
        cert_file = os.environ.get(
            "NEXUS_NSP_CLIENT_CERT",
            certificate_directory / "device-cert.pem" if certificate_directory else None,
        )
        key_file = os.environ.get(
            "NEXUS_NSP_CLIENT_KEY",
            certificate_directory / "device-key.pem" if certificate_directory else None,
        )
        if not ca_file or not cert_file or not key_file:
            raise ValueError("All NSP CA, client certificate, and private key files are required")
        self.context = ssl.create_default_context(ssl.Purpose.SERVER_AUTH, cafile=str(ca_file))
        self.context.minimum_version = ssl.TLSVersion.TLSv1_3
        self.context.maximum_version = ssl.TLSVersion.TLSv1_3
        self.context.set_alpn_protocols(["nsp/1"])
        self.context.load_cert_chain(certfile=str(cert_file), keyfile=str(key_file))
        self.connection = None

    def connect(self):
        if self.connection is not None:
            return
        raw_connection = socket.create_connection((self.host, self.port), timeout=5)
        try:
            self.connection = self.context.wrap_socket(
                raw_connection,
                server_hostname=self.host,
            )
            self.connection.settimeout(5)
            if self.connection.selected_alpn_protocol() != "nsp/1":
                raise ssl.SSLError("Gateway did not negotiate NSP ALPN")
            hello = encode_cbor({
                0: "nexus.hello",
                1: [[1, 0]],
                2: [MESSAGE_TELEMETRY, MESSAGE_DEVICE_STATUS],
            })
            self.connection.sendall(encode_frame(MESSAGE_HELLO, 0, hello))
            message_type, _, result = _read_frame(self.connection)
            if (
                message_type != MESSAGE_AUTHENTICATION_RESULT
                or result.get(0) is not True
                or result.get(1) != self.device_id
            ):
                raise ConnectionError("NSP gateway rejected client authentication")
            message_type, _, selection = _read_frame(self.connection)
            if (
                message_type != MESSAGE_CAPABILITY_NEGOTIATION
                or selection.get(0) != 1
                or selection.get(1) != 0
            ):
                raise ConnectionError("NSP gateway selected an unsupported protocol version")
            print(f"[NSP] TLS 1.3 mutual authentication established for {self.device_id}")
        except Exception:
            self.close()
            raise

    def _send_message(self, message_type, event_type, payload, event_id=None):
        event_id = event_id or uuid.uuid4().bytes
        if isinstance(event_id, uuid.UUID):
            event_id = event_id.bytes
        if not isinstance(event_id, bytes) or len(event_id) != 16 or not any(event_id):
            raise ValueError("Application event ID must be a non-zero 16-byte value")
        envelope = encode_cbor({
            0: "nexus.event",
            1: 1,
            2: self.device_id,
            3: event_id,
            4: event_type,
            7: payload,
        })
        last_error = None
        for attempt in range(2):
            try:
                self.connect()
                self.connection.sendall(encode_frame(message_type, ACK_REQUIRED, envelope))
                response_type, _, acknowledgement = _read_frame(self.connection)
                if response_type == MESSAGE_ERROR:
                    raise ConnectionError("NSP gateway rejected the message")
                if (
                    response_type != MESSAGE_ACKNOWLEDGEMENT
                    or acknowledgement.get(0) != "nexus.ack"
                    or acknowledgement.get(1) != event_id
                ):
                    raise ConnectionError("NSP gateway returned an invalid acknowledgement")
                return acknowledgement.get(3) is True
            except (OSError, ssl.SSLError, ValueError, ConnectionError) as error:
                last_error = error
                self.close()
                if attempt == 0:
                    time.sleep(0.25)
        raise ConnectionError(f"NSP message was not acknowledged: {last_error}") from last_error

    def send_telemetry(self, event, event_id=None):
        return self._send_message(
            MESSAGE_TELEMETRY,
            "road_hazard_motion",
            encode_telemetry_payload(event),
            event_id,
        )

    def send_device_status(self, status, satellites, event_id=None, sensor_status="UNKNOWN"):
        if sensor_status not in {"UNKNOWN", "READY", "ERROR"}:
            raise ValueError("Sensor status must be UNKNOWN, READY, or ERROR")
        return self._send_message(
            MESSAGE_DEVICE_STATUS,
            "device_status",
            {
                "status": status,
                "satellites": satellites,
                "sensorStatus": sensor_status,
            },
            event_id,
        )

    def close(self):
        if self.connection is not None:
            try:
                self.connection.close()
            finally:
                self.connection = None

    def __enter__(self):
        self.connect()
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.close()
