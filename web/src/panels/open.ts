/** Row click: mark the row's unseen events seen, then open the item in a new tab. */
export function openItem(url: string | null, ids: number[], onSee: (ids: number[]) => void): void {
  if (ids.length) onSee(ids);
  if (url) window.open(url, '_blank', 'noopener');
}
