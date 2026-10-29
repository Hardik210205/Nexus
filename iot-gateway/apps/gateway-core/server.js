
const express = require('express');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const cors = require('cors');
const { Server } = require('socket.io');
const { Database } = require('./database');
const { createNspServer } = require('./nsp-server');

const app = express();
app.use(express.json());

const server = http.createServer(app);
const configuredDashboardOrigins = (process.env.DASHBOARD_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
const dashboardOrigins = [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:4173',
    'http://127.0.0.1:4173',
    ...configuredDashboardOrigins
];

app.use(cors({
    origin: (origin, callback) => {
        if (!origin || dashboardOrigins.includes(origin)) {
            callback(null, true);
            return;
        }
        callback(new Error('Origin is not allowed'));
    }
}));
app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
});

const io = new Server(server, {
    cors: {
        origin: dashboardOrigins,
        methods: ['GET', 'POST']
    },
    allowRequest: (request, callback) => {
        callback(null, !request.headers.origin || dashboardOrigins.includes(request.headers.origin));
    }
});

const database = new Database();
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
const nspEnabled = process.env.NEXUS_NSP_ENABLED !== '0';
let latestGpsStatus = {
    status: 'unknown',
    satellites: 0,
    sensorStatus: 'UNKNOWN',
    checkedAt: null
};

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
    database.getGpsStatus()
        .then((status) => res.json(status || latestGpsStatus))
        .catch((error) => {
            console.error('[DATABASE] Failed to retrieve GPS status:', error);
            res.status(500).json({ error: 'Failed to retrieve GPS status' });
        });
});

app.post('/api/gps-status', (req, res) => {
    return res.status(410).json({
        error: 'HTTP GPS status updates are disabled; submit device status over NSP with TLS 1.3 mutual authentication'
    });
});

// Retrieve saved events, newest first
app.get('/api/events', (req, res) => {
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isInteger(requestedLimit)
        ? Math.min(Math.max(requestedLimit, 1), 500)
        : 100;
    database.getEvents(limit)
        .then((events) => res.json({ count: events.length, events }))
        .catch((error) => {
            console.error('[DATABASE] Failed to retrieve events:', error);
            res.status(500).json({ error: 'Failed to retrieve events' });
        });
});

app.delete('/api/events/:id', (req, res) => {
    const eventId = String(req.params.id || '').trim();
    if (!eventId) {
        res.status(400).json({ error: 'Event id is required' });
        return;
    }

    database.deleteEvent(eventId)
        .then((deleted) => {
            if (!deleted) {
                res.status(404).json({ error: 'Event not found' });
                return;
            }
            io.emit('telemetry_deleted', { id: eventId });
            res.json({ deleted: true, id: eventId });
        })
        .catch((error) => {
            console.error('[DATABASE] Failed to delete event:', error);
            res.status(500).json({ error: 'Failed to delete event' });
        });
});

// Report database health only after a query succeeds.
app.get('/api/health', (req, res) => {
    const checkedAt = new Date().toISOString();
    const nspStatus = !nspEnabled
        ? 'disabled'
        : nspServer.listening ? 'listening' : 'unavailable';

    database.healthCheck().then(() => {
        const databaseStatus = 'connected';
        const status = nspStatus === 'listening' || nspStatus === 'disabled' ? 'ok' : 'degraded';
        res.json({
            status,
            database: databaseStatus,
            nsp: nspStatus,
            checkedAt
        });
    }).catch((error) => {
        console.error('[HEALTH] Database check failed:', error);
        res.status(503).json({
            status: 'degraded',
            database: 'unavailable',
            nsp: nspStatus,
            checkedAt
        });
    });
});

const PORT = Number(process.env.PORT || 3000);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
}
if (nspEnabled && (!Number.isInteger(nspPort) || nspPort < 1 || nspPort > 65535 || nspPort === PORT)) {
    throw new Error('NEXUS_NSP_PORT must be a valid port different from PORT');
}
if (!['127.0.0.1', '::1', 'localhost'].includes(httpHost) &&
    process.env.HTTP_ALLOW_REMOTE !== '1') {
    throw new Error('Set HTTP_ALLOW_REMOTE=1 only when exposing the dashboard API through HTTPS and firewall controls');
}
if (nspEnabled && !['127.0.0.1', '::1', 'localhost'].includes(nspHost) &&
    process.env.NEXUS_NSP_ALLOW_REMOTE !== '1') {
    throw new Error('Set NEXUS_NSP_ALLOW_REMOTE=1 only when exposing the mTLS-only NSP listener');
}

const nspServer = nspEnabled ? createNspServer({
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
        const internalId = crypto.randomUUID();
        const timestamp = new Date().toISOString();
        const existing = await database.saveTelemetry({
            deviceId, eventId, eventType, payload, payloadJson, payloadHash,
            internalId,
            timestamp
        });
        if (existing) {
            if (existing.payload_hash !== payloadHash) {
                throw new Error('Conflicting contents for previously accepted event ID');
            }
            return { internalId: existing.internal_id, duplicate: true };
        }

        const internalMessage = {
            id: internalId,
            source: { deviceId, protocol: 'nsp' },
            type: 'telemetry',
            eventType,
            payload,
            timestamp
        };

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
        await database.saveGpsStatus(
            process.env.NEXUS_NSP_DEVICE_ID || 'arhb_uno_1',
            status,
            satellites,
            sensorStatus,
            latestGpsStatus.checkedAt
        );
        io.emit('gps_status_update', latestGpsStatus);
    }
}) : null;

database.initialize().then(async () => {
    const savedGpsStatus = await database.getGpsStatus();
    if (savedGpsStatus) latestGpsStatus = savedGpsStatus;
    server.listen(PORT, httpHost, () => {
        console.log(`Dashboard API listening on http://${httpHost}:${PORT}`);
        console.log(`Database driver: ${database.mode}`);
        console.log(`Event history endpoint: http://localhost:${PORT}/api/events`);
    });
    if (nspServer) {
        nspServer.listen(nspPort, nspHost, () => {
            console.log(`NSP TLS 1.3/mTLS listener on ${nspHost}:${nspPort} (ALPN nsp/1)`);
        });
    } else {
        console.warn('[NSP] Listener disabled; HTTP dashboard/API mode only');
    }
}).catch((error) => {
    console.error(`[DATABASE] Initialization failed: ${error.message}`);
    process.exitCode = 1;
});

if (nspServer) {
    nspServer.on('error', (error) => {
        console.error(`[NSP] Listener failed: ${error.message}`);
        process.exitCode = 1;
        server.close();
    });
}

process.on('SIGTERM', () => {
    server.close();
    if (nspServer) nspServer.close();
    database.close().catch((error) => console.error(`[DATABASE] Shutdown failed: ${error.message}`));
});
