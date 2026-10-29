const path = require('path');
const { DatabaseSync } = require('node:sqlite');

class Database {
    constructor() {
        this.mode = process.env.DATABASE_URL ? 'postgres' : 'sqlite';
        this.pool = null;
        this.sqlite = null;
        this.statements = {};
    }

    async initialize() {
        if (this.mode === 'postgres') {
            const { Pool } = require('pg');
            this.pool = new Pool({
                connectionString: process.env.DATABASE_URL,
                max: Number(process.env.DATABASE_POOL_SIZE || 10),
                connectionTimeoutMillis: 10000,
                statement_timeout: 15000,
                ssl: process.env.DATABASE_SSL === 'disable'
                    ? false
                    : process.env.DATABASE_SSL === 'require'
                        ? { rejectUnauthorized: false }
                        : undefined
            });
            await this.pool.query(`
                CREATE TABLE IF NOT EXISTS telemetry_events (
                    id TEXT PRIMARY KEY,
                    device_id TEXT NOT NULL,
                    event_type TEXT,
                    message_type TEXT NOT NULL,
                    payload JSONB NOT NULL,
                    event_timestamp TIMESTAMPTZ NOT NULL,
                    source_protocol TEXT NOT NULL DEFAULT 'serial-bridge',
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                CREATE TABLE IF NOT EXISTS nsp_event_ids (
                    device_id TEXT NOT NULL,
                    event_id TEXT NOT NULL,
                    internal_id TEXT NOT NULL REFERENCES telemetry_events(id),
                    payload_hash TEXT NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    PRIMARY KEY (device_id, event_id)
                );
                CREATE TABLE IF NOT EXISTS device_status (
                    device_id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    satellites INTEGER NOT NULL,
                    sensor_status TEXT NOT NULL,
                    checked_at TIMESTAMPTZ NOT NULL
                );
                CREATE INDEX IF NOT EXISTS telemetry_events_timestamp_idx
                    ON telemetry_events (event_timestamp DESC);
            `);
            return;
        }

        const dbPath = process.env.NEXUS_DB_PATH
            ? path.resolve(process.env.NEXUS_DB_PATH)
            : path.join(__dirname, 'arhb_events.db');
        this.sqlite = new DatabaseSync(dbPath);
        this.sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
        this.sqlite.exec(`
            CREATE TABLE IF NOT EXISTS telemetry_events (
                id TEXT PRIMARY KEY,
                device_id TEXT NOT NULL,
                event_type TEXT,
                message_type TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                source_protocol TEXT NOT NULL DEFAULT 'serial-bridge'
            );
            CREATE TABLE IF NOT EXISTS nsp_event_ids (
                device_id TEXT NOT NULL,
                event_id TEXT NOT NULL,
                internal_id TEXT NOT NULL,
                payload_hash TEXT NOT NULL,
                PRIMARY KEY (device_id, event_id),
                FOREIGN KEY (internal_id) REFERENCES telemetry_events(id)
            );
            CREATE TABLE IF NOT EXISTS device_status (
                device_id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                satellites INTEGER NOT NULL,
                sensor_status TEXT NOT NULL,
                checked_at TEXT NOT NULL
            );
        `);
        const columns = this.sqlite.prepare('PRAGMA table_info(telemetry_events)').all();
        if (!columns.some((column) => column.name === 'source_protocol')) {
            this.sqlite.exec("ALTER TABLE telemetry_events ADD COLUMN source_protocol TEXT NOT NULL DEFAULT 'serial-bridge'");
        }
        this.statements.insertEvent = this.sqlite.prepare(`
            INSERT INTO telemetry_events
            (id, device_id, event_type, message_type, payload_json, timestamp, source_protocol)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        this.statements.findNspEvent = this.sqlite.prepare(`
            SELECT internal_id, payload_hash FROM nsp_event_ids
            WHERE device_id = ? AND event_id = ?
        `);
        this.statements.insertNspEvent = this.sqlite.prepare(`
            INSERT INTO nsp_event_ids (device_id, event_id, internal_id, payload_hash)
            VALUES (?, ?, ?, ?)
        `);
    }

    async getEvents(limit) {
        if (this.mode === 'postgres') {
            const result = await this.pool.query(`
                SELECT id, device_id, event_type, message_type, payload,
                       event_timestamp AS timestamp, source_protocol
                FROM telemetry_events
                ORDER BY event_timestamp DESC
                LIMIT $1
            `, [limit]);
            return result.rows.map((row) => this.toEvent(row));
        }
        const rows = this.sqlite.prepare(`
            SELECT id, device_id, event_type, message_type,
                   payload_json, timestamp, source_protocol
            FROM telemetry_events
            ORDER BY timestamp DESC
            LIMIT ?
        `).all(limit);
        return rows.map((row) => this.toEvent({
            ...row,
            payload: JSON.parse(row.payload_json)
        }));
    }

    async deleteEvent(eventId) {
        if (this.mode === 'postgres') {
            const client = await this.pool.connect();
            try {
                await client.query('BEGIN');
                await client.query(
                    'DELETE FROM nsp_event_ids WHERE internal_id = $1',
                    [eventId]
                );
                const result = await client.query(
                    'DELETE FROM telemetry_events WHERE id = $1 RETURNING id',
                    [eventId]
                );
                await client.query('COMMIT');
                return result.rowCount > 0;
            } catch (error) {
                await client.query('ROLLBACK').catch(() => {});
                throw error;
            } finally {
                client.release();
            }
        }

        this.sqlite.exec('BEGIN IMMEDIATE');
        try {
            this.sqlite.prepare(
                'DELETE FROM nsp_event_ids WHERE internal_id = ?'
            ).run(eventId);
            const result = this.sqlite.prepare(
                'DELETE FROM telemetry_events WHERE id = ?'
            ).run(eventId);
            this.sqlite.exec('COMMIT');
            return result.changes > 0;
        } catch (error) {
            this.sqlite.exec('ROLLBACK');
            throw error;
        }
    }

    async healthCheck() {
        if (this.mode === 'postgres') {
            await this.pool.query('SELECT 1');
        } else {
            this.sqlite.prepare('SELECT 1').get();
        }
    }

    async getGpsStatus() {
        if (this.mode === 'postgres') {
            const result = await this.pool.query(`
                SELECT status, satellites, sensor_status AS "sensorStatus", checked_at AS "checkedAt"
                FROM device_status
                ORDER BY checked_at DESC
                LIMIT 1
            `);
            return result.rows[0] ? this.normalizeGpsStatus(result.rows[0]) : null;
        }
        const row = this.sqlite.prepare(`
            SELECT status, satellites, sensor_status AS sensorStatus, checked_at AS checkedAt
            FROM device_status ORDER BY checked_at DESC LIMIT 1
        `).get();
        return row ? this.normalizeGpsStatus(row) : null;
    }

    async saveGpsStatus(deviceId, status, satellites, sensorStatus, checkedAt) {
        if (this.mode === 'postgres') {
            await this.pool.query(`
                INSERT INTO device_status (device_id, status, satellites, sensor_status, checked_at)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (device_id) DO UPDATE SET
                    status = EXCLUDED.status,
                    satellites = EXCLUDED.satellites,
                    sensor_status = EXCLUDED.sensor_status,
                    checked_at = EXCLUDED.checked_at
            `, [deviceId, status, satellites, sensorStatus, checkedAt]);
            return;
        }
        this.sqlite.prepare(`
            INSERT INTO device_status (device_id, status, satellites, sensor_status, checked_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(device_id) DO UPDATE SET
                status = excluded.status,
                satellites = excluded.satellites,
                sensor_status = excluded.sensor_status,
                checked_at = excluded.checked_at
        `).run(deviceId, status, satellites, sensorStatus, checkedAt);
    }

    async saveTelemetry({ deviceId, eventId, eventType, payload, payloadJson, payloadHash, internalId, timestamp }) {
        if (this.mode === 'postgres') {
            const client = await this.pool.connect();
            try {
                await client.query('BEGIN');
                const existing = await client.query(`
                    SELECT internal_id, payload_hash FROM nsp_event_ids
                    WHERE device_id = $1 AND event_id = $2
                `, [deviceId, eventId]);
                if (existing.rows[0]) {
                    await client.query('ROLLBACK');
                    return existing.rows[0];
                }
                await client.query(`
                    INSERT INTO telemetry_events
                    (id, device_id, event_type, message_type, payload, event_timestamp, source_protocol)
                    VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
                `, [internalId, deviceId, eventType, 'telemetry', payloadJson, timestamp, 'nsp']);
                await client.query(`
                    INSERT INTO nsp_event_ids (device_id, event_id, internal_id, payload_hash)
                    VALUES ($1, $2, $3, $4)
                `, [deviceId, eventId, internalId, payloadHash]);
                await client.query('COMMIT');
                return null;
            } catch (error) {
                await client.query('ROLLBACK').catch(() => {});
                throw error;
            } finally {
                client.release();
            }
        }

        const existing = this.statements.findNspEvent.get(deviceId, eventId);
        if (existing) return existing;
        this.sqlite.exec('BEGIN IMMEDIATE');
        try {
            this.statements.insertEvent.run(
                internalId, deviceId, eventType, 'telemetry', payloadJson, timestamp, 'nsp'
            );
            this.statements.insertNspEvent.run(deviceId, eventId, internalId, payloadHash);
            this.sqlite.exec('COMMIT');
            return null;
        } catch (error) {
            this.sqlite.exec('ROLLBACK');
            throw error;
        }
    }

    toEvent(row) {
        return {
            id: row.id,
            source: { deviceId: row.device_id, protocol: row.source_protocol },
            type: row.message_type,
            eventType: row.event_type,
            payload: row.payload,
            timestamp: row.timestamp
        };
    }

    normalizeGpsStatus(row) {
        return {
            status: row.status,
            satellites: row.satellites,
            sensorStatus: row.sensorStatus,
            checkedAt: row.checkedAt
        };
    }

    async close() {
        if (this.pool) await this.pool.end();
        if (this.sqlite) this.sqlite.close();
    }
}

module.exports = { Database };
