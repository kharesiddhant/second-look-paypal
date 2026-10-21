// ponytail: naive split, breaks on quoted commas; swap for a CSV parser when real exports arrive.
export function parseCsv(text: string): Record<string, string>[] {
  const [head, ...rows] = text.trim().split(/\r?\n/);
  const keys = head.split(',').map(k => k.trim());
  return rows.filter(r => r.trim()).map(r => {
    const cells = r.split(',');
    return Object.fromEntries(keys.map((k, i) => [k, (cells[i] ?? '').trim()]));
  });
}
