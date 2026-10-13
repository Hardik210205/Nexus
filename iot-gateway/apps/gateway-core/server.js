
const express = require('express');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

// Persistent SQLite database stored beside server.js
const dbPath = path.join(__dirname, 'arhb_events.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

db.exec(`
    CREATE TABLE IF NOT EXISTS telemetry_events (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        event_type TEXT,
        message_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        timestamp TEXT NOT NULL
    )
`);

const insertEvent = db.prepare(`
    INSERT INTO telemetry_events
    (id, device_id, event_type, message_type, payload_json, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
`);

io.on('connection', (socket) => {
    console.log(`[WEBSOCKET] Dashboard connected: ${socket.id}`);

    socket.on('disconnect', () => {
        console.log(`[WEBSOCKET] Dashboard disconnected: ${socket.id}`);
    });
});

// Receive telemetry from the Python serial bridge
app.post('/api/telemetry', (req, res) => {
    const rawMessage = req.body;

    if (
        !rawMessage ||
        typeof rawMessage.deviceId !== 'string' ||
        !rawMessage.deviceId.trim() ||
        typeof rawMessage.type !== 'string' ||
        !rawMessage.type.trim()
    ) {
        return res.status(400).json({
            error: 'Invalid message format: deviceId and type are required'
        });
    }

    const {
        deviceId,
        type,
        eventType,
        ...payload
    } = rawMessage;

    const internalMessage = {
        id: crypto.randomUUID(),
        source: {
            deviceId,
            protocol: 'serial-bridge'
        },
        type,
        payload,
        timestamp: new Date().toISOString()
    };

    try {
        // Save to SQLite before reporting success
        insertEvent.run(
            internalMessage.id,
            deviceId,
            eventType || null,
            type,
            JSON.stringify(payload),
            internalMessage.timestamp
        );

        console.log(
            `[DATABASE] Saved event ${internalMessage.id} from ${deviceId}`
        );

        // Notify connected dashboards after the database save
        io.emit('telemetry_update', internalMessage);

        return res.status(201).json({
            status: 'success',
            internalId: internalMessage.id,
            stored: true
        });
    } catch (error) {
        console.error('[DATABASE] Failed to save event:', error);

        return res.status(500).json({
            error: 'Failed to store telemetry event'
        });
    }
});

// Retrieve saved events, newest first
app.get('/api/events', (req, res) => {
    try {
        const requestedLimit = Number.parseInt(req.query.limit, 10);
        const limit = Number.isInteger(requestedLimit)
            ? Math.min(Math.max(requestedLimit, 1), 500)
            : 100;

        const rows = db.prepare(`
            SELECT id, device_id, event_type, message_type,
                   payload_json, timestamp
            FROM telemetry_events
            ORDER BY timestamp DESC
            LIMIT ?
        `).all(limit);

        const events = rows.map((row) => ({
            id: row.id,
            source: {
                deviceId: row.device_id,
                protocol: 'serial-bridge'
            },
            type: row.message_type,
            eventType: row.event_type,
            payload: JSON.parse(row.payload_json),
            timestamp: row.timestamp
        }));

        res.json({
            count: events.length,
            events
        });
    } catch (error) {
        console.error('[DATABASE] Failed to retrieve events:', error);
        res.status(500).json({ error: 'Failed to retrieve events' });
    }
});

// Basic health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        database: 'connected'
    });
});

const PORT = 3000;

server.listen(PORT, () => {
    console.log(`Gateway running at http://localhost:${PORT}`);
    console.log(`SQLite database: ${dbPath}`);
    console.log('Event history endpoint: http://localhost:3000/api/events');
});
