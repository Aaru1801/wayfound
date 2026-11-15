const CAMPUS_CENTRE = [43.6632, -79.3971];
const METRES_LAT = 111195;
const METRES_LNG = METRES_LAT * Math.cos(CAMPUS_CENTRE[0] * Math.PI / 180);

function planar([lat, lng]) {
  return [(lng - CAMPUS_CENTRE[1]) * METRES_LNG, (CAMPUS_CENTRE[0] - lat) * METRES_LAT];
}

export function createCampusMap(canvas, paths, buildingData, landmarks, onSelect) {
  const ctx = canvas.getContext('2d');
  const buildings = buildingData.buildings.map(building => ({
    ...building,
    rings: building.rings.map(ring => ring.map(planar)),
  })).filter(building => building.rings[0]?.length > 2);
  const wayNodes = paths.nodes.map(planar);
  const points = landmarks.map(landmark => ({ ...landmark, xy: planar([landmark.lat, landmark.lng]) }));
  const byId = new Map(points.map(point => [point.id, point]));
  let targetIds = [];
  let routeLine = [];
  let active = true;
  let angled = true;
  let rotation = -0.12;
  let zoom = 1;
  let offset = [0, 0];
  let centre = [0, 0];
  let scale = 1;
  let width = 0, height = 0, dpr = 1;
  let frame;
  let hitAreas = [];
  let drag;

  function project([x, y], elevation = 0) {
    const dx = x - centre[0], dy = y - centre[1];
    const horizontal = dx * Math.cos(rotation) - dy * Math.sin(rotation);
    const vertical = dx * Math.sin(rotation) + dy * Math.cos(rotation);
    const s = scale * zoom;
    return [width / 2 + offset[0] + horizontal * s,
      height / 2 + offset[1] + (vertical * (angled ? 0.77 : 1) - elevation * (angled ? 0.64 : 0)) * s];
  }

  function trace(coordinates, z = 0, close = false) {
    coordinates.forEach((point, i) => {
      const [x, y] = project(point, z);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    if (close) ctx.closePath();
  }

  function visible(points) {
    const margin = 100;
    return points.some(point => point[0] >= -margin && point[0] <= width + margin
      && point[1] >= -margin && point[1] <= height + margin);
  }

  function drawGrid() {
    ctx.strokeStyle = '#dce4d4';
    ctx.lineWidth = 0.75;
    ctx.beginPath();
    for (let x = -1100; x <= 1100; x += 65) trace([[x, -1100], [x, 1100]]);
    for (let y = -1100; y <= 1100; y += 65) trace([[-1100, y], [1100, y]]);
    ctx.stroke();
  }

  function drawPaths() {
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const way of paths.ways) trace(way.map(index => wayNodes[index]));
    ctx.strokeStyle = '#d2dacb';
    ctx.lineWidth = 2.8;
    ctx.stroke();
    ctx.strokeStyle = '#f9faf2';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  function drawBuilding(building) {
    const { rings } = building;
    const top = Number.isFinite(building.height) ? Math.max(0, building.height) : 0;
    const ring = rings[0];
    const ground = ring.map(point => project(point));
    if (!visible(ground) && !visible(ring.map(point => project(point, top)))) return;
    if (angled && top) {
      ctx.beginPath();
      for (const points of rings) trace(points.map(([x, y]) => [x + top * .33, y + top * .2]), 0, true);
      ctx.fillStyle = '#78896919';
      ctx.fill('evenodd');
      // The city polygons can use either winding. Draw every vertical wall, then cover hidden ones with the roof.
      const walls = ring.map((a, i) => {
        const b = ring[(i + 1) % ring.length];
        const depth = (project(a)[1] + project(b)[1]) / 2;
        return { a, b, depth };
      }).sort((a, b) => a.depth - b.depth);
      for (const wall of walls) {
        const { a, b } = wall;
        const p = [project(a), project(b), project(b, top), project(a, top)];
        ctx.beginPath();
        for (let i = 0; i < p.length; i++) i ? ctx.lineTo(...p[i]) : ctx.moveTo(...p[i]);
        ctx.closePath();
        ctx.fillStyle = p[1][0] >= p[0][0] ? '#b6c3b0' : '#a3b3a0';
        ctx.fill();
        ctx.strokeStyle = '#8fa38e4c';
        ctx.lineWidth = .6;
        ctx.stroke();
      }
    }
    ctx.beginPath();
    for (const roof of rings) trace(roof, top, true);
    ctx.fillStyle = top ? '#e6ece0' : '#e0e7d9';
    ctx.fill('evenodd');
    ctx.strokeStyle = '#bdcbb8';
    ctx.lineWidth = .85;
    ctx.stroke();
  }

  function drawRoute() {
    if (routeLine.length < 2) return;
    ctx.beginPath();
    trace(routeLine);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#fbfff1';
    ctx.lineWidth = 10;
    ctx.stroke();
    ctx.strokeStyle = '#2f6c4c';
    ctx.lineWidth = 5.5;
    ctx.stroke();
  }

  function drawPins() {
    hitAreas = [];
    const [start, end] = targetIds;
    for (const point of [...points].sort((a, b) => Number([start, end].includes(a.id)) - Number([start, end].includes(b.id)))) {
      const [x, y] = project(point.xy);
      if (!visible([[x, y]])) continue;
      const selected = start === point.id || end === point.id;
      ctx.beginPath();
      ctx.arc(x, y, selected ? 11 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = end === point.id ? '#204f3b' : start === point.id ? '#507b47' : '#f7faf0';
      ctx.fill();
      ctx.lineWidth = selected ? 2.4 : 1.4;
      ctx.strokeStyle = selected ? '#f7fff1' : '#708d6c';
      ctx.stroke();
      hitAreas.push({ x, y, id: point.id });
      if (selected) {
        ctx.font = '700 11px system-ui';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#fff';
        ctx.fillText(end === point.id ? 'B' : 'A', x, y + 4);
      }
      if (selected || width >= 680 || zoom > 1.35) {
        const label = point.shortLabel || point.label;
        ctx.font = `${selected ? '700 12' : '600 10'}px system-ui`;
        ctx.textAlign = x < 82 ? 'left' : x > width - 82 ? 'right' : 'center';
        const labelY = y - (selected ? 17 : 10);
        ctx.strokeStyle = '#f8fbf2';
        ctx.lineWidth = 4;
        ctx.strokeText(label, x, labelY);
        ctx.fillStyle = selected ? '#1c4b35' : '#435745';
        ctx.fillText(label, x, labelY);
      }
    }
  }

  function draw() {
    frame = undefined;
    if (!width || !height) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#eef2e8';
    ctx.fillRect(0, 0, width, height);
    drawGrid();
    drawPaths();
    const sorted = angled ? [...buildings].sort((a, b) => project(a.rings[0][0])[1] - project(b.rings[0][0])[1]) : buildings;
    for (const building of sorted) drawBuilding(building);
    drawRoute();
    drawPins();
  }

  function schedule() {
    if (active && !frame) frame = requestAnimationFrame(draw);
  }

  function measure() {
    const bounds = canvas.getBoundingClientRect();
    width = bounds.width;
    height = bounds.height;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    scale = Math.min(width / 1000, height / 790) * 1.2;
    schedule();
  }

  function fit() {
    const markers = targetIds.map(id => byId.get(id)?.xy).filter(Boolean);
    const coordinates = routeLine.length ? [...routeLine, ...markers] : points.map(point => point.xy);
    if (!coordinates.length) return;
    const xs = coordinates.map(point => point[0]), ys = coordinates.map(point => point[1]);
    centre = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
    const horizontal = Math.max(250, Math.max(...xs) - Math.min(...xs));
    const vertical = Math.max(250, Math.max(...ys) - Math.min(...ys));
    zoom = Math.min(2.05, Math.max(.65, Math.min(width / (horizontal + 190), height / (vertical + 210)) / scale));
    offset = [0, 0];
    schedule();
  }

  canvas.addEventListener('pointerdown', event => {
    drag = { x: event.clientX, y: event.clientY, dx: offset[0], dy: offset[1] };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', event => {
    if (!drag) return;
    offset = [drag.dx + event.clientX - drag.x, drag.dy + event.clientY - drag.y];
    schedule();
  });
  canvas.addEventListener('pointerup', event => {
    if (!drag) return;
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) {
      const bounds = canvas.getBoundingClientRect();
      const pin = [...hitAreas].reverse().find(p => Math.hypot(p.x - event.clientX + bounds.left, p.y - event.clientY + bounds.top) < 17);
      if (pin) onSelect(pin.id);
    }
    drag = undefined;
  });
  canvas.addEventListener('pointercancel', () => { drag = undefined; });
  canvas.addEventListener('keydown', event => {
    const arrows = { ArrowLeft: [30, 0], ArrowRight: [-30, 0], ArrowUp: [0, 30], ArrowDown: [0, -30] };
    const nudge = arrows[event.key];
    if (!nudge) return;
    event.preventDefault();
    offset = [offset[0] + nudge[0], offset[1] + nudge[1]];
    schedule();
  });
  new ResizeObserver(measure).observe(canvas);
  measure();

  return {
    setRoute(route, from, to) { routeLine = route?.coordinates.map(planar) ?? []; targetIds = [from, to]; fit(); },
    setAngled(value) { angled = value; schedule(); },
    zoom(factor) { zoom = Math.max(.5, Math.min(4, zoom * factor)); schedule(); },
    rotate() { rotation -= Math.PI / 8; schedule(); },
    fit,
    setActive(value) { active = value; if (active) measure(); },
  };
}
