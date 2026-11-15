import { campuses, profiles, createRouter } from './engine.mjs';
import { createRealMapsView, officialCampusMap } from './real-maps.mjs';
import { createOutdoorRouteEditor } from './route-editor.mjs';
import { createOutdoorPlanner } from './outdoor-routing.mjs';
import { outdoorNetworks } from './outdoor-network.mjs';
import { outdoorAnchors } from './outdoor-anchors.mjs';
const $ = id => document.getElementById(id);
const validProfile = value => Object.hasOwn(profiles, value);
const validCampus = value => Object.hasOwn(campuses, value);
let campus, nodes, edges, placeNodes, placeIds, nodeMap, edgeMap, findRoute, explainExclusions;

function loadCampus(id) {
  campus = campuses[id];
  ({ nodes, edges } = campus);
  ({ findRoute, explainExclusions } = createRouter(campus));
  placeNodes = nodes.filter(node => node.kind === 'place');
  placeIds = new Set(placeNodes.map(node => node.id));
  nodeMap = new Map(nodes.map(node => [node.id, node]));
  edgeMap = new Map(edges.map(edge => [edge.id, edge]));
}
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const iconPaths = {
 wheelchair:'<circle cx="12" cy="4" r="2"/><path d="M11 7v7h7l3 6M11 10h6M8 10a6 6 0 1 0 7 9"/>',
 stroller:'<path d="M4 4h3l3 12h9l3-8H8M11 4h6v4"/><circle cx="11" cy="20" r="1"/><circle cx="19" cy="20" r="1"/>',
 walk:'<circle cx="13" cy="4" r="2"/><path d="M13 7l-3 6 4 3 1 6M10 13l-3 8M12 9l5 4h3M12 8l-5 2-2 4"/>',
 share:'<path d="M12 16V3m-4 4 4-4 4 4M5 12v8h14v-8"/>', download:'<path d="M12 3v12m-4-4 4 4 4-4M5 17v4h14v-4"/>',
 shield:'<path d="M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6"/>', map:'<path d="M3 5l6-2 6 3 6-2v16l-6 2-6-3-6 2zM9 3v16m6-13v16"/>',
 nodes:'<circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="12" cy="19" r="2"/><path d="M7 6h10M6 8l5 9m7-9-5 9"/>',
 expand:'<path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6"/>', plus:'<path d="M12 4v16M4 12h16"/>', check:'<path d="M5 12l4 4L19 6"/>',
 lift:'<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 16V8m-3 3 3-3 3 3m5-3v8m-3-3 3 3 3-3"/>', ramp:'<path d="M3 19h18V6zM5 5h5M8 3l2 2-2 2"/>', barrier:'<path d="M4 9h16v6H4zM7 15v5m10-5v5M7 9l6 6m0-6 6 6"/>', info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>'
};
function icon(name){return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name]||iconPaths.info}</svg>`;}
function injectIcons(){document.querySelectorAll('[data-icon]').forEach(el=>el.innerHTML=icon(el.dataset.icon));}
const params = new URLSearchParams(location.hash.slice(1));
loadCampus(validCampus(params.get('campus')) ? params.get('campus') : 'waterloo');
const state = { reports: [], graph: false, zoom: 1, demo: 0, route: null, view: routeViewFrom(params) };
const realMapsView = createRealMapsView($('maps-view'), (from, to, { snapDestination = false } = {}) => {
  const sameDestination = state.to === to;
  state.from = from;
  state.to = to;
  render();
  replaceRouteFragment(routeParams());
  if (snapDestination) {
    if (sameDestination) outdoorRouteEditor.resetDestination();
    $('outdoor-route-editor').querySelector('.route-editor-status').focus();
  }
});

const outdoorRouteEditor = createOutdoorRouteEditor($('outdoor-route-editor'), {
  planRoute: createOutdoorPlanner(outdoorNetworks),
  anchors: outdoorAnchors,
  networks: outdoorNetworks,
});

function routeViewFrom(params) {
  if (params.get('view') === 'maps' || params.get('view') === 'demo') return params.get('view');
  return params.has('from') || params.has('to') || params.has('profile') ? 'demo' : 'maps';
}

function renderView() {
  $('maps-view').hidden = state.view !== 'maps';
  $('simulation-view').hidden = state.view !== 'demo';
  for (const button of document.querySelectorAll('[data-view]')) {
    button.setAttribute('aria-pressed', String(button.dataset.view === state.view));
  }
  if (state.view === 'maps') {
    realMapsView.update(campus, state.from, state.to);
    outdoorRouteEditor.update(campus, state.from, state.to);
  }
}

for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', () => {
    state.view = button.dataset.view;
    renderView();
    replaceRouteFragment(routeParams());
  });
}

function applyRouteParams(params) {
  const profile = validProfile(params.get('profile')) ? params.get('profile') : 'wheelchair';
  const slope = Number(params.get('slope'));
  const hasSlope = params.has('slope') && Number.isFinite(slope) && slope >= 0 && slope <= 20;
  state.from = placeIds.has(params.get('from')) ? params.get('from') : campus.origin;
  state.to = placeIds.has(params.get('to')) ? params.get('to') : campus.destination;
  state.profile = profile;
  state.maxSlope = hasSlope ? slope : profiles[profile].maxSlope;
  state.avoidRough = params.has('rough') ? params.get('rough') === '1' : profiles[profile].avoidRough;
}

function reportKey() { return `wayfound-reports-v2-${campus.id}`; }
function readReports() {
  try {
    const saved = JSON.parse(localStorage.getItem(reportKey()) || '[]');
    if (!Array.isArray(saved)) return [];
    return saved.filter(report => report && edgeMap.has(report.edgeId)
      && Number.isFinite(report.expiresAt) && report.expiresAt > Date.now())
      .map(report => ({
        edgeId: report.edgeId,
        expiresAt: report.expiresAt,
        reason: typeof report.reason === 'string' ? report.reason : 'Unavailable',
        note: typeof report.note === 'string' ? report.note : '',
      }));
  } catch { return []; }
}
function saveReports() {
  try { localStorage.setItem(reportKey(), JSON.stringify(state.reports)); } catch {}
}

function routeParams() {
  return new URLSearchParams({ campus: campus.id, view: state.view, from: state.from, to: state.to,
    profile: state.profile, slope: String(state.maxSlope), rough: state.avoidRough ? '1' : '0' });
}
function replaceRouteFragment(params) {
  try { history.replaceState(null, '', `#${params}`); } catch {}
}

applyRouteParams(params);
state.reports = readReports();
function closedIds(){return state.reports.filter(r=>r.expiresAt>Date.now()).map(r=>r.edgeId);}
function opts(extra={}){return {from:state.from,to:state.to,profile:state.profile,maxSlope:state.maxSlope,avoidRough:state.avoidRough,closedEdges:closedIds(),...extra};}
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,3600);}
function closeEdge(id,closed=true,reason='Unavailable in demo',note=''){
 state.reports=state.reports.filter(r=>r.edgeId!==id);if(closed)state.reports.push({edgeId:id,reason,note,expiresAt:Date.now()+3600000});saveReports();render();
}
function setProfile(profile){state.profile=profile;state.maxSlope=profiles[profile].maxSlope;state.avoidRough=profiles[profile].avoidRough;render();}
function renderCampus() {
  const options = placeNodes.map(node => `<option value="${node.id}">${esc(node.label)}</option>`).join('');
  $('origin').innerHTML = options;
  $('destination').innerHTML = options;
  $('campus-name').textContent = campus.name;
  $('campus-region').textContent = campus.location;
  $('campus-map-link').href = officialCampusMap(campus.id);
  $('campus-map-link').textContent = `Official ${campus.shortName} campus map ↗`;
  document.body.dataset.activeCampus = campus.id;
  for (const button of document.querySelectorAll('[data-campus]')) {
    button.setAttribute('aria-pressed', String(button.dataset.campus === campus.id));
  }
}

function selectCampus(id) {
  if (!validCampus(id) || id === campus.id) return;
  loadCampus(id);
  state.from = campus.origin;
  state.to = campus.destination;
  state.reports = readReports();
  state.zoom = 1;
  state.demo = 0;
  renderCampus();
  render();
  replaceRouteFragment(routeParams());
  toast(`Showing ${campus.name}`);
}

for (const button of document.querySelectorAll('[data-campus]')) {
  button.addEventListener('click', () => selectCampus(button.dataset.campus));
}
$('slope').max = '20';
renderCampus();
function rememberFocus(){const el=document.activeElement;if(!el)return null;if(el.id)return {id:el.id};for(const key of ['node','barrier','repair'])if(el.dataset?.[key])return {key,value:el.dataset[key]};return null;}
function restoreFocus(focus){if(!focus)return;const el=focus.id?$(focus.id):document.querySelector(`[data-${focus.key}="${focus.value}"]`);if(el&&el!==document.activeElement)el.focus({preventScroll:true});}
function render(){
 const previousFocus=rememberFocus();
 state.route=findRoute(opts());
 $('origin').value=state.from;$('destination').value=state.to;$('slope').value=state.maxSlope;$('slope-value').textContent=`${state.maxSlope}%`;$('avoid-rough').checked=state.avoidRough;
 document.querySelectorAll('[data-profile]').forEach(b=>{const active=b.dataset.profile===state.profile;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
 $('profile-description').textContent={wheelchair:'Step-free paths, with incline and surface limits you control.',stroller:'No stairs. Gentler slopes and smooth surfaces by default.',walking:'Shortest distance, including steps and uneven paths.'}[state.profile];
 renderRoute();renderMap();renderDirections();renderBarriers();renderDemo();renderView();
 const reachable=placeNodes.filter(n=>n.id!==state.from).filter(n=>findRoute(opts({to:n.id}))).length;
 $('reachability-number').textContent=`${reachable} / ${placeNodes.length-1}`;
 $('download-button').disabled=!state.route;
 $('graph-button').setAttribute('aria-pressed',String(state.graph));
 injectIcons();restoreFocus(previousFocus);
}
function renderRoute(){
 const route=state.route;
 if(!route){$('route-summary').innerHTML=`<div class="route-card unavailable"><div class="route-status">${icon('barrier')} No compatible route</div><h3>There isn’t a way<br>through. Yet.</h3><p class="route-explanation">No route matches your current needs and closures. Explore repair impact to see what could restore access.</p></div>`;return;}
 if(state.from===state.to){$('route-summary').innerHTML=`<div class="route-card"><div class="route-status">${icon('check')} You’re already here</div><div class="route-metrics"><strong>0</strong><span>min</span><span class="distance">0 m</span></div><p class="route-explanation">Start and destination are the same. Pick another place to find your way.</p></div>`;return;}
 const baseline=findRoute(opts({closedEdges:[]}));
 const shortest=findRoute({from:state.from,to:state.to,profile:'walking',closedEdges:closedIds()});
 const extra=shortest?route.distanceMeters-shortest.distanceMeters:0;
 const detour=baseline?route.distanceMeters-baseline.distanceMeters:0;
 let reason=detour>0?`Rerouted around a closure. This path adds ${detour} m to your usual compatible route.`:extra>0?`${extra} m beyond the shortest walking route, to respect your mobility preferences.`:'The shortest distance that matches your needs and current closures.';
 $('route-summary').innerHTML=`<div class="route-card"><div class="route-status">${icon(detour>0?'ramp':'check')}${detour>0?'New way found':state.profile==='walking'?'Your walking route':'A route that fits you'}</div><div class="route-metrics"><strong>${route.durationMinutes}</strong><span>min est.</span><span class="distance">${route.distanceMeters} m</span></div><div class="route-tag-row"><span class="route-tag">${route.hasStairs?'Includes steps':'Step-free'}</span><span class="route-tag">${route.maxSlope}% max slope</span><span class="route-tag">${route.hasElevator?'Uses lift':route.roughMeters?'Uneven surface':'Paved paths'}</span></div><p class="route-explanation">${reason}</p></div>`;
}
function renderDirections(){
 const route=state.route;$('directions-count').textContent=route?`${route.steps.length} connections`:'No route';
 if(!route){$('directions').innerHTML='<li class="empty-directions">Your preferences stay in place, even when no route is available. Open repair impact to see which connection would help.</li>';return;}
 if(!route.steps.length){$('directions').innerHTML='<li class="empty-directions">You’ve arrived. Your start and destination are the same.</li>';return;}
 $('directions').innerHTML=route.steps.map((step,i)=>{const e=edgeMap.get(step.edgeId);return `<li class="direction"><span class="direction-index">${i+1}</span><div><strong>${esc(step.label)}</strong><p>${esc(step.instruction)}${e.elevator?' Includes a 1-minute lift allowance.':''}</p></div><span>${step.meters} m</span></li>`;}).join('');
}
function tree(x,y,s=1){return `<g transform="translate(${x} ${y}) scale(${s})"><ellipse cy="5" rx="15" ry="10" fill="#829971" opacity=".08"/><circle r="11" fill="#d3dfc5"/><circle cx="-3" cy="-3" r="7" fill="#dce6ce"/><path d="M0 2v9" stroke="#b7c5a8" stroke-width="1.5"/></g>`;}
function building(x,y,w,h,label){return `<g><rect x="${x+5}" y="${y+7}" width="${w}" height="${h}" rx="5" fill="#ced5c6"/><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5" fill="#e0e3d7" stroke="#cfd6c6" stroke-width="1.5"/><rect x="${x+9}" y="${y+9}" width="${w-18}" height="${h-18}" rx="2" fill="#e6e8de" stroke="#d7dccf"/><path d="M${x+12} ${y+13}h${w-24}" stroke="#f6f7f1" stroke-width="3"/><text x="${x+w/2}" y="${y+h/2+3}" text-anchor="middle" fill="#adb7a3" font-size="8" letter-spacing="1.8">${label}</text></g>`;}
function renderMap(){
 const closed=new Set(closedIds());const route=state.route;const walking=findRoute({from:state.from,to:state.to,profile:'walking',closedEdges:closedIds()});
 const excluded=new Set(explainExclusions(opts()).map(e=>e.edgeId));
 const path=e=>{const a=nodeMap.get(e.from),b=nodeMap.get(e.to);return `M${a.x} ${a.y}L${b.x} ${b.y}`;};
 const trees=[[118,155,1.3],[158,160,1],[200,125,1.2],[265,158,1.2],[347,178,1.4],[385,138,.9],[455,190,1.2],[520,150,.9],[595,140,1.1],[800,325,1],[839,350,.8],[880,280,1.2],[910,220,1.3],[896,158,1.1],[928,475,1],[669,574,1.1],[615,626,1.2],[420,647,.8],[350,602,1.1],[303,515,1],[260,492,.7],[104,415,1.2],[95,352,.8],[145,295,1.3],[398,485,1.2],[540,475,1],[574,540,1.1],[665,370,.9],[692,401,1.2]];
 const landscape = campus.id === 'waterloo'
   ? '<path d="M-20 525C95 490 100 618 198 650S398 646 495 748H-20Z" fill="#e0e8cf"/><path d="M-25 640C60 572 84 595 135 670S265 735 331 699" fill="none" stroke="#cadfd7" stroke-width="19"/>'
   : '<path d="M-25 50C168 -18 254 65 286 161S126 356 -20 304Z" fill="#dce8d3"/><path d="M-35 380C89 360 111 516 193 629S239 733 58 757H-35Z" fill="#e0e9d6"/>';
 const campusBuildings = placeNodes.filter(node => node.id !== campus.origin).map(node => {
   const wide = node.id === campus.destination ? 135 : 96;
   const y = node.id === campus.destination ? node.y + 9 : node.y - 58;
   return building(node.x - wide / 2, y, wide, node.id === campus.destination ? 57 : 47, '');
 }).join('');
 const backdrop = `<defs><pattern id="grain" width="18" height="18" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r=".65" fill="#c8d3be" opacity=".38"/></pattern><filter id="pinshadow" x="-100%" y="-100%" width="300%" height="300%"><feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#28432e" flood-opacity=".12"/></filter></defs><g aria-hidden="true"><rect width="1000" height="720" fill="#edf0e7"/><rect width="1000" height="720" fill="url(#grain)"/>${landscape}<path d="M40 620L110 505 102 166 202 84H950" fill="none" stroke="#e2e7dc" stroke-width="30" stroke-linecap="round"/><path d="M40 620L110 505 102 166 202 84H950" fill="none" stroke="#f7f8f2" stroke-width="20" stroke-linecap="round"/>${trees.map(t => tree(...t)).join('')}${campusBuildings}</g>`;
 const paths=edges.map(e=>`<path d="${path(e)}" fill="none" stroke="${e.surface==='gravel'?'#d6dccd':'#d5ddca'}" stroke-width="${e.stairs?9:14}" stroke-linecap="round"/><path d="${path(e)}" fill="none" stroke="${e.surface==='gravel'?'#e7e8dd':'#fafbf5'}" stroke-width="${e.stairs?6:10}" stroke-linecap="round" ${e.stairs?'stroke-dasharray="2 4"':''}/>`).join('');
 const compare=walking&&route&&walking.edgeIds.join()!==route.edgeIds.join()?walking.edgeIds.map(id=>`<path d="${path(edgeMap.get(id))}" fill="none" stroke="#a6b19f" stroke-width="2" stroke-dasharray="5 6" stroke-linecap="round"/>`).join(''):'';
 const network=state.graph?edges.map(e=>{const a=nodeMap.get(e.from),b=nodeMap.get(e.to);return `<path d="${path(e)}" fill="none" stroke="${excluded.has(e.id)?'#c58e72':'#a1b890'}" stroke-width="2" stroke-dasharray="3 4"/><text x="${(a.x+b.x)/2}" y="${(a.y+b.y)/2-8}" fill="#718762" font-size="8" text-anchor="middle" paint-order="stroke" stroke="#f3f6eb" stroke-width="4">${e.meters} m · ${e.slope}%</text>`;}).join('')+nodes.filter(n=>n.kind==='junction').map(n=>`<circle cx="${n.x}" cy="${n.y}" r="4" fill="#7a946d" stroke="#fff" stroke-width="2"/>`).join(''):'';
 const routePath=route?route.edgeIds.map(id=>`<path d="${path(edgeMap.get(id))}" fill="none" stroke="#e8f2d7" stroke-width="13" stroke-linecap="round"/><path class="route-line" d="${path(edgeMap.get(id))}" fill="none" stroke="#507a52" stroke-width="5" stroke-linecap="round"/>`).join(''):'';
 const barriers=edges.filter(e=>closed.has(e.id)).map(e=>{const a=nodeMap.get(e.from),b=nodeMap.get(e.to),x=(a.x+b.x)/2,y=(a.y+b.y)/2;return `<path d="${path(e)}" fill="none" stroke="#c9886b" stroke-width="4" stroke-dasharray="5 5" stroke-linecap="round"/><g transform="translate(${x} ${y})"><circle r="12" fill="#b97759" stroke="#fff9ed" stroke-width="3"/><path d="M-4-4l8 8m0-8-8 8" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/><title>${esc(e.label)} unavailable</title></g>`;}).join('');
 const facilities = ['library-lift', 'garden-ramp'].filter(id => !closed.has(id)).map(id => {
   const edge = edgeMap.get(id);
   const start = nodeMap.get(edge.from), end = nodeMap.get(edge.to);
   const x = (start.x + end.x) / 2, y = (start.y + end.y) / 2;
   const label = edge.elevator ? 'DEMO LIFT' : `DEMO RAMP · ${edge.slope}%`;
   return `<text x="${x}" y="${y - 15}" class="map-facility-label" text-anchor="middle" aria-hidden="true">${label}</text>`;
 }).join('');
 const markers=placeNodes.map(n=>{const origin=n.id===state.from,dest=n.id===state.to,selected=origin||dest;const yLabel=n.id==='library'?-26:n.id==='science-hall'?31:34;return `<g class="node-marker" data-node="${n.id}" role="button" tabindex="0" aria-label="Set destination to ${esc(n.label)}" transform="translate(${n.x} ${n.y})"><title>${esc(n.label)} — select as destination</title><circle class="marker-focus" r="21" fill="transparent"/><circle r="${selected?15:10}" fill="${dest?'#264c3b':origin?'#fafcf4':'#f9fbf3'}" stroke="${selected?'#305b40':'#c9d5bb'}" stroke-width="${selected?2:1.5}" filter="url(#pinshadow)"/>${dest?'<path d="M-4 0l3 3 6-7" fill="none" stroke="#d4eead" stroke-width="2" stroke-linecap="round"/>':origin?'<circle r="5" fill="#6e9256"/>':'<circle r="2.5" fill="#8ba676"/>'}<text class="map-place-label" text-anchor="middle" y="${yLabel}">${esc(n.shortLabel || n.label)}</text>${selected?`<text class="map-place-small" text-anchor="middle" y="${yLabel+14}">${origin?'START HERE':'YOUR DESTINATION'}</text>`:''}</g>`;}).join('');
 const width=1000/state.zoom,height=720/state.zoom;$('campus-map').setAttribute('viewBox',`${(1000-width)/2} ${(720-height)/2} ${width} ${height}`);
 $('shortest-legend').hidden=!compare;
 $('campus-map').innerHTML=`<title id="map-title">${esc(campus.name)} schematic route map</title><desc id="map-description">${route?`${route.distanceMeters} metre route from ${esc(nodeMap.get(state.from).label)} to ${esc(nodeMap.get(state.to).label)}.`:'No compatible route under current preferences and closures.'} Landmarks are real. Connections, distances, slopes, and closures are simulated.</desc>${backdrop}${paths}${compare}${network}${routePath}${facilities}${barriers}${markers}`;
 $('zoom-in').disabled=state.zoom>=1.8;$('zoom-out').disabled=state.zoom<=.8;
}
function renderBarriers(){
 const previousFocus=rememberFocus();
 const ids=[...new Set(['library-lift','garden-ramp',...closedIds()])];
 $('barrier-list').innerHTML=ids.map(id=>{const e=edgeMap.get(id),r=state.reports.find(r=>r.edgeId===id&&r.expiresAt>Date.now());return `<div class="barrier-row"><div class="barrier-info"><span class="barrier-icon ${r?'closed':''}">${icon(e.elevator?'lift':id==='garden-ramp'?'ramp':'barrier')}</span><div><strong>${esc(e.label)}</strong><p>${r?`${esc(r.reason)} · ${Math.max(1,Math.ceil((r.expiresAt-Date.now())/60000))} min left`:'Available · toggle to simulate a closure'}</p>${r?.note?`<p class="report-detail">${esc(r.note)}</p>`:''}</div></div><button class="toggle" role="switch" aria-checked="${!!r}" aria-label="Close ${esc(e.label)}" data-barrier="${id}"></button></div>`;}).join('');restoreFocus(previousFocus);
}
function openModal(title,content){const wasOpen=$('modal').open;$('modal-eyebrow').textContent=title;$('modal-content').innerHTML=content;if(!wasOpen)$('modal').showModal();else if(!document.activeElement?.closest('#modal'))$('modal-close').focus();injectIcons();}
function renderImpact(){
 const closed=closedIds();const other=placeNodes.filter(n=>n.id!==state.from);const status=other.map(n=>({n,route:findRoute(opts({to:n.id}))}));
 const cards=closed.map(id=>{const repaired=closed.filter(x=>x!==id);const restored=status.filter(s=>!s.route&&findRoute(opts({to:s.n.id,closedEdges:repaired})));const repairedRoute=findRoute(opts({closedEdges:repaired}));const saved=state.route&&repairedRoute?Math.max(0,state.route.distanceMeters-repairedRoute.distanceMeters):0;return {id,restored,saved,repairedRoute};}).sort((a,b)=>b.restored.length-a.restored.length||b.saved-a.saved||(a.repairedRoute?.distanceMeters ?? Infinity)-(b.repairedRoute?.distanceMeters ?? Infinity));
 openModal('COUNTERFACTUAL / REPAIR IMPACT',`<h2>Which repair restores access?</h2><p>${esc(campus.name)} · From ${esc(nodeMap.get(state.from).label)}. Each result restores one simulated connection and keeps your travel preferences.</p><div class="reachability-list">${status.map(s=>`<div class="reachability-item ${s.route?'':'off'}">${s.route?'✓':'×'} ${esc(s.n.label)}${s.route?'':' · unavailable'}</div>`).join('')}</div>${cards.length?cards.map(c=>`<div class="repair-card"><h3>Restore ${esc(edgeMap.get(c.id).label)}</h3><p>${c.restored.length?`Reopens ${c.restored.length} destination${c.restored.length>1?'s':''}: ${c.restored.map(s=>esc(s.n.label)).join(', ')}.`:'No additional destinations become reachable.'} ${c.saved?`Saves ${c.saved} m on your selected journey.`:c.repairedRoute&&!state.route?`Restores your selected journey: ${c.repairedRoute.distanceMeters} m.`:''}</p><button class="primary-button" data-repair="${c.id}">Restore this connection ↗</button></div>`).join(''):'<div class="repair-card"><h3>Every connection is available.</h3><p>Simulate a lift and ramp closure to compare their effect on campus access.</p><button class="primary-button" id="impact-simulate">Simulate both closures</button></div>'}<p>Repair impact describes this illustrative network only. It does not verify real-world accessibility.</p>`);
}
function renderDemo() {
  const previousFocus = rememberFocus();
  const banner = $('demo-banner');
  banner.hidden = !state.demo;
  if (!state.demo) return;
  const destination = esc(nodeMap.get(campus.destination).label);
  const steps = [null,
    { title: `${campus.shortName} · 1 of 4 · Step-free route`,
      text: `The model finds a ${state.route?.distanceMeters ?? '—'} m route to ${destination}. Simulate a lift closure to see the detour.`, button: 'Break the lift' },
    { title: `${campus.shortName} · 2 of 4 · Lift closed`,
      text: `The model reroutes to ${destination} via the ramp (${state.route?.distanceMeters ?? '—'} m). Now close the alternative.`, button: 'Close the ramp too' },
    { title: `${campus.shortName} · 3 of 4 · No compatible route`,
      text: `Both step-free connections to ${destination} are closed in the simulation. Compare what each repair restores.`, button: 'See repair impact' },
    { title: `${campus.shortName} · 4 of 4 · Repair impact`,
      text: `Restore a connection to see how it changes access to ${destination}.`, button: 'Finish demo' },
  ];
  const step = steps[state.demo];
  banner.innerHTML = `<div><strong>${step.title}</strong><p>${step.text}</p></div><div><button class="text-button" id="demo-exit">Exit demo</button><button class="primary-button" id="demo-next">${step.button} →</button></div>`;
  restoreFocus(previousFocus);
}

function resetJourney() {
  applyRouteParams(new URLSearchParams());
  state.reports = [];
  saveReports();
  state.zoom = 1;
}
function startDemo() {
  resetJourney();
  state.demo = 1;
  state.view = 'demo';
  render();
  replaceRouteFragment(routeParams());
  $('demo-banner').scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('demo-next').focus({ preventScroll: true });
}
function reset() {
  resetJourney();
  state.demo = 0;
  state.graph = false;
  replaceRouteFragment(new URLSearchParams({campus: campus.id, view: state.view}));
  render();
  toast(`${campus.shortName} demo reset.`);
}
$('origin').addEventListener('change',e=>{state.from=e.target.value;state.demo=0;render();});$('destination').addEventListener('change',e=>{state.to=e.target.value;state.demo=0;render();});
$('swap').addEventListener('click',()=>{[state.from,state.to]=[state.to,state.from];state.demo=0;render();});
for(const b of document.querySelectorAll('[data-profile]'))b.addEventListener('click',()=>{state.demo=0;setProfile(b.dataset.profile);});
$('slope').addEventListener('input',e=>{state.maxSlope=Number(e.target.value);state.demo=0;render();});$('avoid-rough').addEventListener('change',e=>{state.avoidRough=e.target.checked;state.demo=0;render();});
$('graph-button').addEventListener('click',()=>{state.graph=!state.graph;render();});
$('zoom-in').addEventListener('click',()=>{state.zoom=Math.min(1.8,+(state.zoom+.2).toFixed(1));renderMap();});$('zoom-out').addEventListener('click',()=>{state.zoom=Math.max(.8,+(state.zoom-.2).toFixed(1));renderMap();});$('zoom-reset').addEventListener('click',()=>{state.zoom=1;renderMap();});
function selectMapNode(e){const marker=e.target.closest('[data-node]');if(!marker)return;state.to=marker.dataset.node;state.demo=0;render();toast(`Destination: ${nodeMap.get(state.to).label}`);}
$('campus-map').addEventListener('click',selectMapNode);$('campus-map').addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selectMapNode(e);}});
$('barrier-list').addEventListener('click',e=>{const b=e.target.closest('[data-barrier]');if(b){state.demo=0;closeEdge(b.dataset.barrier,!closedIds().includes(b.dataset.barrier));}});
$('demo-button').addEventListener('click',startDemo);$('demo-banner').addEventListener('click',e=>{if(e.target.closest('#demo-exit')){state.demo=0;renderDemo();}if(e.target.closest('#demo-next')){if(state.demo===1){state.demo=2;closeEdge('library-lift');}else if(state.demo===2){state.demo=3;closeEdge('garden-ramp');}else if(state.demo===3){state.demo=4;renderDemo();renderImpact();}else reset();}});
$('impact-button').addEventListener('click',renderImpact);$('modal-close').addEventListener('click',()=>$('modal').close());$('modal').addEventListener('click',e=>{if(e.target===$('modal')){const r=$('modal').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)$('modal').close();}});
$('modal-content').addEventListener('click',e=>{const repair=e.target.closest('[data-repair]');if(repair){closeEdge(repair.dataset.repair,false);renderImpact();toast('Connection restored. Route recalculated.');}if(e.target.closest('#impact-simulate')){state.reports=state.reports.filter(r=>!['library-lift','garden-ramp'].includes(r.edgeId));state.reports.push(...['library-lift','garden-ramp'].map(edgeId=>({edgeId,reason:'Unavailable in demo',note:'',expiresAt:Date.now()+3600000})));saveReports();render();renderImpact();}});
$('reset-button').addEventListener('click',reset);
$('brand-home').addEventListener('click',e=>{e.preventDefault();reset();window.scrollTo({top:0,behavior:'smooth'});});
$('report-button').addEventListener('click',()=>{openModal('COMMUNITY / LOCAL REPORT',`<h2>Make a barrier visible.</h2><p>This prototype stores reports on your device. Nothing is submitted to campus staff.</p><form class="report-form" id="report-form"><label for="report-edge">Affected connection</label><select id="report-edge" required>${edges.map(e=>`<option value="${e.id}">${esc(e.label)}</option>`).join('')}</select><label for="report-reason">What’s happening?</label><select id="report-reason"><option>Out of service</option><option>Construction or obstruction</option><option>Ice or slippery surface</option><option>Locked access</option><option>Other barrier</option></select><label for="report-note">Details (optional)</label><textarea id="report-note" maxlength="240" placeholder="Describe the barrier. Don’t include personal information."></textarea><button class="primary-button" type="submit">Mark unavailable for 1 hour →</button></form>`);$('report-form').addEventListener('submit',e=>{e.preventDefault();state.demo=0;closeEdge($('report-edge').value,true,$('report-reason').value,$('report-note').value.trim());$('modal').close();toast('Barrier saved on this device. Route updated.');});});
$('about-button').addEventListener('click',()=>{openModal('ONHACKS 2026 / THE BUILD',`<h2>Access isn’t static.<br>Your map shouldn’t be.</h2><p>Wayfound finds routes that respect mobility needs, adapts when connections close, and estimates which repair would restore access.</p><h3>How it works</h3><ul><li>A graph of ${nodes.length} locations and ${edges.length} bidirectional connections.</li><li>Constraints remove stairs, unsuitable slopes, uneven surfaces, and reported closures.</li><li>Dijkstra’s algorithm finds the shortest compatible distance.</li><li>Repair impact restores one closed edge at a time and recalculates reachability.</li></ul><h3>Maps and room references</h3><p>The route editor calculates walks on mapped OpenStreetMap paths with draggable pins and stops. Room numbers link to campus publications, and Google Maps is available as a separate reference. The step-free closure simulation uses a separate modeled graph.</p><h3>About the simulation</h3><p>${esc(campus.referenceNote)} Travel times use a fixed speed and a one-minute allowance per lift. Reports expire locally after one hour.</p><h3>Campus references</h3><ul>${campus.sources.map(source => `<li><a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">${esc(source.label)} ↗</a></li>`).join('')}</ul><p>For current campus access information, use the university’s official resources.</p><h3>Built with AI assistance</h3><p>OpenAI Codex assisted with research, design, implementation, tests, debugging, and pitch preparation. Routing uses deterministic graph logic, not AI predictions. Accessibility assumptions still need validation with people who use mobility aids.</p>`);});
$('share-button').addEventListener('click',async()=>{const p=routeParams();const url=`${location.href.split('#')[0]}#${p}`;try{history.replaceState(null,'',`#${p}`);}catch{}if(location.protocol==='file:'){openModal('SHARE / OFFLINE COPY','<h2>You’re using the offline copy.</h2><p>Send this HTML file to share the app. Use the hosted version to copy a web link. Reports remain on the device that created them.</p>');return;}try{await navigator.clipboard.writeText(url);toast('Route link copied. Local closure reports are not included.');}catch{openModal('SHARE / ROUTE LINK',`<h2>Your way, shared.</h2><p>The link includes the campus, endpoints, and travel preferences. Local reports are not shared. The hosted site may require owner sign-in.</p><input class="copy-field" aria-label="Route link" readonly value="${esc(url)}">`);$('modal-content').querySelector('input').select();}});
$('download-button').addEventListener('click',()=>{if(!state.route)return;const r=state.route;const text=['WAYFOUND — YOUR ROUTE', campus.name,`${nodeMap.get(state.from).label} → ${nodeMap.get(state.to).label}`,`Profile: ${profiles[state.profile].label} | slope limit: ${state.maxSlope}% | avoid uneven: ${state.avoidRough?'yes':'no'}`,`${r.distanceMeters} m | ${r.durationMinutes} minutes estimated`,'','SIMULATED ROUTE — USE OFFICIAL CAMPUS DIRECTIONS IN PERSON','',...r.steps.map((s,i)=>`${i+1}. ${s.instruction}`),'',`Local closures at export: ${closedIds().map(id=>edgeMap.get(id).label).join(', ')||'none'}`,'Times and distances are illustrative. Conditions may change.'].join('\n');const url=URL.createObjectURL(new Blob([text],{type:'text/plain'}));const a=document.createElement('a');a.href=url;a.download='wayfound-route.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Route directions downloaded.');});
window.addEventListener('hashchange', () => {
  const params = new URLSearchParams(location.hash.slice(1));
  if (!params.has('campus') && !params.has('from') && !params.has('to') && !params.has('profile') && !params.has('view')) return;
  const campusId = params.get('campus');
  if (validCampus(campusId) && campusId !== campus.id) {
    loadCampus(campusId);
    state.reports = readReports();
    state.zoom = 1;
    renderCampus();
  }
  applyRouteParams(params);
  state.view = routeViewFrom(params);
  state.demo = 0;
  render();
});
setInterval(()=>{const valid=state.reports.filter(r=>r.expiresAt>Date.now());if(valid.length!==state.reports.length){state.reports=valid;saveReports();render();toast('An old report expired. Routes updated.');}else renderBarriers();},30000);
render();
