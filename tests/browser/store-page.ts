// The desktop app's message store, in a real browser's IndexedDB.
import { messages } from '../../apps/desktop/src/renderer/platform';

declare global {
  interface Window {
    store: typeof messages;
  }
}

window.store = messages;
