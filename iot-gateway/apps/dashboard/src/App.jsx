import { useEffect, useMemo, useState } from 'react';
import { MapContainer, Marker, Popup, TileLayer } from 'react-leaflet';
import L from 'leaflet';
import { io } from 'socket.io-client';
import {
  Activity,
  AlertTriangle,
  Antenna,
  ArrowUpRight,
  CircleHelp,
  Clock3,
  Database,
  Filter,
  Gauge,
  LayoutDashboard,
  Map as MapIcon,
  MapPin,
  Radio,
  Satellite,
  Settings,
  Signal,
  Wifi,
  WifiOff,
} from 'lucide-react';
import 'leaflet/dist/leaflet.css';
import './App.css';

const API_URL = 'http://localhost:3000';
const MAX_EVENTS = 500;

const markerIcon = L.divIcon({
  className: 'event-marker',
  html: '<span></span>',
  iconSize: [22, 22],
  iconAnchor: [11, 11],
  popupAnchor: [0, -12],
});

function formatValue(value) {
  return value === null || value === undefined || value === '' ? '—' : String(value);
}

function formatTimestamp(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function flattenEvent(event) {
  const payload = event && typeof event.payload === 'object' && event.payload !== null
    ? event.payload
    : {};
  const nestedPayload = payload.payload && typeof payload.payload === 'object' ? payload.payload : {};
  return { ...event, ...payload, ...nestedPayload };
}

function normalizeEvent(event) {
  const flattened = flattenEvent(event);
  const rawLatitude = flattened.latitude;
  const rawLongitude = flattened.longitude;
  const latitude = rawLatitude === null || rawLatitude === undefined || rawLatitude === '' ? null : Number(rawLatitude);
  const longitude = rawLongitude === null || rawLongitude === undefined || rawLongitude === '' ? null : Number(rawLongitude);

  return {
    ...flattened,
    id: flattened.id ?? flattened.eventNumber ?? `${rawLatitude}-${rawLongitude}-${flattened.timestamp}`,
    eventNumber: flattened.eventNumber ?? flattened.event_number,
    eventType: flattened.eventType || flattened.type || 'telemetry',
    deviceId: flattened.deviceId || flattened.source?.deviceId,
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
    timestamp: flattened.timestamp || flattened.receivedAt,
  };
}

function hasValidCoordinates(event) {
  return Number.isFinite(event.latitude) && Number.isFinite(event.longitude)
    && event.latitude >= -90 && event.latitude <= 90
    && event.longitude >= -180 && event.longitude <= 180
    && (event.latitude !== 0 || event.longitude !== 0);
}

function eventKey(event) {
  return String(event.id ?? event.eventNumber ?? `${event.timestamp}-${event.latitude}-${event.longitude}`);
}

function isSameEvent(first, second) {
  if (first.id && second.id && String(first.id) === String(second.id)) return true;
  return first.eventNumber !== null && first.eventNumber !== undefined
    && second.eventNumber !== null && second.eventNumber !== undefined
    && String(first.eventNumber) === String(second.eventNumber);
}

function PanelHeading({ kicker, title, detail, children, compact = false }) {
  return (
    <div className={`panel-heading ${compact ? 'compact' : ''}`}>
      <div>
        <span className="section-kicker">{kicker}</span>
        <h2>{title}</h2>
        {detail && <p>{detail}</p>}
      </div>
      {children}
    </div>
  );
}

function MapView({ mappedEvents, fullPage = false }) {
  const mapCenter = mappedEvents.length ? [mappedEvents[0].latitude, mappedEvents[0].longitude] : null;

  return (
    <section className={`map-panel panel ${fullPage ? 'map-page-panel' : ''}`}>
      <PanelHeading
        kicker="GEOGRAPHIC OPERATIONS"
        title="Event field map"
        detail="Only telemetry with valid latitude and longitude is plotted."
      >
        <div className="map-legend" aria-label="Map legend">
          <span><i className="legend-dot" /> Recorded event</span>
          <span><i className="legend-line" /> OpenStreetMap</span>
        </div>
      </PanelHeading>
      <div className="map-frame">
        {mapCenter ? (
          <MapContainer center={mapCenter} zoom={13} scrollWheelZoom className="event-map">
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            {mappedEvents.map((event) => (
              <Marker key={eventKey(event)} position={[event.latitude, event.longitude]} icon={markerIcon}>
                <Popup>
                  <div className="popup-content">
                    <strong>Recorded telemetry</strong>
                    <dl>
                      <dt>Event</dt><dd>#{formatValue(event.eventNumber)}</dd>
                      <dt>Received</dt><dd>{formatTimestamp(event.timestamp)}</dd>
                      <dt>Coordinates</dt><dd>{event.latitude.toFixed(5)}, {event.longitude.toFixed(5)}</dd>
                      <dt>Satellites</dt><dd>{formatValue(event.satellites)}</dd>
                    </dl>
                  </div>
                </Popup>
              </Marker>
            ))}
          </MapContainer>
        ) : (
          <div className="map-empty">
            <div className="empty-crosshair"><MapPin size={22} /></div>
            <strong>No valid GPS positions</strong>
            <span>Events remain available in the stream and history until coordinates are verified.</span>
          </div>
        )}
        <div className="map-stamp">OSM / LIVE EVENT LAYER</div>
      </div>
    </section>
  );
}

function EventStream({ events, newEventId, limit }) {
  return (
    <div className="event-stream">
      {events.slice(0, limit).map((event) => (
        <article className={`stream-entry ${eventKey(event) === newEventId ? 'is-new' : ''}`} key={eventKey(event)}>
          <div className="stream-marker" />
          <div className="stream-body">
            <div className="stream-topline">
              <strong>{event.eventNumber ? `EVENT #${event.eventNumber}` : 'UNNUMBERED EVENT'}</strong>
              <time>{formatTimestamp(event.timestamp)}</time>
            </div>
            <div className="stream-meta">
              <span>{event.eventType}</span>
              <span className={hasValidCoordinates(event) ? 'gps-valid' : 'gps-missing'}>
                {hasValidCoordinates(event) ? 'GPS VERIFIED' : 'GPS UNAVAILABLE'}
              </span>
              {event.deviceId && <span>SOURCE {event.deviceId}</span>}
            </div>
          </div>
          <ArrowUpRight size={15} className="entry-arrow" />
        </article>
      ))}
      {!events.length && <p className="empty-copy">No records match the current filters.</p>}
    </div>
  );
}

function HistoryTable({ events, filter, setFilter, typeFilter, setTypeFilter, eventTypes }) {
  return (
    <section className="history-panel panel">
      <div className="panel-heading history-heading">
        <div>
          <span className="section-kicker">ARCHIVE / LAST {events.length}</span>
          <h2>Event history</h2>
        </div>
        <div className="filter-controls">
          <Filter size={15} />
          <label>
            <span className="sr-only">Filter by GPS</span>
            <select value={filter} onChange={(event) => setFilter(event.target.value)}>
              <option value="all">All positions</option>
              <option value="gps">GPS verified</option>
              <option value="missing">GPS unavailable</option>
            </select>
          </label>
          <label>
            <span className="sr-only">Filter by event type</span>
            <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
              <option value="all">All types</option>
              {eventTypes.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
          </label>
        </div>
      </div>
      <div className="table-container">
        <table>
          <caption className="sr-only">Recorded telemetry event history</caption>
          <thead><tr><th>Event</th><th>Type</th><th>Received</th><th>Coordinates</th><th>Satellites</th><th>Source</th><th>Map</th></tr></thead>
          <tbody>
            {events.map((event) => (
              <tr key={`history-${eventKey(event)}`}>
                <td className="mono event-number">#{formatValue(event.eventNumber)}</td>
                <td><span className="type-label">{event.eventType}</span></td>
                <td className="mono">{formatTimestamp(event.timestamp)}</td>
                <td className="mono coordinates-cell">
                  {hasValidCoordinates(event) ? `${event.latitude.toFixed(5)}, ${event.longitude.toFixed(5)}` : <span className="muted-label">GPS unavailable</span>}
                </td>
                <td className="mono">{formatValue(event.satellites)}</td>
                <td className="mono">{formatValue(event.deviceId)}</td>
                <td>{hasValidCoordinates(event) ? (
                  <a className="map-link" href={`https://www.openstreetmap.org/?mlat=${event.latitude}&mlon=${event.longitude}#map=16/${event.latitude}/${event.longitude}`} target="_blank" rel="noreferrer">
                    Open <ArrowUpRight size={13} />
                  </a>
                ) : <span className="muted-label">Not mapped</span>}</td>
              </tr>
            ))}
            {!events.length && <tr><td colSpan="7" className="empty-state">No events recorded yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function App() {
  const [events, setEvents] = useState([]);
  const [connected, setConnected] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState('overview');
  const [filter, setFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [newEventId, setNewEventId] = useState('');

  useEffect(() => {
    let active = true;
    fetch(`${API_URL}/api/events`)
      .then((response) => {
        if (!response.ok) throw new Error('Could not load event history');
        return response.json();
      })
      .then((data) => {
        if (!active) return;
        const rows = Array.isArray(data) ? data : data.events || data.rows || [];
        const historyEvents = rows.map(normalizeEvent);
        setEvents((previous) => {
          const merged = [...previous];
          historyEvents.forEach((historyEvent) => {
            if (!merged.some((event) => isSameEvent(event, historyEvent))) merged.push(historyEvent);
          });
          return merged.slice(0, MAX_EVENTS);
        });
        setHistoryLoaded(true);
      })
      .catch(() => {
        if (active) {
          setError('History unavailable. The gateway may be offline.');
          setHistoryLoaded(true);
        }
      });

    const socket = io(API_URL);
    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));
    socket.on('telemetry_update', (incomingEvent) => {
      if (!active) return;
      const nextEvent = normalizeEvent(incomingEvent);
      setEvents((previous) => {
        if (previous.some((event) => isSameEvent(event, nextEvent))) return previous;
        return [nextEvent, ...previous].slice(0, MAX_EVENTS);
      });
      setNewEventId(eventKey(nextEvent));
      window.setTimeout(() => setNewEventId(''), 2400);
    });
    return () => {
      active = false;
      socket.disconnect();
    };
  }, []);

  const normalizedEvents = useMemo(() => events.map(normalizeEvent), [events]);
  const mappedEvents = useMemo(() => normalizedEvents.filter(hasValidCoordinates), [normalizedEvents]);
  const eventTypes = useMemo(() => [...new Set(normalizedEvents.map((event) => event.eventType).filter(Boolean))], [normalizedEvents]);
  const filteredEvents = useMemo(() => normalizedEvents.filter((event) => {
    const gpsMatches = filter === 'all' || (filter === 'gps' ? hasValidCoordinates(event) : !hasValidCoordinates(event));
    return gpsMatches && (typeFilter === 'all' || event.eventType === typeFilter);
  }), [filter, normalizedEvents, typeFilter]);
  const latestEvent = normalizedEvents[0];
  const gpsMissingCount = normalizedEvents.length - mappedEvents.length;
  const systemStatus = connected ? 'STREAM ACTIVE' : 'GATEWAY OFFLINE';
  const statusDetail = connected ? 'Socket.IO link established' : 'Waiting for gateway connection';

  const navigation = [
    { id: 'overview', label: 'Operations overview', icon: LayoutDashboard },
    { id: 'map', label: 'Live event map', icon: MapIcon, count: mappedEvents.length },
    { id: 'events', label: 'Event history', icon: Activity, count: normalizedEvents.length },
    { id: 'system', label: 'System status', icon: Settings },
  ];

  return (
    <div className="app-shell">
      <header className="operations-header">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
          <div>
            <p className="eyebrow">NEXUS UNIVERSAL IoT GATEWAY <span>/</span> OPERATIONS</p>
            <h1>Adaptive Road Hazard Beacon</h1>
            <p className="subtitle">Distributed roadside sensing for motion events and geographic traceability.</p>
          </div>
        </div>
        <div className={`system-state ${connected ? 'is-online' : 'is-offline'}`}>
          {connected ? <Wifi size={16} /> : <WifiOff size={16} />}
          <div><strong>{systemStatus}</strong><span>{statusDetail}</span></div>
        </div>
      </header>

      <nav className="app-navigation" aria-label="Application sections">
        {navigation.map(({ id, label, icon: Icon, count }) => (
          <button className={`nav-item ${page === id ? 'active' : ''}`} key={id} onClick={() => setPage(id)} aria-current={page === id ? 'page' : undefined}>
            <Icon size={16} /><span>{label}</span>{count !== undefined && <em>{count}</em>}
          </button>
        ))}
      </nav>
      <div className="header-rule" />

      {error && <div className="notice notice-error" role="status"><AlertTriangle size={16} /><span>{error}</span></div>}

      {page === 'overview' && (
        <>
          <section className="overview-strip" aria-label="System overview">
            <div className="overview-intro"><span className="section-kicker">FIELD OVERVIEW</span><strong>Roadside telemetry</strong><span>{historyLoaded ? 'Gateway history synchronized' : 'Synchronizing gateway history…'}</span></div>
            <div className="overview-value"><Activity size={16} /><span>RECEIVED</span><strong>{normalizedEvents.length}</strong><small>events</small></div>
            <div className="overview-value"><MapPin size={16} /><span>POSITIONED</span><strong>{mappedEvents.length}</strong><small>with GPS</small></div>
            <div className="overview-value warning"><CircleHelp size={16} /><span>UNPOSITIONED</span><strong>{gpsMissingCount}</strong><small>without GPS</small></div>
            <div className="overview-value latest"><Clock3 size={16} /><span>LATEST EVENT</span><strong>{formatValue(latestEvent?.eventNumber ? `#${latestEvent.eventNumber}` : '—')}</strong><small>{latestEvent ? formatTimestamp(latestEvent.timestamp) : 'No events yet'}</small></div>
          </section>
          <main className="overview-grid">
            <section className="panel stream-panel">
              <PanelHeading kicker="LIVE EVENT STREAM" title="Incoming records" detail="New records appear at the top of the operational feed.">
                <span className="stream-count"><span className="status-pip" /> {normalizedEvents.length} total</span>
              </PanelHeading>
              <EventStream events={normalizedEvents} newEventId={newEventId} limit={6} />
              <button className="text-action" onClick={() => setPage('events')}>View complete event history <ArrowUpRight size={14} /></button>
            </section>
            <section className="panel overview-status">
              <PanelHeading kicker="LINK STATUS" title="Gateway channel" compact><Signal size={18} className={connected ? 'icon-green' : 'icon-amber'} /></PanelHeading>
              <div className={`rail-status ${connected ? 'is-online' : 'is-offline'}`}><span className="status-pip" /><strong>{systemStatus}</strong></div>
              <dl className="telemetry-list">
                <div><dt><Antenna size={14} /> Transport</dt><dd>Socket.IO</dd></div>
                <div><dt><Database size={14} /> Persistence</dt><dd>SQLite</dd></div>
                <div><dt><Radio size={14} /> Source</dt><dd>{latestEvent?.deviceId || 'Not reported'}</dd></div>
                <div><dt><Satellite size={14} /> GPS data</dt><dd>{mappedEvents.length ? 'Available' : 'Not verified'}</dd></div>
              </dl>
              <button className="text-action" onClick={() => setPage('system')}>Open system status <ArrowUpRight size={14} /></button>
            </section>
          </main>
        </>
      )}

      {page === 'map' && <main className="single-page"><MapView mappedEvents={mappedEvents} fullPage /></main>}

      {page === 'events' && (
        <main className="events-page">
          <section className="panel stream-panel">
            <PanelHeading kicker="LIVE EVENT STREAM" title="Incoming records" detail="New records appear at the top of the operational feed.">
              <span className="stream-count"><span className="status-pip" /> {filteredEvents.length} shown</span>
            </PanelHeading>
            <EventStream events={filteredEvents} newEventId={newEventId} limit={12} />
          </section>
          <HistoryTable events={filteredEvents} filter={filter} setFilter={setFilter} typeFilter={typeFilter} setTypeFilter={setTypeFilter} eventTypes={eventTypes} />
        </main>
      )}

      {page === 'system' && (
        <main className="system-page">
          <section className="panel system-hero">
            <PanelHeading kicker="SYSTEM STATUS" title="Gateway diagnostics" detail="Connection and data availability reported by the running application." />
            <div className={`diagnostic-banner ${connected ? 'is-online' : 'is-offline'}`}>
              {connected ? <Wifi size={22} /> : <WifiOff size={22} />}
              <div><strong>{systemStatus}</strong><span>{statusDetail}</span></div>
            </div>
            <div className="diagnostic-grid">
              <div><Gauge size={18} /><span>History records</span><strong>{normalizedEvents.length}</strong></div>
              <div><MapPin size={18} /><span>Valid positions</span><strong>{mappedEvents.length}</strong></div>
              <div><Satellite size={18} /><span>GPS unavailable</span><strong>{gpsMissingCount}</strong></div>
              <div><Database size={18} /><span>Storage</span><strong>SQLite</strong></div>
            </div>
          </section>
          <section className="panel integration-panel">
            <PanelHeading kicker="INTEGRATION SURFACE" title="Connected services" detail="Static connection details for the current gateway deployment." />
            <div className="integration-row"><Antenna size={18} /><div><strong>Socket.IO telemetry stream</strong><span>Listening for telemetry_update events</span></div><b className={connected ? 'healthy' : 'waiting'}>{connected ? 'CONNECTED' : 'WAITING'}</b></div>
            <div className="integration-row"><Database size={18} /><div><strong>SQLite event history</strong><span>History endpoint: /api/events</span></div><b className={historyLoaded ? 'healthy' : 'waiting'}>{historyLoaded ? 'AVAILABLE' : 'LOADING'}</b></div>
            <div className="integration-row"><MapPin size={18} /><div><strong>Geographic layer</strong><span>OpenStreetMap tiles; only verified coordinates plotted</span></div><b className="healthy">READY</b></div>
          </section>
        </main>
      )}

      <footer className="dashboard-footer"><span>ARHB / NEXUS GATEWAY</span><span>Telemetry is displayed as received from connected hardware.</span><span>OpenStreetMap attribution applies to the geographic layer.</span></footer>
    </div>
  );
}

export default App;
