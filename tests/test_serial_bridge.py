import unittest

from serial_bridge import parse_event_line, parse_gps_status


class SerialBridgeParsingTests(unittest.TestCase):
    def test_event_with_gps_location_is_preserved(self):
        event, invalid_gps = parse_event_line(
            "EVENT,12,37.774900,-122.419400,7,2026-10-22,08:48:31"
        )

        self.assertFalse(invalid_gps)
        self.assertEqual(event["latitude"], 37.7749)
        self.assertEqual(event["longitude"], -122.4194)
        self.assertEqual(event["gpsDate"], "2026-10-22")

    def test_event_without_gps_is_still_forwardable(self):
        event, invalid_gps = parse_event_line("EVENT,13,,,0,,")

        self.assertFalse(invalid_gps)
        self.assertIsNone(event["latitude"])
        self.assertIsNone(event["longitude"])

    def test_invalid_coordinates_do_not_discard_motion_event(self):
        event, invalid_gps = parse_event_line("EVENT,14,91,181,4,,")

        self.assertTrue(invalid_gps)
        self.assertEqual(event["eventNumber"], 14)
        self.assertIsNone(event["latitude"])
        self.assertIsNone(event["longitude"])

    def test_malformed_event_is_rejected(self):
        with self.assertRaises(ValueError):
            parse_event_line("EVENT,not-a-number,,,0,,")

    def test_gps_status_is_validated(self):
        self.assertEqual(parse_gps_status("GPS_STATUS,FIX,8,READY"), ("FIX", 8, "READY"))
        self.assertEqual(
            parse_gps_status("GPS_STATUS,NO_DATA,0,ERROR"),
            ("NO_DATA", 0, "ERROR"),
        )
        self.assertEqual(
            parse_gps_status("GPS_STATUS,NO_DATA,0"),
            ("NO_DATA", 0, "UNKNOWN"),
        )
        self.assertIsNone(parse_gps_status("GPS_STATUS,UNKNOWN,0"))
        self.assertIsNone(parse_gps_status("GPS_STATUS,FIX,-1"))
        self.assertIsNone(parse_gps_status("GPS_STATUS,FIX,8,NOT_READY"))


if __name__ == "__main__":
    unittest.main()
