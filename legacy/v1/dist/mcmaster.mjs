/**
 * McMaster main-campus demo. Buildings and the transit terminal are real.
 * The schematic links, measurements, surfaces and modeled barriers are fictional.
 */
const nodes = [
  { id: 'transit', label: 'McMaster GO Bus Terminal', shortLabel: 'GO Bus Terminal', x: 150, y: 480, kind: 'place' },
  { id: 'student-centre', label: 'McMaster University Student Centre', shortLabel: 'Student Centre', x: 736, y: 170, kind: 'place' },
  { id: 'library', label: 'Mills Memorial Library', shortLabel: 'Mills Library', x: 739, y: 270, kind: 'place' },
  { id: 'science-hall', label: 'Burke Science Building', shortLabel: 'Burke Science Building', x: 496, y: 465, kind: 'place' },
  { id: 'garden', label: 'H.G. Thode Library', shortLabel: 'Thode Library', x: 265, y: 568, kind: 'place' },
  { id: 'east-entrance', label: 'L.R. Wilson Hall', shortLabel: 'L.R. Wilson Hall', x: 895, y: 504, kind: 'place' },
  { id: 'plaza', label: 'Central walkway junction', x: 490, y: 374, kind: 'junction' },
  { id: 'lift-base', label: 'Lift approach', x: 610, y: 335, kind: 'junction' },
  { id: 'library-landing', label: 'Library approach junction', x: 739, y: 356, kind: 'junction' },
  { id: 'garden-gate', label: 'Ramp approach', x: 860, y: 385, kind: 'junction' },
];

function edge(id, from, to, meters, slope, label, attributes = {}) {
  return { id, from, to, meters, slope, label, surface: 'paved', stairs: false, elevator: false, ...attributes };
}

const edges = [
  edge('transit-walk', 'transit', 'garden', 90, 2, 'Terminal to Thode walkway'),
  edge('campus-walk', 'garden', 'plaza', 200, 1, 'Thode to central walkway'),
  edge('library-stairs', 'plaza', 'library', 110, 12, 'Simulated Mills stairs', { stairs: true }),
  edge('lift-approach', 'plaza', 'lift-base', 100, 2, 'West approach to Mills'),
  edge('library-lift', 'lift-base', 'library-landing', 15, 0, 'Simulated Mills lift', { elevator: true }),
  edge('library-entry', 'library-landing', 'library', 65, 1, 'Mills approach walkway'),
  edge('garden-walk', 'transit', 'science-hall', 260, 1, 'Terminal to Burke walkway'),
  edge('garden-path', 'science-hall', 'east-entrance', 275, 2, 'Burke to Wilson walkway'),
  edge('garden-ramp', 'garden-gate', 'library-landing', 125, 4.5, 'Simulated east ramp'),
  edge('student-centre-link', 'plaza', 'student-centre', 165, 3, 'Central to Student Centre walkway'),
  edge('student-wilson', 'student-centre', 'east-entrance', 185, 1, 'Student Centre to Wilson walkway'),
  edge('east-gate', 'east-entrance', 'garden-gate', 85, 2, 'Wilson to ramp approach'),
  edge('plaza-science', 'plaza', 'science-hall', 90, 2, 'Central to Burke walkway'),
  edge('courtyard-shortcut', 'transit', 'plaza', 230, 1, 'Simulated unpaved shortcut', { surface: 'gravel' }),
  edge('steep-hill', 'plaza', 'library-landing', 160, 9, 'Simulated steep shortcut'),
];

export const mcmaster = {
  id: 'mcmaster',
  name: 'McMaster University',
  shortName: 'McMaster',
  location: 'Hamilton, Ontario',
  origin: 'transit',
  destination: 'library',
  nodes,
  edges,
  sources: [
    { label: 'McMaster campus map (PDF)', url: 'https://library.mcmaster.ca/sites/default/files/2024-11/mcmaster_campus_map.pdf' },
    { label: 'McMaster public transit information', url: 'https://parking.mcmaster.ca/getting-to-campus/public-transit/' },
    { label: 'McMaster Accessibility Hub: Getting Around', url: 'https://accessibility.mcmaster.ca/getting-around/' },
  ],
  referenceNote: 'McMaster’s campus map and transit information identify the landmarks. Wayfound models illustrative paths and uses simulated distances, slopes, surfaces, lifts, ramps, and closures. Consult the university for current access and directions.',
};
