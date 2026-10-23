const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const tls = require('node:tls');
const { createNspServer } = require('./nsp-server');
const { ACK_REQUIRED, FrameDecoder, MESSAGE, decodeCbor, encodeCbor, encodeFrame } = require('./nsp-wire');

const certificateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-nsp-test-'));
const certificateGenerator = path.resolve(__dirname, '../../../scripts/generate_nsp_dev_certs.py');
const certificate = (name) => fs.readFileSync(path.join(certificateDirectory, name));
let server;
let port;
const acceptedEvents = new Map();

test.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(certificateDirectory, { recursive: true, force: true });
});

test('generates local test certificates', () => {
    execFileSync(process.env.PYTHON || 'python', [
        certificateGenerator,
        '--output-dir',
        certificateDirectory
    ], { stdio: 'pipe' });
});

test('frame decoder assembles split/coalesced frames and rejects invalid bounds', () => {
    const first = encodeFrame(MESSAGE.hello, 0, encodeCbor(new Map([[0, 'hello']])));
    const second = encodeFrame(MESSAGE.hello, 0, encodeCbor(new Map([[0, 'again']])));
    const decoder = new FrameDecoder();

    assert.deepEqual(decoder.feed(first.subarray(0, 7)), []);
    assert.equal(decoder.feed(Buffer.concat([first.subarray(7), second])).length, 2);

    const invalidMagic = Buffer.from(first);
    invalidMagic[0] = 0;
    assert.throws(() => new FrameDecoder().feed(invalidMagic), /magic/i);

    const oversizedControl = Buffer.alloc(32);
    Buffer.from('NSP\x00', 'binary').copy(oversizedControl, 0);
    oversizedControl[4] = 1;
    oversizedControl[6] = MESSAGE.hello;
    oversizedControl.writeUInt16BE(32, 8);
    oversizedControl.writeUInt32BE(4097, 12);
    assert.throws(() => new FrameDecoder().feed(oversizedControl), /length/i);
    assert.throws(() => decodeCbor(Buffer.from([0x18, 0x01])), /canonical/i);
});

test('mutual TLS negotiates NSP and durably acknowledges an idempotent event', async () => {
    delete process.env.NEXUS_NSP_DEVICE_ID;
    server = createNspServer({
        certificate: path.join(certificateDirectory, 'server-cert.pem'),
        privateKey: path.join(certificateDirectory, 'server-key.pem'),
        clientCa: path.join(certificateDirectory, 'ca-cert.pem'),
        onTelemetry: async (event) => {
            const previous = acceptedEvents.get(event.eventId);
            if (previous) {
                assert.deepEqual(previous, event.payload);
                return { internalId: '12345678-1234-4234-8234-123456789abc', duplicate: true };
            }
            acceptedEvents.set(event.eventId, event.payload);
            return { internalId: '12345678-1234-4234-8234-123456789abc', duplicate: false };
        },
        onDeviceStatus: async () => {}
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    port = server.address().port;

    const client = tls.connect({
        host: 'localhost',
        port,
        servername: 'localhost',
        ca: certificate('ca-cert.pem'),
        cert: certificate('device-cert.pem'),
        key: certificate('device-key.pem'),
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
        ALPNProtocols: ['nsp/1']
    });
    await new Promise((resolve, reject) => {
        client.once('secureConnect', resolve);
        client.once('error', reject);
    });
    assert.equal(client.alpnProtocol, 'nsp/1');

    const decoder = new FrameDecoder();
    const receivedFrames = [];
    const waitForFrame = async (type) => {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
            const index = receivedFrames.findIndex((frame) => frame.type === type);
            if (index !== -1) return receivedFrames.splice(index, 1)[0];
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`Timed out waiting for NSP message ${type}`);
    };
    client.on('data', (chunk) => receivedFrames.push(...decoder.feed(chunk)));

    client.write(encodeFrame(MESSAGE.hello, 0, encodeCbor(new Map([
        [0, 'nexus.hello'],
        [1, [[1, 0]]],
        [2, [MESSAGE.telemetry]]
    ]))));
    assert.equal((await waitForFrame(MESSAGE.authenticationResult)).type, MESSAGE.authenticationResult);
    assert.equal((await waitForFrame(MESSAGE.capabilityNegotiation)).type, MESSAGE.capabilityNegotiation);

    const eventId = crypto.randomBytes(16);
    const envelope = new Map([
        [0, 'nexus.event'],
        [1, 1],
        [2, 'arhb_uno_1'],
        [3, eventId],
        [4, 'road_hazard_motion'],
        [7, new Map([
            ['eventNumber', 12],
            ['satellites', 8],
            ['latitudeE7', 377749000],
            ['longitudeE7', -1224194000],
            ['gpsDate', '2026-10-22'],
            ['gpsTime', '08:48:31']
        ])]
    ]);
    const telemetryFrame = () => encodeFrame(
        MESSAGE.telemetry,
        ACK_REQUIRED,
        encodeCbor(envelope)
    );

    client.write(telemetryFrame());
    const firstAck = decodeCbor((await waitForFrame(MESSAGE.acknowledgement)).payload);
    assert.equal(firstAck.get(0), 'nexus.ack');
    assert.equal(firstAck.get(1).toString('hex'), eventId.toString('hex'));
    assert.equal(firstAck.get(3), false);

    client.write(telemetryFrame());
    const duplicateAck = decodeCbor((await waitForFrame(MESSAGE.acknowledgement)).payload);
    assert.equal(duplicateAck.get(3), true);
    assert.equal(acceptedEvents.size, 1);
    assert.equal(acceptedEvents.get(eventId.toString('hex')).latitude, 37.7749);
    assert.equal(acceptedEvents.get(eventId.toString('hex')).longitude, -122.4194);
    client.end();
});

test('rejects clients that do not present a trusted device certificate', async () => {
    const client = tls.connect({
        host: 'localhost',
        port,
        servername: 'localhost',
        ca: certificate('ca-cert.pem'),
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
        ALPNProtocols: ['nsp/1']
    });
    let applicationBytes = 0;
    client.on('data', (chunk) => {
        applicationBytes += chunk.length;
    });
    client.setTimeout(1500, () => client.destroy());
    const closed = new Promise((resolve) => {
        client.once('close', resolve);
        client.once('error', resolve);
    });
    client.once('secureConnect', () => {
        client.write(encodeFrame(MESSAGE.hello, 0, encodeCbor(new Map([
            [0, 'nexus.hello'],
            [1, [[1, 0]]]
        ]))));
    });
    await closed;
    assert.equal(applicationBytes, 0);
    assert.equal(acceptedEvents.size, 1);
});

test('rejects a trusted client certificate with the wrong device URI identity', async () => {
    const originalIdentity = process.env.NEXUS_NSP_DEVICE_ID;
    process.env.NEXUS_NSP_DEVICE_ID = 'different-device';
    const identityServer = createNspServer({
        certificate: path.join(certificateDirectory, 'server-cert.pem'),
        privateKey: path.join(certificateDirectory, 'server-key.pem'),
        clientCa: path.join(certificateDirectory, 'ca-cert.pem'),
        onTelemetry: async () => { throw new Error('Wrong device identity reached ingestion'); },
        onDeviceStatus: async () => { throw new Error('Wrong device identity reached status handler'); }
    });
    if (originalIdentity === undefined) delete process.env.NEXUS_NSP_DEVICE_ID;
    else process.env.NEXUS_NSP_DEVICE_ID = originalIdentity;

    await new Promise((resolve, reject) => {
        identityServer.once('error', reject);
        identityServer.listen(0, '127.0.0.1', resolve);
    });
    const identityPort = identityServer.address().port;
    const client = tls.connect({
        host: 'localhost',
        port: identityPort,
        servername: 'localhost',
        ca: certificate('ca-cert.pem'),
        cert: certificate('device-cert.pem'),
        key: certificate('device-key.pem'),
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
        ALPNProtocols: ['nsp/1']
    });
    let applicationBytes = 0;
    client.on('data', (chunk) => { applicationBytes += chunk.length; });
    client.setTimeout(1500, () => client.destroy());
    const closed = new Promise((resolve) => {
        client.once('close', resolve);
        client.once('error', resolve);
    });
    client.once('secureConnect', () => {
        client.write(encodeFrame(MESSAGE.hello, 0, encodeCbor(new Map([
            [0, 'nexus.hello'],
            [1, [[1, 0]]]
        ]))));
    });
    await closed;
    await new Promise((resolve) => identityServer.close(resolve));
    assert.equal(applicationBytes, 0);
});
