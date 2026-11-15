// Wayfound 3D scene. Every layer is built from the campus dataset: no tiles, no glyph
// server, no network. Text is drawn to canvas and handed to MapLibre as icon images.
/* global maplibregl */

// One closure so the module contributes a single top-level name, which keeps it safe to
// inline next to other modules in the single-file offline build.
export const createMap3D = (() => {

const C = {
  ground: '#0d1319', green: '#12251d', pitch: '#17301f', water: '#0f2a3c', plaza: '#151d26', parking: '#111820',
  road: '#1c2631', roadMajor: '#25313e', roadCasing: '#090e13', path: '#3a4756',
  route: '#5ef2a0', walk: '#8fb4ff', stairs: '#ffb454', barrier: '#ff6b5e',
  text: '#e9eef3', muted: '#9aa8b5',
};
const FONT = 'ui-sans-serif, -apple-system, "SF Pro Text", "Segoe UI", sans-serif';
const KIND_STEPS = 5;
const ROAD_WIDTH_M = [15, 12, 9, 7.5, 4.5];
const START = { zoom: 15.4, pitch: 55, bearing: -17 };
const EMPTY = { type: 'FeatureCollection', features: [] };
const IMAGE_SCALE = 2;

const STYLE_ID = 'wf-map-style';
const MAP_CSS = `
.wf-map-root{background:linear-gradient(180deg,#0a1624 0%,#0d1319 60%)}
.wf-map-pin{pointer-events:none;display:flex;align-items:center;gap:6px;font:600 12px/1.2 ${FONT};color:#e9eef3}
.wf-map-pin__dot{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font-weight:700;
  background:#e9eef3;color:#0b1016;border:2px solid #0b1016;box-shadow:0 0 0 2px rgba(233,238,243,.35),0 4px 14px rgba(0,0,0,.55)}
.wf-map-pin--to .wf-map-pin__dot{background:#5ef2a0;box-shadow:0 0 0 2px rgba(94,242,160,.4),0 4px 14px rgba(0,0,0,.55)}
.wf-map-pin__label{position:absolute;left:32px;top:50%;transform:translateY(-50%);white-space:nowrap;max-width:220px;
  overflow:hidden;text-overflow:ellipsis;padding:4px 8px;border-radius:7px;background:rgba(11,16,22,.92);
  border:1px solid rgba(255,255,255,.14)}
.wf-map-dot{pointer-events:none;width:12px;height:12px;border-radius:50%;background:#fff;border:3px solid var(--wf-dot,#5ef2a0);
  box-shadow:0 0 12px 2px var(--wf-dot,#5ef2a0)}
.wf-map-cross{pointer-events:none;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;
  background:#ff6b5e;color:#1a0806;font:700 13px/1 ${FONT};border:2px solid #0b1016;box-shadow:0 3px 12px rgba(0,0,0,.6)}
.wf-map-badge{cursor:pointer;min-width:26px;height:26px;padding:0 6px;border-radius:13px;display:grid;place-items:center;
  background:#ffb454;color:#1d1203;font:700 13px/1 ${FONT};border:2px solid #0b1016;box-shadow:0 3px 12px rgba(0,0,0,.6)}
.wf-map-badge:hover,.wf-map-badge:focus-visible{background:#ffd08f;outline:2px solid #fff;outline-offset:2px}
`;

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = MAP_CSS;
  document.head.appendChild(style);
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
const fc = features => ({ type: 'FeatureCollection', features });

// ---------- dataset -> GeoJSON ----------

function buildScene(dataset) {
  const [west, south] = dataset.meta.bbox;
  const point = (x, y) => [west + x / 1e6, south + y / 1e6];
  const line = flat => {
    const out = new Array(flat.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = point(flat[2 * i], flat[2 * i + 1]);
    return out;
  };
  const ring = flat => {
    const out = line(flat);
    const first = out[0], last = out[out.length - 1];
    if (first && (first[0] !== last[0] || first[1] !== last[1])) out.push(first);
    return out;
  };
  const shoelace = flat => {
    let area = 0;
    for (let i = 0; i + 3 < flat.length; i += 2) area += flat[i] * flat[i + 3] - flat[i + 2] * flat[i + 1];
    return Math.abs(area) / 2;
  };
  const metres = (a, b) => Math.hypot((a[0] - b[0]) * 80500, (a[1] - b[1]) * 110540);

  const areas = fc((dataset.areas || []).map(([t, flat]) => (
    { type: 'Feature', properties: { t }, geometry: { type: 'Polygon', coordinates: [ring(flat)] } })));

  const labelled = new Map(); // street name -> label positions, to avoid a label on every OSM segment
  const roads = fc((dataset.roads || []).map(([c, n, flat]) => {
    const coords = line(flat);
    const w = ROAD_WIDTH_M[c] ?? 6;
    const properties = { c, w, wc: w + 2 };
    if (n >= 0 && c <= 3 && coords.length >= 2) {
      let length = 0;
      for (let i = 1; i < coords.length; i++) length += metres(coords[i - 1], coords[i]);
      const mid = coords[coords.length >> 1];
      const seen = labelled.get(n) || [];
      if (length > 70 && seen.every(p => metres(p, mid) > 240)) {
        seen.push(mid);
        labelled.set(n, seen);
        properties.img = `wf-st-${n}`;
      }
    }
    return { type: 'Feature', properties, geometry: { type: 'LineString', coordinates: coords } };
  }));

  const { nodes, edges, ways } = dataset.net;
  const node = i => point(nodes[2 * i], nodes[2 * i + 1]);
  const paths = [];
  let current = null, lastB = -1, lastWay = -1;
  for (let i = 0; i < edges.length; i += 3) {
    const a = edges[i], b = edges[i + 1], w = edges[i + 2];
    if (w !== lastWay || a !== lastB) {
      current = { type: 'Feature', properties: { k: ways.kind[w] }, geometry: { type: 'LineString', coordinates: [node(a)] } };
      paths.push(current);
    }
    current.geometry.coordinates.push(node(b));
    lastB = b;
    lastWay = w;
  }

  const massByPlace = new Map();
  const importance = new Map();
  const mass = (dataset.mass || []).map((m, i) => {
    const p = m[1];
    if (p >= 0) {
      if (!massByPlace.has(p)) massByPlace.set(p, []);
      massByPlace.get(p).push(i);
      importance.set(p, (importance.get(p) || 0) + shoelace(m[3]));
    }
    return { type: 'Feature', id: i + 1, properties: { h: m[0], p, c: m[2] },
      geometry: { type: 'Polygon', coordinates: m.slice(3).map(ring) } };
  });

  const labels = (dataset.places || []).map((place, p) => {
    // 'b' building with a code chip, 'n' building known by name only, 'v' venue, 't' transit, 'o' other
    const kind = place.type === 'building' ? (place.code ? 'b' : 'n')
      : place.type === 'venue' ? 'v' : place.type === 'transit' ? 't' : 'o';
    return { type: 'Feature', geometry: { type: 'Point', coordinates: point(place.pt[0], place.pt[1]) },
      properties: { p, kind, imp: Math.round((importance.get(p) || 0) / 1e3),
        ic: `wf-code-${p}`, il: `wf-full-${p}`, im: `wf-minor-${p}`, iv: `wf-venue-${p}` } };
  });

  return { point, line, ring, node, areas, roads, paths: fc(paths), mass: fc(mass), labels: fc(labels), massByPlace };
}

// ---------- canvas label images ----------

const measureCtx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');

function textWidth(text, font) {
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

function wrapText(text, font, maxWidth, maxLines) {
  const lines = [];
  let current = '';
  for (const word of String(text).split(/\s+/)) {
    const next = current ? `${current} ${word}` : word;
    if (!current || textWidth(next, font) <= maxWidth) current = next;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let last = lines[maxLines - 1];
    while (last.length > 3 && textWidth(`${last}…`, font) > maxWidth) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last.trimEnd()}…`;
  }
  return lines;
}

function paint(width, height, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * IMAGE_SCALE);
  canvas.height = Math.ceil(height * IMAGE_SCALE);
  const ctx = canvas.getContext('2d');
  ctx.scale(IMAGE_SCALE, IMAGE_SCALE);
  ctx.textBaseline = 'middle';
  draw(ctx);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function pill(ctx, x, y, w, h, r, fill, stroke) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function codeImage(code) {
  const font = `700 12px ${FONT}`;
  const width = textWidth(code, font) + 14, height = 20;
  return paint(width, height, ctx => {
    pill(ctx, 0.5, 0.5, width - 1, height - 1, 6, 'rgba(11,16,22,.9)', 'rgba(233,238,243,.3)');
    ctx.font = font;
    ctx.fillStyle = C.text;
    ctx.textAlign = 'center';
    ctx.fillText(code, width / 2, height / 2 + 0.5);
  });
}

function fullImage(code, name) {
  const codeFont = `700 12px ${FONT}`, nameFont = `600 12px ${FONT}`;
  const lines = wrapText(name, nameFont, 150, 2);
  const chip = textWidth(code, codeFont) + 10;
  const text = Math.max(...lines.map(l => textWidth(l, nameFont)));
  const width = 4 + chip + 6 + text + 9, height = Math.max(24, lines.length * 15 + 9);
  return paint(width, height, ctx => {
    pill(ctx, 0.5, 0.5, width - 1, height - 1, 7, 'rgba(11,16,22,.9)', 'rgba(233,238,243,.2)');
    pill(ctx, 4, (height - 17) / 2, chip, 17, 4, 'rgba(233,238,243,.16)');
    ctx.font = codeFont;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText(code, 4 + chip / 2, height / 2 + 0.5);
    ctx.font = nameFont;
    ctx.fillStyle = '#d8e1ea';
    ctx.textAlign = 'left';
    lines.forEach((l, i) => ctx.fillText(l, 4 + chip + 6, height / 2 + (i - (lines.length - 1) / 2) * 15 + 0.5));
  });
}

function haloImage(text, { font, color, maxWidth, dot }) {
  const lines = wrapText(text, font, maxWidth, 2);
  const lead = dot ? 12 : 0;
  const width = Math.max(...lines.map(l => textWidth(l, font))) + lead + 8, height = lines.length * 15 + 6;
  return paint(width, height, ctx => {
    ctx.font = font;
    ctx.lineJoin = 'round';
    ctx.textAlign = 'left';
    if (dot) {
      ctx.beginPath();
      ctx.arc(8, height / 2, 4, 0, Math.PI * 2);
      ctx.fillStyle = dot;
      ctx.fill();
      ctx.strokeStyle = '#0b1016';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    lines.forEach((l, i) => {
      const y = height / 2 + (i - (lines.length - 1) / 2) * 15 + 0.5;
      ctx.strokeStyle = 'rgba(9,14,19,.92)';
      ctx.lineWidth = 3.5;
      ctx.strokeText(l, 4 + lead, y);
      ctx.fillStyle = color;
      ctx.fillText(l, 4 + lead, y);
    });
  });
}

function venueImage(name) {
  const tagFont = `700 12px ${FONT}`, nameFont = `700 13px ${FONT}`;
  const title = name.replace(/\s*\(.*\)\s*$/, '');
  const tag = 'ONHACKS VENUE';
  const width = Math.max(textWidth(tag, tagFont), textWidth(title, nameFont)) + 20, body = 40, height = body + 7;
  return paint(width, height, ctx => {
    pill(ctx, 0.5, 0.5, width - 1, body - 1, 9, C.route, '#0b1016');
    ctx.beginPath();
    ctx.moveTo(width / 2 - 7, body - 1);
    ctx.lineTo(width / 2, height - 0.5);
    ctx.lineTo(width / 2 + 7, body - 1);
    ctx.closePath();
    ctx.fillStyle = C.route;
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(6,20,12,.72)';
    ctx.font = tagFont;
    ctx.fillText(tag, width / 2, 13);
    ctx.fillStyle = '#06140c';
    ctx.font = nameFont;
    ctx.fillText(title, width / 2, 28);
  });
}

function labelImage(id, dataset) {
  const match = /^wf-(code|full|minor|venue|st)-(\d+)$/.exec(id);
  if (!match) return null;
  const index = Number(match[2]);
  if (match[1] === 'st') {
    const name = dataset.names?.[index];
    return name ? haloImage(name, { font: `600 12px ${FONT}`, color: '#8795a3', maxWidth: 400 }) : null;
  }
  const place = dataset.places?.[index];
  if (!place) return null;
  if (match[1] === 'code') return codeImage(place.code || place.name.slice(0, 3));
  if (match[1] === 'full') return fullImage(place.code || '•', place.name);
  if (match[1] === 'venue') return venueImage(place.name);
  return haloImage(place.name, { font: `500 12px ${FONT}`, color: place.type === 'transit' ? '#b9cffb' : C.muted,
    maxWidth: 140, dot: place.type === 'transit' ? C.walk : null });
}

// ---------- style ----------

function buildStyle(scene) {
  const metreWidth = (prop, min) => ['interpolate', ['exponential', 2], ['zoom'],
    13, ['max', min, ['*', ['get', prop], 0.1445]], 20, ['*', ['get', prop], 18.5]];
  const zoomWidth = (...stops) => ['interpolate', ['linear'], ['zoom'], ...stops];
  const state = (name, colour, otherwise) => ['case', ['boolean', ['feature-state', name], false], colour, otherwise];
  const round = { 'line-cap': 'round', 'line-join': 'round' };
  const source = data => ({ type: 'geojson', data, tolerance: 0.2 });
  const routeLine = (id, filter, paintProps, layout = round) => (
    { id, type: 'line', source: 'wf-route', filter, layout, paint: paintProps });
  const isMain = ['==', ['get', 'role'], 'main'], isGhost = ['==', ['get', 'role'], 'ghost'];
  const isStairs = ['==', ['get', 'role'], 'stairs'];
  const coreWidth = zoomWidth(14, 3, 18, 5.5, 20, 9);
  const label = (id, filter, image, extra = {}, zoom = {}) => ({
    id, type: 'symbol', source: 'wf-labels', filter, ...zoom,
    layout: { 'icon-image': ['get', image], 'icon-padding': 4, 'symbol-sort-key': ['*', -1, ['get', 'imp']], ...extra },
  });

  return {
    version: 8,
    name: 'Wayfound campus',
    light: { anchor: 'viewport', color: '#e6eefa', intensity: 0.38, position: [1.25, 205, 32] },
    sources: {
      'wf-areas': source(scene.areas), 'wf-roads': source(scene.roads), 'wf-paths': source(scene.paths),
      'wf-mass': source(scene.mass), 'wf-labels': source(scene.labels),
      'wf-route': source(EMPTY), 'wf-closures': source(EMPTY), 'wf-highlights': source(EMPTY),
      'wf-hover': source(EMPTY), 'wf-floors': source(EMPTY), 'wf-doors': source(EMPTY),
    },
    layers: [
      { id: 'wf-ground', type: 'background', paint: { 'background-color': C.ground } },
      { id: 'wf-areas', type: 'fill', source: 'wf-areas', paint: {
        'fill-color': ['match', ['get', 't'], 0, C.green, 1, C.pitch, 2, C.water, 3, C.plaza, C.parking],
        'fill-antialias': true } },
      { id: 'wf-roads-casing', type: 'line', source: 'wf-roads', layout: round,
        paint: { 'line-color': C.roadCasing, 'line-width': metreWidth('wc', 1.2) } },
      { id: 'wf-roads', type: 'line', source: 'wf-roads', layout: round, paint: {
        'line-color': ['match', ['get', 'c'], 0, C.roadMajor, 1, C.roadMajor, 4, '#18212b', C.road],
        'line-width': metreWidth('w', 0.7) } },
      { id: 'wf-paths-links', type: 'line', source: 'wf-paths', minzoom: 16.8, filter: ['==', ['get', 'k'], 10],
        paint: { 'line-color': 'rgba(154,168,181,.4)', 'line-width': 1, 'line-dasharray': [1, 2.5] } },
      { id: 'wf-paths', type: 'line', source: 'wf-paths', minzoom: 14, layout: round,
        filter: ['all', ['!=', ['get', 'k'], KIND_STEPS], ['!=', ['get', 'k'], 10]],
        paint: { 'line-color': C.path, 'line-width': zoomWidth(14, 0.5, 16, 1.1, 18, 2.4, 20, 6),
          'line-opacity': zoomWidth(14, 0.4, 16, 0.95) } },
      { id: 'wf-paths-stairs', type: 'line', source: 'wf-paths', minzoom: 15, filter: ['==', ['get', 'k'], KIND_STEPS],
        paint: { 'line-color': 'rgba(255,180,84,.62)', 'line-width': zoomWidth(15, 1.5, 18, 4.5, 20, 9),
          'line-dasharray': [0.45, 0.45] } },
      { id: 'wf-labels-streets', type: 'symbol', source: 'wf-roads', minzoom: 15, filter: ['has', 'img'],
        layout: { 'symbol-placement': 'line-center', 'icon-image': ['get', 'img'], 'icon-rotation-alignment': 'map',
          'icon-pitch-alignment': 'map', 'icon-keep-upright': true, 'icon-padding': 10 },
        paint: { 'icon-opacity': 0.92 } },

      routeLine('wf-route-glow', isMain, { 'line-color': ['get', 'color'], 'line-width': zoomWidth(14, 9, 18, 20),
        'line-blur': 10, 'line-opacity': 0.4 }),
      routeLine('wf-route-ghost', isGhost, { 'line-color': ['get', 'color'], 'line-width': 2.5,
        'line-dasharray': [1.2, 1.6], 'line-opacity': 0.9 }, {}),
      routeLine('wf-route-casing', isMain, { 'line-color': '#071018', 'line-width': zoomWidth(14, 5.5, 18, 9.5, 20, 14) }),
      routeLine('wf-route-core', isMain, { 'line-color': ['get', 'color'], 'line-width': coreWidth }),
      routeLine('wf-route-stairs', isStairs, { 'line-color': C.stairs, 'line-width': coreWidth }),

      { id: 'wf-mass-ctx', type: 'fill-extrusion', source: 'wf-mass', filter: ['==', ['get', 'c'], 0], paint: {
        'fill-extrusion-color': state('hover', '#344a62',
          ['interpolate', ['linear'], ['get', 'h'], 0, '#18212a', 40, '#1d2731', 150, '#27333f']),
        'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-opacity': 0.93 } },
      { id: 'wf-mass-campus', type: 'fill-extrusion', source: 'wf-mass', filter: ['==', ['get', 'c'], 1], paint: {
        'fill-extrusion-color': state('hover', '#55708f', state('selected', '#55708f',
          ['interpolate', ['linear'], ['get', 'h'], 0, '#33435a', 25, '#3a4b5f', 70, '#485b73'])),
        'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-opacity': 0.96 } },
      // Plates below the active floor are solid; plates above it are drawn last and nearly
      // transparent, so the active floor shows through them.
      { id: 'wf-floors', type: 'fill-extrusion', source: 'wf-floors', filter: ['==', ['get', 'a'], 0], paint: {
        'fill-extrusion-color': ['interpolate', ['linear'], ['get', 'i'], 0, '#4d6583', 16, '#84a3c8'],
        'fill-extrusion-base': ['get', 'base'], 'fill-extrusion-height': ['get', 'top'], 'fill-extrusion-opacity': 0.94 } },
      { id: 'wf-floors-active', type: 'fill-extrusion', source: 'wf-floors', filter: ['==', ['get', 'a'], 1], paint: {
        'fill-extrusion-color': C.route, 'fill-extrusion-base': ['get', 'base'], 'fill-extrusion-height': ['get', 'top'],
        'fill-extrusion-vertical-gradient': false } },
      { id: 'wf-floors-above', type: 'fill-extrusion', source: 'wf-floors', filter: ['==', ['get', 'a'], 2], paint: {
        'fill-extrusion-color': '#8fb0d8', 'fill-extrusion-base': ['get', 'base'], 'fill-extrusion-height': ['get', 'top'],
        'fill-extrusion-opacity': 0.28 } },

      // The same route again, faint, so it stays readable where buildings stand in front of it.
      routeLine('wf-route-xray', ['!=', ['get', 'role'], 'ghost'], { 'line-color': ['get', 'color'],
        'line-width': coreWidth, 'line-opacity': 0.34 }),
      routeLine('wf-route-ghost-xray', isGhost, { 'line-color': ['get', 'color'], 'line-width': 2.5,
        'line-dasharray': [1.2, 1.6], 'line-opacity': 0.3 }, {}),

      { id: 'wf-highlights-glow', type: 'line', source: 'wf-highlights', layout: round,
        paint: { 'line-color': C.stairs, 'line-width': zoomWidth(14, 8, 18, 16), 'line-blur': 6, 'line-opacity': 0.55 } },
      { id: 'wf-highlights', type: 'line', source: 'wf-highlights', layout: round,
        paint: { 'line-color': C.stairs, 'line-width': zoomWidth(14, 3, 18, 6) } },
      { id: 'wf-closures-casing', type: 'line', source: 'wf-closures', layout: round,
        paint: { 'line-color': '#1a0806', 'line-width': zoomWidth(14, 6, 18, 10) } },
      { id: 'wf-closures', type: 'line', source: 'wf-closures',
        paint: { 'line-color': C.barrier, 'line-width': zoomWidth(14, 3.5, 18, 6), 'line-dasharray': [0.9, 0.7] } },
      { id: 'wf-hover', type: 'line', source: 'wf-hover', layout: round,
        paint: { 'line-color': '#ffd9d4', 'line-width': zoomWidth(14, 4, 18, 8), 'line-opacity': 0.9 } },
      { id: 'wf-doors', type: 'circle', source: 'wf-doors', paint: {
        'circle-radius': zoomWidth(15, 4, 18, 7.5),
        'circle-color': ['match', ['get', 'access'], 'stepfree', C.route, 'steps', C.stairs, '#8494a3'],
        'circle-stroke-color': '#0b1016', 'circle-stroke-width': 2 } },

      // Sparse on purpose: code chips until you are close, full names only at street level.
      label('wf-labels-minor', ['==', ['get', 'kind'], 'o'], 'im', {}, { minzoom: 17.2 }),
      label('wf-labels-transit', ['==', ['get', 'kind'], 't'], 'im', {}, { minzoom: 14.6 }),
      label('wf-labels-name', ['==', ['get', 'kind'], 'n'], 'im', {}, { minzoom: 15.8 }),
      label('wf-labels-code', ['==', ['get', 'kind'], 'b'], 'ic', {}, { minzoom: 14, maxzoom: 17 }),
      label('wf-labels-full', ['==', ['get', 'kind'], 'b'], 'il', {}, { minzoom: 17 }),
      label('wf-labels-venue', ['==', ['get', 'kind'], 'v'], 'iv',
        { 'icon-anchor': 'bottom', 'icon-allow-overlap': true, 'icon-ignore-placement': false }),
    ],
  };
}

const PLACE_LAYERS = ['wf-labels-venue', 'wf-labels-full', 'wf-labels-code', 'wf-labels-name', 'wf-labels-transit',
  'wf-labels-minor', 'wf-mass-campus', 'wf-mass-ctx'];

// ---------- route geometry helpers ----------

function makeTrack(coords) {
  const kx = 111320 * Math.cos(coords[0][1] * Math.PI / 180), ky = 110540;
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + Math.hypot((coords[i][0] - coords[i - 1][0]) * kx, (coords[i][1] - coords[i - 1][1]) * ky));
  }
  const total = cum[cum.length - 1];
  const at = s => {
    if (s <= 0) return coords[0];
    if (s >= total) return coords[coords.length - 1];
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    const t = (s - cum[lo]) / (cum[hi] - cum[lo] || 1);
    return [coords[lo][0] + (coords[hi][0] - coords[lo][0]) * t, coords[lo][1] + (coords[hi][1] - coords[lo][1]) * t];
  };
  const bearing = (a, b) => Math.atan2((b[0] - a[0]) * kx, (b[1] - a[1]) * ky) * 180 / Math.PI;
  const metres = (a, b) => Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * ky);
  return { total, at, bearing, metres };
}

const profileColour = route => (route?.profile === 'walk' ? C.walk : C.route);

// ---------- public API ----------

return async function createMap3D({ container, campus, dataset, onPlaceClick, onPathClick, onMapClick, onHighlightClick } = {}) {
  if (typeof maplibregl === 'undefined') throw new Error('map3d: the maplibregl global is missing; load vendor/maplibre-gl.js first');
  const root = typeof container === 'string' ? document.getElementById(container) : container;
  if (!root) throw new Error('map3d: container element not found');
  if (!dataset?.meta?.bbox || !dataset.net?.nodes || !dataset.net?.edges || !dataset.net?.ways) {
    throw new Error('map3d: dataset is missing meta.bbox or net.{nodes,edges,ways}');
  }
  injectStyle();
  root.classList.add('wf-map-root');

  const scene = buildScene(dataset);
  const [west, south, east, north] = dataset.meta.bbox;
  // meta.view lets a campus set its own opening camera (centre, zoom, pitch, bearing).
  const home = { center: [(west + east) / 2, (south + north) / 2], ...START, ...dataset.meta.view };
  let map;
  try {
    map = new maplibregl.Map({
      container: root, style: buildStyle(scene), ...home, minZoom: 13.2, maxZoom: 20, maxPitch: 72,
      maxBounds: [[west - 0.012, south - 0.008], [east + 0.012, north + 0.008]],
      antialias: true, attributionControl: false, fadeDuration: 150,
    });
  } catch (error) {
    throw new Error(`map3d: could not start WebGL map (${error.message})`);
  }
  map.on('styleimagemissing', event => {
    const image = labelImage(event.id, dataset);
    if (image && !map.hasImage(event.id)) map.addImage(event.id, image, { pixelRatio: IMAGE_SCALE });
  });
  await new Promise((resolve, reject) => {
    const fail = event => reject(new Error(`map3d: style failed to load (${event.error?.message || 'unknown error'})`));
    map.once('error', fail);
    map.once('load', () => {
      map.off('error', fail);
      resolve();
    });
  });
  map.on('error', event => console.warn('[map3d]', event.error?.message || event));

  const edges = dataset.net.edges, wayKind = dataset.net.ways.kind;
  const edgeLine = e => [scene.node(edges[3 * e]), scene.node(edges[3 * e + 1])];
  const edgesGeometry = list => ({ type: 'MultiLineString', coordinates: (list || []).map(edgeLine) });
  const setData = (id, data) => map.getSource(id)?.setData(data);
  const canvas = map.getCanvas();

  const view = {
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    reportMode: false, hoverPlace: -1, hoverKey: '', selected: -1, focus: -1,
    markers: { from: null, to: null }, crosses: [], badges: [],
    dot: null, dotRaf: 0, fly: null, route: null,
  };

  // ----- hover + click -----
  const placeAt = pointPx => {
    for (const feature of map.queryRenderedFeatures(pointPx, { layers: PLACE_LAYERS })) {
      const p = feature.properties?.p;
      if (Number.isInteger(p) && p >= 0) return p;
    }
    return -1;
  };
  const markPlace = (p, key, on) => {
    for (const i of scene.massByPlace.get(p) || []) map.setFeatureState({ source: 'wf-mass', id: i + 1 }, { [key]: on });
  };
  const setHoverPlace = p => {
    if (p === view.hoverPlace) return;
    markPlace(view.hoverPlace, 'hover', false);
    markPlace(p, 'hover', true);
    view.hoverPlace = p;
    canvas.style.cursor = p >= 0 ? 'pointer' : view.reportMode ? 'crosshair' : '';
  };
  const setHoverSegment = segment => {
    const key = segment ? segment.join(',') : '';
    if (key === view.hoverKey) return;
    view.hoverKey = key;
    setData('wf-hover', segment ? { type: 'Feature', properties: {}, geometry: edgesGeometry(segment) } : EMPTY);
  };
  const pathAt = lngLat => campus?.nearestEdge?.(lngLat, 22) ?? null;

  let pendingMove = null, moveRaf = 0;
  map.on('mousemove', event => {
    pendingMove = event;
    if (moveRaf) return;
    moveRaf = requestAnimationFrame(() => {
      moveRaf = 0;
      const move = pendingMove;
      if (!move || view.fly) return;
      if (view.reportMode) {
        const hit = pathAt([move.lngLat.lng, move.lngLat.lat]);
        setHoverSegment(hit ? campus.segmentOf?.(hit.edge) ?? [hit.edge] : null);
      } else {
        setHoverPlace(placeAt(move.point));
      }
    });
  });
  map.on('mouseout', () => {
    pendingMove = null;
    setHoverPlace(-1);
    setHoverSegment(null);
  });
  map.on('click', event => {
    const lngLat = [event.lngLat.lng, event.lngLat.lat];
    if (view.reportMode) {
      const hit = pathAt(lngLat);
      if (hit) {
        onPathClick?.(hit.edge, lngLat);
        return;
      }
    }
    const p = placeAt(event.point);
    if (p >= 0) onPlaceClick?.(p, lngLat);
    else onMapClick?.(lngLat);
  });

  // ----- camera -----
  const duration = ms => (reducedMotion() ? 0 : ms);
  const routeBounds = coords => {
    const bounds = new maplibregl.LngLatBounds(coords[0], coords[0]);
    for (const c of coords) bounds.extend(c);
    return bounds;
  };
  function fitRoute(route) {
    const coords = route?.coords;
    if (!coords?.length) return;
    map.fitBounds(routeBounds(coords), { padding: 90, pitch: START.pitch, bearing: map.getBearing(),
      maxZoom: 17.6, duration: duration(1300), essential: true });
  }
  function flyToPlace(placeIndex) {
    const place = dataset.places?.[placeIndex];
    if (!place) return;
    map.flyTo({ center: scene.point(place.pt[0], place.pt[1]), zoom: Math.max(map.getZoom(), 17.1), pitch: 58,
      duration: duration(1400), essential: true });
  }
  function resetView() {
    stopFlyThrough();
    map.flyTo({ ...home, duration: duration(1400), essential: true });
  }
  function setPadding(padding = {}) {
    view.padding = { top: 0, right: 0, bottom: 0, left: 0, ...padding };
    map.easeTo({ padding: view.padding, duration: duration(350), essential: true });
  }

  // ----- route -----
  function stopDot() {
    cancelAnimationFrame(view.dotRaf);
    view.dot?.marker.remove();
    view.dot = null;
  }
  function startDot(route) {
    stopDot();
    if (!route?.coords || route.coords.length < 2 || reducedMotion()) return;
    const element = document.createElement('div');
    element.className = 'wf-map-dot';
    element.style.setProperty('--wf-dot', profileColour(route));
    const track = makeTrack(route.coords);
    const marker = new maplibregl.Marker({ element }).setLngLat(route.coords[0]).addTo(map);
    const period = clamp(track.total / 70, 4, 14) * 1000;
    const started = performance.now();
    const tick = now => {
      if (!view.fly) marker.setLngLat(track.at(((now - started) % period) / period * track.total));
      view.dotRaf = requestAnimationFrame(tick);
    };
    view.dot = { marker };
    view.dotRaf = requestAnimationFrame(tick);
  }
  function setRoute(route, { ghost = null } = {}) {
    stopFlyThrough();
    view.route = route?.coords?.length >= 2 ? route : null;
    const features = [];
    if (ghost?.coords?.length >= 2) {
      features.push({ type: 'Feature', properties: { role: 'ghost', color: profileColour(ghost) },
        geometry: { type: 'LineString', coordinates: ghost.coords } });
    }
    if (view.route) {
      features.push({ type: 'Feature', properties: { role: 'main', color: profileColour(route) },
        geometry: { type: 'LineString', coordinates: route.coords } });
      const stairs = (route.edges || []).filter(e => wayKind[edges[3 * e + 2]] === KIND_STEPS);
      if (stairs.length) {
        features.push({ type: 'Feature', properties: { role: 'stairs', color: C.stairs }, geometry: edgesGeometry(stairs) });
      }
    }
    setData('wf-route', fc(features));
    startDot(view.route);
  }

  function stopFlyThrough() {
    const fly = view.fly;
    if (!fly) return;
    view.fly = null;
    cancelAnimationFrame(fly.raf);
    map.stop();
    fly.resolve();
  }
  function flyThrough(route) {
    stopFlyThrough();
    const coords = route?.coords;
    if (!coords || coords.length < 2) return Promise.resolve();
    if (reducedMotion()) {
      fitRoute(route);
      return Promise.resolve();
    }
    const track = makeTrack(coords);
    const lookAhead = s => track.at(Math.min(track.total, s + 40));
    return new Promise(resolve => {
      const fly = { resolve, raf: 0 };
      view.fly = fly;
      setHoverPlace(-1);
      const lead = 1500, travel = clamp(track.total / 45, 8, 16) * 1000;
      let bearing = track.bearing(coords[0], lookAhead(0));
      map.easeTo({ center: coords[0], zoom: 18, pitch: 62, bearing, duration: lead, essential: true });
      const begin = performance.now() + lead;
      const frame = now => {
        if (view.fly !== fly) return;
        if (now >= begin) {
          const u = Math.min(1, (now - begin) / travel);
          const s = (u - Math.sin(2 * Math.PI * u) / (2 * Math.PI)) * track.total;
          const here = track.at(s), ahead = lookAhead(s);
          if (track.metres(here, ahead) > 4) {
            bearing += ((((track.bearing(here, ahead) - bearing) % 360) + 540) % 360 - 180) * 0.06;
          }
          map.jumpTo({ center: here, bearing, pitch: 62, zoom: 18 });
          view.dot?.marker.setLngLat(here);
          if (u >= 1) {
            stopFlyThrough();
            return;
          }
        }
        fly.raf = requestAnimationFrame(frame);
      };
      fly.raf = requestAnimationFrame(frame);
    });
  }
  for (const type of ['pointerdown', 'wheel']) root.addEventListener(type, stopFlyThrough, { passive: true });

  // ----- markers -----
  function pin(kind, spec) {
    view.markers[kind]?.remove();
    view.markers[kind] = null;
    if (!spec?.lngLat) return;
    const element = document.createElement('div');
    element.className = `wf-map-pin wf-map-pin--${kind}`;
    const dot = document.createElement('span');
    dot.className = 'wf-map-pin__dot';
    dot.textContent = kind === 'from' ? 'A' : 'B';
    element.appendChild(dot);
    if (spec.label) {
      const text = document.createElement('span');
      text.className = 'wf-map-pin__label';
      text.textContent = spec.label;
      element.appendChild(text);
    }
    view.markers[kind] = new maplibregl.Marker({ element, anchor: 'left', offset: [-13, 0] }).setLngLat(spec.lngLat).addTo(map);
  }
  // The venue badge and a journey marker would name the same spot twice, so the badge yields.
  const venuePoints = (dataset.places || []).filter(place => place.type === 'venue')
    .map(place => scene.point(place.pt[0], place.pt[1]));
  const atVenue = spec => !!spec?.lngLat && venuePoints.some(([lng, lat]) => Math.hypot(
    (spec.lngLat[0] - lng) * 111320 * Math.cos(lat * Math.PI / 180), (spec.lngLat[1] - lat) * 110540) < 60);
  function setMarkers({ from = null, to = null } = {}) {
    pin('from', from);
    pin('to', to);
    map.setLayoutProperty('wf-labels-venue', 'visibility', atVenue(from) || atVenue(to) ? 'none' : 'visible');
  }
  const clearMarkers = list => {
    for (const marker of list) marker.remove();
    list.length = 0;
  };
  const overlayFeatures = list => fc((list || []).map(item => (
    { type: 'Feature', properties: { id: String(item.id) }, geometry: edgesGeometry(item.edges) })));
  function setClosures(list) {
    setData('wf-closures', overlayFeatures(list));
    clearMarkers(view.crosses);
    for (const item of list || []) {
      if (!item.lngLat) continue;
      const element = document.createElement('div');
      element.className = 'wf-map-cross';
      element.textContent = '✕';
      element.setAttribute('aria-label', 'Reported barrier');
      view.crosses.push(new maplibregl.Marker({ element }).setLngLat(item.lngLat).addTo(map));
    }
  }
  function setHighlights(list) {
    setData('wf-highlights', overlayFeatures(list));
    clearMarkers(view.badges);
    for (const item of list || []) {
      if (!item.lngLat) continue;
      const element = document.createElement('button');
      element.type = 'button';
      element.className = 'wf-map-badge';
      element.textContent = String(item.rank ?? '');
      element.setAttribute('aria-label', `Fix candidate ${item.rank ?? ''}`.trim());
      element.addEventListener('click', event => {
        event.stopPropagation();
        onHighlightClick?.(item.id);
      });
      view.badges.push(new maplibregl.Marker({ element }).setLngLat(item.lngLat).addTo(map));
    }
  }
  function setReportMode(on) {
    view.reportMode = Boolean(on);
    setHoverPlace(-1);
    if (!view.reportMode) setHoverSegment(null);
    canvas.style.cursor = view.reportMode ? 'crosshair' : '';
  }

  // ----- building focus: floor plates + doors -----
  function selectPlace(placeIndex) {
    markPlace(view.selected, 'selected', false);
    view.selected = Number.isInteger(placeIndex) ? placeIndex : -1;
    markPlace(view.selected, 'selected', true);
  }
  function focusPlace(placeIndex, { levels, active } = {}) {
    const place = Number.isInteger(placeIndex) ? dataset.places?.[placeIndex] : null;
    view.focus = place ? placeIndex : -1;
    const hidden = place ? placeIndex : -2;
    const others = ['!=', ['get', 'p'], hidden];
    map.setFilter('wf-mass-ctx', ['all', ['==', ['get', 'c'], 0], others]);
    map.setFilter('wf-mass-campus', ['all', ['==', ['get', 'c'], 1], others]);
    map.setFilter('wf-labels-code', ['all', ['==', ['get', 'kind'], 'b'], others]);
    map.setFilter('wf-labels-full', ['all', ['==', ['get', 'kind'], 'b'], others]);
    map.setFilter('wf-labels-name', ['all', ['==', ['get', 'kind'], 'n'], others]);
    if (!place) {
      setData('wf-floors', EMPTY);
      setData('wf-doors', EMPTY);
      return;
    }
    let shapes = (scene.massByPlace.get(placeIndex) || []).map(i => (
      { rings: scene.mass.features[i].geometry.coordinates, h: dataset.mass[i][0] }));
    if (!shapes.length && place.ring) {
      const known = levels || place.levels || campus?.floorsOf?.(placeIndex)?.levels || 3;
      shapes = [{ rings: [scene.ring(place.ring)], h: place.h || known * 4 }];
    }
    const top = Math.max(4, ...shapes.map(s => s.h));
    const count = Math.max(1, Math.round(levels || campus?.floorsOf?.(placeIndex)?.levels || place.levels || top / 4));
    const floorHeight = top / count, gap = floorHeight * 0.13;
    const hasActive = Number.isInteger(active);
    const plates = [];
    for (const shape of shapes) {
      const geometry = { type: 'Polygon', coordinates: shape.rings };
      const floors = clamp(Math.round(shape.h / floorHeight), 1, count);
      for (let i = 0; i < floors; i++) {
        const a = !hasActive || i + 1 < active ? 0 : i + 1 === active ? 1 : 2;
        plates.push({ type: 'Feature', geometry,
          properties: { i, a, base: i * floorHeight + gap, top: (i + 1) * floorHeight - gap } });
      }
      if (active === 0) {
        plates.push({ type: 'Feature', geometry, properties: { i: 0, a: 1, base: 0, top: Math.min(0.6, gap * 0.8) } });
      }
    }
    setData('wf-floors', fc(plates));
    setData('wf-doors', fc((place.ent || []).map(e => dataset.entrances?.[e]).filter(Boolean).map(door => (
      { type: 'Feature', properties: { access: door.access || 'unknown' },
        geometry: { type: 'Point', coordinates: scene.point(door.pt[0], door.pt[1]) } }))));
  }

  try {
    map.setSky?.({ 'sky-color': '#0a1624', 'horizon-color': '#182a3d', 'fog-color': '#0d1319',
      'sky-horizon-blend': 0.7, 'horizon-fog-blend': 0.8, 'fog-ground-blend': 0.55 });
  } catch (error) {
    console.warn('[map3d] sky not applied:', error.message);
  }

  return { map, setPadding, setRoute, fitRoute, setMarkers, flyToPlace, focusPlace, selectPlace, setClosures,
    setHighlights, setReportMode, flyThrough, stopFlyThrough, resetView };
}
})();
