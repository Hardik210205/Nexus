# Nexus - Universal IoT Gateway

## Complete project guide

This document explains the project's purpose, architecture, data flow, setup,
current behavior, limitations, and roadmap. It is intended for developers,
hardware engineers, testers, and reviewers who need to understand the system
without reading every source file first.

## 1. Project overview

Nexus is an edge-monitoring IoT prototype. It reads measurements from an
Arduino, sends them through a Python serial bridge to a Node.js gateway, and
displays live values in a React web dashboard.

The current demonstration measures:

- Temperature from a DHT11 sensor.
- Distance from an HC-SR04 ultrasonic sensor.
- Gateway and dashboard connectivity.
- A rolling chart of recent readings.
- A live event log.

The long-term goal is a protocol-agnostic gateway. Devices should be able to
communicate through serial, HTTP, MQTT, or CoAP while the rest of the
application consumes one stable internal message format.

> Current implementation and future roadmap are intentionally separated below.
> MQTT, CoAP, persistence, device management, rules, authentication, and
> production deployment are design goals, not complete features today.

## 2. Current implementation status

| Capability | Status |
| --- | --- |
| Arduino sensor firmware | Implemented |
| USB serial telemetry | Implebmented |
| Python serial-to-HTTP bridge | Implemented |
| Node.js HTTP ingestion | Implemented |
| Internal normalized message | Implemented |
| Socket.IO live broadcast | Implemented |
| React monitoring dashboard | Implemented |
| Persistent database | Not implemented |
| Authentication/authorization | Not implemented |
| MQTT adapter | Planned |
| CoAP adapter | Planned |
| Device registry/manager | Planned |
| Configurable rule engine | Planned |
| Production deployment | Not implemented |

The original architecture and implementation roadmap is in
[IoT_Project_SADD.pdf](doc/IoT_Project_SADD.pdf). Extracted text is available
in [pdf_output.txt](doc/pdf_output.txt).

## 3. Problem and architectural idea

IoT devices use different communication protocols. If the dashboard and
business logic understand every protocol directly, adding a new device
requires changes throughout the system.

Nexus separates protocol handling from application behavior:

1. The device reads physical sensors.
2. An adapter translates device data into HTTP.
3. The gateway validates and normalizes the message.
4. The gateway broadcasts the normalized message.
5. The dashboard renders the data without knowing how the device communicated.

The main architectural rule is:

> Protocol-specific logic belongs at the edge; the internal telemetry contract
> should remain stable.

## 4. System architecture

```text
┌─────────────────────┐
│ Arduino Uno         │
│ DHT11 + HC-SR04     │
└──────────┬──────────┘
           │ USB serial, 9600 baud
           │ newline-delimited JSON
           ▼
┌─────────────────────┐
│ serial_bridge.py    │
│ Python protocol     │
│ adapter             │
└──────────┬──────────┘
           │ POST /api/telemetry
           ▼
┌─────────────────────┐
│ gateway-core        │
│ Node.js + Express   │
│ validation + router │
└──────────┬──────────┘
           │ Socket.IO: telemetry_update
           ▼
┌─────────────────────┐
│ dashboard           │
│ React + Vite        │
│ live cards + chart  │
└─────────────────────┘
```

### 4.1 Arduino edge node

Source: [arduino_edge_node.ino](arduino_edge_node/arduino_edge_node.ino)

The Arduino firmware:

- Starts serial communication at `9600` baud.
- Reads the DHT11 data pin on `A1`.
- Uses digital pin `9` as the HC-SR04 trigger.
- Uses digital pin `10` as the HC-SR04 echo.
- Emits one JSON object every two seconds.

Example device message:

```json
{
  "deviceId": "uno_node_1",
  "type": "telemetry",
  "temperature": 24.5,
  "distance": 18.2
}
```

Sensor error values are part of the current device contract:

- `temperature: -999.0` means the DHT11 reading failed.
- `distance: -1.0` means the distance is unavailable or out of range.

The dashboard converts these sentinel values into display behavior. Invalid
temperature is charted as `0.0`; invalid distance is displayed as
`Out of Range`.

### 4.2 Python serial bridge

Source: [serial_bridge.py](serial_bridge.py)

The bridge is a protocol adapter. It:

1. Opens the configured serial port.
2. Waits for the Arduino reset sequence.
3. Reads complete newline-delimited frames.
4. Decodes UTF-8.
5. Parses JSON.
6. Sends valid JSON to the gateway with HTTP POST.
7. Logs malformed frames and connection failures.
8. Closes the port during graceful shutdown.

Current configuration is in the source file:

```python
SERIAL_PORT = "COM5"
BAUD_RATE = 9600
API_URL = "http://localhost:3000/api/telemetry"
```

Change `SERIAL_PORT` to the port assigned by the Arduino IDE. The Arduino
Serial Monitor must be closed while the bridge is running.

The bridge currently does not retry, buffer, or persist messages when the
gateway is unavailable.

### 4.3 Gateway core

Source: [server.js](iot-gateway/apps/gateway-core/server.js)

The gateway is an Express HTTP server with a Socket.IO server attached to the
same HTTP server. It:

- Accepts telemetry over HTTP.
- Requires `deviceId` and `type`.
- Creates a gateway-generated message ID.
- Adds source protocol and receive timestamp metadata.
- Broadcasts accepted messages to all connected dashboard clients.
- Returns the generated ID to the bridge.

The gateway listens on port `3000`.

### 4.4 Dashboard

Main source: [App.jsx](iot-gateway/apps/dashboard/src/App.jsx)

The React dashboard connects to `http://localhost:3000` using Socket.IO and
listens for `telemetry_update`.

It displays:

- Gateway online/offline status.
- Current temperature.
- Current distance.
- Sensor health.
- A dual-axis line chart with up to 25 readings.
- An in-memory event log with up to 30 entries.

The dashboard has no historical API or database integration yet. Refreshing
the page clears the chart and event log.

## 5. End-to-end data flow

1. The Arduino reads its sensors.
2. The Arduino prints one JSON line.
3. `serial_bridge.py` reads the line.
4. The bridge rejects invalid UTF-8 or invalid JSON.
5. The bridge posts valid JSON to `/api/telemetry`.
6. Express parses the request body.
7. The gateway validates required fields.
8. The gateway creates an internal message.
9. Socket.IO emits `telemetry_update`.
10. The dashboard updates its cards, chart, and log.
11. The gateway returns HTTP `200` and the internal message ID.

## 6. Data contracts

### 6.1 Device-to-gateway request

```http
POST http://localhost:3000/api/telemetry
Content-Type: application/json

{
  "deviceId": "uno_node_1",
  "type": "telemetry",
  "temperature": 24.5,
  "distance": 18.2
}
```

### 6.2 Successful HTTP response

```json
{
  "status": "success",
  "internalId": "gateway-generated-uuid"
}
```

### 6.3 Invalid request response

If `deviceId` or `type` is missing, the gateway returns HTTP `400`:

```json
{
  "error": "Invalid message format"
}
```

### 6.4 Normalized internal message

The gateway broadcasts this shape through Socket.IO:

```json
{
  "id": "gateway-generated-uuid",
  "source": {
    "deviceId": "uno_node_1",
    "protocol": "serial-bridge"
  },
  "type": "telemetry",
  "payload": {
    "temperature": 24.5,
    "distance": 18.2
  },
  "timestamp": "2026-10-13T06:27:34.345Z"
}
```

| Field | Meaning |
| --- | --- |
| `id` | UUID generated by the gateway |
| `source.deviceId` | Identity supplied by the device adapter |
| `source.protocol` | Adapter that delivered the message |
| `type` | Message category, currently `telemetry` |
| `payload.temperature` | DHT11 temperature |
| `payload.distance` | HC-SR04 distance |
| `timestamp` | Gateway receive time in ISO 8601 |

### 6.5 WebSocket event

The dashboard connects to:

```text
http://localhost:3000
```

The current event name is:

```text
telemetry_update
```

All connected clients receive every accepted message. Device-level filtering
and subscriptions are planned but not implemented.

## 7. Repository structure

```text
IoT_Project/
├── arduino_edge_node/
│   └── arduino_edge_node.ino       Arduino firmware
├── doc/
│   ├── Hardware.docx               Hardware notes
│   ├── IoT_Project_SADD.pdf        Architecture and roadmap
│   ├── pdf_output.txt              Extracted PDF text
│   ├── read_docx.py                Documentation helper
│   └── read_pdf.py                 Documentation helper
├── iot-gateway/
│   └── apps/
│       ├── gateway-core/
│       │   ├── package.json
│       │   └── server.js           Node.js gateway
│       └── dashboard/
│           ├── package.json
│           ├── index.html
│           ├── vite.config.js
│           └── src/
│               ├── App.jsx          Dashboard behavior
│               ├── App.css          Dashboard styling
│               ├── index.css        Global styling
│               └── main.jsx         React entry point
├── serial_bridge.py                Serial-to-HTTP adapter
└── README.md                       This guide
```

`node_modules` and build outputs are local artifacts and are excluded from
source control.

## 8. Hardware setup

| Component | Arduino connection |
| --- | --- |
| DHT11 data | `A1` |
| HC-SR04 trigger | Digital pin `9` |
| HC-SR04 echo | Digital pin `10` |
| Serial link | USB serial at `9600` baud |

Setup:

1. Install the Arduino IDE.
2. Install Adafruit's DHT sensor library.
3. Open the firmware file.
4. Select the correct board and COM port.
5. Upload the firmware.
6. Close the Arduino Serial Monitor before starting the bridge.

The firmware uses a blocking two-second loop. It is suitable for this
prototype, but not yet optimized for high-frequency or multi-device sampling.

## 9. Software setup and local run

### Prerequisites

- Python 3.
- Python packages `pyserial` and `requests`.
- Node.js and npm.
- Arduino hardware for the full hardware demonstration.

The repository does not currently include a Python dependency manifest. Install
the bridge dependencies in the Python environment you will use:

```powershell
python -m pip install pyserial requests
```

### Install gateway dependencies

```powershell
cd D:\IoT_Project\iot-gateway\apps\gateway-core
npm install
```

### Install dashboard dependencies

```powershell
cd D:\IoT_Project\iot-gateway\apps\dashboard
npm install
```

### Start the gateway

In terminal 1:

```powershell
cd D:\IoT_Project\iot-gateway\apps\gateway-core
npm start
```

The expected address is `http://localhost:3000`.

### Start the dashboard

In terminal 2:

```powershell
cd D:\IoT_Project\iot-gateway\apps\dashboard
npm run dev
```

Open the local URL printed by Vite, normally `http://localhost:5173`.

### Start the bridge

In terminal 3:

```powershell
cd D:\IoT_Project
python serial_bridge.py
```

Update `SERIAL_PORT` first if the Arduino is not on `COM5`.

### Test without hardware

The gateway can be tested independently:

```powershell
Invoke-RestMethod `
  -Uri http://localhost:3000/api/telemetry `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"deviceId":"test-device","type":"telemetry","temperature":23.4,"distance":42.1}'
```

With the dashboard open, the request should update the metrics, chart, and
event log.

## 10. Troubleshooting

### Serial communication error

- Confirm the Arduino is connected and powered.
- Confirm the COM port in `serial_bridge.py`.
- Close Arduino Serial Monitor and other serial tools.
- Confirm the baud rate is `9600`.
- Confirm the expected firmware is uploaded.

### Bridge cannot connect to gateway

- Start the gateway first.
- Confirm it is listening on port `3000`.
- Check whether another process owns port `3000`.
- Confirm `API_URL` in `serial_bridge.py`.

### Dashboard is offline

- Start the gateway.
- Confirm the dashboard uses `http://localhost:3000`.
- Check the browser console for Socket.IO errors.
- Check the gateway CORS configuration.

### No telemetry appears

- Confirm the bridge logs HTTP status `200`.
- Confirm the gateway logs processed telemetry.
- Confirm the JSON includes `deviceId` and `type`.
- Confirm the Arduino emits newline-terminated JSON.

### Sensor values look wrong

- `-999.0` indicates a DHT11 failure.
- `-1.0` indicates an invalid/out-of-range distance.
- Check wiring and sensor power.
- Check the pin definitions against the physical wiring.

## 11. Security and reliability

This is a local prototype and must not be exposed directly to the public
internet in its current form.

Current limitations:

- CORS allows any origin.
- There is no authentication or authorization.
- There is no rate limiting.
- Value types and ranges are not fully validated.
- There is no durable database or replay mechanism.
- The bridge drops messages while the gateway is unavailable.
- There is no queue or retry buffer.
- Every client receives every telemetry message.
- Configuration is hard-coded.
- TLS is not configured.
- There are no health, metrics, or readiness endpoints.
- Automated tests are not currently included.

Before production use, add:

1. Environment-based configuration.
2. Schema validation for all telemetry fields.
3. Authentication between adapters and gateway.
4. Restricted CORS origins.
5. TLS or a trusted reverse proxy.
6. Retry and buffering in the bridge.
7. Persistent storage and retention policies.
8. Per-device authorization and routing.
9. Health/readiness and observability endpoints.
10. Automated tests and CI checks.

## 12. Planned roadmap

The architecture roadmap describes these stages:

1. **Architecture design** - define protocol-independent boundaries.
2. **Core gateway** - receive and route messages.
3. **Internal message model** - normalize all protocols.
4. **Device manager** - track devices, capabilities, and state.
5. **MQTT adapter** - support publish/subscribe devices.
6. **HTTP adapter** - formalize HTTP device ingestion.
7. **CoAP adapter** - support constrained devices.
8. **WebSocket adapter** - stream updates to user interfaces.
9. **Rule engine** - trigger actions from telemetry conditions.
10. **Dashboard** - provide operational visibility.

The repository currently demonstrates the serial adapter, HTTP ingestion,
normalization, WebSocket delivery, and dashboard portions. The remaining
features are future work.

## 13. Recommended next steps

### Stabilize the contract

- Define JSON Schema for adapter input.
- Define JSON Schema for normalized messages.
- Decide units, precision, timestamps, identity, and error semantics.

### Improve configuration

- Move COM port, baud rate, gateway URL, port, and allowed origins to
  environment variables.
- Add an example configuration file without secrets.

### Add validation and tests

- Test invalid JSON and missing fields.
- Test valid HTTP ingestion.
- Test Socket.IO emission.
- Test dashboard handling of sensor error values.

### Add durability

- Add a database or time-series store.
- Persist devices and telemetry.
- Add retention and query APIs.
- Rehydrate the dashboard after refresh.

### Add protocol adapters

- Implement MQTT and CoAP adapters.
- Make every adapter produce the same normalized message.
- Keep protocol-specific code out of gateway business logic.

### Harden deployment

- Add authentication, authorization, TLS, rate limiting, and restricted CORS.
- Add health checks, structured logs, metrics, and graceful shutdown.
- Package the services with a documented deployment method.

## 14. Contributor principles

- Keep protocol handling in adapters.
- Keep normalization and routing in the gateway.
- Do not make the dashboard depend on Arduino or serial details.
- Preserve the internal telemetry shape when adding adapters.
- Treat sentinel values as explicit states, not normal measurements.
- Validate external input at the gateway boundary.
- Prefer configuration over hard-coded deployment values.
- Mark every feature as implemented, experimental, or planned.

## 15. Glossary

| Term | Meaning |
| --- | --- |
| Adapter | Translates one external protocol into the gateway contract |
| Arduino edge node | Microcontroller and attached sensors |
| Telemetry | Measurement or state report from a device |
| Gateway | Service that validates, normalizes, and routes messages |
| Internal message | Protocol-independent message created by the gateway |
| Socket.IO | Real-time transport used by the dashboard |
| Serial bridge | Python serial-to-HTTP adapter |
| Sentinel value | Reserved value for an unavailable or invalid reading |
| Dashboard | React live-monitoring interface |
| Rule engine | Planned telemetry evaluation and action component |

## 16. Source map

- Firmware: [arduino_edge_node.ino](arduino_edge_node/arduino_edge_node.ino)
- Serial adapter: [serial_bridge.py](serial_bridge.py)
- Gateway: [server.js](iot-gateway/apps/gateway-core/server.js)
- Gateway manifest: [gateway-core/package.json](iot-gateway/apps/gateway-core/package.json)
- Dashboard: [App.jsx](iot-gateway/apps/dashboard/src/App.jsx)
- Dashboard styles: [App.css](iot-gateway/apps/dashboard/src/App.css)
- Dashboard entry point: [main.jsx](iot-gateway/apps/dashboard/src/main.jsx)
- Dashboard manifest: [dashboard/package.json](iot-gateway/apps/dashboard/package.json)
- Hardware notes: [Hardware.docx](doc/Hardware.docx)
- Architecture roadmap: [IoT_Project_SADD.pdf](doc/IoT_Project_SADD.pdf)
