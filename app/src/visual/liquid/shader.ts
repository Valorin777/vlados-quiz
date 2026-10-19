// Liquid chrome fragment shader, extended from design/proto-chrome.html:
//  * metaball field of capsules ("circle"/"pill") and rounded boxes, smooth-min union (uK)
//  * reflection of an analytic studio environment, thin-film iridescence, tarnish/oxide, glow
//  * ground: vignette, nacre sheen, contact shadow, iridescent halo, ripples, heat tint
//  * uMode 0..1 morphs the night studio (dark) into the pearl sweep (light)
// One source, two dialects: GLSL ES 3.0 for WebGL2 (TILES: every pixel only visits the blobs of
// its screen tile, listed by the CPU in an R8UI texture — see tiles.ts) and GLSL ES 1.0 for
// WebGL1 (every pixel loops over all blobs, far ones skip the expensive part).
// Compiled per quality step: NB (max blobs) and LOW (no grain, no agitation normals) are #defines.

/** Ground effects (shadow, halo, glow spill) fade to exactly zero at this distance (design units). */
export const GROUND_REACH = 160;
/** A blob farther than this many uK beyond the nearest surface weighs < e^-6 in the union: skipped. */
export const SKIP_K = 6;

export const VERT1 = 'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}';
export const VERT2 = '#version 300 es\nin vec2 a;void main(){gl_Position=vec4(a,0.,1.);}';

const BODY = `
uniform vec4 uFrame;uniform vec2 uDesign;uniform float uCorner,uTime,uPx,uK,uBevel,uHeat,uAgit,uFlash,uCalm,uMode;uniform int uN;
uniform vec4 uA[NB];uniform vec4 uP[NB];uniform vec4 uR[4];
#ifdef TILES
uniform highp usampler2D uTiles;uniform vec3 uTile;uniform int uSlots;
#endif
float h21(vec2 p){p=fract(p*vec2(233.34,851.73));p+=dot(p,p+23.45);return fract(p.x*p.y);}
float vn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h21(i),h21(i+vec2(1.,0.)),f.x),mix(h21(i+vec2(0.,1.)),h21(i+vec2(1.,1.)),f.x),f.y);}
vec3 film(float x){return .55+.45*cos(6.2832*(x+vec3(0.,.33,.67)));}
/** film() averaged over a footprint w (the bands fade to their mean instead of aliasing) */
vec3 filmw(float x,float w){return .55+.45*cos(6.2832*(x+vec3(0.,.33,.67)))*exp(-1.8*w*w);}
// Specular anti-aliasing: the reflection turns fast near the rim (up to a fraction of a radian per
// device pixel), where the studio's thin highlights and horizon line would be sampled into dashes
// and sparkles. Both are widened to the pixel footprint w (energy kept): pow(cos x, n) is a lobe
// of variance 1/n, an exp(-|y|/s) band has width s.
float lobe(float x,float n,float w){float q=1./(1.+n*w*w*.25);return pow(max(0.,cos(x)),n*q)*sqrt(q);}
float band(float y,float s,float w){float s2=sqrt(s*s+w*w*.25);return exp(-abs(y)/s2)*(s/s2);}
vec3 envD(vec3 R,float t,float fw){
  float up=-R.y;
  vec3 c=mix(vec3(.045,.05,.062),vec3(.40,.43,.49),smoothstep(-.05,.9,up));
  c=mix(c,vec3(.022,.021,.024),smoothstep(-.03,-.55,up));
  float fb=smoothstep(.35,.93,R.z);
  c=mix(c,vec3(.69,.72,.78)+vec3(.13)*clamp(up+.35,0.,1.),fb);
  float az=atan(R.x,R.z);float da=fw/max(length(R.xz),.05);
  float s1=lobe(az*3.-t*.33,42.,3.*da);
  float s2=lobe(az*5.+t*.21+1.7,90.,5.*da);
  c+=vec3(1.02,1.05,1.1)*(s1*.85+s2*.45)*smoothstep(-.55,.2,up);
  float hz=smoothstep(.22,0.,abs(up+.02))*(1.-fb);
  c=mix(c,vec3(.015,.017,.022),.55*hz);
  c+=vec3(.75,.83,.96)*band(up+.05,1./26.,fw)*(1.-fb)*.6;
  return c;
}
vec3 envL(vec3 R,float t,float fw){
  float up=-R.y;
  vec3 c=mix(vec3(.60,.635,.69),vec3(.975,.982,.995),smoothstep(-.08,.75,up));
  c=mix(c,vec3(.26,.285,.33),smoothstep(-.02,-.5,up));
  float fb=smoothstep(.42,.95,R.z);
  c=mix(c,vec3(.90,.915,.945)+vec3(.07)*clamp(up+.3,0.,1.),fb);
  float az=atan(R.x,R.z);float da=fw/max(length(R.xz),.05);
  float s1=lobe(az*3.-t*.33,34.,3.*da);
  float s2=lobe(az*5.+t*.21+1.7,80.,5.*da);
  c+=vec3(1.)*(s1*.75+s2*.4)*smoothstep(-.4,.3,up);
  float hz=smoothstep(.27,0.,abs(up+.02))*(1.-fb);
  c=mix(c,vec3(.085,.095,.12),.78*hz);
  c+=vec3(.55,.64,.8)*band(up+.07,1./30.,fw)*(1.-fb)*.28;
  return c;
}
vec3 env(vec3 R,float t,float fw){
  if(uMode<.002)return envD(R,t,fw);
  if(uMode>.998)return envL(R,t,fw);
  return mix(envD(R,t,fw),envL(R,t,fw),uMode);
}
float m,s;vec2 g;vec4 at;
void blob(vec2 p,vec4 A,vec4 P){
  float d,rad;vec2 gn;
  if(P.x>=0.){
    vec2 pa=p-A.xy,ba=A.zw-A.xy;
    float h=clamp(dot(pa,ba)/max(dot(ba,ba),1e-3),0.,1.);
    vec2 q=pa-ba*h;float L=length(q);
    d=L-P.x;gn=q/max(L,1e-3);rad=P.x;
  }else{
    rad=-P.x;vec2 dp=p-A.xy;vec2 q=abs(dp)-A.zw+rad;vec2 qm=max(q,0.);float L=length(qm);
    d=L+min(max(q.x,q.y),0.)-rad;vec2 sg=sign(dp);
    gn=L>1e-3?sg*qm/L:(q.x>q.y?vec2(sg.x,0.):vec2(0.,sg.y));
  }
  // weight < e^-6 against the nearest surface so far: nothing visible, skip the exp
  if(d-m>${SKIP_K.toFixed(1)}*uK)return;
  vec4 v=vec4(rad,P.yzw);
  if(d<m){float sc=exp((d-m)/uK);s=s*sc+1.;g=g*sc+gn;at=at*sc+v;m=d;}
  else{float w=exp((m-d)/uK);s+=w;g+=gn*w;at+=v*w;}
}
void main(){
  vec2 fc=gl_FragCoord.xy-uFrame.xy;
  vec2 p=vec2(fc.x,uFrame.w-fc.y)*uPx;
  vec2 hd=uDesign*.5;
  vec2 q0=abs(p-hd)-hd+uCorner;
  float fr=length(max(q0,0.))+min(max(q0.x,q0.y),0.)-uCorner;
  float mask=clamp(.5-fr/uPx,0.,1.);
  if(mask<=0.){FRAG_OUT=vec4(0.);return;}
  float t=uTime;
  vec2 rp=vec2(0.);float ring=0.;
  for(int i=0;i<4;i++){
    vec4 r=uR[i];if(r.w<=0.)continue;
    vec2 dv=p-r.xy;float L=length(dv);float x=L-r.z*430.;
    float w=sin(x*.075)*exp(-x*x/3200.)*r.w*exp(-r.z*1.3);
    rp+=dv/max(L,1.)*w;ring+=w;
  }
  m=1e5;s=0.;g=vec2(0.);at=vec4(0.);
#ifdef TILES
  ivec2 tc=clamp(ivec2(p/uTile.x),ivec2(0),ivec2(uTile.yz)-1);
  int tb=tc.x*uSlots;
  int cnt=int(texelFetch(uTiles,ivec2(tb,tc.y),0).r);
  if(cnt==255){
    for(int i=0;i<NB;i++){if(i>=uN)break;blob(p,uA[i],uP[i]);}
  }else{
    for(int k=0;k<NB;k++){
      if(k>=cnt)break;
      int i=int(texelFetch(uTiles,ivec2(tb+1+k,tc.y),0).r);
      blob(p,uA[i],uP[i]);
    }
  }
#else
  for(int i=0;i<NB;i++){if(i>=uN)break;blob(p,uA[i],uP[i]);}
#endif
  float D=m-uK*log(max(s,1.));
  at/=max(s,1e-4);
  vec2 od=g/max(length(g),1e-4);
  // the surface breathes; at rest the silhouette stays put (sub-pixel), agitation makes it boil.
  // Only near a surface (fades out by 40 units, where nothing reads D that finely)
  float bw=1.-smoothstep(28.,40.,D);
  if(bw>0.)D+=(vn(p*.02+vec2(t*(.4+uAgit*2.),-t*.27))-.5)*(.5+uAgit*3.5)*uCalm*bw;
  D+=ring*2.4;
  float e=-D;
  // ~1 device pixel of anti-aliasing at the actual render scale
  float cov=smoothstep(-.75*uPx,.75*uPx,e);
  vec2 uv=p/uDesign;
  float vig=smoothstep(1.1,.05,length((uv-vec2(.5,.36))*vec2(1.,1.25)));
  float sh=vn(p*.0045+vec2(t*.025,-t*.018));
  vec3 fs=film(sh*1.3+t*.015);
  float oD=max(D,0.);
  float near=1.-smoothstep(${(GROUND_REACH * 0.6).toFixed(1)},${GROUND_REACH.toFixed(1)},oD);
  vec3 gD=mix(vec3(.056,.062,.078),vec3(.1,.108,.132),vig);
  gD+=fs*.024*smoothstep(.35,.9,sh);
  vec3 gL=mix(vec3(.85,.868,.9),vec3(.972,.978,.988),vig);
  gL+=(fs-.55)*.055*smoothstep(.3,.9,sh);
  if(uHeat>0.){
    float pulse=.05+.035*sin(t*6.2832);
    gD+=vec3(.55,.13,.22)*uHeat*pulse*smoothstep(.2,1.,uv.y);
    gL-=vec3(0.,.05,.07)*uHeat*(.6+.4*sin(t*6.2832))*smoothstep(.2,1.,uv.y);
  }
  gD+=vec3(.6,.7,.82)*ring*.06;
  gL+=vec3(.28,.32,.42)*ring*.05;
  if(near>0.){
    vec3 halo=film(t*.04+uv.x*.6+.2);
    gD*=1.-.5*exp(-oD/16.)*near;
    gD+=halo*.06*exp(-oD/5.);
    gD+=vec3(1.,.98,.95)*at.z*.3*exp(-oD/36.)*near;
    gL*=1.-(.22*exp(-oD/12.)+.07*exp(-oD/48.))*near;
    gL+=(halo-.5)*.13*exp(-oD/6.);
    gL+=(film(t*.3+oD*.03)-.3)*at.z*.3*exp(-oD/30.)*near;
  }
  vec3 gc=mix(gD,gL,uMode);
  vec3 col=gc;
  if(cov>0.){
    // shade edge pixels half a pixel inside the rim: the grazing normal right at the
    // silhouette flickers between env bands from one pixel to the next (jaggy, noisy rim)
    float es=max(e,.5*uPx);
    float bev=max(min(at.x*.78,uBevel),1.);
    float u=1.-clamp(es/bev,0.,1.);
    float nz0=sqrt(max(1.-u*u,0.));
    vec3 n=vec3(od*u,nz0);
    // how far the normal tilts per device pixel: across the bevel (steepest at the rim) and
    // around the outline (its curvature); the reflection turns twice as far
    float dt=uPx*u*(1./(bev*max(nz0,.12))+1./max(at.x,4.));
    float fl=1.-u;
    n.xy+=rp*.3+(vec2(vn(p*.006+t*.08),vn(p*.006-t*.07+9.))-.5)*.34*fl*uCalm;
#ifndef LOW
    if(uAgit>.001)n.xy+=(vec2(vn(p*.017+t*2.3),vn(p*.017-t*2.1+3.))-.5)*uAgit*.3;
#endif
    n=normalize(n);
    vec3 I=normalize(vec3((p-hd)/uDesign.y*.55,-1.));
    vec3 R=reflect(I,n);
    vec3 c=env(R,t,2.*dt);
    float fth=vn(p*.009+vec2(t*.05,t*.03))*.9+(1.-n.z)*1.3+t*.02+uHeat*.35;
    vec3 fcol=filmw(fth,1.3*dt);
    float fa=clamp(at.w*(1.+.4*uMode)*(.1+1.25*pow(1.-n.z,1.6)),0.,1.);
    c=mix(c,c*fcol*1.8+fcol*.05,fa);
    float ty=clamp(at.y,0.,1.);
    if(ty>0.){
      float lum=dot(c,vec3(.3,.5,.2));
      vec3 ox=mix(vec3(.74,.53,.27),vec3(.38,.25,.56),smoothstep(.25,.7,ty+fth*.12));
      ox=mix(ox,vec3(.2,.22,.4),smoothstep(.55,.95,ty));
      c=mix(c,ox*(.16+lum*.95),smoothstep(0.,.6,ty)*.86);
      c=mix(c,c*.45,smoothstep(.7,1.,ty));
    }
    c*=1.-uMode*.32*pow(u,7.);
    if(at.z>0.){
      float sw=pow(max(0.,sin((p.x*.7+p.y)*.01-t*4.)),12.);
      c+=at.z*(.2+.85*sw)*vec3(1.,1.,1.03);
    }
    col=mix(gc,c,cov);
  }
  col+=uFlash*mix(vec3(.55,.57,.6),vec3(.3,.31,.34),uMode);
#ifndef LOW
  col+=(h21(gl_FragCoord.xy+fract(t*7.)*91.)-.5)*.01;
#endif
  FRAG_OUT=vec4(col*mask,mask);
}`;

export interface FragOpts {
  /** max blobs (uniform array size) */
  nb: number;
  low: boolean;
  /** WebGL2 dialect with per-tile blob lists */
  tiles: boolean;
}

export function fragSource(o: FragOpts): string {
  const defs = `#define NB ${o.nb}\n${o.low ? '#define LOW\n' : ''}`;
  if (o.tiles) {
    return `#version 300 es\nprecision highp float;\nprecision highp int;\n${defs}#define TILES\nout vec4 fragOut;\n#define FRAG_OUT fragOut\n${BODY}`;
  }
  return `#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n${defs}#define FRAG_OUT gl_FragColor\n${BODY}`;
}
