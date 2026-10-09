import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { bootClient } from './croc';

const root = createRoot(document.getElementById('root')!);
bootClient()
  .then(() => root.render(<App />))
  .catch((err) => {
    if (String(err).includes('KEYCHAIN_LOCKED')) {
      // The saved keys exist but the system keychain is locked (often on Linux
      // right after login). Starting over here would lose them: ask instead.
      root.render(
        <div style={{ padding: 32, color: '#dbdee1', fontFamily: 'system-ui', maxWidth: 560 }}>
          <h2>Crocodile can't unlock your saved keys</h2>
          <p>
            Your account and messages are encrypted with a key kept in your system keychain, and the
            keychain is locked or not running yet. Unlock it (on Linux, your login keyring), then
            try again. Nothing has been changed.
          </p>
          <button onClick={() => location.reload()}>Try again</button>
        </div>,
      );
      return;
    }
    root.render(
      <div style={{ padding: 32, color: '#dbdee1', fontFamily: 'system-ui' }}>
        <h2>Crocodile could not start</h2>
        <pre>{String(err?.stack ?? err)}</pre>
      </div>,
    );
  });

if (typeof Notification !== 'undefined' && Notification.permission === 'default')
  void Notification.requestPermission();
