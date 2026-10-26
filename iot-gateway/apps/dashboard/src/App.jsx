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
  RefreshCw,
  Satellite,
  Settings,
  Signal,
  Wifi,
  WifiOff,
} from 'lucide-react';
import 'leaflet/dist/leaflet.css';
import './App.css';

const API_URL = import.meta.env.VITE_GATEWAY_URL?.replace(/\/+$/, '') || '';
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
  const eventNumber = flattened.eventNumber ?? flattened.event_number;
  const deviceId = flattened.deviceId || flattened.source?.deviceId;
  const timestamp = flattened.timestamp || flattened.receivedAt;
  const fallbackId = [
    deviceId,
    eventNumber,
    timestamp,
    rawLatitude,
    rawLongitude,
  ].map((value) => value ?? '').join(':');

  return {
    ...flattened,
    id: flattened.id ?? fallbackId,
    eventNumber,
    eventType: flattened.eventType || flattened.type || 'telemetry',
    deviceId,
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
    timestamp,
  };
}

async function loadEventHistory() {
  const response = await fetch(`${API_URL}/api/events?limit=${MAX_EVENTS}`, {
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-cache' }
  });
  if (!response.ok) {
    throw new Error(`The gateway returned HTTP ${response.status}.`);
  }

  const data = await response.json();
  const rows = Array.isArray(data) ? data : data.events || data.rows;
  if (!Array.isArray(rows)) {
    throw new Error('The gateway returned an invalid event-history response.');
  }
  return rows.map(normalizeEvent);
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
  return Boolean(first.id && second.id && String(first.id) === String(second.id));
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
        detail="Locations are recorded with motion events after a GPS fix; GPS positions are not streamed continuously."
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
                      <dt>Device</dt><dd>{formatValue(event.deviceId)}</dd>
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
            <span>Wait for a GPS fix, then trigger a motion event. Events without a valid fix remain available in history but are not plotted.</span>
          </div>
        )}
        <div className="map-stamp">OSM / LIVE EVENT LAYER</div>
      </div>
    </section>
  );
}

function EventStream({ events, newEventId, limit, emptyMessage, onCheckStatus }) {
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
        </article>
      ))}
      {!events.length && (
        <div className="stream-empty">
          <p className="empty-copy">{emptyMessage}</p>
          {onCheckStatus && <button className="text-action" onClick={onCheckStatus}>Check gateway status <ArrowUpRight size={14} /></button>}
        </div>
      )}
    </div>
  );
}

function HistoryTable({ events, filter, setFilter, typeFilter, setTypeFilter, eventTypes, emptyMessage }) {
  return (
    <section className="history-panel panel">
      <div className="panel-heading history-heading">
        <div>
          <span className="section-kicker">RECENT / {events.length} LOADED</span>
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
            {!events.length && <tr><td colSpan="7" className="empty-state">{emptyMessage}</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function App() {
  const [events, setEvents] = useState([]);
  const [connected, setConnected] = useState(null);
  const [gatewayHealth, setGatewayHealth] = useState('checking');
  const [databaseStatus, setDatabaseStatus] = useState('unknown');
  const [nspStatus, setNspStatus] = useState('unknown');
  const [healthDetail, setHealthDetail] = useState('Checking gateway and database availability.');
  const [healthCheckedAt, setHealthCheckedAt] = useState(null);
  const [historyStatus, setHistoryStatus] = useState('loading');
  const [historyError, setHistoryError] = useState('');
  const [gpsStatus, setGpsStatus] = useState({
    status: 'checking',
    satellites: 0,
    sensorStatus: 'UNKNOWN',
    checkedAt: null
  });
  const [currentTime, setCurrentTime] = useState(0);
  const [page, setPage] = useState('overview');
  const [filter, setFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [newEventId, setNewEventId] = useState('');
  const [healthRefreshKey, setHealthRefreshKey] = useState(0);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;

    const refreshHistory = (showLoadingState = false) => {
      if (showLoadingState) setHistoryStatus('loading');
      return loadEventHistory()
        .then((historyEvents) => {
        if (!active) return;
        setEvents((previous) => {
          const merged = [...previous];
          historyEvents.forEach((historyEvent) => {
            if (!merged.some((event) => isSameEvent(event, historyEvent))) merged.push(historyEvent);
          });
          return merged
            .sort((first, second) => new Date(second.timestamp).getTime() - new Date(first.timestamp).getTime())
            .slice(0, MAX_EVENTS);
        });
        setHistoryStatus('available');
      })
        .catch((historyLoadError) => {
          if (active) {
            setHistoryStatus('unavailable');
            const detail = historyLoadError instanceof TypeError
              ? 'The gateway could not be reached.'
              : historyLoadError.message;
            setHistoryError(`Saved event history is unavailable. ${detail} Check the gateway and database status, then retry.`);
          }
        });
    };

    refreshHistory(true);
    const interval = window.setInterval(() => {
      refreshHistory();
    }, 10000);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [historyRefreshKey]);

  useEffect(() => {
    let active = true;
    const checkHealth = async () => {
      try {
        const response = await fetch(`${API_URL}/api/health`, {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache' }
        });
        if (!response.ok && response.status !== 503) {
          if (!active) return;
          setHealthCheckedAt(new Date().toISOString());
          setDatabaseStatus('unknown');
          setNspStatus('unknown');
          setGatewayHealth(response.status === 502 || response.status === 504 ? 'offline' : 'degraded');
          setHealthDetail(`Gateway health check returned HTTP ${response.status}. Check the gateway service and logs.`);
          return;
        }

        const health = await response.json();
        if (!active) return;

        setHealthCheckedAt(health.checkedAt || new Date().toISOString());
        setDatabaseStatus(health.database || 'unknown');
        setNspStatus(
          health.nsp === 'listening' || health.nsp === 'unavailable'
            ? health.nsp
            : 'unreported'
        );
        if (
          health.status === 'ok' &&
          health.database === 'connected' &&
          health.nsp !== 'unavailable' &&
          response.ok
        ) {
          setGatewayHealth('healthy');
          setHealthDetail(health.nsp === 'listening'
            ? 'Gateway API, SQLite, and the NSP TLS listener are available.'
            : 'Gateway API and SQLite are available; this gateway version does not report NSP listener health. The bridge heartbeat below verifies device connectivity.');
        } else if (health.status === 'degraded' && health.database === 'unavailable') {
          setGatewayHealth('degraded');
          setHealthDetail('Gateway responded, but its database is unavailable. Check the gateway logs and database file.');
        } else if (health.nsp === 'unavailable') {
          setGatewayHealth('degraded');
          setHealthDetail('Gateway API and SQLite responded, but the NSP listener is unavailable. Check gateway credentials, port, and logs.');
        } else if (!response.ok) {
          setGatewayHealth('degraded');
          setHealthDetail(`Gateway responded with HTTP ${response.status}. Check the gateway API response and logs.`);
        } else {
          setGatewayHealth('degraded');
          setHealthDetail('Gateway returned an unrecognized health status. Check that the dashboard and gateway versions match.');
        }
      } catch (healthError) {
        if (!active) return;
        setGatewayHealth('offline');
        setDatabaseStatus('unknown');
        setNspStatus('unknown');
        setHealthCheckedAt(new Date().toISOString());
        setHealthDetail(healthError instanceof TypeError
          ? 'Could not reach the gateway health endpoint. Confirm the gateway is running and reachable.'
          : 'The gateway health endpoint returned an invalid response. Check the gateway version and logs.');
      }
    };

    checkHealth();
    const interval = window.setInterval(checkHealth, 10000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [healthRefreshKey]);

  useEffect(() => {
    let active = true;
    const socket = io(API_URL);
    const applyGpsStatus = (status) => {
      if (
        status &&
        ['unknown', 'FIX', 'NO_FIX', 'NO_DATA'].includes(status.status) &&
        Number.isInteger(status.satellites) &&
        (status.checkedAt === null || typeof status.checkedAt === 'string') &&
        (status.sensorStatus === undefined ||
          ['UNKNOWN', 'READY', 'ERROR'].includes(status.sensorStatus))
      ) {
        setGpsStatus({ ...status, sensorStatus: status.sensorStatus || 'UNKNOWN' });
      }
    };

    const refreshGpsStatus = () => fetch(`${API_URL}/api/gps-status`, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' }
    })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((status) => {
        if (active) applyGpsStatus(status);
      })
      .catch(() => {
        if (active) {
          setGpsStatus({
            status: 'unavailable',
            satellites: 0,
            sensorStatus: 'UNKNOWN',
            checkedAt: null
          });
        }
      });
    refreshGpsStatus();
    const gpsInterval = window.setInterval(refreshGpsStatus, 5000);

    socket.on('connect', () => {
      if (active) {
        setConnected(true);
        setHistoryStatus('loading');
        setHistoryError('');
        setHistoryRefreshKey((value) => value + 1);
      }
    });
    socket.on('disconnect', () => {
      if (active) setConnected(false);
    });
    socket.on('connect_error', () => {
      if (active) setConnected(false);
    });
    socket.on('gps_status_update', (status) => {
      if (active) applyGpsStatus(status);
    });
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
      window.clearInterval(gpsInterval);
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => setCurrentTime(Date.now()), 5000);
    return () => window.clearInterval(interval);
  }, []);

  // Keep-alive: ping the Render backend every 8 min to prevent free-tier spin-down.
  // Render sleeps after 15 min of inactivity; 8 min gives a safe margin.
  // Also fires immediately on mount so a cold-start begins as soon as the page loads.
  useEffect(() => {
    if (!API_URL) return; // no-op in local dev when API_URL is empty
    const ping = () => {
      fetch(`${API_URL}/api/health`, { cache: 'no-store' })
        .then(() => console.log('[KEEP-ALIVE] Render backend pinged'))
        .catch(() => console.warn('[KEEP-ALIVE] Ping failed — backend may be cold-starting'));
    };
    ping(); // immediate warm-up on page load
    const keepAliveInterval = window.setInterval(ping, 8 * 60 * 1000); // every 8 minutes
    return () => window.clearInterval(keepAliveInterval);
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
  const systemStatus = gatewayHealth === 'checking'
    ? 'CHECKING SYSTEM'
    : gatewayHealth === 'offline'
      ? 'GATEWAY UNAVAILABLE'
      : gatewayHealth === 'degraded'
        ? 'GATEWAY DEGRADED'
        : connected === true
          ? 'GATEWAY AVAILABLE'
        : connected === false
          ? 'LIVE STREAM DISCONNECTED'
          : 'CONNECTING LIVE STREAM';
  const statusDetail = gatewayHealth === 'healthy' && connected
    ? 'Gateway API, database, and live updates are connected.'
    : gatewayHealth === 'healthy' && connected === false
      ? 'Gateway API and database are available; live updates are disconnected.'
      : gatewayHealth === 'healthy'
      ? 'Gateway API and database are available; connecting to live telemetry.'
      : healthDetail;
  const systemTone = gatewayHealth === 'checking'
    ? 'is-unknown'
    : gatewayHealth === 'offline'
      ? 'is-offline'
      : gatewayHealth === 'degraded' || connected === false
      ? 'is-degraded'
      : connected === true
        ? 'is-online'
        : 'is-unknown';
  const gpsStatusIsStale = gpsStatus.checkedAt
    ? currentTime - new Date(gpsStatus.checkedAt).getTime() > 15000
    : false;
  const gpsStatusLabel = gpsStatus.status === 'checking'
    ? 'Checking GPS receiver…'
    : gpsStatus.status === 'unavailable'
      ? 'GPS diagnostics unavailable'
      : gpsStatus.status === 'unknown'
        ? 'Waiting for bridge status'
        : gpsStatusIsStale
          ? 'GPS status is stale'
          : gpsStatus.status === 'FIX'
            ? `Fix available (${gpsStatus.satellites} satellites)`
            : gpsStatus.status === 'NO_FIX'
              ? `Waiting for a fix (${gpsStatus.satellites} satellites)`
              : 'No GPS data from receiver';
  const gpsStatusDetail = gpsStatus.status === 'unavailable'
    ? 'Update/restart the gateway and serial bridge to enable GPS diagnostics.'
    : gpsStatus.status === 'NO_DATA'
      ? 'Check receiver power, common ground, GPS TX to Arduino D4, and the receiver baud rate.'
      : gpsStatus.status === 'NO_FIX'
        ? 'The receiver is sending data but has no valid fix. Move the antenna outdoors with a clear sky view.'
        : gpsStatus.status === 'FIX'
          ? 'Coordinates are attached to motion events; the map does not track continuously.'
          : 'GPS status is reported by the serial bridge.';
  const sensorStatusIsReady = gpsStatus.sensorStatus === 'READY' && !gpsStatusIsStale;
  const sensorStatusLabel = gpsStatusIsStale
    ? 'Heartbeat stale'
    : gpsStatus.sensorStatus === 'READY'
      ? 'MPU6050 sampling'
      : gpsStatus.sensorStatus === 'ERROR'
        ? 'MPU6050 initialization failed'
        : 'Waiting for bridge heartbeat';
  const requestHistoryRefresh = () => {
    setHistoryStatus('loading');
    setHistoryError('');
    setHistoryRefreshKey((value) => value + 1);
  };
  const requestHealthRefresh = () => {
    setGatewayHealth('checking');
    setHealthRefreshKey((value) => value + 1);
  };
  const noEventsMessage = historyStatus === 'loading'
    ? 'Loading saved event history…'
    : historyStatus === 'unavailable'
      ? 'Saved event history is unavailable. Check the gateway status and retry.'
      : 'No telemetry events have arrived yet. Start the gateway and serial bridge, then verify their connection status.';
  const historyEmptyMessage = normalizedEvents.length
    ? 'No events match these filters. Change the GPS or event-type filters to see other records.'
    : noEventsMessage;

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
        <div className={`system-state ${systemTone}`}>
          {systemTone === 'is-online' ? <Wifi size={16} /> : systemTone === 'is-unknown' ? <Activity size={16} /> : <WifiOff size={16} />}
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

      {historyError && (
        <div className="notice notice-error" role="alert">
          <AlertTriangle size={16} />
          <span>{historyError}</span>
          <button className="notice-action" onClick={requestHistoryRefresh}>Retry history</button>
        </div>
      )}

      {page === 'overview' && (
        <>
          <section className="overview-strip" aria-label="System overview">
            <div className="overview-intro"><span className="section-kicker">FIELD OVERVIEW</span><strong>Roadside telemetry</strong><span>{historyStatus === 'loading' ? 'Loading saved event history…' : historyStatus === 'available' ? 'Saved history loaded; live events update automatically.' : 'Saved history unavailable; live events may still arrive.'}</span></div>
            <div className="overview-value"><Activity size={16} /><span>LOADED</span><strong>{normalizedEvents.length}</strong><small>recent events</small></div>
            <div className="overview-value"><MapPin size={16} /><span>POSITIONED</span><strong>{mappedEvents.length}</strong><small>with GPS</small></div>
            <div className={`overview-value gps-overview ${gpsStatus.status === 'FIX' && !gpsStatusIsStale ? 'is-fixed' : 'is-searching'}`} title={gpsStatusDetail}><Satellite size={16} /><span>GPS RECEIVER</span><strong>{gpsStatus.status === 'FIX' && !gpsStatusIsStale ? 'FIX' : gpsStatus.status === 'NO_FIX' ? 'NO FIX' : gpsStatus.status === 'NO_DATA' ? 'NO DATA' : gpsStatusIsStale ? 'STALE' : 'WAITING'}</strong><small>{gpsStatus.satellites} satellites</small></div>
            <div className="overview-value latest"><Clock3 size={16} /><span>LATEST EVENT</span><strong>{formatValue(latestEvent?.eventNumber ? `#${latestEvent.eventNumber}` : '—')}</strong><small>{latestEvent ? formatTimestamp(latestEvent.timestamp) : 'No events yet'}</small></div>
          </section>
          <main className="overview-grid">
            <section className="panel stream-panel">
              <PanelHeading kicker="LIVE EVENT STREAM" title="Incoming records" detail="New records appear at the top of the operational feed.">
                <span className="stream-count"><span className={`status-pip ${connected === true ? 'is-online' : connected === false ? 'is-degraded' : 'is-unknown'}`} /> {normalizedEvents.length} loaded</span>
              </PanelHeading>
              <EventStream
                events={normalizedEvents}
                newEventId={newEventId}
                limit={6}
                emptyMessage={noEventsMessage}
                onCheckStatus={() => setPage('system')}
              />
              <button className="text-action" onClick={() => setPage('events')}>View complete event history <ArrowUpRight size={14} /></button>
            </section>
            <section className="panel overview-status">
              <PanelHeading kicker="LINK STATUS" title="Gateway channel" compact><Signal size={18} className={connected === true ? 'icon-green' : 'icon-amber'} /></PanelHeading>
              <div className={`rail-status ${systemTone}`}><span className="status-pip" /><strong>{systemStatus}</strong></div>
              <dl className="telemetry-list">
                <div><dt><Antenna size={14} /> Transport</dt><dd>Socket.IO</dd></div>
                <div><dt><Database size={14} /> Persistence</dt><dd>PostgreSQL</dd></div>
                <div><dt><Radio size={14} /> Source</dt><dd>{latestEvent?.deviceId || 'Not reported'}</dd></div>
                <div><dt><Satellite size={14} /> GPS receiver</dt><dd title={gpsStatusDetail}>{gpsStatusIsStale ? 'Status stale' : gpsStatusLabel}</dd></div>
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
              <span className="stream-count"><span className={`status-pip ${connected === true ? 'is-online' : connected === false ? 'is-degraded' : 'is-unknown'}`} /> {filteredEvents.length} loaded</span>
            </PanelHeading>
            <EventStream
              events={filteredEvents}
              newEventId={newEventId}
              limit={12}
              emptyMessage={filteredEvents.length ? '' : historyEmptyMessage}
              onCheckStatus={normalizedEvents.length ? null : () => setPage('system')}
            />
          </section>
          <HistoryTable events={filteredEvents} filter={filter} setFilter={setFilter} typeFilter={typeFilter} setTypeFilter={setTypeFilter} eventTypes={eventTypes} emptyMessage={historyEmptyMessage} />
        </main>
      )}

      {page === 'system' && (
        <main className="system-page">
          <section className="panel system-hero">
            <PanelHeading kicker="SYSTEM STATUS" title="Gateway diagnostics" detail="Connection and data availability reported by the running application." />
            <div className={`diagnostic-banner ${systemTone}`}>
              {systemTone === 'is-online' ? <Wifi size={22} /> : systemTone === 'is-unknown' ? <Activity size={22} /> : <WifiOff size={22} />}
              <div><strong>{systemStatus}</strong><span>{statusDetail}</span></div>
            </div>
            <div className="diagnostic-actions">
              <span>Last checked: {formatTimestamp(healthCheckedAt)}</span>
              <button className="text-action" onClick={requestHealthRefresh} disabled={gatewayHealth === 'checking'}>
                <RefreshCw size={14} /> {gatewayHealth === 'checking' ? 'Checking gateway…' : 'Check gateway now'}
              </button>
            </div>
            <div className="diagnostic-grid">
              <div><Gauge size={18} /><span>Recent records loaded</span><strong>{normalizedEvents.length}</strong></div>
              <div><MapPin size={18} /><span>Valid positions</span><strong>{mappedEvents.length}</strong></div>
              <div><Satellite size={18} /><span>GPS unavailable</span><strong>{gpsMissingCount}</strong></div>
              <div><Database size={18} /><span>Database check</span><strong>{databaseStatus === 'unknown' ? 'Unknown' : databaseStatus}</strong></div>
            </div>
          </section>
          <section className="panel integration-panel">
            <PanelHeading kicker="INTEGRATION STATUS" title="Gateway services" detail="Statuses below come from the live API, database check, and browser connection." />
            <div className="integration-row"><Antenna size={18} /><div><strong>Gateway API and database</strong><span>{healthDetail}</span></div><b className={gatewayHealth === 'healthy' ? 'healthy' : gatewayHealth === 'checking' ? 'waiting' : 'unavailable'}>{gatewayHealth}</b></div>
            <div className="integration-row"><Signal size={18} /><div><strong>NSP TLS listener</strong><span>Gateway health probe verifies the NSP listener is bound and available.</span></div><b className={nspStatus === 'listening' ? 'healthy' : nspStatus === 'unknown' || nspStatus === 'unreported' ? 'waiting' : 'unavailable'}>{nspStatus}</b></div>
            <div className="integration-row"><Radio size={18} /><div><strong>Live telemetry updates</strong><span>Socket.IO browser connection</span></div><b className={connected === true ? 'healthy' : connected === false ? 'unavailable' : 'waiting'}>{connected === true ? 'CONNECTED' : connected === false ? 'DISCONNECTED' : 'CONNECTING'}</b></div>
            <div className="integration-row"><Gauge size={18} /><div><strong>Motion sensor / bridge heartbeat</strong><span>{sensorStatusLabel}{gpsStatus.checkedAt ? `; last bridge update: ${formatTimestamp(gpsStatus.checkedAt)}.` : '. Start the bridge and confirm recurring Arduino status.'}</span></div><b className={sensorStatusIsReady ? 'healthy' : gpsStatus.sensorStatus === 'ERROR' && !gpsStatusIsStale ? 'unavailable' : 'waiting'}>{sensorStatusIsReady ? 'READY' : gpsStatus.sensorStatus === 'ERROR' && !gpsStatusIsStale ? 'ERROR' : gpsStatusIsStale ? 'STALE' : 'WAITING'}</b></div>
            <div className="integration-row"><Satellite size={18} /><div><strong>GPS receiver</strong><span>{gpsStatusIsStale ? 'Last status is more than 15 seconds old. ' : ''}{gpsStatusDetail}{gpsStatus.checkedAt ? ` Last update: ${formatTimestamp(gpsStatus.checkedAt)}.` : ''}</span></div><b className={gpsStatus.status === 'FIX' && !gpsStatusIsStale ? 'healthy' : gpsStatus.status === 'checking' ? 'waiting' : 'unavailable'}>{gpsStatusIsStale ? 'STALE' : gpsStatus.status === 'FIX' ? 'FIX' : gpsStatus.status === 'checking' ? 'CHECKING' : gpsStatus.status === 'NO_FIX' ? 'NO FIX' : gpsStatus.status === 'NO_DATA' ? 'NO DATA' : gpsStatus.status === 'unknown' ? 'WAITING' : 'UNAVAILABLE'}</b></div>
            <div className="integration-row"><Database size={18} /><div><strong>Saved event history</strong><span>PostgreSQL check: {databaseStatus}; history request: {historyStatus}</span></div><b className={historyStatus === 'available' ? 'healthy' : historyStatus === 'loading' ? 'waiting' : 'unavailable'}>{historyStatus}</b></div>
            <div className="integration-row"><MapPin size={18} /><div><strong>Geographic layer</strong><span>Valid event coordinates are mapped. External map tile availability is not monitored.</span></div><b className="waiting">NOT CHECKED</b></div>
            {historyStatus !== 'loading' && (
              <button className="text-action" onClick={requestHistoryRefresh}><RefreshCw size={14} /> Refresh saved history</button>
            )}
          </section>
        </main>
      )}

      <footer className="dashboard-footer"><span>ARHB / NEXUS GATEWAY</span><span>Telemetry is displayed as received from connected hardware.</span><span>OpenStreetMap attribution applies to the geographic layer.</span></footer>
    </div>
  );
}

export default App;
