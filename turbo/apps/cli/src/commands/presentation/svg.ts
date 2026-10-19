/**
 * Browser-side SVG paint adapter. Geometry is measured by the browser; path
 * commands are normalized by svgpath in the CLI before the renderer runs.
 * Return null for an unsupported SVG as a whole, retaining its source vector
 * image and an explicit diagnostic instead of exporting only some children.
 */
export const SVG_RENDERER = String.raw`
({state, roots, color, font, diagnostic}) => {
  const namespace = 'http://www.w3.org/2000/svg';
  const ignored = new Set(['defs','title','desc','metadata','style']);
  const cubic = (x,y,x1,y1,x2,y2) => ({x,y,curve:{type:'cubic',x1,y1,x2,y2}});
  const ellipse = (x,y,rx,ry) => {
    const k = 4 * (Math.SQRT2 - 1) / 3;
    return [{x:x+rx,y,moveTo:true},
      cubic(x,y+ry,x+rx,y+k*ry,x+k*rx,y+ry),
      cubic(x-rx,y,x-k*rx,y+ry,x-rx,y+k*ry),
      cubic(x,y-ry,x-rx,y-k*ry,x-k*rx,y-ry),
      cubic(x+rx,y,x+k*rx,y-ry,x+rx,y-k*ry),{close:true}];
  };
  const geometry = node => {
    if (node.localName === 'path') {
      const path = state.svgPaths[state.nodes.get(node).id];
      if (!path) throw new Error('SVG path has no measured source identity');
      return path;
    }
    if(!['rect','circle','ellipse','line','polygon','polyline'].includes(node.localName))
      return {unsupported:'SVG element <'+node.localName+'>'};
    const b = node.getBBox();
    if (node.localName === 'circle' || node.localName === 'ellipse')
      return {points:ellipse(b.x+b.width/2,b.y+b.height/2,b.width/2,b.height/2)};
    if (node.localName === 'line')
      return {points:[{x:node.x1.baseVal.value,y:node.y1.baseVal.value,moveTo:true},
        {x:node.x2.baseVal.value,y:node.y2.baseVal.value}]};
    if (node.localName === 'polygon' || node.localName === 'polyline') {
      const points=Array.from(node.points,(p,i)=>({x:p.x,y:p.y,...(i===0?{moveTo:true}:{})}));
      if(node.localName==='polygon')points.push({close:true});
      return {points};
    }
    if (node.localName === 'rect') {
      const s=getComputedStyle(node), values=[s.rx,s.ry];
      if(values.some(v=>v.includes('%')))return {unsupported:'Percentage SVG corner radii'};
      let rx=s.rx==='auto'?null:parseFloat(s.rx), ry=s.ry==='auto'?null:parseFloat(s.ry);
      rx=Math.min(b.width/2,Math.max(0,rx ?? ry ?? 0));
      ry=Math.min(b.height/2,Math.max(0,ry ?? rx));
      const {x,y,width:w,height:h}=b;
      if (!rx || !ry) return {points:[{x,y,moveTo:true},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h},{close:true}]};
      const k=4*(Math.SQRT2-1)/3;
      return {points:[{x:x+rx,y,moveTo:true},{x:x+w-rx,y},
        cubic(x+w,y+ry,x+w-rx+k*rx,y,x+w,y+ry-k*ry),{x:x+w,y:y+h-ry},
        cubic(x+w-rx,y+h,x+w,y+h-ry+k*ry,x+w-rx+k*rx,y+h),{x:x+rx,y:y+h},
        cubic(x,y+h-ry,x+rx-k*rx,y+h,x,y+h-ry+k*ry),{x,y:y+ry},
        cubic(x+rx,y,x,y+ry-k*ry,x+rx-k*rx,y),{close:true}]};
    }
    return {unsupported:'SVG element <'+node.localName+'>'};
  };
  return (root,config,inheritedOpacity) => {
    const items=[], reasons=new Set(), unit=config.scale/96;
    const group=state.nodes.get(root).id;
    const reject=reason=>{reasons.add(reason);};
    const rootBox=root.getBoundingClientRect(), rootStyle=getComputedStyle(root);
    const paint=(value,opacity)=>value==='none'?null:{...color(value),alpha:color(value).alpha*opacity};
    const visit=(node,opacity) => {
      if (node.namespaceURI!==namespace) { reject('Non-SVG content');return; }
      if(ignored.has(node.localName))return;
      const s=getComputedStyle(node);
      if(s.display==='none')return;
      opacity*=Number(s.opacity);
      if(opacity===0)return;
      if(s.filter!=='none'||s.clipPath!=='none'||s.maskImage!=='none'||s.mixBlendMode!=='normal') {
        reject('SVG filters, masks, clipping or blending');return;
      }
      if(s.transform!=='none'&&!new DOMMatrix(s.transform).is2D||s.perspective!=='none') {
        reject('3D SVG transform');return;
      }
      if(['svg','g','a'].includes(node.localName)) {
        if(Number(s.opacity)<1&&node.children.length) { reject('Composited SVG group opacity');return; }
        if(node!==root&&node.localName==='svg') { reject('Nested SVG viewport');return; }
        for(const child of node.children)visit(child,opacity);
        return;
      }
      if(s.visibility!=='visible')return;
      if(['use','image','foreignObject','textPath','switch'].includes(node.localName)) {
        reject('SVG element <'+node.localName+'>');return;
      }
      if(node.localName!=='text'&&node.children.length) {reject('SVG geometry with child elements');return;}
      if(s.fill.includes('url(')||s.stroke.includes('url(')) { reject('SVG paint server');return; }
      if(s.fillRule==='evenodd'&&s.fill!=='none') { reject('Even-odd SVG fill');return; }
      if([s.markerStart,s.markerMid,s.markerEnd].some(value=>value!=='none')) { reject('SVG markers');return; }
      if(s.vectorEffect!=='none'||s.strokeDasharray!=='none') { reject('SVG vector effects or dashed strokes');return; }
      if(s.paintOrder!=='normal'&&s.paintOrder!=='fill stroke') { reject('SVG paint order');return; }
      const matrix=node.getScreenCTM();
      if(!matrix||matrix.is2D===false||![matrix.a,matrix.b,matrix.c,matrix.d,matrix.e,matrix.f].every(Number.isFinite)) {
        reject('Unsupported SVG transform');return;
      }
      const sx=Math.hypot(matrix.a,matrix.b),sy=Math.hypot(matrix.c,matrix.d);
      const similarity=Math.abs(sx-sy)<1e-6*Math.max(1,sx,sy)&&Math.abs(matrix.a*matrix.c+matrix.b*matrix.d)<1e-6*Math.max(1,sx*sy);
      if(sx===0||sy===0)return;
      if(s.stroke!=='none'&&!similarity) { reject('Non-uniformly transformed SVG stroke');return; }
      const fill=paint(s.fill,opacity*Number(s.fillOpacity));
      const stroke=paint(s.stroke,opacity*Number(s.strokeOpacity));
      const strokeWidth=stroke?parseFloat(s.strokeWidth)*sx:0;
      if(stroke&&s.strokeWidth.includes('%')) {reject('Percentage SVG stroke width');return;}
      if(stroke&&!['miter','round','bevel'].includes(s.strokeLinejoin)) {reject('SVG stroke join');return;}
      const bounds=node.getBoundingClientRect();
      if(rootStyle.overflow!=='visible'&&
        (bounds.left-strokeWidth/2<rootBox.left-.1||bounds.top-strokeWidth/2<rootBox.top-.1||
         bounds.right+strokeWidth/2>rootBox.right+.1||bounds.bottom+strokeWidth/2>rootBox.bottom+.1)) {
        reject('SVG viewport clipping');return;
      }
      if(node.localName==='text') {
        if(node.children.length||node.hasAttribute('textLength')||node.rotate.baseVal.numberOfItems||
          node.x.baseVal.numberOfItems>1||node.y.baseVal.numberOfItems>1||node.dx.baseVal.numberOfItems>1||node.dy.baseVal.numberOfItems>1||
          !similarity||Math.abs(matrix.b)>1e-6||Math.abs(matrix.c)>1e-6||matrix.a<=0||matrix.d<=0||
          s.writingMode!=='horizontal-tb'||s.direction!=='ltr'||s.textTransform!=='none'||s.textDecorationLine!=='none'||s.textShadow!=='none'||
          (s.letterSpacing!=='normal'&&parseFloat(s.letterSpacing)!==0)||
          (s.wordSpacing!=='normal'&&parseFloat(s.wordSpacing)!==0)||s.whiteSpace!=='nowrap'&&s.whiteSpace!=='normal'||stroke) {
          reject('Positioned, styled or transformed SVG text');return;
        }
        const text=node.textContent.replace(/\s+/g,' ').trim();
        if(!text.trim()||!fill)return;
        const r=document.createRange();r.selectNodeContents(node);
        const box=r.getBoundingClientRect();
        const meta=state.nodes.get(node);
        if(!meta.fontFamily) { reject('Unresolved SVG text font');return; }
        items.push({type:'text',_paintPhase:0,_nativePaint:{svgGroup:group,resolvedFonts:state.hasResolvedFont(s,meta)},
          textParts:state.fontRuns([{text,options:{...font(s,config),
            fontSize:parseFloat(s.fontSize)*sx*.75*config.scale,color:fill.color,transparency:(1-fill.alpha)*100}}],meta,s),
          options:{x:config.offX+(box.x-config.rootX)*unit,y:config.offY+(box.y-config.rootY)*unit,
            w:box.width*unit,h:box.height*unit,margin:0,wrap:false,breakLine:false}});
        return;
      }
      const parsed=geometry(node);
      if(parsed.unsupported) {reject(parsed.unsupported);return;}
      if(!parsed.points.length)return;
      const transform=(x,y)=>({x:matrix.a*x+matrix.c*y+matrix.e,y:matrix.b*x+matrix.d*y+matrix.f});
      const points=parsed.points.map(p=>{
        if(p.close)return p;
        const out={...p,...transform(p.x,p.y)};
        if(p.curve){
          const a=transform(p.curve.x1,p.curve.y1);
          out.curve={...p.curve,x1:a.x,y1:a.y};
          if(p.curve.type==='cubic'){const b=transform(p.curve.x2,p.curve.y2);out.curve.x2=b.x;out.curve.y2=b.y;}
        }
        return out;
      });
      const coordinates=points.flatMap(p=>p.close?[]:[p,...(p.curve?[{x:p.curve.x1,y:p.curve.y1},
        ...(p.curve.type==='cubic'?[{x:p.curve.x2,y:p.curve.y2}]:[])]:[])]);
      if(!coordinates.length)return;
      const extent=coordinates.reduce((b,p)=>({left:Math.min(b.left,p.x),top:Math.min(b.top,p.y),
        right:Math.max(b.right,p.x),bottom:Math.max(b.bottom,p.y)}),{left:Infinity,top:Infinity,right:-Infinity,bottom:-Infinity});
      const x=extent.left,y=extent.top;
      // A horizontal/vertical open path still needs a non-zero DrawingML frame.
      const w=Math.max(.001,extent.right-x),h=Math.max(.001,extent.bottom-y);
      items.push({type:'shape',shapeType:'custGeom',_paintPhase:0,
        _nativePaint:{svgGroup:group,...(stroke&&strokeWidth>0?{svgStroke:{...stroke,width:strokeWidth,
          cap:s.strokeLinecap,join:s.strokeLinejoin,miterLimit:Number(s.strokeMiterlimit)}}:{})},
        options:{x:config.offX+(x-config.rootX)*unit,y:config.offY+(y-config.rootY)*unit,w:w*unit,h:h*unit,
          fill:fill?{color:fill.color,transparency:(1-fill.alpha)*100}:undefined,
          line:{transparency:100},
          points:points.map(p=>{
            if(p.close)return p;
            const out={...p,x:(p.x-x)*unit,y:(p.y-y)*unit};
            if(p.curve){out.curve={...p.curve,x1:(p.curve.x1-x)*unit,y1:(p.curve.y1-y)*unit};
              if(p.curve.type==='cubic'){out.curve.x2=(p.curve.x2-x)*unit;out.curve.y2=(p.curve.y2-y)*unit;}}
            return out;
          })}});
    };
    if(color(rootStyle.backgroundColor).alpha>0||rootStyle.backgroundImage!=='none'||rootStyle.boxShadow!=='none'||
      ['Top','Right','Bottom','Left'].some(side=>parseFloat(rootStyle['border'+side+'Width'])>0)||
      rootStyle.outlineStyle!=='none'&&parseFloat(rootStyle.outlineWidth)>0)reject('Decorated SVG CSS box');
    // CSS 3D transforms and ancestor clips cannot be represented by a 2D path.
    for(let ancestor=root;ancestor;ancestor=ancestor.parentElement){
      const s=getComputedStyle(ancestor);
      if(s.transform!=='none'&&!new DOMMatrix(s.transform).is2D||s.perspective!=='none')reject('3D SVG transform');
      if(ancestor!==root){
        const b=ancestor.getBoundingClientRect();
        if(s.clipPath!=='none'||s.maskImage!=='none'||
          s.overflowX!=='visible'&&(rootBox.left<b.left||rootBox.right>b.right)||
          s.overflowY!=='visible'&&(rootBox.top<b.top||rootBox.bottom>b.bottom))reject('Ancestor SVG clipping');
      }
      if(roots.includes(ancestor))break;
    }
    if(!reasons.size)visit(root,inheritedOpacity);
    if(reasons.size){
      diagnostic(root,'svg-vector-image','Retained source SVG as a vector picture; native component editing is unavailable: '+[...reasons].join('; '));
      return null;
    }
    return items;
  };
}
`;

/** Preserve computed SVG paint and local definitions in a standalone picture. */
export const SVG_PICTURE = String.raw`
(root) => {
  const clone=root.cloneNode(true), sources=[root,...root.querySelectorAll('*')],
    targets=[clone,...clone.querySelectorAll('*')], ids=new Set(sources.map(node=>node.id).filter(Boolean));
  const base=new URL(root.baseURI);base.hash='';
  // A use instance inherits paint from <use>, not from its definition's DOM
  // ancestors. Freezing that definition's computed fill would turn icons black.
  const referenceTrees=Array.from(root.querySelectorAll('use')).flatMap(node=>{
    const href=node.getAttribute('href')||node.getAttributeNS('http://www.w3.org/1999/xlink','href');
    if(!href)return [];
    const target=new URL(href,root.baseURI),id=decodeURIComponent(target.hash.slice(1));target.hash='';
    const definition=sources.find(source=>source.id===id);
    return target.href===base.href&&definition?[definition]:[];
  });
  const localUrls=value=>value.replace(/url\((['"]?)(.*?)\1\)/g,(match,quote,href)=>{
    const target=new URL(href,root.baseURI), id=decodeURIComponent(target.hash.slice(1));target.hash='';
    return target.href===base.href&&ids.has(id)?'url("#'+CSS.escape(id)+'")':match;
  });
  const properties=[
    'fill','fill-opacity','fill-rule','clip-rule','stroke','stroke-width','stroke-opacity',
    'stroke-dasharray','stroke-dashoffset','stroke-linecap','stroke-linejoin','stroke-miterlimit',
    'vector-effect','paint-order','opacity','filter','clip-path','mask-image','mask-mode','mask-size',
    'mask-position','mask-repeat','mask-composite','mask-type','mix-blend-mode','isolation',
    'visibility','display','overflow','color','stop-color','stop-opacity','flood-color','flood-opacity','lighting-color',
    'font-family','font-size','font-weight','font-style','font-stretch','font-variant','font-feature-settings',
    'letter-spacing','word-spacing','text-anchor','dominant-baseline','alignment-baseline','baseline-shift',
    'text-decoration','text-transform','white-space','writing-mode','direction','unicode-bidi',
    'transform','transform-origin','transform-box','x','y','cx','cy','r','rx','ry','width','height','d',
  ];
  sources.forEach((source,index)=>{
    const target=targets[index], style=getComputedStyle(source);
    if(!target.style)return;
    if(referenceTrees.some(definition=>definition.contains(source)))return;
    target.removeAttribute('style');
    const names=source.namespaceURI==='http://www.w3.org/2000/svg'?properties:Array.from(style);
    for(const property of names){const value=style.getPropertyValue(property);if(value)target.style.setProperty(property,localUrls(value));}
    for(const attribute of Array.from(source.attributes))if(attribute.localName==='href'&&!attribute.value.startsWith('#'))
      target.setAttributeNS(attribute.namespaceURI,attribute.name,new URL(attribute.value,source.baseURI).href);
  });
  // The native picture frame owns the outer CSS transform, box paint and opacity.
  clone.removeAttribute('transform');
  clone.style.transform='none';clone.style.opacity='1';
  const style=getComputedStyle(root);
  clone.setAttribute('width',String(parseFloat(style.width)));
  clone.setAttribute('height',String(parseFloat(style.height)));
  clone.setAttribute('xmlns','http://www.w3.org/2000/svg');
  return 'data:image/svg+xml;base64,'+btoa(unescape(encodeURIComponent(new XMLSerializer().serializeToString(clone))));
}
`;
