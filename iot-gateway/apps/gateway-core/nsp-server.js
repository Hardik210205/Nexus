const fs = require('fs');
const tls = require('tls');
const crypto = require('crypto');
const {
    ACK_REQUIRED,
    FrameDecoder,
    MESSAGE,
    decodeCbor,
    encodeCbor,
    encodeFrame
} = require('./nsp-wire');

const MAXIMUM_CONNECTIONS = 128;
const MAXIMUM_PENDING_CHUNKS = 32;
const IDLE_TIMEOUT_MS = 60000;
const HANDSHAKE_TIMEOUT_MS = 5000;

function requireMap(value, label) {
    if (!(value instanceof Map)) throw new Error(`${label} must be a CBOR map`);
    return value;
}

function eventIdText(value) {
    if (!Buffer.isBuffer(value) || value.length !== 16 || value.every((byte) => byte === 0)) {
        throw new Error('Event ID must be a 16-byte value');
    }
    return value.toString('hex');
}

function createNspServer({ certificate, privateKey, clientCa, onTelemetry, onDeviceStatus }) {
    if (!certificate || !privateKey || !clientCa || !onTelemetry || !onDeviceStatus) {
        throw new Error('NSP TLS credentials and ingestion handlers are required');
    }
    for (const filename of [certificate, privateKey, clientCa]) {
        if (!fs.existsSync(filename)) throw new Error(`Required NSP credential file is missing: ${filename}`);
    }

    const allowedIdentity = process.env.NEXUS_NSP_DEVICE_ID || 'arhb_uno_1';
    const server = tls.createServer({
        cert: fs.readFileSync(certificate),
        key: fs.readFileSync(privateKey),
        ca: fs.readFileSync(clientCa),
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
        requestCert: true,
        rejectUnauthorized: true,
        ALPNProtocols: ['nsp/1']
    });
    const activeSockets = new Set();
    const pendingHandshakes = new Map();

    server.on('connection', (socket) => {
        if (activeSockets.size >= MAXIMUM_CONNECTIONS) {
            socket.destroy();
            return;
        }
        activeSockets.add(socket);
        const key = `${socket.remoteAddress}:${socket.remotePort}`;
        const timer = setTimeout(() => socket.destroy(), HANDSHAKE_TIMEOUT_MS);
        pendingHandshakes.set(key, { socket, timer });
        socket.on('close', () => {
            activeSockets.delete(socket);
            const pending = pendingHandshakes.get(key);
            if (pending?.socket === socket) {
                clearTimeout(pending.timer);
                pendingHandshakes.delete(key);
            }
        });
    });

    server.on('secureConnection', (socket) => {
        const key = `${socket.remoteAddress}:${socket.remotePort}`;
        const pendingHandshake = pendingHandshakes.get(key);
        if (pendingHandshake) {
            clearTimeout(pendingHandshake.timer);
            pendingHandshakes.delete(key);
        }
        socket.setTimeout(IDLE_TIMEOUT_MS);
        socket.setNoDelay(true);

        const certificateInfo = socket.getPeerCertificate();
        const expectedUri = `spiffe://nexus.local/device/${allowedIdentity}`;
        const uris = (certificateInfo.subjectaltname || '')
            .split(/,\s*/)
            .filter((entry) => entry.startsWith('URI:'))
            .map((entry) => entry.slice(4));
        let authorized = socket.authorized &&
            socket.alpnProtocol === 'nsp/1' &&
            uris.length === 1 &&
            uris[0] === expectedUri;
        let negotiated = false;
        let pending = Promise.resolve();
        let pendingChunks = 0;
        const decoder = new FrameDecoder();

        const close = (reason) => {
            if (reason) console.warn(`[NSP] Closing connection: ${reason}`);
            socket.destroy();
        };
        const send = (type, payload, flags = 0) => {
            const frame = encodeFrame(type, flags, encodeCbor(payload));
            socket.write(frame);
        };
        const sendError = (code) => {
            if (socket.destroyed) return;
            try {
                send(MESSAGE.error, new Map([[0, code], [1, false]]));
            } finally {
                socket.end();
            }
        };
        const acknowledge = (id, internalId, duplicate) => {
            send(MESSAGE.acknowledgement, new Map([
                [0, 'nexus.ack'],
                [1, Buffer.from(id, 'hex')],
                [2, Buffer.from(internalId.replaceAll('-', ''), 'hex')],
                [3, duplicate]
            ]));
        };

        socket.on('timeout', () => close(negotiated ? 'idle timeout' : 'NSP HELLO timeout'));
        socket.on('error', (error) => {
            console.error(`[NSP] Connection error: ${error.message}`);
        });

        socket.on('data', (chunk) => {
            pendingChunks += 1;
            if (pendingChunks > MAXIMUM_PENDING_CHUNKS) {
                close('message processing backlog exceeded');
                return;
            }
            pending = pending.then(async () => {
                if (!authorized) throw new Error('certificate identity or ALPN rejected');
                for (const frame of decoder.feed(chunk)) {
                    const message = requireMap(decodeCbor(frame.payload), 'NSP payload');
                    if (!negotiated) {
                        if (frame.type !== MESSAGE.hello ||
                            message.get(0) !== 'nexus.hello' ||
                            !Array.isArray(message.get(1)) ||
                            !message.get(1).some((version) =>
                                Array.isArray(version) && version[0] === 1 && version[1] === 0)) {
                            sendError(1);
                            return;
                        }
                        negotiated = true;
                        socket.setTimeout(IDLE_TIMEOUT_MS);
                        send(MESSAGE.authenticationResult, new Map([[0, true], [1, allowedIdentity]]));
                        send(MESSAGE.capabilityNegotiation, new Map([[0, 1], [1, 0], [2, ['telemetry', 'device_status']]]));
                        continue;
                    }
                    if ((frame.flags & ACK_REQUIRED) === 0) {
                        sendError(2);
                        return;
                    }
                    const eventId = eventIdText(message.get(3));
                    const envelopeKeys = new Set([0, 1, 2, 3, 4, 5, 6, 7]);
                    const payloadMap = message.get(7);
                    if (message.get(0) !== 'nexus.event' ||
                        message.get(1) !== 1 ||
                        message.get(2) !== allowedIdentity ||
                        typeof message.get(4) !== 'string' ||
                        !(payloadMap instanceof Map) ||
                        [...message.keys()].some((key) => !envelopeKeys.has(key)) ||
                        (message.has(5) && message.get(5) !== null &&
                            (typeof message.get(5) !== 'string' ||
                                !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(message.get(5)))) ||
                        (message.has(6) && (!Buffer.isBuffer(message.get(6)) ||
                            message.get(6).length !== 16)) ||
                        [...payloadMap.keys()].some((key) => typeof key !== 'string')) {
                        sendError(3);
                        return;
                    }
                    const payload = Object.fromEntries(payloadMap);
                    if (frame.type === MESSAGE.telemetry) {
                        const allowedPayloadKeys = new Set([
                            'eventNumber',
                            'satellites',
                            'latitudeE7',
                            'longitudeE7',
                            'gpsDate',
                            'gpsTime'
                        ]);
                        const coordinatesMissing = payload.latitudeE7 === null &&
                            payload.longitudeE7 === null;
                        const coordinatesValid = Number.isSafeInteger(payload.latitudeE7) &&
                            Number.isSafeInteger(payload.longitudeE7);
                        if ([...payloadMap.keys()].some((key) => !allowedPayloadKeys.has(key)) ||
                            (!coordinatesMissing && !coordinatesValid) ||
                            (payload.gpsDate !== undefined && payload.gpsDate !== null &&
                                (typeof payload.gpsDate !== 'string' ||
                                    !/^\d{4}-\d{2}-\d{2}$/.test(payload.gpsDate))) ||
                            (payload.gpsTime !== undefined && payload.gpsTime !== null &&
                                (typeof payload.gpsTime !== 'string' ||
                                    !/^\d{2}:\d{2}:\d{2}$/.test(payload.gpsTime)))) {
                            sendError(4);
                            return;
                        }
                        if (Number.isInteger(payload.latitudeE7) && Number.isInteger(payload.longitudeE7)) {
                            payload.latitude = payload.latitudeE7 / 1e7;
                            payload.longitude = payload.longitudeE7 / 1e7;
                        } else if (coordinatesMissing) {
                            payload.latitude = null;
                            payload.longitude = null;
                        }
                        if (coordinatesValid || coordinatesMissing) {
                            delete payload.latitudeE7;
                            delete payload.longitudeE7;
                        }
                        if (message.get(4) !== 'road_hazard_motion' ||
                            !Number.isSafeInteger(payload.eventNumber) ||
                            payload.eventNumber < 0 ||
                            !Number.isInteger(payload.satellites) ||
                            payload.satellites < 0 || payload.satellites > 99 ||
                            (payload.latitude !== null &&
                                (typeof payload.latitude !== 'number' ||
                                    !Number.isFinite(payload.latitude) ||
                                    payload.latitude < -90 || payload.latitude > 90)) ||
                            (payload.longitude !== null &&
                                (typeof payload.longitude !== 'number' ||
                                    !Number.isFinite(payload.longitude) ||
                                    payload.longitude < -180 || payload.longitude > 180)) ||
                            ((payload.latitude === null) !== (payload.longitude === null))) {
                            sendError(4);
                            return;
                        }
                        const result = await onTelemetry({
                            deviceId: allowedIdentity,
                            eventId,
                            eventType: message.get(4),
                            payload
                        });
                        acknowledge(eventId, result.internalId, result.duplicate);
                    } else if (frame.type === MESSAGE.deviceStatus) {
                        if ([...payloadMap.keys()].some((key) =>
                            !['status', 'satellites', 'sensorStatus'].includes(key))) {
                            sendError(4);
                            return;
                        }
                        if (message.get(4) !== 'device_status' ||
                            !['FIX', 'NO_FIX', 'NO_DATA'].includes(payload.status) ||
                            !Number.isInteger(payload.satellites) ||
                            payload.satellites < 0 || payload.satellites > 99 ||
                            (payload.sensorStatus !== undefined &&
                                !['UNKNOWN', 'READY', 'ERROR'].includes(payload.sensorStatus))) {
                            sendError(4);
                            return;
                        }
                        await onDeviceStatus(
                            payload.status,
                            payload.satellites,
                            payload.sensorStatus || 'UNKNOWN'
                        );
                        acknowledge(eventId, eventId, false);
                    } else {
                        sendError(2);
                        return;
                    }
                }
            }).catch((error) => {
                console.error(`[NSP] Message rejected: ${error.message}`);
                close();
            }).finally(() => {
                pendingChunks -= 1;
            });
        });
    });

    server.on('tlsClientError', (error) => {
        console.warn(`[NSP] TLS handshake rejected (${error.code || error.name})`);
    });

    return server;
}

module.exports = { createNspServer };
