// Landmark names and their relative positions are based on Waterloo's campus map.
// All links, lengths, slopes, surfaces, and barrier states are demonstration data.
const waterlooNodes = [
  { id: 'transit', label: 'University of Waterloo ION Station', shortLabel: 'ION Station', x: 830, y: 237, kind: 'place' },
  { id: 'library', label: 'Dana Porter Library', shortLabel: 'Dana Porter Library', x: 515, y: 565, kind: 'place' },
  { id: 'student-centre', label: 'Student Life Centre', shortLabel: 'Student Life Centre', x: 240, y: 191, kind: 'place' },
  { id: 'davis-centre', label: 'Davis Centre', shortLabel: 'Davis Centre', x: 690, y: 285, kind: 'place' },
  { id: 'science-teaching', label: 'Science Teaching Complex', shortLabel: 'Science Teaching', x: 333, y: 456, kind: 'place' },
  { id: 'engineering-5', label: 'Engineering 5', shortLabel: 'Engineering 5', x: 890, y: 343, kind: 'place' },
  { id: 'central-junction', label: 'Central campus junction', x: 520, y: 344, kind: 'junction' },
  { id: 'lift-approach', label: 'Demo lift approach', x: 460, y: 416, kind: 'junction' },
  { id: 'library-landing', label: 'Demo library landing', x: 499, y: 491, kind: 'junction' },
  { id: 'ramp-approach', label: 'Demo ramp approach', x: 755, y: 565, kind: 'junction' },
];

function waterlooEdge(id, from, to, meters, slope, label, attributes = {}) {
  return {
    id, from, to, meters, slope, label,
    surface: 'paved', stairs: false, elevator: false,
    ...attributes,
  };
}

const waterlooEdges = [
  waterlooEdge('transit-walk', 'transit', 'davis-centre', 120, 2, 'Station to Davis Centre'),
  waterlooEdge('campus-walk', 'davis-centre', 'central-junction', 140, 1, 'Central campus path'),
  waterlooEdge('student-centre-walk', 'central-junction', 'student-centre', 170, 2, 'Student Life Centre path'),
  waterlooEdge('student-science-link', 'student-centre', 'science-teaching', 180, 2, 'West campus path'),
  waterlooEdge('science-walk', 'central-junction', 'science-teaching', 125, 2.5, 'Science Teaching Complex path'),
  waterlooEdge('lift-approach', 'central-junction', 'lift-approach', 85, 2, 'Demo lift approach'),
  waterlooEdge('library-lift', 'lift-approach', 'library-landing', 25, 0, 'Demo library lift', { elevator: true }),
  waterlooEdge('library-entry', 'library-landing', 'library', 50, 1, 'Demo library entrance path'),
  waterlooEdge('east-walk', 'transit', 'engineering-5', 120, 2, 'Station to Engineering 5'),
  waterlooEdge('south-approach', 'engineering-5', 'ramp-approach', 290, 3, 'South approach from Engineering 5'),
  waterlooEdge('science-south-link', 'science-teaching', 'ramp-approach', 230, 2, 'South campus link'),
  waterlooEdge('garden-ramp', 'ramp-approach', 'library-landing', 110, 4.5, 'Demo ramp'),
  waterlooEdge('courtyard-shortcut', 'transit', 'central-junction', 220, 1, 'Demo courtyard shortcut', { surface: 'gravel' }),
  waterlooEdge('library-stairs', 'central-junction', 'library', 130, 12, 'Demo library steps', { stairs: true }),
  waterlooEdge('steep-hill', 'central-junction', 'library-landing', 110, 9, 'Demo steep approach'),
];

export const waterloo = {
  id: 'waterloo',
  name: 'University of Waterloo',
  shortName: 'Waterloo',
  location: 'Waterloo, Ontario',
  origin: 'transit',
  destination: 'library',
  nodes: waterlooNodes,
  edges: waterlooEdges,
  sources: [
    { label: 'Official Waterloo campus map', url: 'https://uwaterloo.ca/about/maps-and-directions' },
    { label: 'Waterloo campus accessibility', url: 'https://uwaterloo.ca/accessibility/getting-around' },
    { label: 'Waterloo self-guided campus tour', url: 'https://uwaterloo.ca/current-graduate-students/incoming-students/self-guided-tour' },
  ],
  referenceNote: 'Waterloo’s official map identifies the landmarks. Routes, slopes, lift and ramp placements, and closure scenarios are simulated for this prototype. Consult the university’s official accessibility resources before travelling.',
};
