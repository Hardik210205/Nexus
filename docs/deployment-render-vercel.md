# Render + Vercel Deployment Guide

This guide deploys the Nexus application using:

```text
Render PostgreSQL  -> production event database
Render             -> Node.js gateway and Socket.IO API
Vercel             -> React dashboard
Arduino + bridge   -> local hardware and serial connection
```

## Current transport limitation

The current Python bridge sends telemetry using NSP/1 over a raw TLS/TCP
connection on port `3443`. A normal Render Web Service exposes HTTP and
WebSocket traffic, not an arbitrary public TCP listener.

Before production deployment, choose one of these supported paths:

1. **Render TCP support is available for the selected service/plan**: keep
   NSP/1 and configure the bridge to connect to the Render TCP endpoint.
2. **Use a normal Render Web Service**: change the bridge/gateway ingestion
   transport to HTTPS or secure WebSocket. This requires an application code
   change and is not covered by the current NSP deployment.

Do not deploy the current raw TCP bridge against a normal `onrender.com`
HTTP URL. It will not establish an NSP connection.

## Prerequisites

- GitHub repository access
- Render account
- Vercel account
- Node.js 22.13 or newer for local validation
- Production NSP certificates if keeping NSP/TCP
- A deployed or provisioned database in Render

## 1. Create the Render PostgreSQL database

In Render:

1. Open **New +**.
2. Select **PostgreSQL**.
3. Choose the region closest to the gateway service and hardware bridge.
4. Create the database.
5. Record the database name, user, and password in a secure password manager.

The Render database page shows these values:

- Port: normally `5432`
- Database: for example `nexus_13r6`
- Username: for example `nexus_13r6_user`
- Password
- Internal Database URL
- External Database URL

### Which database URL should be used?

| Where the gateway runs | URL to use |
| --- | --- |
| Render service | **Internal Database URL** |
| Local computer | External Database URL |
| Migration run from your computer | External Database URL |

The internal URL is preferred for a Render service because it stays inside
Render's private network. Never commit either URL to Git.

## 2. Verify the database connection locally

Create or update this file locally:

```text
iot-gateway/apps/gateway-core/.env
```

Use the Render **External Database URL** for a local test:

```dotenv
NEXUS_NSP_PROFILE=development
DATABASE_URL=postgresql://<render-user>:<render-password>@<render-external-host>:5432/<render-database>
DATABASE_SSL=require
```

Start the gateway:

```powershell
cd D:\IoT_Project\iot-gateway\apps\gateway-core
npm start
```

Verify:

```powershell
curl http://127.0.0.1:3000/api/health
curl http://127.0.0.1:3000/api/events
```

The health response should report:

```json
{
  "database": "connected"
}
```

The gateway creates the required PostgreSQL tables automatically on startup.

## 3. Optional: migrate existing SQLite history

If existing events in `arhb_events.db` must be retained, run the migration
before deploying the Render service.

```powershell
cd D:\IoT_Project\iot-gateway\apps\gateway-core
$env:NEXUS_DB_PATH = "D:\IoT_Project\iot-gateway\apps\gateway-core\arhb_events.db"
$env:DATABASE_URL = "postgresql://<render-user>:<render-password>@<render-external-host>:5432/<render-database>"
$env:DATABASE_SSL = "require"
npm run migrate:postgres
```

Verify the migration by starting the gateway against the same PostgreSQL
database and checking `/api/events`.

## 4. Deploy the gateway on Render

Create a new Render service connected to the GitHub repository.

Recommended settings:

```text
Service type: Web Service
Root directory: iot-gateway/apps/gateway-core
Runtime: Node
Build command: npm ci
Start command: npm start
Health check path: /api/health
```

Add these environment variables in Render:

```dotenv
NODE_ENV=production
PORT=10000
HTTP_HOST=0.0.0.0
HTTP_ALLOW_REMOTE=1

DATABASE_URL=<Render Internal Database URL>
DATABASE_SSL=require

DASHBOARD_ORIGINS=https://<your-vercel-domain>

NEXUS_NSP_ENABLED=0
NEXUS_NSP_PROFILE=production
NEXUS_NSP_HOST=0.0.0.0
NEXUS_NSP_PORT=3443
NEXUS_NSP_ALLOW_REMOTE=1
```

Use Render's **Secret Files** or secret environment variables for production
certificate material. Do not paste private keys into GitHub.

For a normal Render HTTP Web Service, set `NEXUS_NSP_ENABLED=0`. This allows
the dashboard, API, PostgreSQL, and health endpoint to run, but telemetry from
the current raw TCP bridge will not be accepted. Set it to `1` only when the
selected Render service provides a public TCP endpoint and the three
production certificate paths are configured.

If Render does not provide a public TCP endpoint for this service, the current
NSP bridge cannot connect to it. The dashboard/API deployment can still be
completed, but hardware ingestion requires either a TCP-capable service or a
future HTTPS/WSS transport migration.

## 5. Deploy the dashboard on Vercel

In Vercel:

1. Import the GitHub repository.
2. Set the project root to:

   ```text
   iot-gateway/apps/dashboard
   ```

3. Set:

   ```text
   Framework preset: Vite
   Build command: npm run build
   Output directory: dist
   Install command: npm install
   ```

4. Add this environment variable:

   ```text
   VITE_GATEWAY_URL=https://<your-render-gateway>.onrender.com
   ```

5. Deploy the project.

Vite environment variables are embedded into the browser bundle. Never put
`DATABASE_URL`, database passwords, or private certificates in Vercel
variables beginning with `VITE_`.

## 6. Complete CORS configuration

Copy the final Vercel production domain, then update the Render gateway
variable:

```dotenv
DASHBOARD_ORIGINS=https://<your-vercel-production-domain>
```

If a custom Vercel domain is also used, provide both origins separated by a
comma:

```dotenv
DASHBOARD_ORIGINS=https://dashboard.example.com,https://project.vercel.app
```

Redeploy or restart the Render service after changing the variable.

## 7. Configure the bridge

The bridge remains on the computer connected to the Arduino. It is not
deployed to Render or Vercel because it requires the Arduino USB/COM port.

For production NSP/TCP, configure:

```powershell
$env:NEXUS_NSP_PROFILE = "production"
$env:NEXUS_NSP_HOST = "<render-tcp-host>"
$env:NEXUS_NSP_PORT = "3443"
$env:NEXUS_NSP_DEVICE_ID = "arhb_uno_1"
$env:NEXUS_NSP_CA = "C:\Nexus\certs\ca-cert.pem"
$env:NEXUS_NSP_CLIENT_CERT = "C:\Nexus\certs\device-cert.pem"
$env:NEXUS_NSP_CLIENT_KEY = "C:\Nexus\certs\device-key.pem"
$env:NEXUS_SERIAL_PORT = "COM3"
```

The server certificate must be valid for the hostname in
`NEXUS_NSP_HOST`. The bridge must use the production CA and client
certificate, not the development certificates.

Start the bridge:

```powershell
cd D:\IoT_Project
python serial_bridge.py
```

## 8. Validate the deployment

### Render API

```text
https://<your-render-gateway>.onrender.com/api/health
https://<your-render-gateway>.onrender.com/api/events
https://<your-render-gateway>.onrender.com/api/gps-status
```

The health endpoint should report:

```json
{
  "database": "connected"
}
```

### Vercel dashboard

Open the Vercel URL and check:

- System status reports the gateway as available.
- Database status is connected.
- Socket.IO shows connected.
- GPS status updates.
- New events appear without a page refresh.
- Event history matches PostgreSQL data.

### Database

Confirm that the following tables exist:

```text
telemetry_events
nsp_event_ids
device_status
```

## 9. Troubleshooting

### Database authentication failed

Check:

- Render username and password
- Correct database URL
- URL-encoding special password characters
- `DATABASE_SSL=require`
- Render service and database are in compatible regions

### Dashboard has a CORS error

Check:

- `VITE_GATEWAY_URL` points to the Render gateway
- `DASHBOARD_ORIGINS` exactly matches the Vercel origin
- The Render service was redeployed after changing the variable

### Socket.IO is disconnected

Check the Render service logs and browser network console. The gateway must
be reachable over HTTPS and the Vercel origin must be allowed.

### Bridge cannot connect

Check:

- Render TCP support for the selected service/plan
- TCP endpoint and port
- Production certificate hostname
- Client certificate identity
- Firewall and provider allowlists
- `NEXUS_NSP_HOST` is not an HTTP URL

## Security rules

- Never commit `.env` files.
- Never commit `DATABASE_URL`.
- Never expose a database password in a `VITE_*` variable.
- Never use development certificates in production.
- Rotate database credentials and certificates if exposed.
- Use the Render internal database URL from the Render gateway.
- Keep the external database URL for controlled local migration only.
