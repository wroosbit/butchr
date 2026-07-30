import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './sidepanel.css'; // Just re-use general styles or write inline

function Options() {
  const [defaultAgent, setDefaultAgent] = useState('shell');
  const [status, setStatus] = useState('');

  useEffect(() => {
    chrome.storage.sync.get(['defaultAgent'], (result) => {
      if (result.defaultAgent) {
        setDefaultAgent(result.defaultAgent);
      }
    });
  }, []);

  const handleSave = () => {
    chrome.storage.sync.set({ defaultAgent }, () => {
      setStatus('Settings saved.');
      setTimeout(() => setStatus(''), 2000);
    });
  };

  return (
    <div className="container" style={{ maxWidth: '600px', margin: '40px auto', padding: '20px', color: '#f8fafc', fontFamily: 'sans-serif' }}>
      <div className="header" style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '30px', paddingBottom: '20px', borderBottom: '1px solid #334155' }}>
        <span style={{ fontSize: '24px' }}>⚙️</span>
        <div className="title" style={{ fontSize: '24px', fontWeight: 700 }}>Butchr Settings</div>
      </div>

      <div className="card" style={{ backgroundColor: '#111827', borderRadius: '8px', border: '1px solid #334155', padding: '20px' }}>
        <div style={{ marginBottom: '20px' }}>
          <label style={{ display: 'block', fontWeight: 600, marginBottom: '8px' }}>Default Agent</label>
          <div style={{ fontSize: '13px', color: '#94a3b8', marginBottom: '12px' }}>Choose which agent to launch when you open a terminal session.</div>
          <select
            value={defaultAgent}
            onChange={(e) => setDefaultAgent(e.target.value)}
            style={{ width: '100%', padding: '10px', borderRadius: '6px', background: '#1e293b', border: '1px solid #334155', color: '#f8fafc', fontSize: '14px' }}
          >
            <option value="shell">Shell (No start command)</option>
            <option value="claude">Claude</option>
            <option value="anti-gravity">Anti-Gravity</option>
          </select>
        </div>
        
        <button onClick={handleSave} className="btn btn-primary">Save Settings</button>
        <div style={{ marginTop: '10px', color: '#10b981', fontSize: '14px', height: '20px' }}>{status}</div>
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById('root'));
root.render(<Options />);
