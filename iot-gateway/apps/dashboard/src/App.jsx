
import { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import { io } from 'socket.io-client';
import 'leaflet/dist/leaflet.css';
import './App.css';

// Fix default marker icons in Vite
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl:
    'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl:
    'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl:
    'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

const API_URL = 'http://localhost:3000';

function formatDate(value) {
  if (!value) return '—';
  return value;
}

function App() {
  const [events, setEvents] = useState([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;

    fetch(`${API_URL}/api/events`)
      .then((response) => {
        if (!response.ok) throw new Error('Could not load event history');
        return response.json();
      })
      .then((data) => {
        if (active) {
          const rows = Array.isArray(data)
  ? data
  : data.events || data.rows || [];

setEvents(
  rows.map((event) => ({
    ...event,
    ...(typeof event.payload === 'object' && event.payload !== null
      ? event.payload
      : {}),
  }))
);
        }
      })
      .catch(() => {
        if (active) {
          setError('Cannot load events. Check that the gateway is running.');
        }
      });

    const socket = io(API_URL);

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.on('telemetry_update', (event) => {
      if (!active) return;

      setEvents((previous) => {
        const id = event.id ?? event.eventNumber;
        const duplicate = previous.some(
          (item) =>
            item.id === id ||
            (id != null && item.eventNumber === id)
        );

        if (duplicate) return previous;
        return [event, ...previous].slice(0, 500);
      });
    });

    return () => {
      active = false;
      socket.disconnect();
    };
  }, []);

  // Handle either direct API fields or the stored JSON payload.
  const normalizedEvents = events.map((event) => {
    let payload = event;

    if (typeof event.payload_json === 'string') {
      try {
        payload = { ...event, ...JSON.parse(event.payload_json) };
      } catch {
        payload = event;
      }
    }

    const latitude = Number(payload.latitude);
    const longitude = Number(payload.longitude);

    return {
      ...payload,
      id: payload.id ?? payload.eventNumber ?? `${latitude},${longitude}`,
      latitude:
        payload.latitude !== null &&
        payload.latitude !== undefined &&
        payload.latitude !== ''
          ? latitude
          : null,
      longitude:
        payload.longitude !== null &&
        payload.longitude !== undefined &&
        payload.longitude !== ''
          ? longitude
          : null,
      eventType: payload.eventType || payload.type || 'road_hazard_motion',
    };
  });

  const mappedEvents = normalizedEvents.filter(
    (event) =>
      Number.isFinite(event.latitude) &&
      Number.isFinite(event.longitude) &&
      event.latitude >= -90 &&
      event.latitude <= 90 &&
      event.longitude >= -180 &&
      event.longitude <= 180 &&
      (event.latitude !== 0 || event.longitude !== 0)
  );

  const latestEvent = normalizedEvents[0];

  const mapCenter = mappedEvents.length
    ? [mappedEvents[0].latitude, mappedEvents[0].longitude]
    : [22.298349, 73.196144];

  return (
    <main className="dashboard">
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">NEXUS UNIVERSAL IoT GATEWAY</p>
          <h1>Adaptive Road Hazard Beacon</h1>
          <p className="subtitle">
            Live sensor telemetry and GPS event monitoring
          </p>
        </div>

        <div className={`connection-status ${connected ? 'online' : 'offline'}`}>
          <span className="status-dot" />
          {connected ? 'Live connection' : 'Connecting…'}
        </div>
      </header>

      {error && <p className="error-message">{error}</p>}

      <section className="stats-grid">
        <article className="stat-card">
          <span>Total events</span>
          <strong>{normalizedEvents.length}</strong>
        </article>

        <article className="stat-card">
          <span>Events with GPS</span>
          <strong>{mappedEvents.length}</strong>
        </article>

        <article className="stat-card">
          <span>Events without GPS</span>
          <strong>{normalizedEvents.length - mappedEvents.length}</strong>
        </article>

        <article className="stat-card">
          <span>Latest event</span>
          <strong className="latest-value">
            {latestEvent ? `#${latestEvent.eventNumber ?? '—'}` : 'None'}
          </strong>
        </article>
      </section>

      <section className="panel map-panel">
        <div className="panel-heading">
          <div>
            <h2>GPS Event Map</h2>
            <p>Markers show events with valid GPS coordinates.</p>
          </div>
          <span className="count-badge">{mappedEvents.length} mapped</span>
        </div>

        <div className="map-wrapper">
          <MapContainer
            center={mapCenter}
            zoom={13}
            scrollWheelZoom
            className="event-map"
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />

            {mappedEvents.map((event, index) => (
              <Marker
                key={`${event.id}-${index}`}
                position={[event.latitude, event.longitude]}
              >
                <Popup>
                  <strong>Road Hazard Motion Event</strong>
                  <br />
                  Event: #{event.eventNumber ?? '—'}
                  <br />
                  Latitude: {event.latitude}
                  <br />
                  Longitude: {event.longitude}
                  <br />
                  Satellites: {event.satellites ?? '—'}
                  <br />
                  GPS date: {formatDate(event.gpsDate)}
                  <br />
                  GPS time: {formatDate(event.gpsTime)}
                </Popup>
              </Marker>
            ))}
          </MapContainer>
        </div>

        {mappedEvents.length === 0 && (
          <p className="map-note">
            No valid GPS coordinates yet. The map will show markers when
            an event contains valid latitude and longitude.
          </p>
        )}
      </section>

      <section className="panel history-panel">
        <div className="panel-heading">
          <div>
            <h2>Event History</h2>
            <p>Recent events received by the gateway</p>
          </div>
          <span className="count-badge">
            {normalizedEvents.length} events
          </span>
        </div>

        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Event #</th>
                <th>Type</th>
                <th>Latitude</th>
                <th>Longitude</th>
                <th>Satellites</th>
                <th>GPS Date</th>
                <th>GPS Time</th>
                <th>Location</th>
              </tr>
            </thead>

            <tbody>
              {normalizedEvents.map((event, index) => (
                <tr key={`${event.id}-${index}`}>
                  <td>#{event.eventNumber ?? '—'}</td>
                  <td>{event.eventType}</td>
                  <td>{event.latitude ?? '—'}</td>
                  <td>{event.longitude ?? '—'}</td>
                  <td>{event.satellites ?? '—'}</td>
                  <td>{formatDate(event.gpsDate)}</td>
                  <td>{formatDate(event.gpsTime)}</td>
                  <td>
                    {event.latitude !== null && event.longitude !== null ? (
                      <a
                        href={`https://www.openstreetmap.org/?mlat=${event.latitude}&mlon=${event.longitude}#map=16/${event.latitude}/${event.longitude}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View location
                      </a>
                    ) : (
                      'GPS unavailable'
                    )}
                  </td>
                </tr>
              ))}

              {normalizedEvents.length === 0 && (
                <tr>
                  <td colSpan="8" className="empty-state">
                    No events recorded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <footer className="dashboard-footer">
        ARHB · Nexus Universal IoT Gateway · OpenStreetMap
      </footer>
    </main>
  );
}

export default App;
