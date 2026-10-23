import struct
import unittest

from nsp_client import (
    MESSAGE_TELEMETRY,
    decode_cbor,
    encode_cbor,
    encode_frame,
    encode_telemetry_payload,
)


class NspWireTests(unittest.TestCase):
    def test_deterministic_cbor_round_trip(self):
        value = {
            0: "nexus.event",
            1: 1,
            2: "arhb_uno_1",
            3: bytes(range(16)),
            4: "road_hazard_motion",
            7: {"eventNumber": 12, "latitudeE7": 377749000, "gpsDate": None},
        }

        encoded = encode_cbor(value)

        self.assertEqual(decode_cbor(encoded), value)

    def test_rejects_noncanonical_and_trailing_cbor(self):
        with self.assertRaisesRegex(ValueError, "canonical"):
            decode_cbor(b"\x18\x01")
        with self.assertRaisesRegex(ValueError, "Trailing"):
            decode_cbor(b"\x00\x00")

    def test_gps_coordinates_are_encoded_as_integer_e7_values(self):
        payload = encode_telemetry_payload({
            "deviceId": "arhb_uno_1",
            "type": "telemetry",
            "eventType": "road_hazard_motion",
            "eventNumber": 12,
            "latitude": 37.7749,
            "longitude": -122.4194,
            "satellites": 8,
        })

        self.assertEqual(payload["latitudeE7"], 377749000)
        self.assertEqual(payload["longitudeE7"], -1224194000)
        self.assertNotIn("latitude", payload)
        self.assertNotIn("longitude", payload)

    def test_missing_gps_coordinates_remain_missing(self):
        payload = encode_telemetry_payload({
            "eventNumber": 13,
            "latitude": None,
            "longitude": None,
            "satellites": 0,
        })

        self.assertIsNone(payload["latitudeE7"])
        self.assertIsNone(payload["longitudeE7"])

    def test_frame_has_the_nsp_v1_fixed_header(self):
        message_id = bytes.fromhex("12345678123442348234123456789abc")
        frame = encode_frame(
            MESSAGE_TELEMETRY,
            1,
            encode_cbor({0: "nexus.event"}),
            message_id,
        )

        self.assertEqual(frame[:4], b"NSP\x00")
        self.assertEqual(frame[4:8], bytes([1, 0, MESSAGE_TELEMETRY, 1]))
        self.assertEqual(struct.unpack(">H", frame[8:10])[0], 32)
        self.assertEqual(frame[16:32], message_id)


if __name__ == "__main__":
    unittest.main()
