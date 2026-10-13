import serial
import requests
import time
import json

SERIAL_PORT = "COM5"  # Change this to your Arduino's actual COM port
BAUD_RATE = 9600
API_URL = "http://localhost:3000/api/telemetry"

def main():
    print("[*] Starting ARHB Serial Bridge...")

    try:
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

                fields = line.split(",")

                if len(fields) != 7 or fields[0] != "EVENT":
                    print("[!] Ignored: unexpected event format")
                    continue

                try:
                    event = {
                        "deviceId": "arhb_uno_1",
                        "type": "telemetry",
                        "eventType": "road_hazard_motion",
                        "eventNumber": int(fields[1]),
                        "latitude": float(fields[2]) if fields[2] else None,
                        "longitude": float(fields[3]) if fields[3] else None,
                        "satellites": int(fields[4]) if fields[4] else 0,
                        "gpsDate": fields[5] or None,
                        "gpsTime": fields[6] or None
                    }
                except ValueError:
                    print("[!] Ignored: invalid event values")
                    continue

                try:
                    response = requests.post(
                        API_URL,
                        json=event,
                        timeout=5
                    )

                    if response.ok:
                        print(
                            f"[Gateway] Event {event['eventNumber']} "
                            "forwarded successfully"
                        )
                    else:
                        print(
                            f"[Gateway] HTTP {response.status_code}: "
                            f"{response.text[:200]}"
                        )

                except requests.RequestException as exc:
                    print(f"[Gateway] Request failed: {exc}")

    except serial.SerialException as exc:
        print(f"[!] Serial error: {exc}")
        print("[!] Check the COM port and close Arduino Serial Monitor.")

    except KeyboardInterrupt:
        print("\n[*] Bridge stopped.")

if __name__ == "__main__":
    main()
