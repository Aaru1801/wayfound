// Wayfound interface: planner, route card, place card, access audit.
// The default state shows what is needed at a glance; everything else opens from a labelled button.
// All routing and analysis lives in engine.js; everything drawn inside the map lives in map3d.js.
import { createCampus, PROFILES } from './engine.js';
import { createMap3D } from './map3d.js';

// The first campus is the default. The others load only from the hash (#campus=<id>); there is no control for it.
const CAMPUSES = [
  { id: 'uoft', label: 'U of T · St. George' },
  { id: 'waterloo', label: 'Waterloo' },
  { id: 'mcmaster', label: 'McMaster' },
];
const DOOR_SOURCE = { uoft: 'U of T campus map', uw: 'University of Waterloo open data', osm: 'OpenStreetMap' };
const FIX_DEFAULT = 3;
const MOBILE = window.matchMedia('(max-width: 760px)');
const STEP_ICON = { depart: 'depart', walk: 'walk', cross: 'cross', stairs: 'stairs', ramp: 'ramp', arrive: 'door' };
const ICONS = {
  swap: 'M7 4v16m0 0-3-3m3 3 3-3M17 20V4m0 0-3 3m3-3 3 3',
  close: 'M6 6l12 12M18 6 6 18',
  play: 'M8 5v14l11-7z',
  stop: 'M7 7h10v10H7z',
  warn: 'M12 4 2.5 20h19L12 4zm0 6v5m0 3v.01',
  walk: 'M12 19V5m0 0-6 6m6-6 6 6',
  stairs: 'M4 20h4v-4h4v-4h4V8h4',
  ramp: 'M3 19 21 8v11H3z',
  cross: 'M4 7h16M4 12h16M4 17h16',
  door: 'M6 21V4h10v17M4 21h16M13 12v.01',
  depart: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm0-6a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
};

const $ = (selector, root = document) => root.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const count = new Intl.NumberFormat('en-CA');
const plural = (n, word) => `${count.format(n)} ${word}${n === 1 ? '' : 's'}`;
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const fmtDist = m => (m >= 1000 ? `${(m / 1000).toFixed(m >= 100000 ? 0 : 1)} km` : `${Math.round(m)} m`);
const distParts = m => (m >= 1000 ? [(m / 1000).toFixed(1), 'km'] : [String(Math.round(m)), 'm']);
const fmtMin = min => `${Math.max(1, Math.round(min))} min`;
const signed = m => `${m >= 0 ? '+' : '−'}${fmtDist(Math.abs(m))}`;
const safeUrl = url => (/^https?:\/\//i.test(String(url || '')) ? String(url) : '');
const hashParams = () => new URLSearchParams(location.hash.slice(1));

const CAMPUS = CAMPUSES.find(c => c.id === hashParams().get('campus')) || CAMPUSES[0];
const STORE_KEY = `wayfound3d:${CAMPUS.id}`;

function icon(name) {
  const filled = name === 'play' || name === 'stop';
  return `<svg class="icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" fill="${filled ? 'currentColor' : 'none'}" stroke="${filled ? 'none' : 'currentColor'}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${ICONS[name] || ''}"/></svg>`;
}

function fmtDate(value) {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!iso) return String(value || '');
  return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
}

let campus = null;
let view = null;
let closureSeq = 0;
const state = {
  from: null, to: null, profile: 'walk',
  routes: {}, route: null, ghost: null,
  closures: [],
  card: null, cardDetails: false,
  activeFloor: null,
  more: null, // open route section: 'directions' | 'door' | 'floors' | 'warnings'
  auditMore: null, // open audit section: 'fixes' | 'worst' | 'nodoor'
  reveal: false, // true only while rendering a section that was just opened, so it animates once
  reportMode: false, flying: false,
  auditOpen: false, audit: null, auditRunning: false, auditError: '', auditStale: false, openFix: null,
  suggestions: [], picks: [],
};

// ---------- guarded calls into the other modules ----------

function mapCall(method, ...args) {
  if (!view || typeof view[method] !== 'function') return undefined;
  try {
    return view[method](...args);
  } catch (error) {
    console.error(`map3d.${method} failed`, error);
    return undefined;
  }
}

function safeSearch(text, limit = 8) {
  try {
    return campus.search(text, { limit }) || [];
  } catch (error) {
    console.error('search failed', error);
    return [];
  }
}

function floorsFor(placeIndex) {
  try {
    const floors = campus.floorsOf(placeIndex);
    if (floors && floors.levels >= 1) return floors;
  } catch (error) {
    console.error('floorsOf failed', error);
  }
  return { levels: 1, source: 'unknown', height: null };
}

function segmentOf(edge) {
  try {
    const edges = campus.segmentOf(edge);
    if (Array.isArray(edges) && edges.length) return [...edges];
  } catch (error) {
    console.error('segmentOf failed', error);
  }
  return [edge];
}

function edgeMidpoint(edge) {
  try {
    const [a, b] = campus.edgeLine(edge);
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  } catch (error) {
    console.error('edgeLine failed', error);
    return null;
  }
}

// ---------- endpoints ----------

const placeOf = endpoint => (endpoint && Number.isInteger(endpoint.placeIndex) ? campus.places[endpoint.placeIndex] : null);
const placeLngLat = place => place.lngLat || campus.toLngLat(place.pt);
const shortName = place => place.code || clip(baseName(place), 24);
// Display name without a trailing bracketed note, e.g. "Polish Combatants' Hall (ONHacks venue)".
const baseName = place => place.name.replace(/\s*\([^)]*\)\s*$/, '') || place.name;
// Chip label: the shortest of the name and its aliases that is still at least 8 characters.
const chipName = place => [baseName(place), ...(place.aka || [])].map(String).filter(name => name.length >= 8)
  .sort((a, b) => a.length - b.length)[0] || baseName(place);
// Text for an input: add the building name only while the whole label still fits.
const fitTitle = (lead, name) => (`${lead} · ${name}`.length <= 34 ? `${lead} · ${name}` : lead);
const datasetKey = () => `${campus.meta?.generated || ''}:${campus.meta?.counts?.graphEdges || ''}`;

function normRoom(room, place) {
  if (!room) return null;
  const raw = String(room.label ?? room.room ?? '').trim();
  const number = place?.code ? raw.replace(new RegExp(`^${place.code}[\\s-]*`, 'i'), '') : raw;
  const parsed = Number.isFinite(room.floor) ? room.floor : parseInt(room.floor, 10);
  const floor = Number.isFinite(parsed) ? parsed : null;
  // The engine's floorLabel is already display text ("Floor 2", "Basement").
  const label = String(room.floorLabel ?? '').trim();
  const floorText = /^(floor\s|basement|ground|lower)/i.test(label) ? label
    : label ? `Floor ${label}` : floor === 0 ? 'Basement' : floor != null ? `Floor ${floor}` : '';
  return { number: number || raw, floor, floorText };
}

const roomTitle = (place, room) => (place.code ? fitTitle(`${place.code} ${room.number}`, baseName(place)) : fitTitle(`Room ${room.number}`, baseName(place)));

function endpointFromPlace(placeIndex) {
  const place = campus.places[placeIndex];
  return place ? { placeIndex, room: null, title: baseName(place) } : null;
}

function endpointFromResult(result) {
  const place = campus.places[result.placeIndex];
  if (!place) return null;
  const room = normRoom(result.room, place);
  let title = baseName(place);
  if (result.kind === 'office' && result.title) title = fitTitle(result.title, baseName(place));
  else if (room) title = roomTitle(place, room);
  return { placeIndex: result.placeIndex, room, title };
}

function endpointFromRoomText(placeIndex, roomText) {
  const place = campus.places[placeIndex];
  if (!place || !roomText || !place.code) return endpointFromPlace(placeIndex);
  const hit = safeSearch(`${place.code} ${roomText}`, 4).find(r => r.placeIndex === placeIndex && r.room);
  if (hit) return endpointFromResult(hit);
  try {
    const parsed = campus.parseRoom(`${place.code} ${roomText}`);
    if (parsed) {
      const room = normRoom({ label: parsed.room, floor: parsed.floor, floorLabel: parsed.floorLabel }, place);
      return { placeIndex, room, title: roomTitle(place, room) };
    }
  } catch (error) {
    console.error('parseRoom failed', error);
  }
  return endpointFromPlace(placeIndex);
}

function endpointFromId(id, roomText) {
  if (id == null || id === '') return null;
  const index = campus.places.findIndex(place => String(place.id) === String(id));
  if (index < 0) return null;
  return roomText ? endpointFromRoomText(index, roomText) : endpointFromPlace(index);
}

const defaultOrigin = () => endpointFromId(campus.meta?.start);

// src 'none' marks an estimated arrival point, not a mapped door.
const doorsOf = place => (place?.ent || []).map(i => campus.entrances[i]).filter(door => door && door.src !== 'none');

function doorCounts(place) {
  const counts = { stepfree: 0, steps: 0, total: 0 };
  for (const door of doorsOf(place)) {
    if (door.access === 'stepfree') counts.stepfree += 1;
    else if (door.access === 'steps') counts.steps += 1;
    counts.total += 1;
  }
  return counts;
}

const doorBadge = door => (door.access === 'stepfree' ? ['Step-free', 'ok'] : door.access === 'steps' ? ['Stairs', 'caution'] : ['Unverified', 'neutral']);

// ---------- routing state ----------

function closedEdgeSet() {
  const closed = new Set();
  for (const closure of state.closures) for (const edge of closure.edges) closed.add(edge);
  return closed;
}

function sameEdges(a, b) {
  if (!a?.edges || !b?.edges || a.edges.length !== b.edges.length) return false;
  return a.edges.every((edge, i) => edge === b.edges[i]);
}

function tryRoute(profile, closedEdges) {
  try {
    return campus.route({ from: state.from.placeIndex, to: state.to.placeIndex, profile, closedEdges });
  } catch (error) {
    console.error(`route(${profile}) failed`, error);
    return { ok: false, reason: 'bad-input', message: error.message || String(error) };
  }
}

function computeRoutes() {
  state.routes = {};
  if (state.from && state.to) {
    const closedEdges = closedEdgeSet();
    for (const profile of PROFILES) state.routes[profile.id] = tryRoute(profile.id, closedEdges);
  }
  selectRoute();
}

function selectRoute() {
  state.route = state.routes[state.profile] || null;
  const walk = state.routes.walk;
  const comparable = state.profile !== 'walk' && state.route?.ok && walk?.ok && !sameEdges(walk, state.route);
  state.ghost = comparable ? walk : null;
}

function journeyChanged({ fit = true } = {}) {
  state.card = null;
  state.more = null;
  stopFlying();
  computeRoutes();
  renderAll({ fit });
  saveState();
  announceRoute();
}

function setEndpoint(which, endpoint, options) {
  state[which] = endpoint;
  if (which === 'to') state.activeFloor = null;
  journeyChanged(options);
}

function setProfile(id) {
  if (!PROFILES.some(profile => profile.id === id) || id === state.profile) return;
  state.profile = id;
  stopFlying();
  selectRoute();
  renderAll();
  saveState();
  announceRoute();
}

function loadJourney(a, b, profile) {
  const from = endpointFromPlace(a);
  const to = endpointFromPlace(b);
  if (!from || !to) return;
  state.from = from;
  state.to = to;
  if (PROFILES.some(p => p.id === profile)) state.profile = profile;
  state.activeFloor = null;
  journeyChanged();
  if (MOBILE.matches) closeAudit();
}

function announceRoute() {
  const route = state.route;
  if (!state.from || !state.to || !route) return;
  const label = PROFILES.find(p => p.id === state.profile)?.label || '';
  $('#sr-status').textContent = route.ok
    ? `${label} route: ${fmtDist(route.distance)}, ${fmtMin(route.duration)}.`
    : `${label}: no route.`;
}

// ---------- barriers ----------

function addClosure(edge, lngLat) {
  if (!Number.isInteger(edge) || edge < 0) return;
  if (state.closures.some(closure => closure.edges.includes(edge))) {
    toast('Already blocked');
    return;
  }
  const before = state.route?.ok ? state.route.distance : null;
  state.closures.push({ id: `b${++closureSeq}`, edge, edges: segmentOf(edge), lngLat: lngLat || edgeMidpoint(edge) });
  closuresChanged();
  const after = state.route?.ok ? state.route.distance : null;
  if (before != null && after == null) toast('Barrier added · no route left', { tone: 'bad' });
  else if (before != null && after - before >= 1) toast(`Barrier added · rerouted ${signed(after - before)}`, { tone: 'warn' });
  else toast('Barrier added');
}

function clearClosures() {
  if (!state.closures.length) return;
  state.closures = [];
  closuresChanged();
  toast('Barriers cleared');
}

function closuresChanged() {
  if (state.audit) state.auditStale = true;
  mapCall('setClosures', state.closures.map(({ id, edges, lngLat }) => ({ id, edges, lngLat })));
  computeRoutes();
  renderAll({ fit: false });
  if (state.auditOpen) renderAudit();
  syncHighlights();
  saveState();
}

function setReportMode(on) {
  state.reportMode = !!on;
  mapCall('setReportMode', state.reportMode);
  $('#report-banner').hidden = !state.reportMode;
  if (state.reportMode && MOBILE.matches) setSheetCollapsed(true);
  renderResult();
}

// ---------- persistence (per campus) ----------

function saveState() {
  writeHash();
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      dataset: datasetKey(),
      profile: state.profile,
      from: placeOf(state.from)?.id ?? null,
      to: placeOf(state.to)?.id ?? null,
      room: state.to?.room?.number ?? null,
      closures: state.closures.map(c => ({ edge: c.edge, lngLat: c.lngLat })),
    }));
  } catch {
    // Storage can be unavailable (private mode, file://); the app works without it.
  }
}

function writeHash() {
  const params = new URLSearchParams();
  if (CAMPUS !== CAMPUSES[0]) params.set('campus', CAMPUS.id);
  if (state.from) params.set('from', placeOf(state.from).id);
  if (state.to) {
    params.set('to', placeOf(state.to).id);
    if (state.to.room) params.set('room', state.to.room.number);
  }
  if (state.from || state.to) params.set('profile', state.profile);
  try {
    history.replaceState(null, '', `#${params}`);
  } catch {
    // Some browsers refuse replaceState on file:// URLs.
  }
}

function applyHash() {
  const params = hashParams();
  if (!params.has('from') && !params.has('to')) return false;
  if (PROFILES.some(p => p.id === params.get('profile'))) state.profile = params.get('profile');
  state.from = endpointFromId(params.get('from'));
  state.to = endpointFromId(params.get('to'), params.get('room'));
  return true;
}

function restoreState() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
  } catch {
    saved = null;
  }
  const sameDataset = saved && saved.dataset === datasetKey();
  if (!applyHash()) {
    if (saved && PROFILES.some(p => p.id === saved.profile)) state.profile = saved.profile;
    if (sameDataset) {
      state.from = endpointFromId(saved.from);
      state.to = endpointFromId(saved.to, saved.room);
    }
    if (!state.from) state.from = defaultOrigin();
  }
  if (sameDataset && Array.isArray(saved.closures)) {
    for (const item of saved.closures.slice(0, 40)) {
      if (!Number.isInteger(item?.edge) || item.edge < 0 || !edgeMidpoint(item.edge)) continue;
      state.closures.push({
        id: `b${++closureSeq}`, edge: item.edge, edges: segmentOf(item.edge),
        lngLat: Array.isArray(item.lngLat) ? item.lngLat : edgeMidpoint(item.edge),
      });
    }
  }
}

// ---------- rendering: planner ----------

function renderAll({ fit = true } = {}) {
  syncInputs();
  renderProfiles();
  renderChips();
  renderCard();
  renderResult();
  applyRouteToMap({ fit });
}

function syncInputs() {
  for (const which of ['from', 'to']) {
    const input = $(`#${which}-input`);
    if (document.activeElement !== input) input.value = state[which]?.title || '';
    $(`#${which}-clear`).hidden = !state[which];
  }
}

function renderProfiles() {
  const group = $('#profiles');
  const hadFocus = group.contains(document.activeElement);
  const hasJourney = !!(state.from && state.to);
  group.innerHTML = PROFILES.map(profile => {
    const route = state.routes[profile.id];
    const on = profile.id === state.profile;
    const meta = !hasJourney || !route ? '' : route.ok ? `${fmtDist(route.distance)} · ${fmtMin(route.duration)}` : 'No route';
    return `<button type="button" role="radio" class="seg${on ? ' on' : ''}${route && !route.ok ? ' fail' : ''}" aria-checked="${on}" tabindex="${on ? 0 : -1}" data-profile="${esc(profile.id)}"><span class="seg-label">${esc(profile.label)}</span><span class="seg-meta">${esc(meta) || '&nbsp;'}</span></button>`;
  }).join('');
  if (hadFocus) $('.seg.on', group)?.focus({ preventScroll: true });
}

// A row of small buttons that each reveal one hidden section, one at a time, in the region below the row.
function togglesHTML(items, open, attr, region) {
  return `<div class="toggles">${items.map(item => `<button type="button" class="toggle" ${attr}="${item.id}" aria-expanded="${item.id === open}" aria-controls="${region}">${esc(item.label)}${item.count ? ` <span class="count${item.alert ? ' alert' : ''}">${count.format(item.count)}</span>` : ''}</button>`).join('')}</div>`;
}

const regionHTML = (id, html) => `<div id="${id}" class="more-body${state.reveal ? ' reveal' : ''}"${html ? '' : ' hidden'}>${html}</div>`;

function renderChips() {
  const picks = state.to || state.card != null ? [] : state.picks.filter(i => i !== state.from?.placeIndex);
  $('#chips').innerHTML = picks.length
    ? `<div class="sec chips">${picks.map(i => `<button type="button" class="chip" data-pick="${i}">${esc(chipName(campus.places[i]))}</button>`).join('')}</div>`
    : '';
}

// ---------- rendering: place card ----------

function cardDetailsHTML(place) {
  const blocks = [];
  const doors = doorsOf(place).slice(0, 10);
  if (doors.length) {
    blocks.push(`<h4>Doors</h4><ul class="list">${doors.map(door => `<li><span>${esc(door.name || 'Entrance')}</span><span class="muted">${doorBadge(door)[0]}${door.powered === true ? ' · powered' : ''}</span></li>`).join('')}</ul>`);
  }
  const washrooms = (place.wc || []).slice(0, 4);
  if (washrooms.length) {
    blocks.push(`<h4>Accessible washrooms</h4><ul class="list">${washrooms.map(w => `<li><span>${esc(w.n)}${w.d ? `<span class="muted"> · ${esc(w.d)}</span>` : ''}</span></li>`).join('')}</ul>`);
  }
  const notices = (place.notices?.recent || []).slice(0, 3);
  if (notices.length) {
    blocks.push(`<h4>Access notices</h4><ul class="list">${notices.map(n => `<li><span>${safeUrl(n.url) ? `<a href="${esc(safeUrl(n.url))}" target="_blank" rel="noopener">${esc(n.title)}</a>` : esc(n.title)}</span><span class="muted">${esc(fmtDate(n.from))}</span></li>`).join('')}</ul>`);
  }
  return blocks.join('');
}

function renderCard() {
  const el = $('#place-card');
  const place = state.card == null ? null : campus.places[state.card];
  if (!place) {
    el.innerHTML = '';
    return;
  }
  const floors = floorsFor(state.card);
  const doors = doorCounts(place);
  const facts = [];
  if (floors.source !== 'unknown') facts.push(`${floors.source === 'estimated' ? '~' : ''}${plural(floors.levels, 'floor')}`);
  if (doors.stepfree) facts.push(plural(doors.stepfree, 'step-free door'));
  else if (doors.steps) facts.push('No step-free door');
  else if (doors.total) facts.push('Doors unverified');
  const details = cardDetailsHTML(place);
  el.innerHTML = `<section class="sec place" aria-label="Selected place">
    <div class="place-head">
      <h3>${esc(baseName(place))}${place.code ? ` <span class="code">${esc(place.code)}</span>` : ''}</h3>
      <button type="button" class="icon-btn" data-action="card-close" aria-label="Close place details">${icon('close')}</button>
    </div>
    ${facts.length ? `<p class="line">${esc(facts.join(' · '))}</p>` : ''}
    <div class="pair">
      <button type="button" class="btn primary" data-action="card-to">Directions to</button>
      <button type="button" class="btn" data-action="card-from">From here</button>
    </div>
    ${details ? `${togglesHTML([{ id: 'details', label: 'Details' }], state.cardDetails ? 'details' : null, 'data-card-more', 'card-more')}${regionHTML('card-more', state.cardDetails ? details : '')}` : ''}
  </section>`;
}

function openCard(placeIndex) {
  if (!campus.places[placeIndex]) return;
  state.card = placeIndex;
  state.cardDetails = false;
  renderChips();
  renderCard();
  syncFocus();
  setSheetCollapsed(false);
  $('#planner-body').scrollTop = 0;
  $('#sr-status').textContent = `${campus.places[placeIndex].name} selected.`;
}

function closeCard() {
  if (state.card == null) return;
  state.card = null;
  renderChips();
  renderCard();
  syncFocus();
}

// ---------- rendering: route card ----------

const arrivalDoor = route => (Number.isInteger(route.entrance?.to) ? campus.entrances[route.entrance.to] : null);

function statusText(route) {
  const flights = route.stairs?.flights || 0;
  const steps = route.stairs?.steps || 0;
  const parts = [flights > 0 ? `${plural(flights, 'stair flight')}${steps ? `, ${plural(steps, 'step')}` : ''}` : 'No stairs'];
  const walk = state.routes.walk;
  const extra = state.ghost && walk?.ok ? route.distance - walk.distance : 0;
  if (extra >= 1) parts.push(`${fmtDist(extra)} longer than walking`);
  return parts.join(' · ');
}

function floorChipsHTML() {
  const endpoint = state.to;
  const target = endpoint?.room?.floor;
  if (!endpoint?.room) return [];
  const top = Math.min(30, Math.max(floorsFor(endpoint.placeIndex).levels, target ?? 1));
  const active = state.activeFloor ?? target;
  const chip = (value, label) => `<button type="button" class="floor-chip${value === target ? ' target' : ''}" data-floor="${value}" aria-pressed="${value === active}" aria-label="Floor ${label}">${label}</button>`;
  const chips = [];
  if (target === 0) chips.push(chip(0, 'B'));
  for (let n = 1; n <= top; n += 1) chips.push(chip(n, String(n)));
  return chips;
}

function doorDetailsHTML(door) {
  const facts = [];
  if (door.powered === true) facts.push('Powered door');
  else if (door.src === 'uoft') facts.push('Manual door');
  if (door.lift) facts.push('Relies on a lift');
  facts.push(DOOR_SOURCE[door.src] ? `Source: ${DOOR_SOURCE[door.src]}` : 'Position estimated, no published door data');
  return `${door.desc ? `<p class="quote">${esc(door.desc)}</p>` : ''}<p class="note">${esc(facts.join(' · '))}</p>`;
}

// The hidden sections that apply to this route, and the content of the open one.
function routeSections(route) {
  const door = arrivalDoor(route);
  const steps = route.steps || [];
  const chips = floorChipsHTML();
  const warnings = route.warnings || [];
  const sections = [];
  if (steps.length) {
    sections.push({
      id: 'directions', label: 'Directions',
      html: () => `<ol class="steps">${steps.map((step, i) => `<li><button type="button" class="step" data-step="${i}"><span class="step-icon ${esc(step.type)}">${icon(STEP_ICON[step.type] || 'walk')}</span><span class="step-text">${esc(step.text)}</span>${step.distance >= 1 ? `<span class="step-dist">${fmtDist(step.distance)}</span>` : ''}</button></li>`).join('')}</ol>`,
    });
  }
  if (door) sections.push({ id: 'door', label: 'Door details', html: () => doorDetailsHTML(door) });
  if (chips.length > 1) {
    sections.push({
      id: 'floors', label: 'Floors',
      html: () => `<div class="floors" role="group" aria-label="Show a floor on the map">${chips.join('')}</div><p class="note">Floor read from the room number.</p>`,
    });
  }
  if (warnings.length) {
    sections.push({
      id: 'warnings', label: 'Warnings', count: warnings.length, alert: true,
      html: () => `<ul class="notes">${warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>`,
    });
  }
  return sections;
}

function actionsHTML(hasRoute) {
  const buttons = [];
  if (hasRoute) {
    buttons.push(`<button type="button" class="btn${state.flying ? '' : ' primary'}" data-action="fly" aria-pressed="${state.flying}">${icon(state.flying ? 'stop' : 'play')}${state.flying ? 'Stop' : 'Fly the route'}</button>`);
    buttons.push(`<button type="button" class="btn danger" data-action="report" aria-pressed="${state.reportMode}">Report a barrier</button>`);
  }
  if (state.closures.length) buttons.push('<button type="button" class="btn" data-action="clear-closures">Clear barriers</button>');
  return buttons.length ? `<div class="sec actions">${buttons.join('')}</div>` : '';
}

// One line and at most one button.
function failureHTML(failure) {
  const walkButton = state.profile !== 'walk' && state.routes.walk?.ok
    ? '<button type="button" class="btn" data-profile="walk">Show walking route</button>' : '';
  let line = 'No route found.';
  let button = walkButton;
  if (failure.reason === 'same') {
    line = 'Start and destination are the same.';
    button = '';
  } else if (failure.reason === 'no-stepfree-entrance') {
    const blocked = [placeOf(state.to), placeOf(state.from)].find(place => doorCounts(place).stepfree === 0);
    line = `No documented step-free entrance at ${blocked ? baseName(blocked) : 'this building'}.`;
  } else if (failure.reason === 'unreachable' && state.closures.length && tryRoute(state.profile).ok) {
    line = 'Reported barriers block every route.';
    button = '<button type="button" class="btn" data-action="clear-closures">Clear barriers</button>';
  } else if (failure.reason === 'unreachable' && state.profile === 'stepfree') {
    line = "No step-free path reaches this building's mapped doors.";
  } else if (failure.reason === 'unreachable') {
    line = 'No mapped path connects these places.';
  }
  const clearsBarriers = button.includes('clear-closures');
  return `<section class="sec failure" role="alert"><p>${esc(line)}</p>${button}</section>${clearsBarriers ? '' : actionsHTML(false)}`;
}

function renderResult() {
  const el = $('#result');
  const route = state.route;
  if (!state.from || !state.to || !route) {
    el.innerHTML = actionsHTML(false);
    return;
  }
  if (!route.ok) {
    el.innerHTML = failureHTML(route);
    return;
  }
  const [num, unit] = distParts(route.distance);
  const door = arrivalDoor(route);
  const room = state.to.room;
  const sections = routeSections(route);
  const open = sections.find(section => section.id === state.more);
  const [badgeText, badgeTone] = door ? doorBadge(door) : [];
  el.innerHTML = `<section class="sec summary" aria-label="Route">
      <div class="metrics">
        <div class="metric"><span class="num">${num}</span><span class="unit">${unit}</span></div>
        <div class="metric"><span class="num">${Math.max(1, Math.round(route.duration))}</span><span class="unit">min</span></div>
      </div>
      <p class="status">${esc(statusText(route))}</p>
      ${door ? `<div class="row"><span class="row-text">${esc(door.name || 'Entrance')}</span><span class="badge ${badgeTone}">${badgeText}</span></div>` : ''}
      ${room ? `<div class="row"><span class="row-text">${esc([room.floorText, `Room ${room.number}`].filter(Boolean).join(' · '))}</span></div>` : ''}
    </section>
    ${actionsHTML(true)}
    <div class="sec">${togglesHTML(sections, open?.id, 'data-more', 'route-more')}${regionHTML('route-more', open ? open.html() : '')}</div>`;
}

// ---------- map sync ----------

function markerFor(endpoint, coord) {
  const place = placeOf(endpoint);
  return place ? { lngLat: coord || placeLngLat(place), label: shortName(place) } : null;
}

function applyRouteToMap({ fit = true } = {}) {
  const route = state.route?.ok ? state.route : null;
  mapCall('setRoute', route, { ghost: state.ghost });
  mapCall('setMarkers', {
    from: markerFor(state.from, route?.coords?.[0]),
    to: markerFor(state.to, route?.coords?.[route.coords.length - 1]),
  });
  if (fit) updatePadding({ instant: true });
  if (fit && route) mapCall('fitRoute', route);
  else if (fit && !(state.from && state.to)) {
    const only = state.to || state.from;
    if (only) mapCall('flyToPlace', only.placeIndex);
  }
  syncFocus();
}

function syncFocus() {
  if (state.card != null) {
    mapCall('focusPlace', state.card, { levels: floorsFor(state.card).levels });
    return;
  }
  const to = state.to;
  if (state.route?.ok && to?.room && to.room.floor != null) {
    const levels = Math.max(floorsFor(to.placeIndex).levels, to.room.floor);
    mapCall('focusPlace', to.placeIndex, { levels, active: state.activeFloor ?? to.room.floor });
    return;
  }
  mapCall('focusPlace', null);
}

function computePadding() {
  const planner = $('#planner').getBoundingClientRect();
  const drawer = $('#audit');
  if (MOBILE.matches) {
    document.documentElement.style.setProperty('--sheet-h', `${Math.round(planner.height)}px`);
    // The map adds its own 90 px margin to every fit, which already clears the top bar on a phone.
    const sheet = Math.min(planner.height, window.innerHeight * 0.6);
    return { top: 0, right: 0, bottom: Math.max(0, Math.round(sheet) - 60), left: 0 };
  }
  document.documentElement.style.setProperty('--sheet-h', '0px');
  const right = drawer.hidden ? 24 : Math.round(drawer.getBoundingClientRect().width) + 40;
  return { top: 80, right, bottom: 56, left: Math.round(planner.right) + 24 };
}

// The map module eases padding changes, and any camera ease cancels a fit or fly-through in flight.
// So padding is only sent when it changes, and is applied instantly when a camera move follows or is running.
let appliedPadding = '';
function updatePadding({ instant = false } = {}) {
  if (!view) return;
  const padding = computePadding();
  const key = JSON.stringify(padding);
  if (key === appliedPadding) return;
  appliedPadding = key;
  if ((instant || state.flying) && typeof view.map?.setPadding === 'function') {
    try {
      view.map.setPadding(padding);
      return;
    } catch (error) {
      console.error('map.setPadding failed', error);
    }
  }
  mapCall('setPadding', padding);
}

function setSheetCollapsed(collapsed) {
  $('#planner').classList.toggle('collapsed', collapsed);
  $('#sheet-toggle').setAttribute('aria-expanded', String(!collapsed));
}

// ---------- actions ----------

async function toggleFly() {
  if (state.flying) {
    stopFlying();
    return;
  }
  const route = state.route?.ok ? state.route : null;
  if (!route || !view || typeof view.flyThrough !== 'function') return;
  state.flying = true;
  renderResult();
  if (MOBILE.matches) setSheetCollapsed(true);
  updatePadding({ instant: true });
  try {
    await view.flyThrough(route);
  } catch (error) {
    console.error('flyThrough failed', error);
  }
  state.flying = false;
  renderResult();
}

function stopFlying() {
  if (state.flying) mapCall('stopFlyThrough');
}

function toast(message, { tone = 'info', ms = 3600 } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${tone}`;
  el.textContent = message;
  $('#toasts').append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 260);
  }, ms);
}

// Render a section that was just opened or closed; it animates only on this render.
function revealed(render) {
  state.reveal = true;
  render();
  state.reveal = false;
}

// ---------- combobox ----------

function optionHTML(result, i, which, active) {
  const place = campus.places[result.placeIndex] || {};
  const floorText = normRoom(result.room, place)?.floorText || '';
  // The floor is shown on the right, so drop the engine's trailing "· Floor N" from the subtitle.
  const subtitle = floorText ? String(result.subtitle || '').replace(/\s*·\s*(Floor\s+\S+|Basement)\s*$/i, '') : result.subtitle;
  return `<li role="option" id="${which}-opt-${i}" data-i="${i}" aria-selected="${i === active}"><span class="opt-code">${esc(place.code || '·')}</span><span class="opt-main"><span class="opt-title">${esc(result.title)}</span>${subtitle ? `<span class="opt-sub">${esc(subtitle)}</span>` : ''}</span>${floorText ? `<span class="opt-tag">${esc(floorText)}</span>` : ''}</li>`;
}

function setupCombo(which) {
  const input = $(`#${which}-input`);
  const list = $(`#${which}-list`);
  let items = [];
  let active = -1;
  let open = false;

  const render = () => {
    list.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
    if (active >= 0 && open) input.setAttribute('aria-activedescendant', `${which}-opt-${active}`);
    else input.removeAttribute('aria-activedescendant');
    if (!open) return;
    list.innerHTML = items.length
      ? items.map((r, i) => optionHTML(r, i, which, active)).join('')
      : '<li class="empty" role="presentation">No match</li>';
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  };
  const refresh = () => {
    const typed = input.value.trim();
    items = typed ? safeSearch(typed, 8) : state.suggestions;
    active = typed && items.length ? 0 : -1;
    open = !!typed || items.length > 0;
    render();
  };
  const close = () => {
    open = false;
    active = -1;
    render();
  };
  const pick = i => {
    const endpoint = items[i] && endpointFromResult(items[i]);
    if (!endpoint) return;
    close();
    input.blur();
    setEndpoint(which, endpoint);
  };

  input.addEventListener('focus', () => {
    input.select();
    refresh();
  });
  input.addEventListener('input', refresh);
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) refresh();
      if (items.length) {
        active = (active + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        render();
      }
    } else if (event.key === 'Enter') {
      if (open && active < 0 && items.length && input.value.trim()) active = 0;
      if (open && active >= 0) {
        event.preventDefault();
        pick(active);
      }
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      close();
      syncInputs();
    }
  });
  input.addEventListener('blur', () => {
    setTimeout(() => {
      close();
      syncInputs();
    }, 120);
  });
  list.addEventListener('mousedown', event => event.preventDefault());
  list.addEventListener('click', event => {
    const option = event.target.closest('[data-i]');
    if (option) pick(Number(option.dataset.i));
  });
  $(`#${which}-clear`).addEventListener('click', () => {
    setEndpoint(which, null, { fit: false });
    input.value = '';
    input.focus();
  });
}

// ---------- access audit ----------

function openAudit() {
  state.auditOpen = true;
  $('#audit').hidden = false;
  $('#audit-btn').setAttribute('aria-expanded', 'true');
  document.body.classList.add('drawer-open');
  renderAudit();
  syncHighlights();
  updatePadding();
}

function closeAudit() {
  if (!state.auditOpen) return;
  state.auditOpen = false;
  $('#audit').hidden = true;
  $('#audit-btn').setAttribute('aria-expanded', 'false');
  document.body.classList.remove('drawer-open');
  syncHighlights();
  updatePadding();
}

// The fix rows currently on screen: the top three, or all of them once "All fixes" is open.
const shownFixes = () => (state.audit?.fixes || []).slice(0, state.auditMore === 'fixes' ? 12 : FIX_DEFAULT);

function syncHighlights() {
  const fixes = state.auditOpen && !state.auditStale ? shownFixes() : [];
  mapCall('setHighlights', fixes.length ? fixes.map((fix, i) => ({ id: fix.id, edges: fix.edges, lngLat: fix.lngLat, rank: i + 1 })) : null);
}

async function runAudit() {
  if (state.auditRunning) return;
  state.auditRunning = true;
  state.auditError = '';
  state.openFix = null;
  renderAudit();
  try {
    state.audit = await campus.audit({
      closedEdges: closedEdgeSet(),
      onProgress: (done, total) => {
        const bar = $('#audit-progress');
        if (bar) bar.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
      },
    });
    state.auditStale = false;
  } catch (error) {
    console.error('audit failed', error);
    state.auditError = error.message || String(error);
  }
  state.auditRunning = false;
  renderAudit();
  syncHighlights();
}

function fixHTML(fix, i) {
  const open = String(state.openFix) === String(fix.id);
  const a = campus.places[fix.example?.a];
  const b = campus.places[fix.example?.b];
  return `<li>
    <button type="button" class="fix" data-fix="${esc(fix.id)}" aria-expanded="${open}">
      <span class="rank">${i + 1}</span>
      <span class="row-main"><strong>${esc(fix.label || 'Stairs')}</strong><span>${esc(`${fmtDist(fix.savedMeters || 0)} saved · ${plural(fix.journeys || 0, 'journey')}`)}</span></span>
    </button>
    ${open && a && b ? `<button type="button" class="btn small example" data-journey="${Number(fix.example.a)},${Number(fix.example.b)}">Example: ${esc(shortName(a))} to ${esc(shortName(b))}</button>` : ''}
  </li>`;
}

function auditHTML() {
  if (state.auditRunning) {
    return '<div class="progress" role="progressbar" aria-label="Audit progress"><span id="audit-progress"></span></div>';
  }
  const audit = state.audit;
  const current = audit && !state.auditStale && !state.auditError;
  const run = `<button type="button" class="btn ${current ? '' : 'primary '}block" data-action="run-audit">${audit || state.auditError ? 'Run again' : 'Run audit'}</button>`;
  if (state.auditError) return `<p class="alert" role="alert">${esc(state.auditError)}</p>${run}`;
  if (!audit) return run;
  const share = audit.reachable ? Math.round(((audit.detoured || 0) / audit.reachable) * 100) : 0;
  const audited = (audit.audited ?? ((audit.reachable || 0) + (audit.unreachable || 0))) || audit.journeys || 0;
  const fixes = (audit.fixes || []).slice(0, 12);
  const worst = (audit.worst || []).filter(j => campus.places[j.a] && campus.places[j.b]).slice(0, 8);
  const mapped = (audit.doorPolicy || (campus.meta?.doorData === 'osm' ? 'mapped' : 'verified')) === 'mapped';
  const noDoor = mapped ? [] : (audit.noStepFreeDoor || []).filter(i => campus.places[i]);
  const sections = [];
  if (fixes.length > FIX_DEFAULT) {
    sections.push({ id: 'fixes', label: 'All fixes', html: () => `<ol class="rank-list">${fixes.slice(FIX_DEFAULT).map((fix, i) => fixHTML(fix, i + FIX_DEFAULT)).join('')}</ol>` });
  }
  if (worst.length) {
    sections.push({
      id: 'worst', label: 'Hardest journeys',
      html: () => `<ol class="rank-list">${worst.map(j => `<li><button type="button" class="fix" data-journey="${Number(j.a)},${Number(j.b)}"><span class="row-main"><strong>${esc(shortName(campus.places[j.a]))} to ${esc(shortName(campus.places[j.b]))}</strong><span>${esc(`${fmtDist(j.extra || 0)} longer step-free`)}</span></span></button></li>`).join('')}</ol>`,
    });
  }
  if (noDoor.length) {
    sections.push({
      id: 'nodoor', label: 'Buildings without a step-free door', count: noDoor.length,
      html: () => `<ul class="place-list">${noDoor.map(i => `<li><button type="button" class="linkish" data-place="${i}">${esc(baseName(campus.places[i]))}</button></li>`).join('')}</ul>`,
    });
  }
  const open = sections.find(section => section.id === state.auditMore);
  return `${run}
    <div class="tiles">
      <div class="tile"><strong>${count.format(audited)}</strong><span>journeys audited</span></div>
      <div class="tile"><strong>${share}%</strong><span>longer step-free</span></div>
      <div class="tile"><strong>+${fmtDist(audit.meanExtra || 0)}</strong><span>average detour</span></div>
    </div>
    <h3 class="section-title">Fix first</h3>
    ${fixes.length ? `<ol class="rank-list">${fixes.slice(0, FIX_DEFAULT).map(fixHTML).join('')}</ol>` : '<p class="muted">No single fix shortens a journey.</p>'}
    ${mapped ? '<p class="note">This campus publishes no door data, so this measures the paths between buildings.</p>' : ''}
    ${sections.length ? `<div class="more">${togglesHTML(sections, open?.id, 'data-audit-more', 'audit-more')}${regionHTML('audit-more', open ? open.html() : '')}</div>` : ''}`;
}

function renderAudit() {
  $('#audit-body').innerHTML = auditHTML();
}

function openFix(id, { fly = true } = {}) {
  const fix = (state.audit?.fixes || []).find(f => String(f.id) === String(id));
  if (!fix) return;
  // A click in the list toggles the row; a click on the map marker only ever opens it.
  state.openFix = fly && String(state.openFix) === String(id) ? null : id;
  renderAudit();
  if (fly && state.openFix != null && Array.isArray(fix.lngLat) && view?.map) {
    try {
      view.map.flyTo({ center: fix.lngLat, zoom: 18.2, pitch: 58, duration: 1400 });
    } catch (error) {
      console.error('flyTo failed', error);
    }
  }
}

// ---------- about and attribution ----------

const sourcesOf = () => (campus.meta?.sources || []).filter(source => source?.name);
const sourceLink = (source, text) => (safeUrl(source.url)
  ? `<a href="${esc(safeUrl(source.url))}" target="_blank" rel="noopener" title="${esc(source.name)}">${esc(text)}</a>` : esc(text));

function renderAbout() {
  const sources = sourcesOf();
  $('#about-body').innerHTML = `
    <p>Wayfound finds walking and step-free routes across campus, door to door.</p>
    ${sources.length ? `<p class="sources">Data: ${sources.map(source => sourceLink(source, source.name)).join(' · ')}</p>` : ''}
    <ul class="limits">
      <li>Outdoor routes only.</li>
      <li>Doors are unverified unless the university documents them.</li>
      <li>A prototype, not a safety aid.</li>
    </ul>`;
}

// One short line: the first three sources of the loaded campus, each cut down to who published it.
// The full names and the rest of the list are in the About dialog.
function renderAttribution() {
  const short = name => String(name).split(/[,(]/)[0].replace(/\s+(open data|campus map|datasets)$/i, '').trim();
  const sources = sourcesOf().slice(0, 3);
  $('#attribution').innerHTML = sources.length
    ? `Data: ${sources.map(source => `<span>${sourceLink(source, short(source.name))}</span>`).join('')}`
    : '';
}

// ---------- map callbacks ----------

function onPlaceClick(placeIndex) {
  if (!state.reportMode) openCard(placeIndex);
}

function onMapClick() {
  if (!state.reportMode) closeCard();
}

function onPathClick(edge, lngLat) {
  if (!state.reportMode) return;
  setReportMode(false);
  addClosure(edge, lngLat);
}

function onHighlightClick(id) {
  if (!state.auditOpen) openAudit();
  openFix(id, { fly: false });
}

// ---------- wiring ----------

function initUI() {
  $('#swap').innerHTML = icon('swap');
  for (const id of ['from-clear', 'to-clear', 'audit-close', 'about-close']) $(`#${id}`).innerHTML = icon('close');
  renderAttribution();

  // Quick picks and the default start come from the dataset; anything that does not resolve is dropped.
  const origin = defaultOrigin()?.placeIndex;
  const picks = (campus.meta?.picks || []).slice(0, 4).map(id => endpointFromId(id)?.placeIndex).filter(Number.isInteger);
  state.picks = [...new Set(picks)].filter(i => i !== origin);
  state.suggestions = [...new Set([origin, ...picks].filter(Number.isInteger))]
    .map(i => ({ placeIndex: i, title: baseName(campus.places[i]), subtitle: '', kind: 'place' }));

  setupCombo('from');
  setupCombo('to');

  $('#swap').addEventListener('click', () => {
    [state.from, state.to] = [state.to, state.from];
    state.activeFloor = null;
    journeyChanged();
  });

  $('#profiles').addEventListener('keydown', event => {
    const move = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!move) return;
    event.preventDefault();
    const index = PROFILES.findIndex(p => p.id === state.profile);
    setProfile(PROFILES[(index + move + PROFILES.length) % PROFILES.length].id);
    $('.seg.on', $('#profiles'))?.focus({ preventScroll: true });
  });

  $('#planner').addEventListener('click', event => {
    const target = event.target.closest('button');
    if (!target) return undefined;
    const data = target.dataset;
    if (data.profile) return setProfile(data.profile);
    if (data.pick != null) {
      if (!state.from) state.from = defaultOrigin();
      return setEndpoint('to', endpointFromPlace(Number(data.pick)));
    }
    if (data.more) {
      state.more = state.more === data.more ? null : data.more;
      return revealed(renderResult);
    }
    if (data.cardMore) {
      state.cardDetails = !state.cardDetails;
      return revealed(renderCard);
    }
    if (data.floor != null) {
      // Update the chips in place so the open section does not re-render and re-animate.
      state.activeFloor = Number(data.floor);
      for (const chip of target.parentElement.children) chip.setAttribute('aria-pressed', String(chip === target));
      return syncFocus();
    }
    if (data.step != null) {
      const step = state.route?.steps?.[Number(data.step)];
      if (MOBILE.matches) setSheetCollapsed(true);
      updatePadding({ instant: true });
      if (step?.coords?.length) mapCall('fitRoute', { ...state.route, coords: step.coords });
      return undefined;
    }
    switch (data.action) {
      case 'fly': return toggleFly();
      case 'report': return setReportMode(!state.reportMode);
      case 'clear-closures': return clearClosures();
      case 'card-close': return closeCard();
      case 'card-to': return setEndpoint('to', endpointFromPlace(state.card));
      case 'card-from': return setEndpoint('from', endpointFromPlace(state.card));
      default: return undefined;
    }
  });

  $('#sheet-toggle').addEventListener('click', () => setSheetCollapsed(!$('#planner').classList.contains('collapsed')));
  $('#report-cancel').addEventListener('click', () => setReportMode(false));

  $('#audit-btn').addEventListener('click', () => (state.auditOpen ? closeAudit() : openAudit()));
  $('#audit-close').addEventListener('click', closeAudit);
  $('#audit').addEventListener('click', event => {
    const target = event.target.closest('button');
    if (!target) return;
    const data = target.dataset;
    if (data.action === 'run-audit') runAudit();
    else if (data.auditMore) {
      state.auditMore = state.auditMore === data.auditMore ? null : data.auditMore;
      revealed(renderAudit);
      syncHighlights();
    } else if (data.fix) openFix(data.fix);
    else if (data.journey) {
      const [a, b] = data.journey.split(',').map(Number);
      loadJourney(a, b, 'stepfree');
    } else if (data.place) {
      const index = Number(data.place);
      mapCall('flyToPlace', index);
      openCard(index);
      if (MOBILE.matches) closeAudit();
    }
  });

  const about = $('#about');
  $('#about-btn').addEventListener('click', () => {
    renderAbout();
    if (typeof about.showModal === 'function') about.showModal();
    else about.setAttribute('open', '');
  });
  $('#about-close').addEventListener('click', () => about.close());
  about.addEventListener('click', event => {
    if (event.target === about) about.close();
  });

  $('#brand').addEventListener('click', () => mapCall('resetView'));

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || about.open) return;
    if (state.reportMode) setReportMode(false);
    else if (state.flying) stopFlying();
    else if (state.card != null) closeCard();
    else if (state.auditOpen) closeAudit();
  });

  window.addEventListener('hashchange', () => {
    if (!applyHash()) return;
    journeyChanged();
  });

  const onResize = () => updatePadding();
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(onResize);
    observer.observe($('#planner'));
    observer.observe($('#audit'));
  }
  window.addEventListener('resize', onResize);
  MOBILE.addEventListener?.('change', onResize);
}

// Runs before the data loads: the parts of the page that do not depend on it.
function initShell() {
  $('#brand-sub').textContent = CAMPUS.label;
  document.title = `Wayfound · ${CAMPUS.label}`;
  // A hash that names another known campus loads that campus.
  window.addEventListener('hashchange', () => {
    const id = hashParams().get('campus');
    if (id !== CAMPUS.id && CAMPUSES.some(c => c.id === id)) location.reload();
  });
  // The skip link must not replace the hash, which holds the journey.
  $('.skip-link').addEventListener('click', event => {
    event.preventDefault();
    $('#to-input').focus();
  });
  $('#fatal-reload').addEventListener('click', () => location.reload());
}

async function loadDataset() {
  const embedded = window.WAYFOUND_DATA?.[CAMPUS.id];
  if (embedded) return embedded;
  const file = `data/${CAMPUS.id}.json`;
  let response;
  try {
    response = await fetch(file);
  } catch {
    throw new Error(`${CAMPUS.label} data could not be loaded (${file}).`);
  }
  if (!response.ok) throw new Error(`${CAMPUS.label} data is missing (${file}, HTTP ${response.status}).`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${CAMPUS.label} data is not readable (${file}).`);
  }
}

function showFatal(error) {
  console.error(error);
  $('#loading').hidden = true;
  $('#fatal-message').textContent = error?.message || String(error);
  $('#fatal-hint').textContent = location.protocol === 'file:' ? 'Open the offline build, or serve this folder over http.' : '';
  $('#fatal').hidden = false;
}

async function boot() {
  // A timer, not requestAnimationFrame: rAF never fires in a background tab and would stall start-up.
  const step = text => {
    $('#loading-step').textContent = text;
    return new Promise(resolve => setTimeout(resolve, 30));
  };
  try {
    const dataset = await loadDataset();
    await step('Building the route graph');
    campus = createCampus(dataset);
    await step('Rendering the 3D campus');
    if (!window.maplibregl) throw new Error('The map library did not load (vendor/maplibre-gl.js).');
    view = await createMap3D({ container: $('#map'), campus, dataset, onPlaceClick, onPathClick, onMapClick, onHighlightClick });
    initUI();
    restoreState();
    computeRoutes();
    updatePadding({ instant: true });
    mapCall('setClosures', state.closures.map(({ id, edges, lngLat }) => ({ id, edges, lngLat })));
    renderAll({ fit: !!(state.from && state.to) });
    const loading = $('#loading');
    loading.classList.add('done');
    setTimeout(() => { loading.hidden = true; }, 400);
  } catch (error) {
    showFatal(error);
  }
}

initShell();
boot();
