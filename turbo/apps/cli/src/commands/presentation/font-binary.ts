/** Lossless SFNT helpers shared by the browser adapter and binary regression
 * tests. Keep this factory self-contained: its compiled source runs in both
 * local and borrowed browser sessions. */
export function nativeFontTools() {
  const table = (parts: Map<string, Uint8Array>, name: string): Uint8Array => {
    const value = parts.get(name);
    if (value === undefined)
      throw new Error(`Presentation font has no ${name} table`);
    return value;
  };
  const tag = (s: string) => {
    return Array.from(s).reduce((n, c) => {
      return (n * 256 + c.charCodeAt(0)) >>> 0;
    }, 0);
  };
  const tables = (buffer: ArrayBuffer) => {
    if (buffer.byteLength < 12)
      throw new Error("Truncated presentation font directory");
    const view = new DataView(buffer),
      result = new Map<string, Uint8Array>();
    const count = view.getUint16(4);
    if (count === 0 || 12 + count * 16 > buffer.byteLength)
      throw new Error("Invalid presentation font directory");
    for (let i = 0; i < view.getUint16(4); i++) {
      const offset = 12 + i * 16,
        name = String.fromCharCode(...new Uint8Array(buffer, offset, 4));
      const start = view.getUint32(offset + 8),
        length = view.getUint32(offset + 12);
      if (start + length > buffer.byteLength || result.has(name))
        throw new Error("Invalid presentation font table: " + name);
      result.set(name, new Uint8Array(buffer.slice(start, start + length)));
    }
    return result;
  };
  const coverage = (buffer: ArrayBuffer) => {
    const cmap = tables(buffer).get("cmap");
    if (!cmap) throw new Error("Presentation font has no cmap");
    const view = new DataView(cmap.buffer),
      maps: { offset: number; format: number }[] = [];
    for (let i = 0; i < view.getUint16(2); i++) {
      const p = 4 + i * 8,
        platform = view.getUint16(p),
        encoding = view.getUint16(p + 2),
        offset = view.getUint32(p + 4);
      if (platform !== 0 && !(platform === 3 && [1, 10].includes(encoding)))
        continue;
      const format = view.getUint16(offset);
      if (format === 4 || format === 12) maps.push({ offset, format });
    }
    return (code: number) => {
      return maps.some(({ offset, format }) => {
        if (format === 12) {
          let lo = 0,
            hi = view.getUint32(offset + 12) - 1;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1,
              p = offset + 16 + mid * 12,
              start = view.getUint32(p),
              end = view.getUint32(p + 4);
            if (code < start) hi = mid - 1;
            else if (code > end) lo = mid + 1;
            else return view.getUint32(p + 8) + code - start !== 0;
          }
          return false;
        }
        if (code > 65535) return false;
        const count = view.getUint16(offset + 6) / 2;
        for (let i = 0; i < count; i++) {
          const end = view.getUint16(offset + 14 + i * 2);
          if (code > end) continue;
          const start = view.getUint16(offset + 16 + count * 2 + i * 2);
          if (code < start) return false;
          const delta = view.getInt16(offset + 16 + count * 4 + i * 2),
            p = offset + 16 + count * 6 + i * 2,
            range = view.getUint16(p);
          if (!range) return ((code + delta) & 65535) !== 0;
          const glyph = view.getUint16(p + range + 2 * (code - start));
          return glyph !== 0 && ((glyph + delta) & 65535) !== 0;
        }
        return false;
      });
    };
  };
  // Only replace names and style-linking flags. Copy every shaping/hinting
  // table verbatim and recompute SFNT directory/checkSumAdjustment checksums.
  const rename = (buffer: ArrayBuffer, name: string) => {
    const parts = tables(buffer),
      records: [number, number, number, number, number, number][] = [],
      strings: number[] = [],
      old = table(parts, "name"),
      ov = new DataView(old.buffer);
    // Keep copyright, license, designer and version records unchanged.
    for (let i = 0; i < ov.getUint16(2); i++) {
      const p = 6 + i * 12,
        id = ov.getUint16(p + 6);
      if ([1, 2, 3, 4, 6, 16, 17].includes(id)) continue;
      const length = ov.getUint16(p + 8),
        start = ov.getUint16(4) + ov.getUint16(p + 10);
      records.push([
        ov.getUint16(p),
        ov.getUint16(p + 2),
        ov.getUint16(p + 4),
        id,
        length,
        strings.length,
      ]);
      strings.push(...old.slice(start, start + length));
    }
    for (const [id, value] of [
      [1, name],
      [2, "Regular"],
      [3, name],
      [4, name],
      [6, name.replace(/[^a-zA-Z0-9-]/g, "")],
      [16, name],
      [17, "Regular"],
    ] as const) {
      const bytes = [];
      for (const c of value) {
        const n = c.charCodeAt(0);
        bytes.push(n >> 8, n & 255);
      }
      records.push([3, 1, 0x409, id, bytes.length, strings.length]);
      strings.push(...bytes);
    }
    records.sort((a, b) => {
      return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3];
    });
    const names = new Uint8Array(6 + records.length * 12 + strings.length),
      nv = new DataView(names.buffer);
    nv.setUint16(2, records.length);
    nv.setUint16(4, 6 + records.length * 12);
    records.forEach((r, i) => {
      return r.forEach((v, j) => {
        return nv.setUint16(6 + i * 12 + j * 2, v);
      });
    });
    names.set(strings, 6 + records.length * 12);
    parts.set("name", names);
    const head = new DataView(table(parts, "head").buffer);
    head.setUint32(8, 0);
    head.setUint16(44, head.getUint16(44) & ~3);
    const os2 = parts.get("OS/2");
    if (os2) {
      const v = new DataView(os2.buffer);
      v.setUint16(62, (v.getUint16(62) & ~33) | 64);
    }
    const entries = [...parts].sort(([a], [b]) => {
        return tag(a) - tag(b);
      }),
      size =
        12 +
        16 * entries.length +
        entries.reduce((n, [, b]) => {
          return n + ((b.length + 3) & ~3);
        }, 0);
    const output = new Uint8Array(size),
      v = new DataView(output.buffer);
    v.setUint32(0, new DataView(buffer).getUint32(0));
    v.setUint16(4, entries.length);
    const power = 2 ** Math.floor(Math.log2(entries.length));
    v.setUint16(6, power * 16);
    v.setUint16(8, Math.log2(power));
    v.setUint16(10, entries.length * 16 - power * 16);
    const sum = (bytes: Uint8Array) => {
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      let n = 0;
      for (let i = 0; i < bytes.length; i += 4)
        n = (n + view.getUint32(i)) >>> 0;
      return n;
    };
    let offset = 12 + 16 * entries.length,
      headOffset = 0;
    entries.forEach(([name, bytes], i) => {
      const p = 12 + i * 16;
      v.setUint32(p, tag(name));
      v.setUint32(p + 8, offset);
      v.setUint32(p + 12, bytes.length);
      output.set(bytes, offset);
      v.setUint32(
        p + 4,
        sum(output.subarray(offset, offset + ((bytes.length + 3) & ~3))),
      );
      if (name === "head") headOffset = offset;
      offset += (bytes.length + 3) & ~3;
    });
    v.setUint32(headOffset + 8, (0xb1b0afba - sum(output)) >>> 0);
    return output.buffer;
  };
  return { tag, tables, coverage, rename };
}
