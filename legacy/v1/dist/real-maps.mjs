const waterlooRoomPlans = 'https://uwaterloo.ca/plant-operations/floor-plans';
const campusMaps = {
  waterloo: {
    campusMap: 'https://uwaterloo.ca/map//',
    floorPlans: waterlooRoomPlans,
    floorPlanNote: 'Some Waterloo floor plans require WatIAM sign-in.',
    googleEmbed: 'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d2895.4400845818063!2d-80.5448576!3d43.4722854!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x882bf6ad02edccff%3A0xdd9df23996268e17!2sUniversity%20of%20Waterloo!5e0!3m2!1sen!2sca!4v1794767326875!5m2!1sen!2sca',
    rooms: [
      { code: 'LIB 251', landmark: 'library', name: 'Library Accessibility Services', building: 'Dana Porter Library', detail: 'Main floor', url: 'https://uwaterloo.ca/lib-accessibility', link: 'Room details' },
      { code: 'DC 1302', landmark: 'davis-centre', name: 'Room 1302', building: 'Davis Centre', url: 'https://uwaterloo.ca/math/events/deans-town-hall', link: 'Room reference' },
      { code: 'SLC 3102', landmark: 'student-centre', name: 'Mates office', building: 'Student Life Centre', url: 'https://wusa.ca/services/student-run-services/mates/', link: 'Room details' },
      { code: 'E5 2004', landmark: 'engineering-5', name: 'Sedra Student Design Centre classroom', building: 'Engineering 5', url: 'https://uwaterloo.ca/sedra-student-design-centre/facilities', link: 'Room details' },
      { code: 'STC 1012', landmark: 'science-teaching', name: 'Room 1012', building: 'Science Teaching Complex', url: 'https://uwaterloo.ca/indigenous/smudging/approved-rooms', link: 'Room reference' },
    ],
    extraLinks: [{ label: 'Public library floor plans', url: 'https://clickable-floor-plans.lib.uwaterloo.ca/' }],
  },
  mcmaster: {
    campusMap: 'https://discover.mcmaster.ca/map/',
    floorPlans: 'https://www.mcmaster.ca/uts/maps/',
    floorPlanNote: 'For a room link below, enter the room number in the university’s floor map search.',
    googleEmbed: 'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d2905.526211023359!2d-79.9197003!3d43.2613506!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x882c84ac44f72ac1%3A0x399e00ea6143011c!2sMcMaster%20University!5e0!3m2!1sen!2sca!4v1794767344604!5m2!1sen!2sca',
    rooms: [
      { code: 'L101', landmark: 'library', name: 'Library service desk', building: 'Mills Memorial Library', detail: 'Main floor', url: 'https://www.mcmaster.ca/uts/maps/ml1.html', link: 'Floor plan' },
      { code: '207', landmark: 'student-centre', name: 'Room 207', building: 'McMaster University Student Centre', detail: 'Floor 2', url: 'https://www.mcmaster.ca/uts/maps/musc2.html', link: 'Floor plan' },
      { code: '240', landmark: 'science-hall', name: 'Meeting room', building: 'Burke Science Building', detail: 'Floor 2', url: 'https://www.mcmaster.ca/uts/maps/bsb2.html', link: 'Floor plan' },
      { code: '210', landmark: 'garden', name: 'Room 210', building: 'H.G. Thode Library', detail: 'Floor 2', url: 'https://www.mcmaster.ca/uts/maps/hgtl2.html', link: 'Floor plan' },
      { code: '1001', landmark: 'east-entrance', name: 'Room 1001', building: 'L.R. Wilson Hall', detail: 'Floor 1', url: 'https://www.mcmaster.ca/uts/maps/lrwh1.html', link: 'Floor plan' },
    ],
    extraLinks: [{ label: 'McMaster accessibility information', url: 'https://accessibility.mcmaster.ca/getting-around/' }],
  },
};

export function officialCampusMap(campusId) {
  return campusMaps[campusId].campusMap;
}

function mapsUrl(path, params) {
  return `https://www.google.com/maps/${path}/?${new URLSearchParams({ api: '1', ...params })}`;
}

function newExternalLink(href, label) {
  const link = document.createElement('a');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = `${label} ↗`;
  return link;
}

function normalizedRoom(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function createRealMapsView(container, changeJourney) {
  const el = id => container.querySelector(`#${id}`);
  const frame = el('google-campus-map');
  const reference = el('map-reference');
  reference.addEventListener('toggle', () => {
    if (reference.open && activeCampus) frame.src = campusMaps[activeCampus.id].googleEmbed;
  });
  const origin = el('map-origin');
  const destination = el('map-destination');
  const query = el('room-query');
  const results = el('room-results');
  let activeCampus;

  function renderRooms() {
    if (!activeCampus) return;
    const config = campusMaps[activeCampus.id];
    const search = query.value.trim().toLowerCase();
    const code = normalizedRoom(search);
    const matches = config.rooms.filter(room => !search
      || (code && normalizedRoom(room.code).includes(code))
      || search.split(/\s+/).every(term => `${room.building} ${room.name} ${room.code}`.toLowerCase().includes(term)));
    el('room-status').textContent = matches.length
      ? `${matches.length} sourced ${matches.length === 1 ? 'room' : 'rooms'}`
      : 'No listing in this sample. Try the official floor plans above.';
    results.replaceChildren(...matches.map(room => {
      const row = document.createElement('li');
      row.className = 'room-row';
      const badge = document.createElement('strong');
      badge.className = 'room-code';
      badge.textContent = room.code;
      const info = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = room.name;
      const building = document.createElement('span');
      building.textContent = [room.building, room.detail].filter(Boolean).join(' · ');
      const link = newExternalLink(room.url, room.link);
      link.setAttribute('aria-label', `${room.link} for ${room.building} ${room.code} (opens in a new tab)`);
      info.append(name, building);
      const actions = document.createElement('div');
      actions.className = 'room-actions';
      const route = document.createElement('button');
      route.type = 'button';
      route.textContent = 'Route here';
      route.setAttribute('aria-label', `Route to ${room.building} for room ${room.code}`);
      route.addEventListener('click', () => changeJourney(origin.value, room.landmark, { snapDestination: true }));
      actions.append(route, link);
      row.append(badge, info, actions);
      return row;
    }));
  }

  function update(campus, from, to) {
    const points = campus.nodes.filter(node => node.kind === 'place');
    if (activeCampus?.id !== campus.id) {
      activeCampus = campus;
      const config = campusMaps[campus.id];
      el('real-map-title').textContent = campus.name;
      el('real-map-region').textContent = campus.location;
      frame.title = `Google Maps of ${campus.name}`;
      if (reference.open) frame.src = config.googleEmbed;
      else frame.removeAttribute('src');
      el('live-google-campus').href = mapsUrl('search', { query: `${campus.name}, ${campus.location}` });
      el('live-official-campus').href = config.campusMap;
      el('live-floor-plans').href = config.floorPlans;
      el('floor-plan-note').textContent = config.floorPlanNote;
      el('real-map-resources').replaceChildren(...config.extraLinks.map(link => newExternalLink(link.url, link.label)));
      for (const select of [origin, destination]) {
        select.replaceChildren(...points.map(node => new Option(node.label, node.id)));
      }
      query.value = '';
      renderRooms();
    }
    origin.value = from;
    destination.value = to;

  }

  query.addEventListener('input', renderRooms);
  origin.addEventListener('change', () => changeJourney(origin.value, destination.value));
  destination.addEventListener('change', () => changeJourney(origin.value, destination.value));
  return { update };
}
