import math
import os
import time

from nsp_client import NspClient

SERIAL_PORT = os.environ.get("NEXUS_SERIAL_PORT", "COM3")
BAUD_RATE = 9600


def parse_event_line(line):
    fields = line.split(",")
    if len(fields) != 7 or fields[0] != "EVENT":
        raise ValueError("expected a seven-field EVENT record")

    event_number = int(fields[1])
    satellites = int(fields[4]) if fields[4] else 0
    latitude = None
    longitude = None

    if fields[2] and fields[3]:
        try:
            candidate_latitude = float(fields[2])
            candidate_longitude = float(fields[3])
            if (
                math.isfinite(candidate_latitude)
                and math.isfinite(candidate_longitude)
                and -90 <= candidate_latitude <= 90
                and -180 <= candidate_longitude <= 180
            ):
                latitude = candidate_latitude
                longitude = candidate_longitude
        except ValueError:
            pass

    event = {
        "deviceId": "arhb_uno_1",
        "type": "telemetry",
        "eventType": "road_hazard_motion",
        "eventNumber": event_number,
        "latitude": latitude,
        "longitude": longitude,
        "satellites": satellites,
        "gpsDate": fields[5] or None,
        "gpsTime": fields[6] or None
    }
    return event, bool(fields[2] or fields[3]) and latitude is None


def parse_gps_status(line):
    fields = line.split(",")
    if len(fields) not in {3, 4} or fields[0] != "GPS_STATUS":
        return None
    if fields[1] not in {"FIX", "NO_FIX", "NO_DATA"}:
        return None
    sensor_status = fields[3] if len(fields) == 4 else "UNKNOWN"
    if sensor_status not in {"UNKNOWN", "READY", "ERROR"}:
        return None

    try:
        satellites = int(fields[2])
    except ValueError:
        return None
    if satellites < 0:
        return None
    return fields[1], satellites, sensor_status


def report_serial_ports():
    from serial.tools import list_ports

    ports = list(list_ports.comports())
    if not ports:
        print("[!] No serial ports detected. Connect the Arduino and check its USB cable/driver.")
        return

    print("[*] Detected serial ports:")
    for port in ports:
        print(f"    {port.device}: {port.description}")


def main():
    import serial

    print("[*] Starting ARHB Serial Bridge...")
    nsp_client = None

    try:
        nsp_client = NspClient()
        with nsp_client:
            print("[*] NSP TLS 1.3/mTLS connection established")

            with serial.Serial(SERIAL_PORT, BAUD_RATE, timeout=2) as ser:
                print(f"[*] Connected to Arduino on {SERIAL_PORT}")

                # Arduino may reset when the serial port opens.
                time.sleep(2)
                ser.reset_input_buffer()

                print("[*] Waiting for ARHB events...\n")

                while True:
                    raw_line = ser.readline()

                    if not raw_line:
                        continue

                    try:
                        line = raw_line.decode("utf-8").strip()
                    except UnicodeDecodeError:
                        print("[!] Ignored invalid serial data")
                        continue

                    if not line:
                        continue

                    print(f"[Arduino] {line}")

                    if line == "ARHB_READY":
                        continue

                    gps_status = parse_gps_status(line)
                    if gps_status:
                        status, satellites, sensor_status = gps_status
                        if status == "FIX":
                            print(f"[GPS] Fix available ({satellites} satellites); locations attach to motion events.")
                        elif status == "NO_FIX":
                            print(f"[GPS] Receiver data received; waiting for a valid fix ({satellites} satellites).")
                        else:
                            print("[GPS] No NMEA data received. Check receiver power, common ground, TX to Arduino D4, and 9600 baud.")
                        try:
                            duplicate = nsp_client.send_device_status(
                                status,
                                satellites,
                                sensor_status=sensor_status,
                            )
                            if duplicate:
                                print("[NSP] GPS status acknowledged as a duplicate")
                        except (OSError, ValueError, ConnectionError) as exc:
                            print(f"[NSP] Could not deliver GPS status: {exc}")
                        continue

                    if line.startswith("GPS_STATUS,"):
                        print(f"[GPS] Unrecognized status from firmware: {line}")
                        continue

                    if not line.startswith("EVENT,"):
                        print("[!] Ignored: unexpected event format")
                        continue

                    try:
                        event, invalid_gps = parse_event_line(line)
                    except ValueError:
                        print("[!] Ignored: invalid event values")
                        continue
                    if invalid_gps:
                        print(f"[!] Event {event['eventNumber']} has invalid GPS coordinates; forwarding without location.")

                    try:
                        duplicate = nsp_client.send_telemetry(event)
                        result = "duplicate acknowledged" if duplicate else "durably acknowledged"
                        print(f"[Gateway] Event {event['eventNumber']} {result} over NSP")
                    except (OSError, ValueError, ConnectionError) as exc:
                        print(f"[NSP] Event {event['eventNumber']} was not acknowledged: {exc}")

    except serial.SerialException as exc:
        print(f"[!] Could not open serial port {SERIAL_PORT}: {exc}")
        report_serial_ports()
        print("[!] Set NEXUS_SERIAL_PORT to the Arduino's port and close Arduino Serial Monitor.")

    except (OSError, ValueError) as exc:
        print(f"[!] Could not establish secure NSP connection: {exc}")
        print("[!] Generate/configure the NSP certificates and start the gateway before starting the bridge.")

    except KeyboardInterrupt:
        print("\n[*] Bridge stopped.")
    finally:
        if nsp_client is not None:
            nsp_client.close()

if __name__ == "__main__":
    main()
