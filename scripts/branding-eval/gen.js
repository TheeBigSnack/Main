// Procedural car-gallery generator for the dealer-branding check harness.
// Runs in Chromium (harness.html, served by serve.mjs). Nothing here is a real dealer, a real
// photo or a real logo: scenes are drawn from gradients, SVG feTurbulence
// noise and shapes, and overlays carry made-up text (EXAMPLE AUTO GROUP,
// 555-0100, example-auto.test).
//
// Pipeline per photo, the way a dealer photo vendor and the extension do it:
//   scene canvas (natural size) -> overlay PNG of the same pixel size drawn
//   over it (source-over) -> JPEG (q 0.75-0.9) -> optionally a CDN resize and
//   a second JPEG -> Blob. Then decodeSample(): createImageBitmap(blob,
//   { imageOrientation: 'from-image' }) -> drawImage at checkSize on an
//   OffscreenCanvas -> getImageData.

export function rngOf(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => Math.floor(lo + (hi - lo + 1) * next()),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
  };
}

const hsl = (h, s, l, a = 1) => `hsla(${h.toFixed(1)},${s.toFixed(1)}%,${l.toFixed(1)}%,${a})`;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function canvas(W, H) {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  return c;
}

// ---------- noise textures (SVG feTurbulence, tileable) ----------
const textureCache = new Map();
export async function noiseTexture(W, H, freq, octaves, seed, slope = 2.2) {
  const key = `${W}x${H}:${freq}:${octaves}:${seed}:${slope}`;
  if (textureCache.has(key)) return textureCache.get(key);
  const icpt = (1 - slope) / 2;
  const fn = (c) => `<feFunc${c} type="linear" slope="${slope}" intercept="${icpt}"/>`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
    `<filter id="f" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">` +
    `<feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="${octaves}" seed="${seed}" stitchTiles="stitch"/>` +
    `<feColorMatrix type="matrix" values="0.33 0.33 0.33 0 0 0.33 0.33 0.33 0 0 0.33 0.33 0.33 0 0 0 0 0 0 1"/>` +
    `<feComponentTransfer>${fn('R')}${fn('G')}${fn('B')}</feComponentTransfer>` +
    `</filter><rect width="100%" height="100%" filter="url(#f)"/></svg>`;
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  const c = canvas(W, H);
  c.getContext('2d').drawImage(img, 0, 0);
  textureCache.set(key, c);
  return c;
}

export async function texturesFor(W, H) {
  const k = W / 1024;
  return {
    fine: await noiseTexture(W, H, (0.55 / k).toFixed(4), 2, 3, 1.6),
    fine2: await noiseTexture(W, H, (0.35 / k).toFixed(4), 2, 11, 1.8),
    medium: await noiseTexture(W, H, (0.02 / k).toFixed(4), 4, 5, 2.4),
    medium2: await noiseTexture(W, H, (0.045 / k).toFixed(4), 3, 17, 2.2),
    coarse: await noiseTexture(W, H, (0.004 / k).toFixed(5), 4, 7, 2.6),
  };
}

function texFill(ctx, tex, r, x, y, w, h, alpha, op, scale = 1) {
  const pat = ctx.createPattern(tex, 'repeat');
  pat.setTransform(new DOMMatrix().translate(r.range(0, tex.width), r.range(0, tex.height)).scale(scale));
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = op;
  ctx.fillStyle = pat;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

// ---------- cars ----------
const BODY_COLOURS = [
  [0, 0, 92], [0, 0, 12], [210, 6, 70], [210, 5, 45], [355, 75, 38], [215, 60, 32],
  [200, 45, 50], [140, 30, 28], [35, 25, 62], [25, 70, 40], [0, 0, 78], [45, 80, 50],
];
const INTERIOR_COLOURS = [[0, 0, 10], [0, 0, 18], [30, 25, 55], [25, 30, 30], [0, 0, 35]];

export function makeCar(r) {
  const [h, s, l] = r.pick(BODY_COLOURS);
  const [ih, is, il] = r.pick(INTERIOR_COLOURS);
  return {
    body: { h: h + r.range(-4, 4), s, l: clamp(l + r.range(-4, 4), 5, 95) },
    interior: { h: ih, s: is, l: il },
    kind: r.pick(['sedan', 'suv', 'truck', 'hatch']),
    rim: r.pick(['#c9ccd1', '#8a8f96', '#2b2d30', '#d8d2c4']),
  };
}

function bodyGradient(ctx, car, y0, y1, gain = 0) {
  const { h, s, l } = car.body;
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, hsl(h, s, clamp(l + 18 + gain, 0, 98)));
  g.addColorStop(0.35, hsl(h, s, clamp(l + 4 + gain, 0, 96)));
  g.addColorStop(0.7, hsl(h, s, clamp(l - 6 + gain, 0, 90)));
  g.addColorStop(1, hsl(h, s, clamp(l - 22 + gain, 0, 80)));
  return g;
}

function wheel(ctx, car, x, y, R, r) {
  ctx.fillStyle = '#121212';
  ctx.beginPath();
  ctx.arc(x, y, R, 0, Math.PI * 2);
  ctx.fill();
  const g = ctx.createRadialGradient(x - R * 0.2, y - R * 0.2, R * 0.05, x, y, R * 0.68);
  g.addColorStop(0, '#f2f2f2');
  g.addColorStop(0.5, car.rim);
  g.addColorStop(1, '#3a3a3a');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, R * 0.66, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(20,20,20,0.75)';
  ctx.lineWidth = Math.max(1, R * 0.07);
  const spokes = r.int(5, 10);
  const rot = r.range(0, Math.PI);
  for (let k = 0; k < spokes; k++) {
    const a = rot + (k * Math.PI * 2) / spokes;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(a) * R * 0.18, y + Math.sin(a) * R * 0.18);
    ctx.lineTo(x + Math.cos(a) * R * 0.6, y + Math.sin(a) * R * 0.6);
    ctx.stroke();
  }
  ctx.fillStyle = '#555';
  ctx.beginPath();
  ctx.arc(x, y, R * 0.13, 0, Math.PI * 2);
  ctx.fill();
}

// A car seen from the side, three-quarter, front or rear: a body, a glass
// house, wheels, lights, a shoulder highlight and a soft ground shadow.
export function drawCar(ctx, car, view, cx, gy, L, flip, r) {
  const tall = car.kind === 'suv' || car.kind === 'truck' ? 1.18 : 1;
  ctx.save();
  if (flip) {
    ctx.translate(cx * 2, 0);
    ctx.scale(-1, 1);
  }
  // ground shadow
  ctx.save();
  ctx.filter = `blur(${Math.max(2, L * 0.02).toFixed(1)}px)`;
  ctx.fillStyle = `rgba(0,0,0,${r.range(0.45, 0.7).toFixed(2)})`;
  ctx.beginPath();
  const sw = view === 'front' || view === 'rear' ? L * 0.5 : view === 'three' ? L * 0.62 : L * 0.56;
  ctx.ellipse(cx, gy, sw, L * 0.05, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  if (view === 'front' || view === 'rear') {
    const w = L * 0.46;
    const bh = L * 0.2 * tall;
    const ch = L * 0.16 * tall;
    const x0 = cx - w;
    const x1 = cx + w;
    const yb = gy - L * 0.04;
    const yt = yb - bh;
    // tyres
    ctx.fillStyle = '#111';
    ctx.fillRect(x0 + w * 0.08, yb - L * 0.03, w * 0.28, L * 0.07);
    ctx.fillRect(x1 - w * 0.36, yb - L * 0.03, w * 0.28, L * 0.07);
    // body
    ctx.fillStyle = bodyGradient(ctx, car, yt - ch, yb);
    ctx.beginPath();
    ctx.moveTo(x0, yb);
    ctx.lineTo(x0 - w * 0.02, yt + bh * 0.25);
    ctx.quadraticCurveTo(x0, yt, x0 + w * 0.2, yt - bh * 0.05);
    ctx.lineTo(x1 - w * 0.2, yt - bh * 0.05);
    ctx.quadraticCurveTo(x1, yt, x1 + w * 0.02, yt + bh * 0.25);
    ctx.lineTo(x1, yb);
    ctx.closePath();
    ctx.fill();
    // glass house
    const gg = ctx.createLinearGradient(0, yt - ch, 0, yt);
    gg.addColorStop(0, 'rgba(160,185,205,1)');
    gg.addColorStop(0.5, 'rgba(40,50,60,1)');
    gg.addColorStop(1, 'rgba(15,18,22,1)');
    ctx.fillStyle = bodyGradient(ctx, car, yt - ch, yt, 6);
    ctx.beginPath();
    ctx.moveTo(x0 + w * 0.18, yt);
    ctx.lineTo(x0 + w * 0.32, yt - ch);
    ctx.lineTo(x1 - w * 0.32, yt - ch);
    ctx.lineTo(x1 - w * 0.18, yt);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = gg;
    ctx.beginPath();
    ctx.moveTo(x0 + w * 0.22, yt - ch * 0.05);
    ctx.lineTo(x0 + w * 0.34, yt - ch * 0.9);
    ctx.lineTo(x1 - w * 0.34, yt - ch * 0.9);
    ctx.lineTo(x1 - w * 0.22, yt - ch * 0.05);
    ctx.closePath();
    ctx.fill();
    // grille / lights
    const lit = view === 'front' ? 'rgba(240,245,255,0.95)' : 'rgba(200,20,25,0.95)';
    ctx.fillStyle = lit;
    ctx.fillRect(x0 + w * 0.06, yt + bh * 0.18, w * 0.32, bh * 0.16);
    ctx.fillRect(x1 - w * 0.38, yt + bh * 0.18, w * 0.32, bh * 0.16);
    ctx.fillStyle = view === 'front' ? '#151515' : hsl(car.body.h, car.body.s, clamp(car.body.l - 15, 0, 90));
    ctx.fillRect(cx - w * 0.42, yt + bh * 0.42, w * 0.84, bh * 0.3);
    ctx.fillStyle = '#e8e8e8';
    ctx.fillRect(cx - w * 0.14, yt + bh * 0.48, w * 0.28, bh * 0.14);
  } else {
    const len = view === 'three' ? L * 0.8 : L;
    const x0 = cx - len / 2;
    const x1 = cx + len / 2;
    const R = L * 0.085 * (car.kind === 'truck' ? 1.15 : 1);
    const yb = gy - R * 0.35;
    const bh = L * 0.17 * tall;
    const ch = L * 0.14 * tall;
    const yt = yb - bh;
    const fx = view === 'three' ? L * 0.1 : 0; // the front face, seen at an angle
    // body side
    ctx.fillStyle = bodyGradient(ctx, car, yt - ch, yb);
    ctx.beginPath();
    ctx.moveTo(x0, yb);
    ctx.lineTo(x0 - len * 0.01, yt + bh * 0.3);
    ctx.quadraticCurveTo(x0, yt, x0 + len * 0.1, yt);
    ctx.lineTo(x1 - len * 0.12, yt + bh * 0.08);
    ctx.quadraticCurveTo(x1 + len * 0.01, yt + bh * 0.12, x1, yt + bh * 0.45);
    ctx.lineTo(x1, yb);
    ctx.closePath();
    ctx.fill();
    // cabin
    const rear = car.kind === 'truck' ? 0.45 : car.kind === 'hatch' || car.kind === 'suv' ? 0.12 : 0.24;
    ctx.fillStyle = bodyGradient(ctx, car, yt - ch, yt, 8);
    ctx.beginPath();
    ctx.moveTo(x0 + len * rear, yt + 1);
    ctx.lineTo(x0 + len * (rear + 0.06), yt - ch);
    ctx.lineTo(x1 - len * 0.42, yt - ch);
    ctx.lineTo(x1 - len * 0.26, yt + 1);
    ctx.closePath();
    ctx.fill();
    const gg = ctx.createLinearGradient(0, yt - ch, 0, yt);
    gg.addColorStop(0, `rgba(${r.int(150, 210)},${r.int(170, 215)},${r.int(190, 230)},1)`);
    gg.addColorStop(0.55, 'rgba(45,55,66,1)');
    gg.addColorStop(1, 'rgba(16,19,24,1)');
    ctx.fillStyle = gg;
    ctx.beginPath();
    ctx.moveTo(x0 + len * (rear + 0.025), yt - ch * 0.06);
    ctx.lineTo(x0 + len * (rear + 0.075), yt - ch * 0.88);
    ctx.lineTo(x1 - len * 0.44, yt - ch * 0.88);
    ctx.lineTo(x1 - len * 0.29, yt - ch * 0.06);
    ctx.closePath();
    ctx.fill();
    // pillar
    ctx.fillStyle = hsl(car.body.h, car.body.s, clamp(car.body.l - 10, 0, 85));
    const px = x0 + len * (rear + 0.06 + (0.58 - rear) * 0.5);
    ctx.fillRect(px, yt - ch * 0.9, len * 0.018, ch * 0.88);
    // shoulder highlight
    const hl = ctx.createLinearGradient(0, yt + bh * 0.05, 0, yt + bh * 0.3);
    hl.addColorStop(0, 'rgba(255,255,255,0)');
    hl.addColorStop(0.5, `rgba(255,255,255,${r.range(0.25, 0.55).toFixed(2)})`);
    hl.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hl;
    ctx.fillRect(x0 + len * r.range(0.02, 0.2), yt + bh * 0.05, len * r.range(0.5, 0.75), bh * 0.25);
    // door lines, handle
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = Math.max(1, L * 0.003);
    ctx.beginPath();
    ctx.moveTo(px + len * 0.01, yt);
    ctx.lineTo(px + len * 0.01, yb - R * 0.9);
    ctx.stroke();
    ctx.fillStyle = 'rgba(20,20,20,0.6)';
    ctx.fillRect(px + len * 0.04, yt + bh * 0.28, len * 0.04, bh * 0.05);
    // lights
    ctx.fillStyle = 'rgba(245,248,255,0.95)';
    ctx.fillRect(x1 - len * 0.05, yt + bh * 0.2, len * 0.045, bh * 0.14);
    ctx.fillStyle = 'rgba(190,20,25,0.95)';
    ctx.fillRect(x0 + len * 0.005, yt + bh * 0.18, len * 0.03, bh * 0.14);
    // three-quarter: the front face
    if (fx) {
      ctx.fillStyle = bodyGradient(ctx, car, yt, yb, -6);
      ctx.beginPath();
      ctx.moveTo(x1, yt + bh * 0.4);
      ctx.lineTo(x1 + fx, yt + bh * 0.25);
      ctx.lineTo(x1 + fx, yb - R * 0.1);
      ctx.lineTo(x1, yb);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(x1 + fx * 0.25, yt + bh * 0.55, fx * 0.5, bh * 0.2);
      ctx.fillStyle = 'rgba(240,245,255,0.95)';
      ctx.fillRect(x1 + fx * 0.05, yt + bh * 0.3, fx * 0.22, bh * 0.12);
      ctx.fillRect(x1 + fx * 0.72, yt + bh * 0.28, fx * 0.22, bh * 0.12);
    }
    // wheel arches and wheels
    ctx.fillStyle = '#0c0c0c';
    for (const wx of [x0 + len * 0.2, x1 - len * 0.18]) {
      ctx.beginPath();
      ctx.arc(wx, yb - R * 0.05, R * 1.12, Math.PI, 0);
      ctx.fill();
      wheel(ctx, car, wx, yb - R * 0.05 + R * 0.35, R, r);
    }
  }
  ctx.restore();
}

// ---------- scenes ----------
function sky(ctx, W, hz, r, opt) {
  const g = ctx.createLinearGradient(0, 0, 0, hz);
  if (opt.overcast) {
    const v = r.range(248, 255);
    g.addColorStop(0, `rgb(${v},${v},${v})`);
    g.addColorStop(1, 'rgb(255,255,255)');
  } else {
    const h = r.range(195, 218);
    g.addColorStop(0, hsl(h, r.range(40, 75), r.range(36, 55)));
    g.addColorStop(1, hsl(h, r.range(20, 50), r.range(74, 90)));
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, hz + 2);
}

function backdrop(ctx, W, H, hz, r, T, opt) {
  const top = hz - H * r.range(0.05, 0.2);
  // buildings
  const nb = r.int(0, 4);
  for (let k = 0; k < nb; k++) {
    const bw = W * r.range(0.15, 0.5);
    const bx = r.range(-0.1 * W, W);
    const bt = hz - H * r.range(0.06, 0.24);
    ctx.fillStyle = r.pick([hsl(35, 15, r.range(55, 80)), hsl(210, 10, r.range(40, 70)), hsl(205, 35, r.range(35, 55)), hsl(0, 0, r.range(85, 95))]);
    ctx.fillRect(bx, bt, bw, hz - bt + 1);
    ctx.fillStyle = `rgba(30,40,55,${r.range(0.4, 0.8).toFixed(2)})`;
    const cols = r.int(4, 14);
    const rows = r.int(1, 4);
    for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) ctx.fillRect(bx + (bw * (i + 0.2)) / cols, bt + ((hz - bt) * (j + 0.25)) / (rows + 0.5), (bw / cols) * 0.6, ((hz - bt) / (rows + 0.5)) * 0.45);
  }
  // trees, textured inside their own outline only
  const nt = r.int(4, 30);
  const trees = new Path2D();
  for (let k = 0; k < nt; k++) {
    const tx = r.range(0, W);
    const tr = H * r.range(0.02, 0.09);
    const ty = hz - tr * r.range(0.4, 1.4);
    const p = new Path2D();
    p.ellipse(tx, ty, tr * r.range(0.8, 1.5), tr, 0, 0, Math.PI * 2);
    ctx.fillStyle = hsl(r.range(85, 130), r.range(25, 50), r.range(14, 32));
    ctx.fill(p);
    trees.addPath(p);
  }
  ctx.save();
  ctx.clip(trees);
  texFill(ctx, T.medium2, r, 0, top - H * 0.2, W, hz - top + H * 0.2, 0.55, 'overlay');
  ctx.restore();
  // parked cars in the distance
  const nc = r.int(0, 6);
  for (let k = 0; k < nc; k++) {
    ctx.fillStyle = hsl(r.range(0, 360), r.range(0, 50), r.range(15, 85));
    const cw = W * r.range(0.05, 0.12);
    const cx = r.range(0, W);
    ctx.fillRect(cx, hz - cw * 0.35, cw, cw * 0.3);
    ctx.fillRect(cx + cw * 0.2, hz - cw * 0.55, cw * 0.55, cw * 0.22);
  }
}

function ground(ctx, W, H, hz, r, T) {
  const v = r.range(70, 135);
  const g = ctx.createLinearGradient(0, hz, 0, H);
  g.addColorStop(0, `rgb(${v + 25},${v + 25},${v + 28})`);
  g.addColorStop(1, `rgb(${v - 20},${v - 20},${v - 18})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, hz, W, H - hz);
  texFill(ctx, T.fine, r, 0, hz, W, H - hz, r.range(0.25, 0.5), 'overlay');
  texFill(ctx, T.medium, r, 0, hz, W, H - hz, r.range(0.15, 0.35), 'soft-light');
  // parking lines in perspective
  const nl = r.int(0, 4);
  ctx.fillStyle = r.chance(0.7) ? 'rgba(235,235,225,0.85)' : 'rgba(225,190,60,0.85)';
  for (let k = 0; k < nl; k++) {
    const x = r.range(-0.2, 1.2) * W;
    const sk = r.range(-0.6, 0.6) * W;
    const lw = W * 0.012;
    ctx.beginPath();
    ctx.moveTo(x, hz + 2);
    ctx.lineTo(x + lw * 0.4, hz + 2);
    ctx.lineTo(x + sk + lw * 2, H);
    ctx.lineTo(x + sk, H);
    ctx.closePath();
    ctx.fill();
  }
}

function exterior(ctx, W, H, car, r, T, opt, view) {
  // opt.spot: the dealer's usual photo spot, the same background every time
  // (only the camera moves a little); otherwise a different place per shot.
  const rb = opt.spot != null ? rngOf(opt.spot) : r;
  const hz = H * rb.range(0.36, 0.52);
  if (opt.studio) {
    studioBackdrop(ctx, W, H, STUDIOS[opt.studio] || STUDIOS.grey);
  } else {
    ctx.save();
    if (opt.spot != null && !opt.fixed) {
      ctx.translate(W / 2 + r.range(-0.015, 0.015) * W, H / 2 + r.range(-0.015, 0.015) * H);
      ctx.rotate(r.range(-0.01, 0.01));
      ctx.scale(1.04, 1.04);
      ctx.translate(-W / 2, -H / 2);
    }
    sky(ctx, W, hz, rb, opt);
    if (!opt.overcast && rb.chance(0.75)) texFill(ctx, T.coarse, rb, 0, 0, W, hz, rb.range(0.3, 0.75), 'screen');
    backdrop(ctx, W, H, hz, rb, T, opt);
    ground(ctx, W, H, hz, rb, T);
    ctx.restore();
  }
  const L = W * r.range(0.55, 0.92);
  const cx = W * r.range(0.4, 0.6);
  const gy = opt.studio ? H * r.range(0.72, 0.8) : clamp(hz + H * r.range(0.22, 0.42), hz + H * 0.15, H * 0.95);
  drawCar(ctx, car, view, cx, gy, L, r.chance(0.5), r);
}

const STUDIOS = {
  grey: { wallTop: '#9aa0a6', wallBottom: '#d5d8dc', floorTop: '#c3c6ca', floorBottom: '#7d8287' },
  white: { wallTop: '#f4f4f4', wallBottom: '#ffffff', floorTop: '#eeeeee', floorBottom: '#c9c9c9' },
  // a showroom corner: a poster with text and a logo on the wall, lines on the floor
  poster: { wallTop: '#6b7a89', wallBottom: '#a9b4bf', floorTop: '#8d939a', floorBottom: '#4d5359', poster: true },
};

// A studio: the same wall and floor in every exterior shot, pixel for pixel
// (a booth with a fixed camera and fixed exposure, or a pasted backdrop).
function studioBackdrop(ctx, W, H, s) {
  const g = ctx.createLinearGradient(0, 0, 0, H * 0.62);
  g.addColorStop(0, s.wallTop);
  g.addColorStop(1, s.wallBottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H * 0.62);
  const f = ctx.createLinearGradient(0, H * 0.58, 0, H);
  f.addColorStop(0, s.floorTop);
  f.addColorStop(1, s.floorBottom);
  ctx.fillStyle = f;
  ctx.beginPath();
  ctx.moveTo(0, H * 0.64);
  ctx.quadraticCurveTo(W * 0.5, H * 0.56, W, H * 0.64);
  ctx.lineTo(W, H);
  ctx.lineTo(0, H);
  ctx.closePath();
  ctx.fill();
  // ceiling lights reflected on the floor
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  for (let k = 0; k < 4; k++) ctx.fillRect(W * (0.1 + k * 0.22), H * 0.86, W * 0.12, H * 0.03);
  if (s.poster) {
    ctx.fillStyle = '#f5f1e8';
    ctx.fillRect(W * 0.04, H * 0.06, W * 0.22, H * 0.3);
    ctx.fillStyle = '#b5121b';
    ctx.fillRect(W * 0.05, H * 0.08, W * 0.2, H * 0.08);
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.round(H * 0.035)}px Inter, sans-serif`;
    ctx.fillText('SERVICE', W * 0.07, H * 0.13);
    ctx.fillStyle = '#1b263b';
    ctx.font = `bold ${Math.round(H * 0.03)}px Inter, sans-serif`;
    ctx.fillText('PARTS · SALES', W * 0.06, H * 0.22);
    ctx.fillText('OPEN 7 DAYS', W * 0.06, H * 0.28);
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillRect(W * 0.7, H * 0.1, W * 0.25, H * 0.02);
    ctx.fillStyle = '#e8c547';
    for (let k = 0; k < 5; k++) ctx.fillRect(W * (0.05 + k * 0.2), H * 0.93, W * 0.08, H * 0.012);
  }
}

function dash(ctx, W, H, car, r, T, opt) {
  const ic = car.interior;
  const wsy = H * r.range(0.28, 0.45);
  // windshield: outside, often blown out
  const g = ctx.createLinearGradient(0, 0, 0, wsy);
  const out = opt.overcast || r.chance(0.6) ? 255 : r.range(170, 230);
  g.addColorStop(0, `rgb(${out},${out},${out})`);
  g.addColorStop(1, `rgb(${out * 0.8},${out * 0.85},${out * 0.8})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, wsy + 4);
  if (out < 250) texFill(ctx, T.medium, r, 0, wsy * 0.5, W, wsy * 0.5, 0.4, 'multiply');
  // A pillars
  ctx.fillStyle = hsl(ic.h, ic.s, ic.l + 5);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(W * r.range(0.08, 0.2), 0);
  ctx.lineTo(W * 0.02, wsy * 1.2);
  ctx.lineTo(0, wsy * 1.2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(W, 0);
  ctx.lineTo(W * r.range(0.8, 0.92), 0);
  ctx.lineTo(W * 0.98, wsy * 1.2);
  ctx.lineTo(W, wsy * 1.2);
  ctx.fill();
  // dashboard
  const dg = ctx.createLinearGradient(0, wsy, 0, H);
  dg.addColorStop(0, hsl(ic.h, ic.s, ic.l + 12));
  dg.addColorStop(0.3, hsl(ic.h, ic.s, ic.l));
  dg.addColorStop(1, hsl(ic.h, ic.s, Math.max(3, ic.l - 6)));
  ctx.fillStyle = dg;
  ctx.beginPath();
  ctx.moveTo(0, wsy + H * 0.05);
  ctx.bezierCurveTo(W * 0.3, wsy - H * 0.05, W * 0.7, wsy - H * 0.05, W, wsy + H * 0.06);
  ctx.lineTo(W, H);
  ctx.lineTo(0, H);
  ctx.closePath();
  ctx.fill();
  texFill(ctx, T.medium2, r, 0, wsy, W, H - wsy, 0.3, 'soft-light');
  // cluster
  const cl = W * r.range(0.18, 0.35);
  ctx.fillStyle = '#060708';
  ctx.beginPath();
  ctx.roundRect(cl - W * 0.13, wsy + H * 0.08, W * 0.26, H * 0.17, H * 0.03);
  ctx.fill();
  for (const dx of [-0.06, 0.06]) {
    const x = cl + W * dx;
    const y = wsy + H * 0.165;
    ctx.strokeStyle = r.pick(['rgba(255,255,255,0.85)', 'rgba(120,200,255,0.9)', 'rgba(255,150,40,0.9)']);
    ctx.lineWidth = Math.max(1, W * 0.003);
    ctx.beginPath();
    ctx.arc(x, y, H * 0.06, Math.PI * 0.8, Math.PI * 2.2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,60,40,0.95)';
    ctx.beginPath();
    ctx.moveTo(x, y);
    const a = r.range(Math.PI, Math.PI * 1.9);
    ctx.lineTo(x + Math.cos(a) * H * 0.05, y + Math.sin(a) * H * 0.05);
    ctx.stroke();
  }
  // screen
  const sx = W * r.range(0.45, 0.6);
  ctx.fillStyle = '#0b1220';
  ctx.fillRect(sx, wsy + H * 0.1, W * 0.17, H * 0.12);
  for (let k = 0; k < 5; k++) {
    ctx.fillStyle = r.pick(['#2b6cb0', '#e2e8f0', '#38a169', '#f6ad55', '#90cdf4']);
    ctx.fillRect(sx + W * 0.01 + k * W * 0.032, wsy + H * 0.12, W * 0.025, H * r.range(0.02, 0.08));
  }
  // steering wheel
  ctx.strokeStyle = hsl(ic.h, ic.s, Math.max(4, ic.l - 4));
  ctx.lineWidth = H * 0.035;
  ctx.beginPath();
  ctx.arc(cl, wsy + H * 0.36, H * 0.24, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = H * 0.006;
  ctx.beginPath();
  ctx.arc(cl, wsy + H * 0.36, H * 0.255, Math.PI * 1.1, Math.PI * 1.7);
  ctx.stroke();
  ctx.fillStyle = hsl(ic.h, ic.s, Math.max(4, ic.l - 2));
  ctx.fillRect(cl - H * 0.24, wsy + H * 0.34, H * 0.48, H * 0.05);
  ctx.beginPath();
  ctx.arc(cl, wsy + H * 0.36, H * 0.07, 0, Math.PI * 2);
  ctx.fill();
  // vents, console
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  for (let k = 0; k < 2; k++) ctx.fillRect(sx + W * (0.02 + k * 0.08), wsy + H * 0.25, W * 0.06, H * 0.035);
  ctx.fillStyle = hsl(ic.h, ic.s, ic.l + 8);
  ctx.fillRect(sx, H * 0.82, W * 0.18, H * 0.2);
}

function seats(ctx, W, H, car, r, T, opt) {
  const ic = car.interior;
  // door glass / outside light
  const g = ctx.createLinearGradient(0, 0, W, 0);
  const out = r.range(150, 255);
  g.addColorStop(0, `rgb(${out},${out},${out})`);
  g.addColorStop(1, `rgb(${out * 0.6},${out * 0.62},${out * 0.65})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H * r.range(0.25, 0.4));
  ctx.fillStyle = hsl(ic.h, ic.s, ic.l + 6);
  ctx.fillRect(0, H * 0.3, W, H * 0.7);
  texFill(ctx, T.medium, r, 0, H * 0.3, W, H * 0.7, 0.2, 'soft-light');
  const n = r.int(1, 3);
  for (let k = 0; k < n; k++) {
    const x = W * r.range(0.05, 0.6);
    const w = W * r.range(0.25, 0.45);
    const y = H * r.range(0.15, 0.4);
    const sg = ctx.createLinearGradient(x, 0, x + w, 0);
    sg.addColorStop(0, hsl(ic.h, ic.s, ic.l + 14));
    sg.addColorStop(0.5, hsl(ic.h, ic.s, ic.l + 4));
    sg.addColorStop(1, hsl(ic.h, ic.s, Math.max(2, ic.l - 6)));
    ctx.fillStyle = sg;
    ctx.beginPath();
    ctx.roundRect(x, y, w, H * 0.8, W * 0.04);
    ctx.fill();
    texFill(ctx, T.medium2, r, x, y, w, H * 0.8, 0.22, 'soft-light');
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.setLineDash([W * 0.006, W * 0.006]);
    ctx.lineWidth = Math.max(1, W * 0.002);
    for (let j = 1; j < 4; j++) {
      ctx.beginPath();
      ctx.moveTo(x + (w * j) / 4, y + H * 0.05);
      ctx.lineTo(x + (w * j) / 4, y + H * 0.7);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
}

function odometer(ctx, W, H, car, r) {
  ctx.fillStyle = '#07080a';
  ctx.fillRect(0, 0, W, H);
  const cx = W * r.range(0.35, 0.65);
  const cy = H * r.range(0.4, 0.6);
  const R = H * r.range(0.3, 0.45);
  ctx.strokeStyle = r.pick(['#e6e6e6', '#7fd1ff', '#ffb347']);
  ctx.lineWidth = Math.max(2, H * 0.008);
  ctx.beginPath();
  ctx.arc(cx, cy, R, Math.PI * 0.75, Math.PI * 2.25);
  ctx.stroke();
  for (let k = 0; k <= 12; k++) {
    const a = Math.PI * 0.75 + (k * Math.PI * 1.5) / 12;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * R * 0.85, cy + Math.sin(a) * R * 0.85);
    ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    ctx.stroke();
  }
  ctx.fillStyle = '#f2f2f2';
  ctx.font = `bold ${Math.round(H * 0.08)}px "DejaVu Sans Mono", monospace`;
  ctx.fillText(String(r.int(10000, 99999)).padStart(6, '0'), cx - R * 0.45, cy + R * 0.45);
  ctx.strokeStyle = '#ff3b1f';
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  const a = r.range(Math.PI * 0.8, Math.PI * 1.6);
  ctx.lineTo(cx + Math.cos(a) * R * 0.9, cy + Math.sin(a) * R * 0.9);
  ctx.stroke();
}

function engine(ctx, W, H, car, r, T) {
  ctx.fillStyle = `rgb(${r.int(40, 80)},${r.int(40, 80)},${r.int(42, 84)})`;
  ctx.fillRect(0, 0, W, H);
  // hood edge in body colour at the top
  ctx.fillStyle = bodyGradient(ctx, car, 0, H * 0.18);
  ctx.fillRect(0, 0, W, H * r.range(0.06, 0.16));
  for (let k = 0; k < 26; k++) {
    const x = r.range(0, W);
    const y = r.range(H * 0.1, H);
    const w = W * r.range(0.04, 0.3);
    const h = H * r.range(0.03, 0.25);
    const g = ctx.createLinearGradient(x, y, x + w, y + h);
    const base = r.int(15, 150);
    g.addColorStop(0, `rgb(${base + 60},${base + 60},${base + 62})`);
    g.addColorStop(0.5, `rgb(${base},${base},${base + 4})`);
    g.addColorStop(1, `rgb(${base * 0.5},${base * 0.5},${base * 0.5})`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, Math.min(w, h) * 0.3);
    ctx.fill();
  }
  ctx.lineCap = 'round';
  for (let k = 0; k < 12; k++) {
    ctx.strokeStyle = r.pick(['#111', '#1d1d1d', '#2a2a2a', '#3b2b1b']);
    ctx.lineWidth = H * r.range(0.01, 0.03);
    ctx.beginPath();
    ctx.moveTo(r.range(0, W), r.range(0, H));
    ctx.bezierCurveTo(r.range(0, W), r.range(0, H), r.range(0, W), r.range(0, H), r.range(0, W), r.range(0, H));
    ctx.stroke();
  }
  for (let k = 0; k < 5; k++) {
    ctx.fillStyle = r.pick(['#f2c230', '#2f6fd6', '#e8e8e8', '#d9531e', '#222']);
    ctx.beginPath();
    ctx.arc(r.range(0, W), r.range(H * 0.2, H), H * r.range(0.02, 0.05), 0, Math.PI * 2);
    ctx.fill();
  }
  texFill(ctx, T.fine2, r, 0, 0, W, H, 0.25, 'overlay');
}

function wheelShot(ctx, W, H, car, r, T) {
  const gy = H * r.range(0.75, 0.95);
  ground(ctx, W, H, gy - H * 0.2, r, T);
  ctx.fillStyle = bodyGradient(ctx, car, 0, gy);
  ctx.fillRect(0, 0, W, gy - H * 0.25);
  const R = H * r.range(0.32, 0.45);
  const x = W * r.range(0.35, 0.65);
  ctx.fillStyle = '#0b0b0b';
  ctx.beginPath();
  ctx.arc(x, gy - R, R * 1.15, Math.PI, 0);
  ctx.fill();
  wheel(ctx, car, x, gy - R, R, r);
}

function cargo(ctx, W, H, car, r, T) {
  const ic = car.interior;
  const out = r.range(160, 255);
  ctx.fillStyle = `rgb(${out},${out},${out})`;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = bodyGradient(ctx, car, 0, H * 0.2);
  ctx.fillRect(0, 0, W, H * r.range(0.08, 0.2));
  ctx.fillStyle = hsl(ic.h, ic.s, Math.max(5, ic.l));
  ctx.beginPath();
  ctx.moveTo(W * 0.08, H * 0.25);
  ctx.lineTo(W * 0.92, H * 0.25);
  ctx.lineTo(W, H);
  ctx.lineTo(0, H);
  ctx.closePath();
  ctx.fill();
  texFill(ctx, T.fine2, r, 0, H * 0.25, W, H * 0.75, 0.5, 'overlay');
  texFill(ctx, T.medium, r, 0, H * 0.25, W, H * 0.75, 0.3, 'multiply');
}

// The order a dealer gallery usually comes in: walk-around exteriors first,
// then the cabin, the cargo area, the engine bay and details.
export function galleryPlan(count, r, opt = {}) {
  const ext = ['three', 'side', 'three', 'rear', 'front', 'side', 'three', 'rear'];
  const inside = ['dash', 'seats', 'seats', 'dash', 'odometer', 'seats', 'dash', 'seats'];
  const extShare = opt.extShare != null ? opt.extShare : 0.45;
  const plan = [];
  const nExt = Math.max(1, Math.round(count * extShare));
  for (let i = 0; i < nExt; i++) plan.push({ type: 'ext', view: ext[i % ext.length] });
  const rest = ['wheel', 'engine', 'cargo'];
  let k = 0;
  while (plan.length < count) {
    const left = count - plan.length;
    if (left <= 3 && !opt.noRest) plan.push({ type: rest[3 - left] || 'seats' });
    else plan.push({ type: inside[k++ % inside.length] });
  }
  return plan.slice(0, count);
}

export function drawScene(ctx, W, H, car, shot, r, T, opt) {
  switch (shot.type) {
    case 'ext': return exterior(ctx, W, H, car, r, T, opt, shot.view);
    case 'dash': return dash(ctx, W, H, car, r, T, opt);
    case 'seats': return seats(ctx, W, H, car, r, T, opt);
    case 'odometer': return odometer(ctx, W, H, car, r);
    case 'engine': return engine(ctx, W, H, car, r, T);
    case 'wheel': return wheelShot(ctx, W, H, car, r, T);
    case 'cargo': return cargo(ctx, W, H, car, r, T);
    default: throw new Error('shot ' + shot.type);
  }
}

// One finished photo: the scene, then what the camera adds (exposure,
// contrast, white balance, vignetting, sensor noise). In a studio the
// backdrop is pixel-identical between shots, so only the car layer varies.
export function renderPhoto(W, H, car, shot, r, T, opt = {}) {
  const raw = canvas(W, H);
  const rc = raw.getContext('2d');
  const studio = opt.studio && shot.type === 'ext';
  if (studio) rc.clearRect(0, 0, W, H);
  drawScene(rc, W, H, car, shot, r, T, { ...opt, studio: studio ? opt.studio : null });
  const out = canvas(W, H);
  const oc = out.getContext('2d');
  if (studio && !opt.auto) {
    // the booth: fixed camera, fixed exposure. Nothing varies but the car.
    oc.drawImage(raw, 0, 0);
    return out;
  }
  const b = r.range(0.82, 1.22);
  const c = r.range(0.9, 1.15);
  const s = r.range(0.85, 1.15);
  oc.filter = `brightness(${b.toFixed(3)}) contrast(${c.toFixed(3)}) saturate(${s.toFixed(3)})`;
  oc.drawImage(raw, 0, 0);
  oc.filter = 'none';
  // white balance
  oc.save();
  oc.globalCompositeOperation = 'soft-light';
  oc.globalAlpha = r.range(0.04, 0.16);
  oc.fillStyle = r.pick(['#ffb070', '#70a8ff', '#ffe0a0', '#a0ffd0']);
  oc.fillRect(0, 0, W, H);
  oc.restore();
  if (r.chance(0.55)) {
    const g = oc.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.55);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${r.range(0.12, 0.38).toFixed(2)})`);
    oc.fillStyle = g;
    oc.fillRect(0, 0, W, H);
  }
  texFill(oc, T.fine, r, 0, 0, W, H, r.range(0.05, 0.12), 'overlay');
  return out;
}

// ---------- overlays (the vendor's transparent PNG, at the photo's pixel size) ----------
function logo(ctx, x, y, s, colours = ['#ffffff', '#d62828']) {
  ctx.save();
  ctx.fillStyle = colours[0];
  ctx.beginPath();
  ctx.arc(x + s / 2, y + s / 2, s / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = colours[1];
  ctx.beginPath();
  ctx.moveTo(x + s * 0.15, y + s * 0.65);
  ctx.quadraticCurveTo(x + s * 0.5, y + s * 0.15, x + s * 0.9, y + s * 0.35);
  ctx.quadraticCurveTo(x + s * 0.55, y + s * 0.4, x + s * 0.2, y + s * 0.8);
  ctx.closePath();
  ctx.fill();
  ctx.font = `bold ${Math.round(s * 0.28)}px Inter, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('EA', x + s / 2, y + s * 0.9);
  ctx.restore();
}

function text(ctx, str, x, y, px, colour, align = 'left', weight = 'bold') {
  ctx.save();
  ctx.fillStyle = colour;
  ctx.font = `${weight} ${Math.max(6, Math.round(px))}px Inter, "DejaVu Sans", sans-serif`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(str, x, y);
  ctx.restore();
}

export const OVERLAYS = {
  bottomBand(ctx, W, H) {
    const y = Math.round(H * 0.86);
    const g = ctx.createLinearGradient(0, y, 0, H);
    g.addColorStop(0, '#13233a');
    g.addColorStop(1, '#0a1220');
    ctx.fillStyle = g;
    ctx.fillRect(0, y, W, H - y);
    ctx.fillStyle = '#c1121f';
    ctx.fillRect(0, y, W, Math.max(2, Math.round(H * 0.006)));
    logo(ctx, W * 0.025, y + H * 0.02, H * 0.1);
    text(ctx, 'EXAMPLE AUTO GROUP', W * 0.13, y + H * 0.045, H * 0.045, '#ffffff');
    text(ctx, '555-0100  |  example-auto.test', W * 0.13, y + H * 0.1, H * 0.03, '#d7dde6', 'left', '600');
    text(ctx, 'CERTIFIED PRE-OWNED', W * 0.97, y + H * 0.07, H * 0.035, '#f1c40f', 'right');
  },
  topBottom(ctx, W, H) {
    const t = Math.round(H * 0.07);
    ctx.fillStyle = '#b5121b';
    ctx.fillRect(0, 0, W, t);
    text(ctx, 'SHOP 24/7 AT EXAMPLE-AUTO.TEST', W / 2, t / 2, H * 0.036, '#ffffff', 'center');
    const y = Math.round(H * 0.89);
    ctx.fillStyle = '#f4f4f2';
    ctx.fillRect(0, y, W, H - y);
    logo(ctx, W * 0.03, y + H * 0.012, H * 0.085, ['#b5121b', '#13233a']);
    text(ctx, 'EXAMPLE AUTO GROUP  555-0100', W * 0.13, y + H * 0.055, H * 0.04, '#13233a');
  },
  frame(ctx, W, H) {
    const t = Math.round(H * 0.035);
    const b = Math.round(H * 0.13);
    const rad = H * 0.06;
    ctx.fillStyle = '#1e3a5f';
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.roundRect(t, t, W - 2 * t, H - t - b, rad);
    ctx.fill();
    ctx.restore();
    logo(ctx, W * 0.03, H - b + H * 0.015, H * 0.1);
    text(ctx, 'EXAMPLE AUTO GROUP', W * 0.14, H - b * 0.62, H * 0.045, '#ffffff');
    text(ctx, 'example-auto.test  ·  555-0100', W * 0.14, H - b * 0.25, H * 0.03, '#cfe3ff', 'left', '600');
  },
  cornerBadge(ctx, W, H) {
    const x = Math.round(W * 0.02);
    const y = Math.round(H * 0.02);
    const w = Math.round(W * 0.15);
    const h = Math.round(H * 0.1);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#13233a';
    ctx.lineWidth = Math.max(2, H * 0.004);
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, H * 0.015);
    ctx.fill();
    ctx.stroke();
    logo(ctx, x + w * 0.05, y + h * 0.12, h * 0.76, ['#d62828', '#13233a']);
    text(ctx, 'EXAMPLE', x + w * 0.62, y + h * 0.4, h * 0.24, '#13233a', 'center');
    text(ctx, 'AUTO', x + w * 0.62, y + h * 0.7, h * 0.22, '#d62828', 'center');
  },
  tab(ctx, W, H) {
    const y = Math.round(H * 0.9);
    ctx.fillStyle = '#101820';
    ctx.fillRect(0, y, W, H - y);
    const tx = Math.round(W * 0.05);
    const tw = Math.round(W * 0.26);
    const ty = Math.round(H * 0.82);
    ctx.beginPath();
    ctx.roundRect(tx, ty, tw, y - ty + 4, [H * 0.03, H * 0.03, 0, 0]);
    ctx.fill();
    logo(ctx, tx + tw * 0.06, ty + H * 0.012, H * 0.075);
    text(ctx, 'EXAMPLE', tx + tw * 0.62, ty + H * 0.045, H * 0.04, '#ffffff', 'center');
    text(ctx, 'AUTO GROUP  ·  555-0100  ·  example-auto.test', W * 0.36, y + H * 0.05, H * 0.032, '#e6e6e6');
  },
  shadowBand(ctx, W, H) {
    const y = Math.round(H * 0.88);
    const s = Math.round(H * 0.045);
    const g = ctx.createLinearGradient(0, y - s, 0, y);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = g;
    ctx.fillRect(0, y - s, W, s);
    ctx.fillStyle = '#1b1b1b';
    ctx.fillRect(0, y, W, H - y);
    logo(ctx, W * 0.025, y + H * 0.015, H * 0.09);
    text(ctx, 'EXAMPLE AUTO GROUP', W * 0.12, y + H * 0.04, H * 0.04, '#ffffff');
    text(ctx, '555-0100  |  example-auto.test', W * 0.12, y + H * 0.085, H * 0.028, '#cccccc', 'left', '600');
  },
  semiBand(ctx, W, H) {
    const y = Math.round(H * 0.85);
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(0, y, W, H - y);
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    // opaque white marks over the see-through band
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(W * 0.06, y + (H - y) / 2, (H - y) * 0.36, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    text(ctx, 'EXAMPLE AUTO GROUP', W * 0.12, y + (H - y) * 0.38, H * 0.045, '#ffffff');
    text(ctx, '555-0100  ·  example-auto.test', W * 0.12, y + (H - y) * 0.75, H * 0.03, '#ffffff', 'left', '600');
  },
  coverBanner(ctx, W, H, opt = {}) {
    const h = Math.round(H * 0.16);
    const g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, '#d00000');
    g.addColorStop(1, '#8d0801');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, h);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, h - Math.max(2, Math.round(H * 0.006)), W, Math.max(2, Math.round(H * 0.006)));
    // starburst
    ctx.fillStyle = '#ffd60a';
    ctx.beginPath();
    const cx = W * 0.08;
    const cy = h * 0.5;
    for (let k = 0; k < 24; k++) {
      const a = (k * Math.PI) / 12;
      const rr = k % 2 ? h * 0.3 : h * 0.44;
      ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fill();
    text(ctx, 'NEW ARRIVAL', cx, cy, h * 0.16, '#8d0801', 'center');
    text(ctx, 'SPECIAL OFFER  ·  EXAMPLE AUTO', W * 0.17, h * 0.36, h * 0.27, '#ffffff');
    text(ctx, 'Call 555-0100 today', W * 0.17, h * 0.72, h * 0.18, '#ffe8e8', 'left', '600');
    if (opt.price) text(ctx, opt.price, W * 0.97, h * 0.5, h * 0.42, '#ffd60a', 'right');
  },
  letterbox(ctx, W, H) {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, W, Math.round(H * 0.08));
    ctx.fillRect(0, H - Math.round(H * 0.08), W, Math.round(H * 0.08));
  },
  weakWatermark(ctx, W, H) {
    ctx.save();
    ctx.globalAlpha = 0.15;
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.round(H * 0.06)}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('example-auto.test', W / 2, H * 0.55);
    ctx.restore();
  },
  centreLogo(ctx, W, H) {
    const x = Math.round(W * 0.4);
    const y = Math.round(H * 0.62);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.roundRect(x, y, Math.round(W * 0.2), Math.round(H * 0.12), H * 0.02);
    ctx.fill();
    logo(ctx, x + W * 0.01, y + H * 0.015, H * 0.09, ['#d62828', '#13233a']);
    text(ctx, 'EXAMPLE', x + W * 0.135, y + H * 0.06, H * 0.03, '#13233a', 'center');
  },
  thickFrame(ctx, W, H) {
    const t = Math.round(H * 0.06);
    const b = Math.round(H * 0.2);
    ctx.fillStyle = '#f2f2f2';
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillRect(t, t, W - 2 * t, H - t - b);
    ctx.restore();
    logo(ctx, W * 0.04, H - b + H * 0.03, H * 0.13, ['#b5121b', '#13233a']);
    text(ctx, 'EXAMPLE AUTO GROUP', W * 0.2, H - b * 0.62, H * 0.06, '#13233a');
    text(ctx, '555-0100  ·  example-auto.test  ·  OPEN 7 DAYS', W * 0.2, H - b * 0.28, H * 0.035, '#b5121b', 'left', '600');
  },
  // a bottom band with text that changes per photo (a photo counter)
  bandCounter(ctx, W, H, opt = {}) {
    OVERLAYS.bottomBand(ctx, W, H);
    const y = Math.round(H * 0.86);
    ctx.fillStyle = '#13233a';
    ctx.fillRect(W * 0.55, y + H * 0.05, W * 0.14, H * 0.05);
    text(ctx, opt.counter || '', W * 0.62, y + H * 0.075, H * 0.03, '#ffffff', 'center', '600');
  },
  // a see-through logo in the bottom-right corner
  cornerWatermark(ctx, W, H) {
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = H * 0.01;
    ctx.beginPath();
    ctx.arc(W * 0.85, H * 0.915, H * 0.03, 0, Math.PI * 2);
    ctx.stroke();
    ctx.font = `bold ${Math.round(H * 0.035)}px Inter, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText('EXAMPLE', W * 0.88, H * 0.915);
    ctx.restore();
  },
  watermark(ctx, W, H) {
    ctx.save();
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = H * 0.025;
    ctx.beginPath();
    ctx.arc(W / 2, H * 0.42, H * 0.13, 0, Math.PI * 2);
    ctx.stroke();
    ctx.font = `bold ${Math.round(H * 0.075)}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('EXAMPLE AUTO', W / 2, H * 0.64);
    ctx.restore();
  },
  // a smaller badge in the bottom-right corner, touching the edges
  cornerTab(ctx, W, H) {
    const w = Math.round(W * 0.2);
    const h = Math.round(H * 0.09);
    ctx.fillStyle = '#0f4c81';
    ctx.beginPath();
    ctx.roundRect(W - w, H - h, w, h, [H * 0.02, 0, 0, 0]);
    ctx.fill();
    text(ctx, 'example-auto.test', W - w / 2, H - h / 2, h * 0.32, '#ffffff', 'center');
  },
};

export function makeOverlay(kind, W, H, opt = {}) {
  const c = canvas(W, H);
  const ctx = c.getContext('2d');
  for (const k of String(kind).split('+')) OVERLAYS[k](ctx, W, H, opt);
  return c;
}

export function alphaOf(c) {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const a = new Uint8Array(c.width * c.height);
  for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
  return a;
}

export function toBlob(c, type, q) {
  return new Promise((resolve) => c.toBlob(resolve, type, q));
}

// The vendor's step: overlay drawn over the photo, saved as JPEG.
export async function vendorPhoto(photo, overlay, q) {
  const W = photo.width;
  const H = photo.height;
  const c = canvas(W, H);
  const ctx = c.getContext('2d');
  ctx.drawImage(photo, 0, 0);
  if (overlay) ctx.drawImage(overlay, 0, 0);
  return toBlob(c, 'image/jpeg', q);
}

// A CDN that resizes the vendor's JPEG and saves it again.
export async function cdnResize(blob, W, H, q) {
  const bmp = await createImageBitmap(blob);
  const c = canvas(W, H);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, W, H);
  bmp.close();
  return toBlob(c, 'image/jpeg', q);
}

// The effective overlay alpha after the same resize (for the metrics).
export function resizeAlpha(overlay, W, H) {
  const c = canvas(W, H);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(overlay, 0, 0, W, H);
  return alphaOf(c);
}

// What the extension will do: decode at the natural size (EXIF orientation
// applied), then draw at the check size and read the pixels.
export async function decodeSample(blob, sizeFn, quality = 'high') {
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const width = bmp.width;
  const height = bmp.height;
  const size = sizeFn(width, height);
  if (!size) {
    bmp.close();
    return { width, height, w: 0, h: 0, rgba: null };
  }
  const oc = new OffscreenCanvas(size.w, size.h);
  const ctx = oc.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = quality;
  ctx.drawImage(bmp, 0, 0, size.w, size.h);
  const rgba = ctx.getImageData(0, 0, size.w, size.h).data;
  bmp.close();
  return { width, height, w: size.w, h: size.h, rgba };
}

// Applies a crop the way the extension would before attaching: the
// sub-rectangle of the decoded photo, saved as JPEG.
export async function applyCrop(blob, crop, q = 0.92) {
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const oc = new OffscreenCanvas(crop.w, crop.h);
  oc.getContext('2d').drawImage(bmp, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
  bmp.close();
  return oc.convertToBlob({ type: 'image/jpeg', quality: q });
}
