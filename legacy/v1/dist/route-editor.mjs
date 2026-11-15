const maximumStops = 5;
const editorStoragePrefix = 'wayfound-outdoor-route-v1-';
const osmAttribution = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>';
const stopKey = index => `stop-${index}`;

function validPosition(position, bounds) {
  if (!Array.isArray(position) || position.length !== 2 || !position.every(Number.isFinite)) return false;
  const [lat, lng] = position;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  return !bounds || (lat >= bounds[0][0] && lat <= bounds[1][0]
    && lng >= bounds[0][1] && lng <= bounds[1][1]);
}

function distanceLabel(meters) {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(2)} km`;
}

function button(label, edit, className = '') {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = label;
  node.dataset.edit = edit;
  if (className) node.className = className;
  return node;
}

/** Create the editor on a visible element. Updates preserve edits until an endpoint landmark changes. */
export function createOutdoorRouteEditor(container, { planRoute, anchors, networks = {} }) {
  container.classList.add('route-editor');
  container.innerHTML = `
    <div class="route-editor-tools" role="group" aria-label="Edit route pins">
      <button type="button" data-edit="start" aria-pressed="false"><span class="route-editor-badge">A</span> Set start</button>
      <button type="button" data-edit="end" aria-pressed="false"><span class="route-editor-badge is-end">B</span> Set destination</button>
      <button type="button" data-edit="append" aria-pressed="false">+ Add stop</button>
      <button type="button" data-edit="fit" class="route-editor-secondary">Fit route</button>
    </div>
    <div class="route-editor-placement" hidden>
      <span class="route-editor-placement-hint"></span>
      <button type="button" data-edit="center">Use map center</button>
      <button type="button" data-edit="cancel">Cancel</button>
    </div>
    <div class="route-editor-map" role="region" aria-label="Editable walking route map"></div>
    <div class="route-editor-result">
      <div class="route-editor-result-line"><p class="route-editor-status" role="status" tabindex="-1">Choose outdoor landmarks to start.</p><button type="button" data-edit="reset" class="route-editor-secondary">Reset pins</button></div>
      <ol class="route-editor-stops" aria-label="Route points in walking order"></ol>
      <p class="route-editor-note">Drag pins to edit the route. The route connects nearby mapped paths and may include steps.</p>
      <a class="route-editor-attribution" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a>
    </div>`;

  const tools = container.querySelector('.route-editor-tools');
  const mapElement = container.querySelector('.route-editor-map');
  const stopsList = container.querySelector('.route-editor-stops');
  const placement = container.querySelector('.route-editor-placement');
  const placementHint = container.querySelector('.route-editor-placement-hint');
  const status = container.querySelector('.route-editor-status');
  const tileFallbackAttribution = container.querySelector('.route-editor-attribution');
  const records = new Map();
  let map;
  let pinLayer;
  let routeLine;
  let fallbackLayer;
  let fallbackRenderer;
  let fallbackCampus;
  let tileAvailable = false;
  let pointMode = null;
  let activeCampus;
  let record;
  let generation = 0;
  let latestPath = [];

  function campusBounds() {
    return networks[activeCampus?.id]?.bounds;
  }

  function coordinateFor(id) {
    const position = anchors[activeCampus.id]?.[id];
    return validPosition(position, campusBounds()) ? [...position] : null;
  }

  function persistRecord() {
    try { localStorage.setItem(`${editorStoragePrefix}${activeCampus.id}`, JSON.stringify(record)); } catch {}
  }

  function readRecord(campus) {
    try {
      const value = JSON.parse(localStorage.getItem(`${editorStoragePrefix}${campus.id}`) || 'null');
      const places = anchors[campus.id];
      if (!value || !places || !Object.hasOwn(places, value.from) || !Object.hasOwn(places, value.to)) return null;
      const bounds = networks[campus.id]?.bounds;
      if (!validPosition(value.start, bounds) || !validPosition(value.end, bounds)) return null;
      if (!Array.isArray(value.stops) || value.stops.length > maximumStops
        || !value.stops.every(position => validPosition(position, bounds))) return null;
      return { from: value.from, to: value.to, start: value.start, end: value.end,
        startCustom: value.startCustom === true, endCustom: value.endCustom === true, stops: value.stops };
    } catch { return null; }
  }

  function defaultRecord(from, to) {
    return { from, to, start: coordinateFor(from), end: coordinateFor(to), startCustom: false, endCustom: false, stops: [] };
  }

  function itinerary() {
    if (!record) return [];
    const landmarkLabel = (id, fallback) => activeCampus.nodes?.find(node => node.id === id)?.shortLabel
      || activeCampus.nodes?.find(node => node.id === id)?.label || fallback;
    return [
      { id: 'start', label: record.startCustom ? 'Pinned start' : landmarkLabel(record.from, 'Start'), pin: 'A', position: record.start },
      ...record.stops.map((position, index) => ({ id: stopKey(index), label: `Stop ${index + 1}`, pin: `${index + 1}`, position })),
      { id: 'end', label: record.endCustom ? 'Pinned destination' : landmarkLabel(record.to, 'Destination'), pin: 'B', position: record.end },
    ];
  }

  function drawFallback() {
    if (!map || activeCampus?.id === fallbackCampus) return;
    if (fallbackLayer) fallbackLayer.remove();
    fallbackCampus = activeCampus?.id;
    const data = networks[fallbackCampus];
    if (!data?.nodes || !data?.ways) return;
    const segments = data.ways.map(way => way.map(index => data.nodes[index]));
    fallbackLayer = globalThis.L.polyline(segments, {
      renderer: fallbackRenderer,
      color: '#a7b5a1', opacity: 0.85, weight: 2.5, interactive: false,
    }).addTo(map);
  }

  function mountMap() {
    if (map) return true;
    const leaflet = globalThis.L;
    if (!leaflet) {
      status.textContent = 'The interactive map could not load. Reload Wayfound to try again.';
      return false;
    }
    map = leaflet.map(mapElement, {
      minZoom: 14, maxZoom: 19, scrollWheelZoom: false, attributionControl: true,
      zoomControl: true, maxBoundsViscosity: 0.75,
    });
    map.createPane('wayfoundPathNetwork').style.zIndex = '190';
    fallbackRenderer = leaflet.canvas({ pane: 'wayfoundPathNetwork' });
    pinLayer = leaflet.layerGroup().addTo(map);
    routeLine = leaflet.polyline([], { color: '#17684c', weight: 6, opacity: 0.95, interactive: false }).addTo(map);
    map.on('click', ({ latlng }) => {
      if (pointMode) applyPosition(pointMode, [latlng.lat, latlng.lng]);
    });
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      const tiles = leaflet.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: osmAttribution, maxNativeZoom: 19, referrerPolicy: 'strict-origin-when-cross-origin',
      });
      tiles.once('tileload', () => {
        tileAvailable = true;
        tileFallbackAttribution.hidden = true;
      });
      tiles.on('tileerror', drawFallback);
      tiles.addTo(map);
    } else {
      drawFallback();
    }
    if (globalThis.ResizeObserver) {
      const observer = new ResizeObserver(entries => {
        if (entries.some(entry => entry.contentRect.width > 0 && entry.contentRect.height > 0)) {
          map.invalidateSize({ pan: false });
        }
      });
      observer.observe(mapElement);
    }
    return true;
  }

  function fitRoute() {
    if (!map || !record) return;
    const positions = [...latestPath, ...itinerary().map(point => point.position).filter(Boolean)];
    if (!positions.length) return;
    map.fitBounds(positions, { padding: [40, 40], maxZoom: 17, animate: false });
  }

  function renderPoints() {
    pinLayer.clearLayers();
    const points = itinerary();
    stopsList.replaceChildren();
    for (const [index, point] of points.entries()) {
      if (point.position) {
        const marker = globalThis.L.marker(point.position, {
          draggable: true, title: `${point.label} · Drag to move`, alt: `${point.label} route pin`,
          icon: globalThis.L.divIcon({ className: 'route-editor-pin', iconSize: [34, 38], iconAnchor: [17, 36],
            html: `<span class="route-editor-pin-shape ${point.id === 'end' ? 'is-end' : ''}"><span>${point.pin}</span></span>` }),
        }).addTo(pinLayer);
        marker.on('dragend', () => {
          const { lat, lng } = marker.getLatLng();
          if (!applyPosition(point.id, [lat, lng])) marker.setLatLng(point.position);
        });
      }
      const item = document.createElement('li');
      const badge = document.createElement('span');
      badge.className = `route-editor-badge ${point.id === 'end' ? 'is-end' : ''}`;
      badge.textContent = point.pin;
      const name = document.createElement('span');
      name.textContent = point.label;
      item.append(badge, name);
      if (point.id.startsWith('stop-')) {
        const edit = button('Move', point.id, 'route-editor-secondary');
        edit.setAttribute('aria-label', `Move ${point.label}`);
        edit.setAttribute('aria-pressed', String(pointMode === point.id));
        const remove = button('Remove', `remove-${index - 1}`, 'route-editor-secondary');
        remove.setAttribute('aria-label', `Remove ${point.label}`);
        item.append(edit, remove);
      }
      stopsList.append(item);
    }
    tools.querySelector('[data-edit="append"]').disabled = record.stops.length === maximumStops;
  }

  async function redraw({ fit = false } = {}) {
    const updateId = ++generation;
    latestPath = [];
    routeLine.setLatLngs([]);
    renderPoints();
    if (fit) fitRoute();
    const points = itinerary().map(point => point.position);
    if (points.some(position => !position)) {
      status.textContent = 'Set the start and destination pins on the campus map.';
      return;
    }
    status.textContent = 'Finding a walking route…';
    let route;
    try { route = await planRoute(activeCampus.id, points); } catch {
      if (updateId === generation) status.textContent = 'Routing is temporarily unavailable.';
      return;
    }
    if (updateId !== generation) return;
    if (!route || !Array.isArray(route.coordinates) || !route.coordinates.length
      || !Number.isFinite(route.distanceMeters)) {
      status.textContent = 'No mapped walking route between these pins. Move a pin closer to a campus path.';
      return;
    }
    latestPath = route.coordinates;
    routeLine.setLatLngs(latestPath);
    if (fit) fitRoute();
    const stops = record.stops.length;
    const detourNote = route.maxSnapMeters > 25 ? ' A pin is more than 25 m from its mapped path.' : '';
    status.textContent = `${distanceLabel(route.distanceMeters)} walking route${stops ? ` · ${stops} ${stops === 1 ? 'stop' : 'stops'}` : ''}${route.hasMappedSteps ? ' · Includes mapped steps' : ''}.${detourNote}`;
  }

  function setMode(mode) {
    pointMode = mode;
    placement.hidden = !mode;
    mapElement.classList.toggle('is-placing', Boolean(mode));
    const point = mode === 'append' ? 'new stop' : mode === 'start' ? 'start' : mode === 'end' ? 'destination' : 'stop';
    if (mode) placementHint.textContent = `Click the map to set the ${point}. For keyboard controls, pan the map and choose Use map center.`;
    for (const control of container.querySelectorAll('[data-edit][aria-pressed]')) {
      control.setAttribute('aria-pressed', String(control.dataset.edit === mode));
    }
  }

  function applyPosition(mode, position) {
    if (!validPosition(position, campusBounds())) {
      status.textContent = 'Choose a position inside the campus map.';
      return false;
    }
    if (mode === 'start' || mode === 'end') {
      record[mode] = position;
      record[`${mode}Custom`] = true;
    } else if (mode === 'append' && record.stops.length < maximumStops) {
      record.stops.push(position);
    } else if (mode.startsWith('stop-')) {
      const index = Number(mode.slice(5));
      if (index < 0 || index >= record.stops.length) return false;
      record.stops[index] = position;
    } else return false;
    setMode(null);
    persistRecord();
    void redraw();
    return true;
  }

  container.addEventListener('click', event => {
    const control = event.target.closest('[data-edit]');
    if (!control || !map || !record) return;
    const action = control.dataset.edit;
    if (action === 'reset') {
      record = defaultRecord(record.from, record.to);
      records.set(activeCampus.id, record);
      setMode(null);
      persistRecord();
      void redraw({ fit: true });
    } else if (action === 'fit') {
      fitRoute();
    } else if (action === 'center' && pointMode) {
      const { lat, lng } = map.getCenter();
      const mode = pointMode;
      if (applyPosition(mode, [lat, lng])) (tools.querySelector(`[data-edit="${mode}"]`) || tools.firstElementChild).focus();
    } else if (action === 'cancel') {
      setMode(null);
      tools.firstElementChild.focus();
    } else if (action.startsWith('remove-')) {
      record.stops.splice(Number(action.slice(7)), 1);
      setMode(null);
      persistRecord();
      void redraw();
      tools.querySelector('[data-edit="append"]').focus();
    } else {
      setMode(pointMode === action ? null : action);
    }
  });
  container.addEventListener('keydown', event => {
    if (event.key === 'Escape' && pointMode) {
      event.preventDefault();
      setMode(null);
      tools.firstElementChild.focus();
    }
  });

  function update(campus, from, to) {
    const changedCampus = activeCampus?.id !== campus.id;
    activeCampus = campus;
    const existing = records.get(campus.id) || readRecord(campus);
    record = existing || defaultRecord(from, to);
    const changedFrom = record.from !== from;
    const changedTo = record.to !== to;
    if (changedFrom) Object.assign(record, { from, start: coordinateFor(from), startCustom: false });
    if (changedTo) Object.assign(record, { to, end: coordinateFor(to), endCustom: false });
    records.set(campus.id, record);
    if (!mountMap()) return;
    map.invalidateSize({ pan: false });
    if (changedCampus) {
      const bounds = campusBounds();
      if (bounds) {
        map.setMaxBounds(globalThis.L.latLngBounds(bounds).pad(0.14));
        map.fitBounds(bounds, { maxZoom: 16, animate: false });
      } else if (record.start) map.setView(record.start, 16, { animate: false });
      if (!tileAvailable || fallbackLayer) drawFallback();
    }
    if (!existing || changedCampus || changedFrom || changedTo) {
      setMode(null);
      persistRecord();
      void redraw({ fit: true });
    }
  }
  function resetDestination() {
    if (!record || !map) return;
    record.end = coordinateFor(record.to);
    record.endCustom = false;
    setMode(null);
    persistRecord();
    void redraw({ fit: true });
  }

  return { update, resetDestination };
}
