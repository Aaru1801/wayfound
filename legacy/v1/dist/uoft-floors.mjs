// Public room metadata and paraphrased directions. Plans stay on their publishers' sites.
const gersteinNoticeUrl = 'https://blogs.library.utoronto.ca/blog/notice-construction-main-floor-fall-2026';
const gersteinBookingUrl = 'https://libcal.library.utoronto.ca/reserve/gerstein';
const robartsBookingUrl = 'https://libcal.library.utoronto.ca/r/search/robarts';
const robartsStacksUrl = 'https://library.utoronto.ca/space/robarts/robarts-library-stacks';
const robartsRoom4004Url = 'https://library.utoronto.ca/space/robarts/robarts-library-4th-floor-accessible-consultation-room-4004';
const hartHouseAccessUrl = 'https://harthouse.ca/about/visitor-info';
const bahenVenueUrl = 'https://campusevents.utoronto.ca/event-spaces/centrally-shared-spaces/bahen-centre/';

const gersteinStudySteps = [
  'From the main floor, find the Public Service Desk.',
  'Use the hallway across from the desk. Follow the blue arrows to the stairs for the second-floor study rooms.',
  'On Floor 2, follow room signs to the selected study room.',
];

const gersteinStudyRooms = ['2100', '2101', '2102', '2103', '2104', '2105', '2106', '2107'].map(code => ({
  code,
  name: 'Group study room',
  url: 'https://library.utoronto.ca/space/gerstein-library/' + code,
  steps: gersteinStudySteps,
  directionsUrl: gersteinNoticeUrl,
  usesStairs: true,
  note: 'The published detour uses stairs. Ask the Public Service Desk for elevator access if you need a step-free route. A UTORid is required to reserve this room.',
}));

export const uoftFloors = {
  gerstein: {
    name: 'Gerstein Science Information Centre',
    address: '9 King’s College Circle',
    accessUrl: 'https://library.utoronto.ca/library/gerstein',
    notice: {
      text: 'Gerstein’s September 2026 construction notice describes a signed detour to the second-floor study rooms, via the hallway across from the Public Service Desk.',
      url: gersteinNoticeUrl,
    },
    floors: [
      {
        id: '1-below',
        label: '1 Below',
        rooms: [
          { code: 'B110', name: 'Study space', url: 'https://library.utoronto.ca/space/gerstein-library/room-b110-gerstein-library' },
          { code: 'B172', name: 'Group study room', url: gersteinBookingUrl },
          { code: 'B173', name: 'Group study room', url: gersteinBookingUrl },
          { code: 'B174', name: 'Group study room', url: gersteinBookingUrl },
          { code: 'B175', name: 'Group study room', url: gersteinBookingUrl },
        ],
      },
      {
        id: '1',
        label: 'Main floor',
        rooms: [
          { code: '1201', name: 'George Kiddell Room', url: gersteinBookingUrl },
          {
            code: '2365', name: 'Family workstation',
            url: 'https://library.utoronto.ca/space/gerstein-science-information-centre/gerstein-family-workstation',
          },
        ],
      },
      {
        id: '2',
        label: 'Floor 2',
        plan: { label: 'University construction and wayfinding notice', url: gersteinNoticeUrl },
        rooms: [
          ...gersteinStudyRooms,
          { code: '2000', name: 'Presentation Practice Space', url: gersteinBookingUrl },
          {
            code: '2320',
            name: 'Instruction Lab',
            url: 'https://library.utoronto.ca/space/gerstein-library/mobile-application-development-lab-madlab-gerstein-library',
          },
        ],
      },
    ],
  },
  robarts: {
    name: 'Robarts Library',
    address: '130 St. George Street',
    accessUrl: 'https://library.utoronto.ca/library/robarts',
    floors: [
      {
        id: '2',
        label: 'Floor 2',
        rooms: [
          {
            code: '2241',
            name: 'Group Study Room 2A · Robarts Common',
            url: 'https://library.utoronto.ca/space/robarts/2241-group-study-room-2a',
            steps: [
              'On Floor 2 of Robarts Library, find the cafeteria lounge south of Starbucks.',
              'Take the connecting corridor through to Robarts Common. Look for room 2241 near the elevator.',
            ],
            directionsUrl: robartsBookingUrl,
            note: 'Check the library booking rules and building access before visiting.',
          },
        ],
      },
      {
        id: '4',
        label: 'Floor 4',
        plan: { label: 'Official floor diagram and route to 4004', url: robartsRoom4004Url },
        rooms: [
          {
            code: '4004',
            name: 'Accessible Consultation Room',
            url: robartsRoom4004Url,
            steps: [
              'Take the elevator to Floor 4. Walk around the escalators to the Reading Room doors opposite the elevators.',
              'Go through the double doors and continue straight into the Reading Room.',
              'Find the group of three doors along the right-hand wall. Room 4004 is the leftmost.',
            ],
            note: 'Book a research consultation in advance. Library staff control access to the room.',
          },
          {
            code: '4006',
            name: 'Consultation Room',
            url: 'https://library.utoronto.ca/space/robarts/robarts-library-4th-floor-consultation-room-4006',
            steps: [
              'From the Floor 4 elevators, go around the escalators to the Reading Room doors opposite.',
              'Continue straight through the double doors. Room 4006 is the third door in the group on the right wall.',
            ],
            note: 'Book a research consultation in advance. Library staff control access to the room.',
          },
        ],
      },
      {
        id: '5',
        label: 'Floor 5',
        plan: {
          label: 'Fifth-floor Map & Data Library visitor information',
          url: 'https://library.utoronto.ca/news/robarts-library-reopens-transformed-fifth-floor',
        },
        rooms: [
          { code: 'MDL', name: 'Map & Data Library', url: 'https://guides.library.utoronto.ca/mdl' },
        ],
      },
      ...[9, 10, 11, 12, 13].map(level => ({
        id: String(level),
        label: 'Floor ' + level,
        plan: { label: 'Robarts stacks floor guide', url: robartsStacksUrl },
        rooms: [{ code: 'Stacks', name: 'Robarts book stacks', url: robartsStacksUrl }],
      })),
    ],
  },
  'hart-house': {
    name: 'Hart House',
    address: '7 Hart House Circle',
    accessUrl: hartHouseAccessUrl,
    floors: [
      {
        id: '1',
        label: 'Main floor',
        plan: { label: 'Hart House entry and accessibility map', url: hartHouseAccessUrl },
        rooms: [
          {
            code: '1039',
            name: 'Map Room',
            url: 'https://harthouse.ca/spaces/venues/map-room',
            steps: ['Use the west entrance off Tower Road. The Map Room is nearby on the main floor.'],
            directionsUrl: 'https://harthouse.ca/spaces/venues/map-room',
          },
          { code: '1022', name: 'Great Hall · East Wing', url: 'https://harthouse.ca/spaces/venue/great-hall' },
        ],
      },
      {
        id: '2',
        label: 'Floor 2',
        rooms: [
          { code: '2006', name: 'Music Room', url: 'https://harthouse.ca/spaces/venue/music-room' },
          { code: '2005', name: 'Donald Burwash Dining Room', url: 'https://harthouse.ca/spaces/venue/south-dining-room' },
          { code: '2037', name: 'Meeting Room', url: 'https://harthouse.ca/spaces/venues/meeting-room' },
        ],
      },
      {
        id: '3',
        label: 'Floor 3',
        rooms: [
          { code: '3017', name: 'South Sitting Room', url: 'https://harthouse.ca/spaces/venues/south-sitting-room' },
        ],
      },
    ],
  },
  bahen: {
    name: 'Bahen Centre for Information Technology',
    address: '40 St. George Street',
    accessUrl: bahenVenueUrl,
    floors: [
      {
        id: 'B',
        label: 'Basement',
        rooms: [
          { code: 'BA B026', name: 'Classroom', url: 'https://techknowfile.utoronto.ca/event/aws-teksystems-hands-on-with-amazon-kiro/' },
        ],
      },
      {
        id: '1',
        label: 'Main floor',
        plan: { label: 'Bahen Atrium floor plans and 3D tour', url: bahenVenueUrl },
        rooms: [
          { code: 'BA 1130', name: 'Classroom', url: 'https://techknowfile.utoronto.ca/event/build-your-second-brain-atomic-note-taking-with-obsidian-and-ai/' },
          { code: 'BA 1160', name: 'Classroom', url: 'https://engsci.utoronto.ca/experience/esec/esec-2025-home/schedule/' },
          { code: 'BA 1210', name: 'Classroom', url: 'https://techknowfile.utoronto.ca/event/teaching-students-to-work-critically-with-ai-vibe-coding-as-a-model-for-ai-augmented-learning/' },
        ],
      },
      {
        id: '2',
        label: 'Floor 2',
        rooms: [
          { code: 'BA 2135', name: 'Classroom', url: 'https://chem-eng.utoronto.ca/graduate-studies/programs-degrees/gradtimetable/' },
          { code: 'BA 2139', name: 'Classroom', url: 'https://www.mie.utoronto.ca/programs/graduate/course-schedule/' },
          { code: 'BA 2155', name: 'Classroom', url: 'https://techknowfile.utoronto.ca/event/from-classroom-to-campus-impact-how-a-campus-living-lab-sparked-cross-institutional-collaboration-for-sustainable-it/' },
        ],
      },
    ],
  },
};

export const uoftIndoorCoverage = {
  text: 'Room and floor listings are drawn from public university sources. The campus map routes outdoors to the building; selected rooms have additional published indoor directions.',
  buildingPlansUrl: 'https://updc.utoronto.ca/university-planning/building-plans/',
  campusMapUrl: 'https://map.utoronto.ca/',
  accessibilityNoticesUrl: 'https://notices.aoda.utoronto.ca/',
};
