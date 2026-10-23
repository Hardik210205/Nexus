const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '.env') });

async function migrate() {
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is required');
    }

    const sourcePath = process.env.NEXUS_DB_PATH
        ? path.resolve(process.env.NEXUS_DB_PATH)
        : path.join(__dirname, 'arhb_events.db');
    const source = new DatabaseSync(sourcePath, { readOnly: true });
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_SSL === 'require' ? { rejectUnauthorized: false } : undefined
    });

    try {
        await pool.query(`
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
        `);
        const events = source.prepare(`
            SELECT id, device_id, event_type, message_type, payload_json,
                   timestamp, source_protocol
            FROM telemetry_events ORDER BY timestamp ASC
        `).all();
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            for (const event of events) {
                await client.query(`
                    INSERT INTO telemetry_events
                    (id, device_id, event_type, message_type, payload, event_timestamp, source_protocol)
                    VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
                    ON CONFLICT (id) DO NOTHING
                `, [
                    event.id,
                    event.device_id,
                    event.event_type,
                    event.message_type,
                    event.payload_json,
                    event.timestamp,
                    event.source_protocol
                ]);
            }
            const deduplication = source.prepare(`
                SELECT device_id, event_id, internal_id, payload_hash
                FROM nsp_event_ids
            `).all();
            for (const event of deduplication) {
                await client.query(`
                    INSERT INTO nsp_event_ids
                    (device_id, event_id, internal_id, payload_hash)
                    VALUES ($1, $2, $3, $4)
                    ON CONFLICT (device_id, event_id) DO NOTHING
                `, [event.device_id, event.event_id, event.internal_id, event.payload_hash]);
            }
            await client.query('COMMIT');
            console.log(`Migrated ${events.length} telemetry events and ${deduplication.length} deduplication records.`);
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    } finally {
        source.close();
        await pool.end();
    }
}

migrate().catch((error) => {
    console.error(`[MIGRATION] ${error.message}`);
    process.exitCode = 1;
});
