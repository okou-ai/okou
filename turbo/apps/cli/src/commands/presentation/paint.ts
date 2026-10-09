import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { PNG } from "pngjs";
import { z } from "zod";

import type { browser } from "./shared";

const regionSchema = z.object({
  id: z.number().int().nonnegative(),
  mode: z.enum(["background", "content"]),
  features: z.array(z.string()),
  tag: z.string(),
  textStrings: z.number().int().nonnegative(),
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().positive(),
  h: z.number().positive(),
  padding: z.number().nonnegative(),
});
const planSchema = z.object({
  pages: z.array(
    z.object({
      width: z.number().positive(),
      height: z.number().positive(),
      texts: z.array(z.string()),
      regions: z.array(regionSchema),
    }),
  ),
});

export interface PaintRegion {
  readonly page: number;
  readonly mode: "background" | "content";
  readonly features: readonly string[];
  readonly tag: string;
  readonly textStrings: number;
}

/**
 * Native shapes cannot express arbitrary CSS paint. Capture those regions with
 * the SAME browser that measured the slide, not another HTML rasterizer. Keep
 * backgrounds separate so an unsupported gradient need not flatten its text.
 */
const PLAN_PAINT = String.raw`((selector) => {
  const slides = Array.from(document.querySelectorAll(selector));
  const undo = [];
  const previous = window.__okouRestoreLayout;
  window.__okouRestoreLayout = () => {
    window.__okouRestoreCapture?.();
    for (const restore of undo.reverse()) restore();
    previous?.();
    delete window.__okouPaintTargets;
    delete window.__okouPaintBytes;
    delete window.__okouPaintUndo;
    delete window.__okouRestoreLayout;
  };
  const save = element => {
    const style = element.getAttribute('style');
    undo.push(() => style === null ? element.removeAttribute('style') : element.setAttribute('style',style));
  };
  const visible = element => {
    if (getComputedStyle(element).visibility !== 'visible') return false;
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (style.display === 'none' || Number(style.opacity) === 0) return false;
    }
    return true;
  };
  const texts = element => {
    const walker = document.createTreeWalker(element,NodeFilter.SHOW_TEXT);
    const result = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement && !node.parentElement.closest('script,style,noscript,svg,math') && visible(node.parentElement) && node.nodeValue.trim()) result.push(node.nodeValue.trim());
    }
    return result;
  };
  const affine = style => {
    if (style.transform === 'none') return false;
    const matrix = new DOMMatrix(style.transform);
    return !matrix.is2D || Math.abs(Math.hypot(matrix.a,matrix.b)-1)>0.00001 || Math.abs(Math.hypot(matrix.c,matrix.d)-1)>0.00001 || Math.abs(matrix.a*matrix.c+matrix.b*matrix.d)>0.00001;
  };
  const composition = style => Number(style.opacity)<1 || style.mixBlendMode!=='normal' || style.filter!=='none' || style.backdropFilter!=='none' || affine(style);
  const targets = [];
  const pages = slides.map((slide,page) => {
    const root = slide.getBoundingClientRect();
    const sourceTexts = texts(slide);
    const candidates = [];
    const own = getComputedStyle(slide);
    if (own.backgroundImage !== 'none') candidates.push({element:slide,mode:'background',features:['page-background']});
    if (own.backgroundImage === 'none' && (own.backgroundColor==='rgba(0, 0, 0, 0)' || own.backgroundColor==='transparent')) {
      for (let ancestor=slide.parentElement; ancestor; ancestor=ancestor.parentElement) {
        const style=getComputedStyle(ancestor);
        if (style.backgroundImage!=='none') { candidates.push({element:slide,mode:'background',features:['ancestor-background']}); break; }
        if (style.backgroundColor!=='rgba(0, 0, 0, 0)' && style.backgroundColor!=='transparent') break;
      }
    }
    for (const element of slide.querySelectorAll('*')) {
      if (!visible(element) || element.closest('script,style,noscript,svg') || element.tagName==='STYLE') continue;
      const style=getComputedStyle(element);
      const rect=element.getBoundingClientRect();
      if (rect.width<0.5 || rect.height<0.5) continue;
      const features=[];
      let mode='background';
      if (style.backgroundImage!=='none') features.push('background-image');
      if ((style.backgroundClip==='text' || style.webkitBackgroundClip==='text') || parseFloat(style.webkitTextStrokeWidth)>0) { features.push('text-paint'); mode='content'; }
      if (style.filter!=='none') { features.push('filter'); mode='content'; }
      if (style.backdropFilter!=='none') { features.push('backdrop-filter'); mode='content'; }
      if (style.mixBlendMode!=='normal' || (Number(style.opacity)>0 && Number(style.opacity)<1)) { features.push('composition'); mode='content'; }
      if (affine(style)) { features.push('affine-transform'); mode='content'; }
      if (style.clipPath!=='none' || style.maskImage!=='none') { features.push('clip-or-mask'); mode='content'; }
      if (((style.overflowX==='hidden' || style.overflowX==='clip') && element.scrollWidth>element.clientWidth+1) || ((style.overflowY==='hidden' || style.overflowY==='clip') && element.scrollHeight>element.clientHeight+1) || Number(style.webkitLineClamp)>0) { features.push('overflow'); mode='content'; }
      if (element.localName==='math') { features.push('math'); mode='content'; }
      if (['::before','::after'].some(pseudo=>{
        const generated=getComputedStyle(element,pseudo);
        return generated.display!=='none' && generated.visibility==='visible' && Number(generated.opacity)>0 && !['none','normal','""','\'\''].includes(generated.content);
      })) { features.push('generated-content'); mode='content'; }
      if (element.tagName==='IMG' && style.objectFit==='contain' && style.backgroundColor!=='rgba(0, 0, 0, 0)' && style.backgroundColor!=='transparent') { features.push('image-letterbox'); mode='content'; }
      const innerWidth=element.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);
      const innerHeight=element.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom);
      if ((innerWidth<=0.5 || innerHeight<=0.5) && ['Top','Right','Bottom','Left'].some(side=>parseFloat(style['border'+side+'Width'])>0)) features.push('border-shape');
      if (!features.length) continue;
      let target=element;
      // A captured image is already composited. Move the whole affected group
      // to a normal ancestor, otherwise opacity/filter would be applied twice.
      if (composition(style)) mode='content';
      for (let ancestor=element.parentElement; ancestor && ancestor!==slide; ancestor=ancestor.parentElement) {
        if (composition(getComputedStyle(ancestor))) { target=ancestor; mode='content'; }
      }
      const table=target.closest('table');
      if (table) { target=table; mode='content'; }
      candidates.push({element:target,mode,features});
    }
    const merged=[];
    for (const candidate of candidates) {
      const same=merged.find(item=>item.element===candidate.element);
      if (same) { same.features.push(...candidate.features); if (candidate.mode==='content') same.mode='content'; }
      else merged.push(candidate);
    }
    const retained=merged.filter(candidate=>!merged.some(other=>other!==candidate && other.mode==='content' && other.element.contains(candidate.element)));
    const regions=retained.map(candidate=>{
      const element=candidate.element;
      const rect=element.getBoundingClientRect();
      const style=getComputedStyle(element);
      const id=targets.length;
      let padding=0;
      for (const match of style.filter.matchAll(/blur\(([\d.]+)px\)/g)) padding+=Number(match[1])*3;
      targets.push({element,slide,mode:candidate.mode,save});
      return {id,mode:candidate.mode,features:[...new Set(candidate.features)],tag:element.tagName,textStrings:candidate.mode==='content'?texts(element).length:0,x:rect.left-root.left,y:rect.top-root.top,w:rect.width,h:rect.height,padding};
    });
    return {width:root.width,height:root.height,texts:sourceTexts,regions};
  });
  window.__okouPaintTargets=targets;
  window.__okouPaintBytes='';
  window.__okouPaintUndo=undo;
  return JSON.stringify({pages});
})`;

const BEGIN_CAPTURE = String.raw`(async (id) => {
  const target=window.__okouPaintTargets[id];
  const undo=[];
  const save=element=>{
    const style=element.getAttribute('style');
    undo.push(()=>style===null?element.removeAttribute('style'):element.setAttribute('style',style));
  };
  window.__okouRestoreCapture=()=>{for (const restore of undo.reverse()) restore(); delete window.__okouRestoreCapture;};
  // UI outside the selected slide must not be baked into its export.
  for (const element of document.body.querySelectorAll('*')) {
    if (!target.slide.contains(element) && !element.contains(target.slide)) {
      save(element); element.style.setProperty('visibility','hidden','important');
    }
  }
  if (target.mode==='background') {
    save(target.element);
    for (const property of ['color','-webkit-text-fill-color']) target.element.style.setProperty(property,'transparent','important');
    target.element.style.setProperty('-webkit-text-stroke-width','0','important');
    target.element.style.setProperty('text-shadow','none','important');
    for (const child of target.element.querySelectorAll('*')) { save(child); child.style.setProperty('visibility','hidden','important'); }
  }
  target.slide.scrollIntoView({block:'start',inline:'start',behavior:'instant'});
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const rect=target.slide.getBoundingClientRect();
  return JSON.stringify({x:rect.left,y:rect.top,viewportWidth:window.innerWidth,viewportHeight:window.innerHeight});
})`;

const INSTALL_PAINT = String.raw`(async (id, box) => {
  const target=window.__okouPaintTargets[id];
  const element=target.element;
  const root=target.slide.getBoundingClientRect();
  const image=document.createElement('img');
  image.setAttribute('data-okou-raster',target.mode);
  image.src='data:image/png;base64,'+window.__okouPaintBytes;
  image.alt='';
  let anchor=target.mode==='background'?element:element.parentElement;
  while (anchor && getComputedStyle(anchor).position==='static' && getComputedStyle(anchor).transform==='none') anchor=anchor.parentElement;
  const rect=anchor ? anchor.getBoundingClientRect() : {left:-window.scrollX,top:-window.scrollY};
  const borderLeft=anchor ? parseFloat(getComputedStyle(anchor).borderLeftWidth) : 0;
  const borderTop=anchor ? parseFloat(getComputedStyle(anchor).borderTopWidth) : 0;
  image.style.setProperty('all','initial','important');
  const set=(name,value)=>image.style.setProperty(name,value,'important');
  for (const [name,value] of Object.entries({position:'absolute',display:'block',left:(root.left+box.x-rect.left-borderLeft)+'px',top:(root.top+box.y-rect.top-borderTop)+'px',width:box.w+'px',height:box.h+'px','max-width':'none','max-height':'none',padding:'0',margin:'0',border:'0',opacity:'1',filter:'none',transform:'none','pointer-events':'none'})) set(name,value);
  target.save(element);
  if (target.mode==='background') {
    set('z-index','-2147483647');
    element.style.setProperty('background','transparent','important');
    element.style.setProperty('border-color','transparent','important');
    element.prepend(image);
  } else {
    set('z-index',getComputedStyle(element).zIndex);
    element.style.setProperty('opacity','0','important');
    element.after(image);
  }
  window.__okouPaintUndo.push(()=>image.remove());
  await image.decode();
  window.__okouPaintBytes='';
  return 1;
})`;

export function capturePaint(
  page: ReturnType<typeof browser>,
  selector: string,
): {
  texts: readonly (readonly string[])[];
  regions: readonly PaintRegion[];
} {
  const plan = planSchema.parse(
    page.evaluate(`${PLAN_PAINT}(${JSON.stringify(selector)})`),
  );
  const regions: PaintRegion[] = [];
  const directory = mkdtempSync(join(tmpdir(), "okou-paint-"));
  try {
    // Capture ALL source pixels before changing any element's paint.
    const captures: {
      id: number;
      data: string;
      box: { x: number; y: number; w: number; h: number };
    }[] = [];
    for (const [pageIndex, slide] of plan.pages.entries()) {
      for (const region of slide.regions) {
        const path = join(directory, `${region.id.toString()}.png`);
        const view = z
          .object({
            x: z.number().finite(),
            y: z.number().finite(),
            viewportWidth: z.number().positive(),
            viewportHeight: z.number().positive(),
          })
          .parse(page.evaluate(`${BEGIN_CAPTURE}(${region.id.toString()})`));
        try {
          if (
            view.x < -0.5 ||
            view.y < -0.5 ||
            view.x + slide.width > view.viewportWidth + 0.5 ||
            view.y + slide.height > view.viewportHeight + 0.5
          ) {
            throw new Error(
              "Browser paint requires the selected page to fit the viewport; increase --viewport-width/--viewport-height",
            );
          }
          // Element screenshots can capture an unpainted offscreen surface.
          // Scroll first, then take the ordinary viewport, as screenshot.ts does.
          page.call(["screenshot", path]);
        } finally {
          page.quiet(["eval", "window.__okouRestoreCapture?.()"]);
        }
        const bytes = readFileSync(path);
        if (
          !bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ) {
          throw new Error("Browser did not return a PNG screenshot");
        }
        const source = PNG.sync.read(bytes);
        const sx = source.width / view.viewportWidth;
        const sy = source.height / view.viewportHeight;
        const left = Math.max(
          0,
          Math.floor(view.x * sx),
          Math.floor((view.x + region.x - region.padding) * sx),
        );
        const top = Math.max(
          0,
          Math.floor(view.y * sy),
          Math.floor((view.y + region.y - region.padding) * sy),
        );
        const right = Math.min(
          source.width,
          Math.ceil((view.x + slide.width) * sx),
          Math.ceil((view.x + region.x + region.w + region.padding) * sx),
        );
        const bottom = Math.min(
          source.height,
          Math.ceil((view.y + slide.height) * sy),
          Math.ceil((view.y + region.y + region.h + region.padding) * sy),
        );
        if (right <= left || bottom <= top) {
          throw new Error("Unsupported paint lies outside the selected page");
        }
        const crop = new PNG({ width: right - left, height: bottom - top });
        PNG.bitblt(source, crop, left, top, crop.width, crop.height, 0, 0);
        captures.push({
          id: region.id,
          data: PNG.sync.write(crop).toString("base64"),
          box: {
            x: left / sx - view.x,
            y: top / sy - view.y,
            w: crop.width / sx,
            h: crop.height / sy,
          },
        });
        regions.push({
          page: pageIndex + 1,
          mode: region.mode,
          features: region.features,
          tag: region.tag,
          textStrings: region.textStrings,
        });
      }
    }
    for (const capture of captures) {
      for (let offset = 0; offset < capture.data.length; offset += 60_000) {
        page.call([
          "eval",
          `window.__okouPaintBytes+=${JSON.stringify(capture.data.slice(offset, offset + 60_000))};1`,
        ]);
      }
      page.evaluate(
        `${INSTALL_PAINT}(${capture.id.toString()},${JSON.stringify(capture.box)})`,
      );
    }
    return {
      texts: plan.pages.map((slide) => {
        return slide.texts;
      }),
      regions,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
