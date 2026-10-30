/**
 * A file dropped on the window would otherwise open in the window itself,
 * as a page with the app's bridge to the main process. The main process
 * refuses that navigation too; this makes a drop anywhere but a place that
 * takes it do nothing, and shows the "not allowed" pointer on the way.
 * A place that takes drops marks the event handled first (the chat does),
 * and the event reaches the document last.
 */
export interface DropEvent {
  defaultPrevented: boolean;
  dataTransfer: { dropEffect: string; types: readonly string[] } | null;
  preventDefault(): void;
}

export function refuseStrayDrops(doc: {
  addEventListener(type: 'dragover' | 'drop', fn: (e: DropEvent) => void): void;
}) {
  // Only files: text dragged within or into a field is left alone.
  const carriesFiles = (e: DropEvent) => !!e.dataTransfer?.types.includes('Files');
  doc.addEventListener('dragover', (e) => {
    if (e.defaultPrevented || !carriesFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
  });
  doc.addEventListener('drop', (e) => {
    if (carriesFiles(e)) e.preventDefault();
  });
}
