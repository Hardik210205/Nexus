const express = require('express');
const crypto = require('crypto');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors()); // Allow frontend to fetch/send data

// Create HTTP server (needed for Socket.IO)
const server = http.createServer(app);

// Phase 8: WebSocket Adapter
const io = new Server(server, {
    cors: {
        origin: "*", // Allow any frontend dashboard to connect for now
        methods: ["GET", "POST"]
    }
});

io.on('connection', (socket) => {
    console.log(`[WEBSOCKET] 🔌 Dashboard Client connected: ${socket.id}`);
    
    socket.on('disconnect', () => {
        console.log(`[WEBSOCKET] ❌ Dashboard Client disconnected: ${socket.id}`);
    });
});


// Implementation of Phase 6 (HTTP Adapter) & Phase 2 (Gateway Receive)
app.post('/api/telemetry', (req, res) => {
    const rawMessage = req.body;
    
    // Core Gateway Validation
    if(!rawMessage.deviceId || !rawMessage.type) {
        return res.status(400).json({ error: "Invalid message format" });
    }
    
    // Implementation of Phase 3 (Internal Message Model)
    const internalMessage = {
        id: crypto.randomUUID(), 
        source: {
            deviceId: rawMessage.deviceId,
            protocol: "serial-bridge" 
        },
        type: rawMessage.type, 
        payload: {
            temperature: rawMessage.temperature,
            distance: rawMessage.distance
        },
        timestamp: new Date().toISOString()
    };
    
    console.log(`[GATEWAY] 🚀 Processed telemetry from ${rawMessage.deviceId}`);
    
    // Phase 9: Routing/Rule Engine (Simple Version)
    // Here we broadcast the internal message out to all connected Dashboard clients!
    io.emit('telemetry_update', internalMessage);
    
    res.status(200).json({ status: "success", internalId: internalMessage.id });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`🚀 Phase 2 Gateway Core & Phase 8 WebSocket Adapter running on http://localhost:${PORT}`);
    console.log(`Listening for incoming connections...`);
});
