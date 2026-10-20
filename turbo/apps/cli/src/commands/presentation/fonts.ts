import { nativeFontTools } from "./font-binary";

/** Browser-side font preparation shares the pinned renderer's lossless WOFF
 * decoders. HarfBuzz instances variable fonts without dropping OpenType layout
 * tables; distinct CSS weights get distinct editable Office font families. */
export const INSTALL_FONTS = String.raw`
() => {
  const state = window.__okouNative;
  const urls = [],
    restore = window.__okouRestoreLayout;
  window.__okouRestoreLayout = () => {
    for (const url of urls) URL.revokeObjectURL(url);
    restore?.();
  };
  const family = (s) =>
    s.fontFamily
      .split(",")[0]
      .trim()
      .replace(/^['"]|['"]$/g, "");
  const key = (s) =>
    [
      family(s),
      s.fontWeight,
      s.fontStyle,
      s.fontSynthesisWeight,
      s.fontStretch,
      s.fontVariationSettings,
      s.fontOpticalSizing,
      s.fontOpticalSizing === "auto" ? s.fontSize : "",
    ].join("|");
  const faces = new Map(),
    aliases = new Map(),
    provenance = new Map(),
    resolved = new Map();
  state.fontStyle = (s) =>
    faces.get(key(s))?.[0].style || {
      fontFace: resolved.get(key(s)) || family(s),
      bold: Number(s.fontWeight) >= 600,
      italic: s.fontStyle === "italic",
    };
  state.fontProvenance = (parts, style) => parts.map(part => {
    const alias=(part.options?.fontFace || '').replace(/__spc_-?\d+$/, '');
    return {text:part.text,...(provenance.get(alias) || {family:alias || family(style),weight:Number(style.fontWeight),italic:part.options?.italic ?? style.fontStyle==='italic'})};
  });
  state.hasResolvedFont = (s, meta) =>
    faces.has(key(s)) || meta.fontFamilies?.length === 1;
  state.fontRuns = (parts, meta, style) =>
    parts.flatMap((part) => {
      // Character spacing is transported in the name until XML normalization.
      const transport =
        /__spc_-?\d+$/.exec(part.options?.fontFace || "")?.[0] || "";
      const faceName = (part.options?.fontFace || "").slice(
        0,
        transport ? -transport.length : undefined,
      );
      const measured = style && faces.get(key(style));
      const group = measured?.some((face) => face.style.fontFace === faceName)
        ? measured
        : aliases.get(faceName);
      if (!group)
        return [
          {
            ...part,
            options: {
              ...part.options,
              ...(meta?.fontFamilies?.length === 1
                ? { fontFace: meta.fontFamily + transport }
                : {}),
            },
          },
        ];
      const result = [];
      let current;
      for (const char of part.text) {
        const face = group.find((f) => f.has(char.codePointAt(0))) || group[0];
        if (current?.options.fontFace !== face.style.fontFace + transport) {
          current = {
            ...part,
            text: "",
            options: {
              ...part.options,
              ...face.style,
              fontFace: face.style.fontFace + transport,
            },
          };
          result.push(current);
        }
        current.text += char;
      }
      return result;
    });
  const { tag, tables, coverage, rename, standalone } = (${nativeFontTools.toString()})();
  state.prepareFonts = async (roots, discover, decode, toEot) => {
    const used = new Map();
    for (const root of roots)
      for (const element of [root, ...root.querySelectorAll("*")]) {
        if (
          !Array.from(element.childNodes).some(
            (n) => n.nodeType === 3 && n.nodeValue.trim(),
          )
        )
          continue;
        const s = getComputedStyle(element);
        if (s.visibility !== "visible" || s.display === "none") continue;
        const k = key(s);
        if (!used.has(k))
          used.set(k, { s, element, text: "", families: new Set() });
        used.get(k).text += element.textContent;
        for (const name of state.nodes.get(element)?.fontFamilies || [])
          used.get(k).families.add(name);
      }
    const loadedFamilies = new Set(
      Array.from(document.fonts)
        .filter((face) => face.status === "loaded")
        .map((face) => face.family.replace(/^['"]|['"]$/g, "")),
    );
    for (const [k, item] of used) {
      const stack = item.s.fontFamily
        .split(",")
        .map((n) => n.trim().replace(/^['"]|['"]$/g, ""));
      // CSS aliases need not equal the font file's internal family (CDP).
      item.names = [
        ...new Set([
          ...stack.filter((n) => item.families.has(n) || loadedFamilies.has(n)),
          ...item.families,
        ]),
      ];
      if (!item.names.length) item.names = [family(item.s)];
      resolved.set(k, item.names[0]);
    }
    const descriptors = await discover(
      new Set([...used.values()].flatMap((item) => item.names)),
    );
    if (!descriptors.length) return [];
    let instancer;
    const getInstancer = async () => {
      if (instancer) return instancer;
      const response = await fetch(
        "https://cdn.jsdelivr.net/npm/harfbuzzjs@1.6.1/dist/harfbuzz-subset.wasm",
      );
      if (!response.ok)
        throw new Error("Cannot load the pinned native font instancer");
      const { instance } = await WebAssembly.instantiate(
        await response.arrayBuffer(),
      );
      instancer = instance.exports;
      instancer._initialize();
      return instancer;
    };
    const buffers = new Map(),
      instances = new Map(),
      fonts = [];
    for (const [k, { s, element, text, names }] of used) {
      const weight = Number(s.fontWeight),
        group = [];
      const characters = [
        ...new Set(Array.from(text, (c) => c.codePointAt(0))),
      ];
      for (const name of names) {
        const candidates = descriptors.filter(
          (f) => f.name === name && (f.style || "normal") === s.fontStyle,
        );
        if (!candidates.length) {
          group.push({
            style: {
              fontFace: name,
              bold: weight >= 600,
              italic: s.fontStyle === "italic",
            },
            has: () => true,
          });
          continue;
        }
        const distance = (f) => {
          const values = String(f.weight || 400)
            .split(/\s+/)
            .map((value) => value === "normal" ? 400 : value === "bold" ? 700 : Number(value));
          return Math.max(values[0] - weight, weight - values.at(-1), 0);
        };
        const nearest = Math.min(...candidates.map(distance)),
          sources = [];
        for (const descriptor of candidates.filter(
          (f) => distance(f) === nearest,
        )) {
          if (!buffers.has(descriptor.url))
            buffers.set(
              descriptor.url,
              (async () => {
                const r = await fetch(descriptor.url);
                if (!r.ok)
                  throw new Error("Cannot fetch a used presentation font");
                return standalone(await decode(await r.arrayBuffer()));
              })(),
            );
          const buffer = await buffers.get(descriptor.url),
            has = coverage(buffer);
          sources.push({
            buffer,
            url: descriptor.url,
            has,
            count: characters.filter(has).length,
          });
        }
        sources.sort((a, b) => b.count - a.count);
        for (const source of sources) {
          if (
            characters.every(
              (c) => !source.has(c) || group.some((f) => f.has(c)),
            )
          )
            continue;
          const selected = source.buffer;
          const parts = tables(selected),
            os2 = parts.get("OS/2");
          if (os2 && new DataView(os2.buffer).getUint16(8) & 2) {
            state.diagnostic(
              element,
              "font-embedding",
              "The used font disallows embedding",
            );
            continue;
          }
          const axes = parts.get("fvar"),
            settings = {
              wght: weight,
              wdth: parseFloat(s.fontStretch) || 100,
              ital: s.fontStyle === "italic" ? 1 : 0,
            };
          for (const match of s.fontVariationSettings.matchAll(
            /["'](.{4})["']\s+(-?[\d.]+)/g,
          ))
            settings[match[1]] = Number(match[2]);
          if (s.fontOpticalSizing === "auto" && !("opsz" in settings))
            settings.opsz = parseFloat(s.fontSize);
          const coordinates = [];
          if (axes) {
            const av = new DataView(axes.buffer),
              offset = av.getUint16(4),
              count = av.getUint16(8),
              size = av.getUint16(10);
            for (let i = 0; i < count; i++) {
              const p = offset + i * size,
                t = String.fromCharCode(...axes.slice(p, p + 4));
              coordinates.push([t, settings[t] ?? av.getInt32(p + 8) / 65536]);
            }
          }
          const instanceKey =
            name +
            "|" +
            s.fontStyle +
            "|" +
            weight +
            "|" +
            s.fontSynthesisWeight +
            "|" +
            source.url +
            "|" +
            JSON.stringify(coordinates);
          if (instances.has(instanceKey)) {
            group.push(instances.get(instanceKey));
            continue;
          }
          // Static fonts already have the desired outlines. Preserve their
          // tables byte-for-byte, including large CID-keyed CFF collections.
          let buffer = selected;
          if (coordinates.length) {
            const hb = await getInstancer();
            const pointer = hb.malloc(selected.byteLength);
            new Uint8Array(hb.memory.buffer).set(
              new Uint8Array(selected),
              pointer,
            );
            const blob = hb.hb_blob_create(
                pointer,
                selected.byteLength,
                2,
                0,
                0,
              ),
              face = hb.hb_face_create(blob, 0),
              input = hb.hb_subset_input_create_or_fail();
            try {
              hb.hb_subset_input_keep_everything(input);
              for (const [axis, value] of coordinates)
                if (
                  !hb.hb_subset_input_pin_axis_location(
                    input,
                    face,
                    tag(axis),
                    value,
                  )
                )
                  throw new Error(
                    "Cannot instance presentation font axis " + axis,
                  );
              const subset = hb.hb_subset_or_fail(face, input);
              if (!subset) throw new Error("Cannot instance presentation font");
              const result = hb.hb_face_reference_blob(subset),
                start = hb.hb_blob_get_data(result, 0),
                length = hb.hb_blob_get_length(result);
              buffer = new Uint8Array(hb.memory.buffer).slice(
                start,
                start + length,
              ).buffer;
              hb.hb_blob_destroy(result);
              hb.hb_face_destroy(subset);
            } finally {
              hb.hb_subset_input_destroy(input);
              hb.hb_face_destroy(face);
              hb.hb_blob_destroy(blob);
              hb.free(pointer);
            }
          }
          const resultTables = tables(buffer);
          if (!["glyf", "CFF ", "CFF2"].some((name) => resultTables.has(name)))
            throw new Error("Native font preparation lost the glyph outlines");
          const alias = (
              name.slice(0, 18) +
              " " +
              weight +
              " " +
              (fonts.length + 1)
            ).trim(),
            eot = toEot(rename(buffer, alias));
          const url = URL.createObjectURL(new Blob([eot]));
          urls.push(url);
          fonts.push({ name: alias, url, weight: 400, style: "normal" });
          provenance.set(alias,{family:name,weight,italic:s.fontStyle === "italic"});
          const style = {
              fontFace: alias,
              bold:
                !axes &&
                nearest > 0 &&
                weight >= 600 &&
                s.fontSynthesisWeight !== "none",
              italic: false,
            },
            entry = { style, has: source.has };
          group.push(entry);
          instances.set(instanceKey, entry);
        }
      }
      if (group.length) {
        faces.set(k, group);
        for (const face of group) aliases.set(face.style.fontFace, group);
      }
    }
    return fonts;
  };
  return 1;
}
`;
