import { randomUUID } from "crypto";

import { array, number, object, string, tuple, enum as zEnum } from "zod";

import { browser, run } from "./shared";

const snapshotSchema = array(
  object({
    id: number().int().nonnegative(),
    order: number().int().nonnegative(),
    fontFamily: string().optional(),
    fontFamilies: array(string()).optional(),
    generated: array(
      object({
        kind: zEnum(["before", "after", "marker"]),
        text: string(),
        order: number().int().nonnegative(),
        bounds: tuple([number(), number(), number(), number()]),
      }),
    ),
  }),
);

/** CDP stays behind the browser boundary; never print endpoints or other tabs. */
const CAPTURE = String.raw`
const [endpoint, token, attribute] = process.argv.slice(1);
const socket = new WebSocket(endpoint),
  pending = new Map();
let sequence = 0;
const timeout = setTimeout(() => {
  process.stderr.write('Browser layout capture timed out');
  process.exit(1);
}, 30000);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = () => reject(new Error('Cannot connect to browser layout session'));
});
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  message.error
    ? request.reject(new Error('Browser layout protocol failed'))
    : request.resolve(message.result);
};
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
try {
  const { targetInfos } = await send('Target.getTargets');
  let selected;
  for (const target of targetInfos.filter((target) => target.type === 'page')) {
    const { sessionId } = await send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    });
    const result = await send(
      'Runtime.evaluate',
      {
        expression: 'window.__okouNative?.token === ' + JSON.stringify(token),
        returnByValue: true,
      },
      sessionId,
    );
    if (result.result.value === true) {
      if (selected) throw new Error('Ambiguous browser layout page');
      selected = sessionId;
    } else await send('Target.detachFromTarget', { sessionId });
  }
  if (!selected) throw new Error('Cannot identify the selected browser page');
  const snapshot = await send(
    'DOMSnapshot.captureSnapshot',
    { computedStyles: [], includePaintOrder: true, includeDOMRects: true },
    selected,
  );
  const strings = snapshot.strings,
    records = new Map(),
    fontNodes = [];
  for (const document of snapshot.documents) {
    const nodes = document.nodes,
      layout = document.layout,
      owners = new Map(),
      pseudos = new Map();
    const textOwners=new Set(nodes.nodeType.flatMap((type,index)=>type===3&&(strings[nodes.nodeValue[index]]||'').trim()?[nodes.parentIndex[index]]:[]));
    for (let i = 0; i < nodes.nodeType.length; i++) {
      const attrs = nodes.attributes[i];
      for (let j = 0; j < attrs.length; j += 2)
        if (strings[attrs[j]] === attribute) {
          const id = Number(strings[attrs[j + 1]]);
          owners.set(i, id);
          records.set(id, { id, order: 0, generated: [] });
          if (textOwners.has(i)||['math', 'mi', 'mn', 'mo', 'mtext'].includes(strings[nodes.nodeName[i]]))
            fontNodes.push({ id, backendNodeId: nodes.backendNodeId[i] });
        }
      const name = strings[nodes.nodeName[i]];
      if (['::before', '::after', '::marker'].includes(name)) pseudos.set(i, name.slice(2));
    }
    for (let i = 0; i < layout.nodeIndex.length; i++) {
      const ni = layout.nodeIndex[i];
      if (owners.has(ni)) records.get(owners.get(ni)).order = layout.paintOrders[i];
      let ancestor = ni,
        kind;
      while (ancestor >= 0 && !owners.has(ancestor)) {
        if (pseudos.has(ancestor)) kind = pseudos.get(ancestor);
        ancestor = nodes.parentIndex[ancestor];
      }
      if (!kind || !owners.has(ancestor)) continue;
      const text = strings[layout.text[i]] || '',
        bounds = layout.bounds[i];
      if ((!text && !pseudos.has(ni)) || !bounds[2] || !bounds[3]) continue;
      records.get(owners.get(ancestor)).generated.push({
        kind,
        text,
        order: layout.paintOrders[i],
        bounds: [
          bounds[0] - document.scrollOffsetX,
          bounds[1] - document.scrollOffsetY,
          bounds[2],
          bounds[3],
        ],
      });
    }
  }
  if (fontNodes.length) {
    await send('DOM.enable', {}, selected);
    await send('CSS.enable', {}, selected);
    await send('DOM.getDocument', {}, selected);
    const { nodeIds } = await send(
      'DOM.pushNodesByBackendIdsToFrontend',
      {
        backendNodeIds: fontNodes.map((node) => node.backendNodeId),
      },
      selected,
    );
    for (let offset = 0; offset < fontNodes.length; offset+=25) {
      await Promise.all(fontNodes.slice(offset,offset+25).map(async(node,index)=>{
        const { fonts } = await send('CSS.getPlatformFontsForNode', { nodeId: nodeIds[offset+index] }, selected);
        fonts.sort((a, b) => b.glyphCount - a.glyphCount);
        if (fonts.length) {
          records.get(node.id).fontFamily = fonts[0].familyName;
          records.get(node.id).fontFamilies = [...new Set(fonts.map(font=>font.familyName))];
        }
      }));
    }
  }
  process.stdout.write(JSON.stringify([...records.values()]));
} finally {
  clearTimeout(timeout);
  socket.close();
}
`;

/** Preserve source identity before text materialization changes the DOM. */
export function captureBrowserLayout(
  page: ReturnType<typeof browser>,
  selector: string,
): void {
  const token = randomUUID();
  const attribute = `data-okou-capture-${token}`;
  page.evaluate(`(() => {
    const nodes=[...new Set(Array.from(document.querySelectorAll(${JSON.stringify(selector)})).flatMap(root=>[root,...root.querySelectorAll('*')]))];
    const state={token:${JSON.stringify(token)},nodes:new WeakMap(),elements:nodes,paints:{},diagnostics:[],generatedTexts:new WeakMap()};
    window.__okouNative=state;
    nodes.forEach((node,id)=>{node.setAttribute(${JSON.stringify(attribute)},String(id));state.nodes.set(node,{id,order:0,generated:[]})});
    const previous=window.__okouRestoreLayout;
    window.__okouRestoreLayout=()=>{nodes.forEach(node=>node.removeAttribute(${JSON.stringify(attribute)}));delete window.__okouNative;delete window.__okouNativeRender;previous?.()};
    return 1;
  })()`);
  try {
    const endpoint = page.call(["get", "cdp-url"]);
    let response: string;
    try {
      response = run(process.execPath, [
        "--input-type=module",
        "-e",
        CAPTURE,
        endpoint,
        token,
        attribute,
      ]);
    } catch {
      // execFileSync errors contain command arguments, including private CDP URLs.
      throw new Error("Cannot capture the selected browser's rendered layout");
    }
    const records = snapshotSchema.parse(JSON.parse(response));
    page.evaluate(`(() => {
      if(${records.length.toString()}!==window.__okouNative.elements.length)throw new Error('Incomplete browser layout identity');
      return 1;
    })()`);
    // Bound each CLI argument independently of the number of selected pages.
    for (let index = 0; index < records.length; index += 100) {
      page.evaluate(`(() => {
        const state=window.__okouNative;
        for(const record of ${JSON.stringify(records.slice(index, index + 100))}){
          const element=state.elements[record.id];if(!element)throw new Error('Browser layout identity changed');
          state.nodes.set(element,record);
        }
        return 1;
      })()`);
    }
    // CDP paintOrders identify layers, not every box within them. A negative-z
    // child can have a later layer number than normal-flow text. Capture CSS
    // context membership before materialization adds positioned fragments.
    page.evaluate(`(() => {
      const state=window.__okouNative, roots=new Set(document.querySelectorAll(${JSON.stringify(selector)})), contexts=new WeakMap();
      for(const element of state.elements){
        const s=getComputedStyle(element), meta=state.nodes.get(element);
        const parent=contexts.get(element.parentElement);
        const positioned=s.position!=='static';
        const flexItem=/flex|grid/.test(getComputedStyle(element.parentElement||element).display);
        const z=(positioned||flexItem)&&s.zIndex!=='auto'?Number(s.zIndex):0;
        const context=roots.has(element)||((positioned||flexItem)&&s.zIndex!=='auto')||['fixed','sticky'].includes(s.position)||Number(s.opacity)<1||s.transform!=='none'||s.filter!=='none'||s.perspective!=='none'||s.isolation==='isolate'||s.mixBlendMode!=='normal'||/paint|layout|strict|content/.test(s.contain)||/transform|opacity|filter/.test(s.willChange);
        const base=parent?.key||[];
        if(context){
          const key=roots.has(element)?[]:[...base,z<0?1:z>0?4:3,z,meta.id];
          contexts.set(element,{key,flow:key});
          meta.paintKey=[...key,0,0,meta.id];
          meta.contentKey=[...key,2,0,meta.id];
        }else{
          const flow=positioned?[...base,3,0,meta.id]:parent?.flow||base;
          contexts.set(element,{key:base,flow});
          meta.paintKey=[...flow,positioned?0:2,0,meta.id];
          meta.contentKey=[...flow,2,0,meta.id];
        }
      }
      return 1;
    })()`);
  } finally {
    page.evaluate(
      `(() => {for(const element of window.__okouNative.elements)element.removeAttribute(${JSON.stringify(attribute)});return 1})()`,
    );
  }
}
