import serial
import json
import requests
import time
import sys

# Configure this to the exact COM port you see in your Arduino IDE!
SERIAL_PORT = 'COM5'
BAUD_RATE = 9600
API_URL = 'http://localhost:3000/api/telemetry' # Where we will send the Gateway Data

def main():
    print(f"[*] Starting Protocol Adapter (Serial -> HTTP)...")
    try:
        # Open serial connection
        ser = serial.Serial(SERIAL_PORT, BAUD_RATE, timeout=2)
        print(f"[*] Successfully connected to Arduino on {SERIAL_PORT}")
        print("[*] Listening for telemetry...\n")
        
        while True:
            # Check if there is data waiting to be read
            if ser.in_waiting > 0:
                # Read the line and decode it
                line = ser.readline().decode('utf-8').strip()
                if line:
                    print(f"[Arduino] {line}")
                    
                    try:
                        # Validate it's proper JSON
                        data = json.loads(line)
                        
                        # Forward the data to our future Gateway Core via HTTP POST
                        try:
                            response = requests.post(API_URL, json=data, timeout=3)
                            print(f"   -> [Gateway] Forwarded Data! Status HTTP {response.status_code}")
                            
                        except requests.exceptions.RequestException as e:
                            # If building the gateway, this is expected right now!
                            print(f"   -> [Gateway] Failed to connect: is your Node.js Gateway running on port 3000?")
                            
                    except json.JSONDecodeError:
                        print("   -> Ignored: Not valid JSON formatting")
                        
    except serial.SerialException as e:
        print(f"[!] Serial Communication Error: {e}")
        print("\n[!] CRITICAL FIX: Make sure the Serial Monitor inside the Arduino IDE is CLOSED before running this bridge script!")
    except KeyboardInterrupt:
        print("\n[*] Bridge shut down gracefully by user.")
    finally:
        if 'ser' in locals() and ser.is_open:
            ser.close()

if __name__ == '__main__':
    main()
