const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const rootDirectory = path.resolve(__dirname, '../../..');
const certificateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-gateway-nsp-'));
const databasePath = path.join(certificateDirectory, 'gateway.db');
const certificateGenerator = path.join(rootDirectory, 'scripts', 'generate_nsp_dev_certs.py');
let gateway;
let httpPort;
let nspPort;

function findFreePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close((error) => error ? reject(error) : resolve(port));
        });
    });
}

async function waitForGateway() {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        if (gateway.exitCode !== null) {
            throw new Error(`Gateway exited before readiness (${gateway.exitCode})`);
        }
        try {
            const response = await fetch(`http://127.0.0.1:${httpPort}/api/health`);
            if (response.ok) return response.json();
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Gateway did not become ready');
}

test.after(async () => {
    if (gateway && gateway.exitCode === null) {
        gateway.kill();
        await new Promise((resolve) => gateway.once('exit', resolve));
    }
    fs.rmSync(certificateDirectory, { recursive: true, force: true });
});

test('the running gateway accepts only NSP/mTLS writes and persists GPS events once', async () => {
    execFileSync(process.env.PYTHON || 'python', [
        certificateGenerator,
        '--output-dir',
        certificateDirectory
    ], { stdio: 'pipe' });
    httpPort = await findFreePort();
    nspPort = await findFreePort();

    gateway = spawn(process.execPath, ['server.js'], {
        cwd: __dirname,
        env: {
            ...process.env,
            HTTP_HOST: '127.0.0.1',
            PORT: String(httpPort),
            NEXUS_DB_PATH: databasePath,
            NEXUS_NSP_CERT_DIR: certificateDirectory,
            NEXUS_NSP_HOST: '127.0.0.1',
            NEXUS_NSP_PORT: String(nspPort),
            NEXUS_NSP_DEVICE_ID: 'arhb_uno_1'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let gatewayOutput = '';
    gateway.stdout.on('data', (chunk) => { gatewayOutput += chunk.toString(); });
    gateway.stderr.on('data', (chunk) => { gatewayOutput += chunk.toString(); });

    const health = await waitForGateway();
    assert.equal(health.status, 'ok');
    assert.equal(health.nsp, 'listening');

    const clientScript = `
import uuid
from nsp_client import NspClient
from serial_bridge import parse_event_line

event_id = uuid.UUID("f17f4f91-51be-4f41-8c68-ec8f3c895812")
event, invalid_gps = parse_event_line(
    "EVENT,57,37.774900,-122.419400,8,2026-10-22,08:48:31"
)
assert invalid_gps is False
with NspClient() as client:
    client.send_device_status("FIX", 8, sensor_status="READY")
    assert client.send_telemetry(event, event_id) is False
    assert client.send_telemetry(event, event_id) is True
    conflicting_event = {**event, "eventNumber": 58}
    try:
        client.send_telemetry(conflicting_event, event_id)
    except ConnectionError:
        pass
    else:
        raise AssertionError("Gateway accepted conflicting contents for a reused event ID")
    restarted_event, invalid_gps = parse_event_line(
        "EVENT,1,37.775000,-122.419500,8,2026-10-22,08:48:33"
    )
    assert invalid_gps is False
    assert client.send_telemetry(
        restarted_event,
        uuid.UUID("d24c0154-4319-49ad-9a1c-332f2b9e27d7")
    ) is False
`;
    execFileSync(process.env.PYTHON || 'python', ['-c', clientScript], {
        cwd: rootDirectory,
        env: {
            ...process.env,
            NEXUS_NSP_CERT_DIR: certificateDirectory,
            NEXUS_NSP_HOST: 'localhost',
            NEXUS_NSP_PORT: String(nspPort),
            NEXUS_NSP_DEVICE_ID: 'arhb_uno_1'
        },
        stdio: 'pipe'
    });

    const [historyResponse, statusResponse, telemetryResponse, gpsWriteResponse] = await Promise.all([
        fetch(`http://127.0.0.1:${httpPort}/api/events?limit=10`),
        fetch(`http://127.0.0.1:${httpPort}/api/gps-status`),
        fetch(`http://127.0.0.1:${httpPort}/api/telemetry`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ deviceId: 'forged', type: 'telemetry' })
        }),
        fetch(`http://127.0.0.1:${httpPort}/api/gps-status`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ status: 'FIX', satellites: 8 })
        })
    ]);
    const history = await historyResponse.json();
    const gpsStatus = await statusResponse.json();

    assert.equal(history.count, 2);
    assert.equal(history.events[0].source.protocol, 'nsp');
    assert.deepEqual(
        history.events.map(({ payload }) => payload.eventNumber).sort((a, b) => a - b),
        [1, 57]
    );
    assert.equal(history.events.find(({ payload }) => payload.eventNumber === 57).payload.latitude, 37.7749);
    assert.equal(history.events.find(({ payload }) => payload.eventNumber === 57).payload.longitude, -122.4194);
    assert.equal(gpsStatus.status, 'FIX');
    assert.equal(gpsStatus.sensorStatus, 'READY');
    assert.equal(telemetryResponse.status, 410);
    assert.equal(gpsWriteResponse.status, 410);
});
