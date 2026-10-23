const crypto = require('crypto');

const MESSAGE = Object.freeze({
    hello: 0x01,
    authenticationResult: 0x02,
    capabilityNegotiation: 0x03,
    telemetry: 0x10,
    acknowledgement: 0x11,
    error: 0x12,
    deviceStatus: 0x15
});
const ACK_REQUIRED = 0x01;
const FIXED_HEADER_LENGTH = 32;
const MAXIMUM_HEADER_LENGTH = 256;
const MAXIMUM_PAYLOAD_LENGTH = 65536;
const MAXIMUM_CONTROL_PAYLOAD_LENGTH = 4096;
const MAXIMUM_BUFFERED_BYTES = 131584;
const MAGIC = Buffer.from([0x4e, 0x53, 0x50, 0x00]);

function encodeLength(major, value) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError('CBOR lengths and integers must be non-negative safe integers');
    }
    if (value < 24) return Buffer.from([(major << 5) | value]);
    if (value <= 0xff) return Buffer.from([(major << 5) | 24, value]);
    if (value <= 0xffff) {
        const output = Buffer.alloc(3);
        output[0] = (major << 5) | 25;
        output.writeUInt16BE(value, 1);
        return output;
    }
    if (value <= 0xffffffff) {
        const output = Buffer.alloc(5);
        output[0] = (major << 5) | 26;
        output.writeUInt32BE(value, 1);
        return output;
    }
    const output = Buffer.alloc(9);
    output[0] = (major << 5) | 27;
    output.writeBigUInt64BE(BigInt(value), 1);
    return output;
}

function encodeCbor(value, depth = 0) {
    if (depth > 8) throw new TypeError('CBOR nesting exceeds the supported limit');
    if (value === null) return Buffer.from([0xf6]);
    if (value === false) return Buffer.from([0xf4]);
    if (value === true) return Buffer.from([0xf5]);
    if (Buffer.isBuffer(value)) {
        return Buffer.concat([encodeLength(2, value.length), value]);
    }
    if (typeof value === 'string') {
        const text = Buffer.from(value, 'utf8');
        return Buffer.concat([encodeLength(3, text.length), text]);
    }
    if (typeof value === 'number') {
        if (Number.isSafeInteger(value) && value >= 0) return encodeLength(0, value);
        if (Number.isSafeInteger(value) && value < 0) return encodeLength(1, -1 - value);
        if (!Number.isFinite(value)) throw new TypeError('CBOR numbers must be finite');
        const output = Buffer.alloc(9);
        output[0] = 0xfb;
        output.writeDoubleBE(value, 1);
        return output;
    }
    if (value instanceof Map) {
        const entries = [...value.entries()].map(([key, entry]) => [
            encodeCbor(key, depth + 1),
            encodeCbor(entry, depth + 1)
        ]);
        entries.sort((first, second) =>
            first[0].length - second[0].length || Buffer.compare(first[0], second[0]));
        return Buffer.concat([
            encodeLength(5, entries.length),
            ...entries.flat()
        ]);
    }
    if (Array.isArray(value)) {
        return Buffer.concat([
            encodeLength(4, value.length),
            ...value.map((entry) => encodeCbor(entry, depth + 1))
        ]);
    }
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
        return encodeCbor(new Map(Object.entries(value)), depth);
    }
    throw new TypeError('Unsupported CBOR value');
}

function decodeCbor(bytes) {
    let offset = 0;

    function readLength(additional) {
        if (additional < 24) return additional;
        let value;
        if (additional === 24) {
            if (offset + 1 > bytes.length) throw new Error('Truncated CBOR value');
            value = bytes[offset++];
            if (value < 24) throw new Error('Non-canonical CBOR integer');
            return value;
        }
        if (additional === 25) {
            if (offset + 2 > bytes.length) throw new Error('Truncated CBOR value');
            value = bytes.readUInt16BE(offset);
            offset += 2;
            if (value <= 0xff) throw new Error('Non-canonical CBOR integer');
            return value;
        }
        if (additional === 26) {
            if (offset + 4 > bytes.length) throw new Error('Truncated CBOR value');
            value = bytes.readUInt32BE(offset);
            offset += 4;
            if (value <= 0xffff) throw new Error('Non-canonical CBOR integer');
            return value;
        }
        if (additional === 27) {
            if (offset + 8 > bytes.length) throw new Error('Truncated CBOR value');
            const wide = bytes.readBigUInt64BE(offset);
            offset += 8;
            if (wide <= 0xffffffffn || wide > BigInt(Number.MAX_SAFE_INTEGER)) {
                throw new Error('CBOR integer is non-canonical or too large');
            }
            return Number(wide);
        }
        throw new Error('Indefinite or reserved CBOR length is not supported');
    }

    function readValue(depth = 0) {
        if (depth > 8 || offset >= bytes.length) throw new Error('Truncated or deeply nested CBOR value');
        const initial = bytes[offset++];
        const major = initial >> 5;
        const additional = initial & 0x1f;

        if (major === 7) {
            if (initial === 0xf4) return false;
            if (initial === 0xf5) return true;
            if (initial === 0xf6) return null;
            if (initial === 0xfb) {
                if (offset + 8 > bytes.length) throw new Error('Truncated CBOR float');
                const value = bytes.readDoubleBE(offset);
                offset += 8;
                if (!Number.isFinite(value)) throw new Error('CBOR float must be finite');
                return value;
            }
            throw new Error('Unsupported CBOR simple or floating-point value');
        }

        const length = readLength(additional);
        if (major === 0) return length;
        if (major === 1) return -1 - length;
        if (major === 2 || major === 3) {
            if (length > bytes.length - offset) throw new Error('Truncated CBOR string');
            const value = bytes.subarray(offset, offset + length);
            offset += length;
            if (major === 2) return Buffer.from(value);
            const text = value.toString('utf8');
            if (!Buffer.from(text, 'utf8').equals(value)) throw new Error('Invalid CBOR UTF-8');
            return text;
        }
        if (major === 4) {
            if (length > 256) throw new Error('CBOR array exceeds the supported limit');
            return Array.from({ length }, () => readValue(depth + 1));
        }
        if (major === 5) {
            if (length > 256) throw new Error('CBOR map exceeds the supported limit');
            const result = new Map();
            for (let index = 0; index < length; index += 1) {
                const key = readValue(depth + 1);
                if (result.has(key)) throw new Error('Duplicate CBOR map key');
                result.set(key, readValue(depth + 1));
            }
            return result;
        }
        throw new Error('Unsupported CBOR major type');
    }

    const result = readValue();
    if (offset !== bytes.length) throw new Error('Trailing bytes after CBOR value');
    if (!encodeCbor(result).equals(bytes)) throw new Error('CBOR value is not deterministic');
    return result;
}

function encodeFrame(type, flags, payload) {
    if (!Number.isInteger(type) || type < 1 || type > 0x7f) {
        throw new TypeError('Invalid NSP message type');
    }
    if (![MESSAGE.telemetry, MESSAGE.deviceStatus].includes(type) && flags !== 0) {
        throw new TypeError('ACK_REQUIRED is only valid for telemetry and device status');
    }
    if ((flags & ~ACK_REQUIRED) !== 0) throw new TypeError('Reserved NSP flags must be zero');
    if (payload.length > MAXIMUM_PAYLOAD_LENGTH) throw new TypeError('NSP payload is too large');
    if (type !== MESSAGE.telemetry && type !== MESSAGE.deviceStatus &&
        payload.length > MAXIMUM_CONTROL_PAYLOAD_LENGTH) {
        throw new TypeError('NSP control payload is too large');
    }
    const messageId = crypto.randomBytes(16);
    while (messageId.every((byte) => byte === 0)) crypto.randomFillSync(messageId);
    const frame = Buffer.alloc(FIXED_HEADER_LENGTH + payload.length);
    MAGIC.copy(frame, 0);
    frame[4] = 1;
    frame[5] = 0;
    frame[6] = type;
    frame[7] = flags;
    frame.writeUInt16BE(FIXED_HEADER_LENGTH, 8);
    frame.writeUInt32BE(payload.length, 12);
    messageId.copy(frame, 16);
    payload.copy(frame, FIXED_HEADER_LENGTH);
    return frame;
}

class FrameDecoder {
    constructor() {
        this.buffer = Buffer.alloc(0);
    }

    feed(chunk) {
        if (this.buffer.length + chunk.length > MAXIMUM_BUFFERED_BYTES) {
            throw new Error('NSP connection buffer limit exceeded');
        }
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const frames = [];

        while (this.buffer.length >= FIXED_HEADER_LENGTH) {
            const header = this.buffer;
            if (!header.subarray(0, 4).equals(MAGIC)) throw new Error('Invalid NSP magic');
            if (header[4] !== 1 || header[5] !== 0) throw new Error('Unsupported NSP version');
            const type = header[6];
            const flags = header[7];
            if (![...Object.values(MESSAGE)].includes(type)) throw new Error('Unknown NSP message type');
            if ((flags & ~ACK_REQUIRED) !== 0 ||
                (flags !== 0 && ![MESSAGE.telemetry, MESSAGE.deviceStatus].includes(type))) {
                throw new Error('Invalid NSP flags');
            }
            const headerLength = header.readUInt16BE(8);
            const payloadLength = header.readUInt32BE(12);
            if (header.readUInt16BE(10) !== 0 ||
                headerLength < FIXED_HEADER_LENGTH ||
                headerLength > MAXIMUM_HEADER_LENGTH ||
                payloadLength > MAXIMUM_PAYLOAD_LENGTH ||
                (![MESSAGE.telemetry, MESSAGE.deviceStatus].includes(type) &&
                    payloadLength > MAXIMUM_CONTROL_PAYLOAD_LENGTH)) {
                throw new Error('Invalid NSP frame length or reserved field');
            }
            const frameLength = headerLength + payloadLength;
            if (frameLength > MAXIMUM_BUFFERED_BYTES) throw new Error('NSP frame exceeds limits');
            if (this.buffer.length < frameLength) break;
            if (header.subarray(16, 32).every((byte) => byte === 0)) {
                throw new Error('NSP message ID must be non-zero');
            }
            let extensionOffset = FIXED_HEADER_LENGTH;
            const extensionIds = new Set();
            while (extensionOffset < headerLength) {
                if (extensionOffset + 4 > headerLength) throw new Error('Malformed NSP extension');
                const rawId = header.readUInt16BE(extensionOffset);
                const extensionLength = header.readUInt16BE(extensionOffset + 2);
                const extensionId = rawId & 0x7fff;
                if (extensionId === 0 || extensionIds.has(extensionId) ||
                    extensionOffset + 4 + extensionLength > headerLength) {
                    throw new Error('Malformed or duplicate NSP extension');
                }
                if ((rawId & 0x8000) !== 0) throw new Error('Unsupported critical NSP extension');
                extensionIds.add(extensionId);
                extensionOffset += 4 + extensionLength;
            }
            frames.push({
                type,
                flags,
                messageId: Buffer.from(header.subarray(16, 32)),
                payload: Buffer.from(header.subarray(headerLength, frameLength))
            });
            this.buffer = this.buffer.subarray(frameLength);
        }
        return frames;
    }
}

module.exports = {
    ACK_REQUIRED,
    FrameDecoder,
    MESSAGE,
    decodeCbor,
    encodeCbor,
    encodeFrame
};
