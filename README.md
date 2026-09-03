# Nexus - Universal IoT Gateway 🚀

An end-to-end IoT platform implementing a highly decoupled "Universal Gateway" architecture. This project reads live hardware sensors via an edge node, bridges the data across a Serial-to-HTTP proxy, normalizes it through a Node.js Core API Gateway, and visualizes it onto a premium Real-Time React Dashboard.

## Architecture Pipeline ⚙️

1. **Edge Node (Arduino)**: Reads DHT11 (Temperature) and HC-SR04 (Ultrasonic Proximity). Performs initial hardware filtering and JSON serialization.
2. **Serial Bridge (Python)**: Captures UART metrics and acts as a gateway transport proxy, injecting the telemetry into the API.
3. **Gateway Core (Node.js/Express)**: Normalizes incoming payloads into a strict "Internal Message Format" and broadcasts cross-platform updates over WebSockets.
4. **Dashboard (React/Vite)**: A modern, real-time GUI implementing Socket.IO and Recharts to visualize environmental metrics dynamically.

## Quick Start 🏎️

### 1. Hardware Setup (Arduino)
Flash `arduino_edge_node/arduino_edge_node.ino` to your Arduino Uno. Connect your DHT11 output to `A0` and Ultrasonic Trig/Echo to `9` & `10`.

### 2. Start the Gateway Core
```bash
cd iot-gateway/apps/gateway-core
npm install
npm run start
```
*Runs on `http://localhost:3000`*

### 3. Start the React Dashboard
```bash
cd iot-gateway/apps/dashboard
npm install
npm run dev
```
*Runs on `http://localhost:5173`*

### 4. Boot the Bridge
Make sure your Arduino IDE Serial Monitor is closed!
```bash
python serial_bridge.py
```

## Stack 🛠️
* **Hardware:** C++ (Arduino)
* **Bridge:** Python (`pyserial`, `requests`)
* **Backend:** Node.js, Express, Socket.IO
* **Frontend:** React, Vite, Recharts, Lucide-React
