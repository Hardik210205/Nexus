import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Activity, Thermometer, Ruler, Database, LayoutDashboard, Settings, Router } from 'lucide-react';
import './App.css';

const socket = io('http://localhost:3000');

function App() {
  const [temperature, setTemperature] = useState('--');
  const [distance, setDistance] = useState('--');
  const [connected, setConnected] = useState(false);
  const [logs, setLogs] = useState([]);
  const [chartData, setChartData] = useState([]);

  useEffect(() => {
    socket.on('connect', () => {
      setConnected(true);
      addLog('🟢 Connected to Core WebSocket API');
    });

    socket.on('disconnect', () => {
      setConnected(false);
      addLog('🔴 Gateway Connection Lost');
    });

    socket.on('telemetry_update', (msg) => {
      // Parse payloads safely
      let t = Number(msg.payload.temperature);
      const d = Number(msg.payload.distance);
      
      // Hardware error filtering (so bad readings don't break our beautiful graphs!)
      if (t < -100) t = 0; // Filter out the -999.0 errors from disconnected DHT sensors
      const safeT = t.toFixed(1);
      
      const filteredD = d < 0 ? 0 : d.toFixed(1); // Set to 0 if out of bounds (-1)
      
      setTemperature(safeT);
      setDistance(d < 0 ? 'Out of Range' : filteredD);
      
      const timeStr = new Date(msg.timestamp).toLocaleTimeString();
      addLog(`⚡ Parsed telemetry from ${msg.source.deviceId}`);
      
      setChartData(prev => {
        const newData = [...prev, { time: timeStr, temp: parseFloat(safeT), dist: parseFloat(filteredD) }];
        if (newData.length > 25) newData.shift();
        return newData;
      });
    });

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('telemetry_update');
    };
  }, []);

  const addLog = (msg) => {
    setLogs((prev) => [[new Date().toLocaleTimeString(), msg], ...prev].slice(0, 30));
  };

  return (
    <>
      <aside>
        <div className="brand">
          <Router size={28} color="#8b5cf6" />
          IoT Gateway
        </div>
        
        <div className="nav-item active"><LayoutDashboard size={20}/> Dashboard</div>
        <div className="nav-item"><Database size={20}/> Device Routes</div>
        <div className="nav-item"><Activity size={20}/> Monitoring</div>
        <div className="nav-item"><Settings size={20}/> Settings</div>
      </aside>

      <main>
        <header className="topbar">
          <div>
            <h1>Gateway Dashboard</h1>
            <p className="subtitle">Universal protocol-agnostic edge monitoring (Phase 10)</p>
          </div>
          
          <div className={`status-badge ${!connected ? 'offline' : ''}`}>
            <div style={{
              width: '8px', 
              height: '8px', 
              borderRadius: '50%', 
              backgroundColor: connected ? '#10b981' : '#ef4444'
            }}></div>
            {connected ? 'Gateway Online' : 'Gateway Offline'}
          </div>
        </header>

        <div className="metrics-grid">
          <div className="metric-card">
            <div className="metric-header">
              <span>Ambient Temperature</span>
              <Thermometer size={20} color="#f43f5e" />
            </div>
            <div className="metric-value">
              {temperature} <span className="metric-unit">°C</span>
            </div>
          </div>

          <div className="metric-card">
            <div className="metric-header">
              <span>Ultrasonic Proximity</span>
              <Ruler size={20} color="#38bdf8" />
            </div>
            <div className="metric-value">
              {distance} {distance !== 'Out of Range' && <span className="metric-unit">cm</span>}
            </div>
          </div>
          
          <div className="metric-card">
            <div className="metric-header">
              <span>Sensor Health</span>
              <Activity size={20} color="#10b981" />
            </div>
            <div className="metric-value status">
              {connected && distance !== '--' ? 'Active & Normal' : 'Waiting...'}
            </div>
          </div>
        </div>

        <div className="content-grid">
          <div className="panel">
            <h3>Live Telemetry Feed (Time vs Value)</h3>
            <div style={{ width: '100%', height: 320 }}>
              <ResponsiveContainer>
                <LineChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                  <XAxis dataKey="time" stroke="#52525b" fontSize={12} tickMargin={10} />
                  <YAxis yAxisId="left" stroke="#f43f5e" fontSize={12} domain={['auto', 'auto']} />
                  <YAxis yAxisId="right" orientation="right" stroke="#38bdf8" fontSize={12} />
                  
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#18181b', border: '1px solid #27272a', borderRadius: '8px' }}
                    itemStyle={{ color: '#e4e4e7' }}
                  />
                  <Line yAxisId="left" type="monotone" dataKey="temp" stroke="#f43f5e" strokeWidth={3} dot={false} name="Temp (°C)"/>
                  <Line yAxisId="right" type="monotone" dataKey="dist" stroke="#38bdf8" strokeWidth={3} dot={false} name="Distance (cm)"/>
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="panel">
            <h3>Internal Event Router (Bus)</h3>
            <div className="log-entries">
              {logs.map((log, i) => (
                <div key={i} className="log-entry">
                  <span style={{ color: '#6b7280', marginRight: '8px' }}>[{log[0]}]</span> 
                  {log[1]}
                </div>
              ))}
              {logs.length === 0 && <span style={{color: '#71717a'}}>Awaiting adapter data...</span>}
            </div>
          </div>
        </div>
      </main>
    </>
  );
}

export default App;
