import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { bootClient } from './croc';

const root = createRoot(document.getElementById('root')!);
bootClient()
  .then(() => root.render(<App />))
  .catch((err) => {
    root.render(
      <div style={{ padding: 32, color: '#dbdee1', fontFamily: 'system-ui' }}>
        <h2>Crocodile could not start</h2>
        <pre>{String(err?.stack ?? err)}</pre>
      </div>,
    );
  });

if (typeof Notification !== 'undefined' && Notification.permission === 'default')
  void Notification.requestPermission();
