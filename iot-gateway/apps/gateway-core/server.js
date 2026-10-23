
const express = require('express');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { Server } = require('socket.io');
const { createNspServer } = require('./nsp-server');

const app = express();
app.use(express.json());

const server = http.createServer(app);
const dashboardOrigins = [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:4173',
    'http://127.0.0.1:4173'
];

const io = new Server(server, {
    cors: {
        origin: dashboardOrigins,
        methods: ['GET', 'POST']
    },
    allowRequest: (request, callback) => {
        callback(null, dashboardOrigins.includes(request.headers.origin));
    }
});

// Persistent SQLite database stored beside server.js
const dbPath = process.env.NEXUS_DB_PATH
    ? path.resolve(process.env.NEXUS_DB_PATH)
    : path.join(__dirname, 'arhb_events.db');
const db = new DatabaseSync(dbPath);
const nspProfile = process.env.NEXUS_NSP_PROFILE || 'production';
if (!['development', 'production'].includes(nspProfile)) {
    throw new Error('NEXUS_NSP_PROFILE must be development or production');
}
const nspCertificateDirectory = process.env.NEXUS_NSP_CERT_DIR
    ? path.resolve(process.env.NEXUS_NSP_CERT_DIR)
    : nspProfile === 'development'
        ? path.resolve(__dirname, '..', '..', '..', '.local', 'nsp-certs')
        : null;
const nspPort = Number(process.env.NEXUS_NSP_PORT || 3443);
const nspHost = process.env.NEXUS_NSP_HOST || '127.0.0.1';
const httpHost = process.env.HTTP_HOST || '127.0.0.1';
let latestGpsStatus = {
    status: 'unknown',
    satellites: 0,
    sensorStatus: 'UNKNOWN',
    checkedAt: null
};

db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

db.exec(`
    CREATE TABLE IF NOT EXISTS telemetry_events (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        event_type TEXT,
        message_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        source_protocol TEXT NOT NULL DEFAULT 'serial-bridge'
    )
`);

const telemetryColumns = db.prepare('PRAGMA table_info(telemetry_events)').all();
if (!telemetryColumns.some((column) => column.name === 'source_protocol')) {
    db.exec("ALTER TABLE telemetry_events ADD COLUMN source_protocol TEXT NOT NULL DEFAULT 'serial-bridge'");
}

db.exec(`
    CREATE TABLE IF NOT EXISTS nsp_event_ids (
        device_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        internal_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        PRIMARY KEY (device_id, event_id),
        FOREIGN KEY (internal_id) REFERENCES telemetry_events(id)
    )
`);

const insertEvent = db.prepare(`
    INSERT INTO telemetry_events
    (id, device_id, event_type, message_type, payload_json, timestamp, source_protocol)
    VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const findNspEvent = db.prepare(`
    SELECT internal_id, payload_hash FROM nsp_event_ids
    WHERE device_id = ? AND event_id = ?
`);
const insertNspEvent = db.prepare(`
    INSERT INTO nsp_event_ids (device_id, event_id, internal_id, payload_hash)
    VALUES (?, ?, ?, ?)
`);

io.on('connection', (socket) => {
    console.log(`[WEBSOCKET] Dashboard connected: ${socket.id}`);

    socket.on('disconnect', () => {
        console.log(`[WEBSOCKET] Dashboard disconnected: ${socket.id}`);
    });
});

app.post('/api/telemetry', (req, res) => {
    return res.status(410).json({
        error: 'HTTP telemetry ingestion is disabled; submit telemetry over NSP with TLS 1.3 mutual authentication'
    });
});

app.get('/api/gps-status', (req, res) => {
    res.json(latestGpsStatus);
});

app.post('/api/gps-status', (req, res) => {
    return res.status(410).json({
        error: 'HTTP GPS status updates are disabled; submit device status over NSP with TLS 1.3 mutual authentication'
    });
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
                   payload_json, timestamp, source_protocol
            FROM telemetry_events
            ORDER BY timestamp DESC
            LIMIT ?
        `).all(limit);

        const events = rows.map((row) => ({
            id: row.id,
            source: {
                deviceId: row.device_id,
                protocol: row.source_protocol
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

// Report database health only after a query succeeds.
app.get('/api/health', (req, res) => {
    const checkedAt = new Date().toISOString();
    const nspStatus = nspServer.listening ? 'listening' : 'unavailable';

    try {
        db.prepare('SELECT 1').get();
        const databaseStatus = 'connected';
        const status = nspStatus === 'listening' ? 'ok' : 'degraded';
        return res.json({
            status,
            database: databaseStatus,
            nsp: nspStatus,
            checkedAt
        });
    } catch (error) {
        console.error('[HEALTH] Database check failed:', error);
        return res.status(503).json({
            status: 'degraded',
            database: 'unavailable',
            nsp: nspStatus,
            checkedAt
        });
    }
});

const PORT = Number(process.env.PORT || 3000);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
}
if (!Number.isInteger(nspPort) || nspPort < 1 || nspPort > 65535 || nspPort === PORT) {
    throw new Error('NEXUS_NSP_PORT must be a valid port different from PORT');
}
if (!['127.0.0.1', '::1', 'localhost'].includes(httpHost)) {
    throw new Error('HTTP_HOST must be loopback; expose only the TLS-protected NSP listener to the network');
}
if (!['127.0.0.1', '::1', 'localhost'].includes(nspHost) &&
    process.env.NEXUS_NSP_ALLOW_REMOTE !== '1') {
    throw new Error('Set NEXUS_NSP_ALLOW_REMOTE=1 only when exposing the mTLS-only NSP listener');
}

const nspServer = createNspServer({
    certificate: process.env.NEXUS_NSP_SERVER_CERT ||
        (nspCertificateDirectory && path.join(nspCertificateDirectory, 'server-cert.pem')),
    privateKey: process.env.NEXUS_NSP_SERVER_KEY ||
        (nspCertificateDirectory && path.join(nspCertificateDirectory, 'server-key.pem')),
    clientCa: process.env.NEXUS_NSP_CLIENT_CA ||
        (nspCertificateDirectory && path.join(nspCertificateDirectory, 'ca-cert.pem')),
    onTelemetry: async ({ deviceId, eventId, eventType, payload }) => {
        const payloadJson = JSON.stringify(payload);
        const payloadHash = crypto.createHash('sha256')
            .update(`${eventType}\n${payloadJson}`)
            .digest('hex');
        const existing = findNspEvent.get(deviceId, eventId);
        if (existing) {
            if (existing.payload_hash !== payloadHash) {
                throw new Error('Conflicting contents for previously accepted event ID');
            }
            return { internalId: existing.internal_id, duplicate: true };
        }

        const internalId = crypto.randomUUID();
        const timestamp = new Date().toISOString();
        const internalMessage = {
            id: internalId,
            source: { deviceId, protocol: 'nsp' },
            type: 'telemetry',
            eventType,
            payload,
            timestamp
        };

        db.exec('BEGIN IMMEDIATE');
        try {
            insertEvent.run(
                internalId,
                deviceId,
                eventType,
                'telemetry',
                payloadJson,
                timestamp,
                'nsp'
            );
            insertNspEvent.run(deviceId, eventId, internalId, payloadHash);
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }

        console.log(`[DATABASE] Saved NSP event ${internalId} from ${deviceId}`);
        io.emit('telemetry_update', internalMessage);
        return { internalId, duplicate: false };
    },
    onDeviceStatus: async (status, satellites, sensorStatus) => {
        latestGpsStatus = {
            status,
            satellites,
            sensorStatus,
            checkedAt: new Date().toISOString()
        };
        io.emit('gps_status_update', latestGpsStatus);
    }
});

server.listen(PORT, httpHost, () => {
    console.log(`Dashboard API listening on http://${httpHost}:${PORT} (loopback only)`);
    console.log(`SQLite database: ${dbPath}`);
    console.log(`Event history endpoint: http://localhost:${PORT}/api/events`);
});

nspServer.listen(nspPort, nspHost, () => {
    console.log(`NSP TLS 1.3/mTLS listener on ${nspHost}:${nspPort} (ALPN nsp/1)`);
});

nspServer.on('error', (error) => {
    console.error(`[NSP] Listener failed: ${error.message}`);
    process.exitCode = 1;
    server.close();
});
