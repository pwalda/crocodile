/**
 * Length hiding. Plaintexts are padded (ISO/IEC 7816-4: 0x80 then zeros) to
 * a Padmé bucket, which leaks at most O(log log n) bits of the length while
 * costing at most ~12% overhead.
 */
export function padmeLength(len: number): number {
  if (len < 64) return 64;
  const e = Math.floor(Math.log2(len));
  const s = Math.floor(Math.log2(e)) + 1;
  const lastBits = e - s;
  const mask = (1 << lastBits) - 1;
  return (len + mask) & ~mask;
}

export function pad(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(padmeLength(data.length + 1));
  out.set(data, 0);
  out[data.length] = 0x80;
  return out;
}

export function unpad(data: Uint8Array): Uint8Array | null {
  let i = data.length - 1;
  while (i >= 0 && data[i] === 0) i--;
  if (i < 0 || data[i] !== 0x80) return null;
  return data.subarray(0, i);
}
