import { z } from "zod";

import { SETTLE } from "./shared";

const boxSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().positive(),
  h: z.number().positive(),
});

const textBoxSchema = boxSchema.extend({
  eastAsianFont: z.string(),
  complexFont: z.string(),
  strike: z.boolean(),
  underlineColor: z.string(),
  underlineWidth: z.number().nonnegative(),
});

const tableSchema = boxSchema.extend({
  rows: z.array(z.number().positive()),
  fills: z.array(z.array(z.string())),
});

export const layoutSchema = z.object({
  pages: z.array(
    z.object({
      width: z.number().positive(),
      height: z.number().positive(),
      tables: z.array(tableSchema),
      textBoxes: z.array(textBoxSchema),
      texts: z.array(z.string()),
    }),
  ),
  activated: z.number().int().nonnegative(),
  fragmented: z.number().int().nonnegative(),
});

export type Layout = z.infer<typeof layoutSchema>;

const RESTORABLE = String.raw`
  const undo = [];
  const scroll = Array.from(document.querySelectorAll('*')).map(element=>({element,left:element.scrollLeft,top:element.scrollTop}));
  const scrollX=window.scrollX, scrollY=window.scrollY;
  undo.push(()=>{
    for (const item of scroll) { item.element.scrollLeft=item.left; item.element.scrollTop=item.top; }
    window.scrollTo({left:scrollX,top:scrollY,behavior:'instant'});
  });
  const previous = window.__okouRestoreLayout;
  const save = (element) => {
    const style = element.getAttribute('style');
    const classes = element.getAttribute('class');
    undo.push(() => {
      if (style === null) element.removeAttribute('style');
      else element.setAttribute('style', style);
      if (classes === null) element.removeAttribute('class');
      else element.setAttribute('class', classes);
    });
  };
  window.__okouRestoreLayout = () => {
    for (const restore of undo.reverse()) restore();
    previous?.();
    delete window.__okouRestoreLayout;
  };`;

/**
 * Activate selected pages and settle resources before either pixel capture or
 * native measurement. Keep this separate from text/paint materialization.
 */
export const PREPARE_PAGES = String.raw`(async (selector) => {
  const slides = Array.from(document.querySelectorAll(selector));
  ${RESTORABLE}
  const hidden = element => getComputedStyle(element).display === 'none';
  const specimen = slides.find(slide => !hidden(slide));
  let activated = 0;
  for (const slide of slides) {
    save(slide);
    if (hidden(slide)) {
      if (!specimen) throw new Error('No visible slide supplies the inactive-page layout');
      const reference = getComputedStyle(specimen);
      for (const property of ['display','flex-direction','flex-wrap','align-items','align-content','justify-content','grid-template-columns','grid-template-rows','grid-auto-flow']) {
        slide.style.setProperty(property, reference.getPropertyValue(property), 'important');
      }
      activated += 1;
    }
    // Selection is an explicit request to export these pages, including inactive pages.
    slide.style.setProperty('visibility', 'visible', 'important');
    if (Number(getComputedStyle(slide).opacity) === 0) slide.style.setProperty('opacity', '1', 'important');
    const own = getComputedStyle(slide);
    if (own.backgroundImage === 'none' && (own.backgroundColor === 'rgba(0, 0, 0, 0)' || own.backgroundColor === 'transparent')) {
      for (let ancestor = slide.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (style.backgroundImage !== 'none') break;
        if (style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent') {
          slide.style.backgroundColor = style.backgroundColor;
          break;
        }
      }
    }
  }
  // Activation can start additional font loads. Measure only after they settle.
  for (const slide of slides) slide.getBoundingClientRect();
  await ${SETTLE};
  return activated;
})`;

/** Measure native text after independently capturing unsupported browser paint. */
export const PREPARE_LAYOUT = String.raw`((selector, activated) => {
  const slides = Array.from(document.querySelectorAll(selector));
  ${RESTORABLE}
  const visible = element => {
    if (getComputedStyle(element).visibility !== 'visible') return false;
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (style.display === 'none' || Number(style.opacity) === 0) return false;
    }
    return true;
  };
  const color = value => {
    const values = value.match(/[\d.]+/g);
    if (!values || values.length < 3 || (values.length > 3 && Number(values[3]) === 0)) return '';
    return values.slice(0,3).map(value => Math.round(Number(value)).toString(16).padStart(2,'0')).join('').toUpperCase();
  };
  // Computed declarations are live: retain values before detaching source nodes.
  const snapshotStyle = element => {
    const source = getComputedStyle(element);
    const copy = document.createElement('span').style;
    for (const property of Array.from(source)) copy.setProperty(property,source.getPropertyValue(property));
    return copy;
  };
  const families = style => style.fontFamily.split(',').map(value => value.trim().replace(/^['"]|['"]$/g,''));
  const fonts = style => {
    const names = families(style);
    return {
      eastAsianFont: names.find(name => /CJK|PingFang|Hiragino|Meiryo|Yu Gothic|Microsoft YaHei|SimSun|Malgun|Nanum|Noto Sans (SC|TC|JP|KR)/i.test(name)) || '',
      complexFont: names.find(name => /Arabic|Hebrew|Devanagari|Thai/i.test(name)) || '',
    };
  };
  const textNodes = owner => {
    const walker = document.createTreeWalker(owner, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement && !node.parentElement.closest('script,style,noscript,svg,math') && visible(node.parentElement) && node.nodeValue.trim()) nodes.push(node);
    }
    return nodes;
  };
  const fragment = (node, splitWords) => {
    const style = snapshotStyle(node.parentElement);
    const preserve = style.whiteSpace.startsWith('pre');
    const segments = Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(node.nodeValue));
    const result = [];
    let current = null;
    for (const segment of segments) {
      const end = segment.index + segment.segment.length;
      const range = document.createRange();
      range.setStart(node, segment.index);
      range.setEnd(node, end);
      const rect = Array.from(range.getClientRects()).find(rect => rect.width > 0 && rect.height > 0);
      if (!rect || segment.segment === '\n' || segment.segment === '\r' || segment.segment === '\t') { current = null; continue; }
      const value = preserve ? segment.segment : segment.segment.replace(/[\n\r\t]/g,' ');
      if (!current || Math.abs(rect.top - current.top) > 1 || (splitWords && /[ \t\u00a0]/.test(value))) {
        current = {text:value,left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,style,href:node.parentElement.closest('a[href]')?.href || ''};
        result.push(current);
      } else {
        current.text += value;
        current.left = Math.min(current.left,rect.left);
        current.right = Math.max(current.right,rect.right);
        current.bottom = Math.max(current.bottom,rect.bottom);
      }
      if (splitWords && /[ \t\u00a0]/.test(value)) current = null;
    }
    return result.filter(part => part.text.trim());
  };
  const inlineTree = owner => Array.from(owner.querySelectorAll('*')).every(child => {
    const style = getComputedStyle(child);
    return child.hasAttribute('data-okou-raster') || child.tagName === 'BR' || ((style.display === 'inline' || style.display === 'inline-block' || style.display === 'contents') && !child.matches('svg,img,canvas,math,ruby,rt,video,iframe'));
  });
  // visibility is inherited but can be overridden. Unlike display:none, it
  // must not prune visible descendants from the renderer's traversal.
  for (const slide of slides) {
    const exposed = [];
    for (const element of slide.querySelectorAll('*')) {
      if (!visible(element) || exposed.some(parent => parent.contains(element))) continue;
      let ancestor = element.parentElement;
      while (ancestor && ancestor !== slide && getComputedStyle(ancestor).visibility === 'visible') ancestor = ancestor.parentElement;
      if (!ancestor || ancestor === slide) continue;
      const rect = element.getBoundingClientRect();
      const root = slide.getBoundingClientRect();
      const clone = element.cloneNode(true);
      const style = snapshotStyle(element);
      for (const property of Array.from(style)) clone.style.setProperty(property,style.getPropertyValue(property),'important');
      // Physical coordinates must win over copied logical inset declarations.
      // CSS setters without priority otherwise lose to the computed snapshot.
      const rootStyle = getComputedStyle(slide);
      for (const [property,value] of Object.entries({position:'absolute','box-sizing':'border-box',inset:'auto',left:(rect.left-root.left-parseFloat(rootStyle.borderLeftWidth))+'px',top:(rect.top-root.top-parseFloat(rootStyle.borderTopWidth))+'px',width:rect.width+'px',height:rect.height+'px',margin:'0'})) clone.style.setProperty(property,value,'important');
      clone.removeAttribute('id');
      save(element);
      element.style.setProperty('visibility','hidden','important');
      for (const child of element.querySelectorAll('*')) {
        save(child);
        child.style.setProperty('visibility','hidden','important');
      }
      slide.append(clone);
      undo.push(() => clone.remove());
      const actual = clone.getBoundingClientRect();
      if (Math.abs(actual.left-rect.left)>0.5 || Math.abs(actual.top-rect.top)>0.5 || Math.abs(actual.width-rect.width)>0.5 || Math.abs(actual.height-rect.height)>0.5) throw new Error('Visible descendant geometry disagrees with the measured source');
      exposed.push(element);
    }
  }
  const candidates = [];
  for (const slide of slides) {
    for (const owner of slide.querySelectorAll('*')) {
      if (!visible(owner) || owner.closest('table,svg,math,pre,ruby,rt') || !inlineTree(owner)) continue;
      const style = getComputedStyle(owner);
      if (style.display === 'inline' || style.writingMode !== 'horizontal-tb') continue;
      const nodes = textNodes(owner);
      if (!nodes.length) continue;
      let transformed = false;
      for (let ancestor = owner; ancestor; ancestor = ancestor.parentElement) {
        const transform = getComputedStyle(ancestor).transform;
        if (transform !== 'none') {
          const matrix = new DOMMatrix(transform);
          if (!matrix.is2D || Math.abs(matrix.a-1)>0.00001 || Math.abs(matrix.d-1)>0.00001 || Math.abs(matrix.b)>0.00001 || Math.abs(matrix.c)>0.00001) transformed = true;
        }
        if (ancestor === slide) break;
      }
      // Rotated/scaled bounds are axis-aligned unions too, but require affine
      // composition, not the untransformed line-fragment contract below.
      if (transformed) continue;
      const decorated = owner.querySelector('[data-okou-raster]') || color(style.backgroundColor) || style.backgroundImage !== 'none' || parseFloat(style.borderTopWidth) > 0 || Array.from(owner.querySelectorAll('*')).some(child => {
        const s = getComputedStyle(child);
        return s.backgroundImage !== 'none' || color(s.backgroundColor) || parseFloat(s.borderTopWidth) > 0;
      });
      const naturalWrap = nodes.some(node => fragment(node,false).length > 1);
      const spacing = nodes.some(node => parseFloat(getComputedStyle(node.parentElement).wordSpacing) > 0 || /\t|\u00a0{2}/.test(node.nodeValue));
      const scripts = nodes.some(node => /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(node.nodeValue) || getComputedStyle(node.parentElement).direction === 'rtl');
      if (decorated || naturalWrap || spacing || scripts || owner.querySelector('sup,sub')) candidates.push({owner,nodes,decorated});
    }
  }
  const relativeOpacity = (element,owner) => {
    let opacity = 1;
    for (let ancestor = element; ancestor && ancestor !== owner; ancestor = ancestor.parentElement) opacity *= Number(getComputedStyle(ancestor).opacity);
    return opacity;
  };
  let fragmented = 0;
  const prepared = [];
  for (const candidate of candidates) {
    const {owner,nodes} = candidate;
    if (candidates.some(other => other !== candidate && other.owner.contains(owner))) continue;
    const root = owner.getBoundingClientRect();
    const sourceStyle = snapshotStyle(owner);
    const parts = nodes.flatMap(node => fragment(node,parseFloat(getComputedStyle(node.parentElement).wordSpacing) > 0 || /\t|\u00a0{2}/.test(node.nodeValue)).map(part => ({...part,opacity:relativeOpacity(node.parentElement,owner)})));
    if (!parts.length) continue;
    const decorations = Array.from(owner.querySelectorAll('*')).filter(child => {
      const style = getComputedStyle(child);
      return color(style.backgroundColor) || style.backgroundImage !== 'none' || parseFloat(style.borderTopWidth) > 0;
    }).map(child => ({style:snapshotStyle(child),opacity:relativeOpacity(child,owner),rects:Array.from(child.getClientRects())}));
    const originalChildren = Array.from(owner.childNodes);
    const pictures = Array.from(owner.querySelectorAll('img[data-okou-raster]')).map(image => ({image,rect:image.getBoundingClientRect()}));
    save(owner);
    undo.push(() => owner.replaceChildren(...originalChildren));
    owner.replaceChildren();
    if (sourceStyle.position === 'static') owner.style.setProperty('position','relative','important');
    owner.style.setProperty('box-sizing','border-box','important');
    owner.style.setProperty('width',root.width+'px','important');
    owner.style.setProperty('height',root.height+'px','important');
    // Absolute child coordinates are relative to the padding box, not the border box.
    const originX = root.left + parseFloat(sourceStyle.borderLeftWidth);
    const originY = root.top + parseFloat(sourceStyle.borderTopWidth);
    for (const {image,rect} of pictures) {
      image.style.setProperty('left',(rect.left-originX)+'px','important');
      image.style.setProperty('top',(rect.top-originY)+'px','important');
      owner.append(image);
    }
    for (const decoration of decorations) {
      for (const rect of decoration.rects) {
        const paint = document.createElement('span');
        for (const property of ['background-color','background-image','background-size','background-position','background-repeat','border-top','border-right','border-bottom','border-left','border-radius','box-shadow']) paint.style.setProperty(property,decoration.style.getPropertyValue(property));
        Object.assign(paint.style,{position:'absolute',display:'block',left:(rect.left-originX)+'px',top:(rect.top-originY)+'px',width:rect.width+'px',height:rect.height+'px',padding:'0',margin:'0'});
        paint.style.opacity = String(decoration.opacity);
        owner.append(paint);
      }
    }
    for (const part of parts) {
      const span = document.createElement(part.href ? 'a' : 'span');
      if (part.href) span.href = part.href;
      for (const property of ['font-family','font-size','font-weight','font-style','font-variant','letter-spacing','text-transform','text-decoration','color','direction']) span.style.setProperty(property,part.style.getPropertyValue(property));
      Object.assign(span.style,{position:'absolute',display:'block',left:(part.left-originX)+'px',top:(part.top-originY)+'px',width:(part.right-part.left)+'px',height:(part.bottom-part.top)+'px',padding:'0',margin:'0',lineHeight:'normal',whiteSpace:'pre',background:'transparent'});
      span.style.opacity = String(part.opacity);
      span.textContent = part.text;
      owner.append(span);
      prepared.push({span,style:part.style});
    }
    fragmented += 1;
  }
  const pages = slides.map(slide => {
    const rect = slide.getBoundingClientRect();
    const box = element => {
      const r = element.getBoundingClientRect();
      return {x:r.left-rect.left,y:r.top-rect.top,w:r.width,h:r.height};
    };
    const tables = Array.from(slide.querySelectorAll('table')).filter(visible).map(table => ({
      ...box(table), rows:Array.from(table.rows).map(row => row.getBoundingClientRect().height),
      fills:Array.from(table.rows).map(row => Array.from(row.cells).flatMap(cell => {
        let fill = '';
        for (let element = cell; element && table.contains(element); element = element.parentElement) {
          fill = color(getComputedStyle(element).backgroundColor);
          if (fill) break;
        }
        return Array.from({length:cell.colSpan},() => fill);
      })),
    }));
    const textBoxes = prepared.filter(part => slide.contains(part.span)).map(part => ({
      ...box(part.span), ...fonts(part.style), strike:part.style.textDecorationLine.includes('line-through'),
      underlineColor:part.style.textDecorationLine.includes('underline') ? color(part.style.textDecorationColor) : '',
      underlineWidth:parseFloat(part.style.textDecorationThickness) || 0,
    }));
    return {width:rect.width,height:rect.height,tables,textBoxes,texts:textNodes(slide).map(node => node.nodeValue.trim())};
  });
  return JSON.stringify({pages,activated,fragmented});
})`;
