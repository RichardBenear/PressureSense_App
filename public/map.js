// PressureSense remote zone-map viewer (read-only).
//
// Everything the local MAP page does over SSE (/events) + HTTP poll
// (/manual-zones) is funneled here through the SAME WebSocket the CHART and
// SCHEDULE pages use. Message shapes match the Master's build*Json()
// functions:
//   sensorUpdate      -> scheduled zone + live psi (Master buildSensorUpdateJson)
//   manualZoneStatus  -> active manual runs        (Master buildManualZoneRunsJson)
//
// This page sends no outbound commands -- it's strictly read-only, unlike
// dashboard.js/schedule.js. Everything below normalizeZone() through
// bindMapControls() is a verbatim port of the local MAP page's map.js (SVG
// prep, highlighting, gap-connector stitching, zoom/pan/view-mode) -- none
// of it touches the data feed, so none of it needed to change.

const BASE_URL = '';
const MAP_URL = BASE_URL + '/sprinklers_map.svg';
const MAPPING_URL = BASE_URL + '/zone_mappings.txt';
const QS_NS = 'http://qcad.org/namespaces/svg';
const ACTIVE_HIGHLIGHT_COLOR = '#ff2d55';
const YARD_VIEW_Y_OFFSET_RATIO = 0.02;
const YARD_VIEW_HEIGHT_RATIO = 1.15; // multiplier on the yard view box height; raise above 1 if the top/bottom are truncated
const FULL_VIEW_Y_SHIFT = 0.6;

const state = {
  svg: null,
  drawingRoot: null,
  highlightLayer: null,
  mappings: new Map(),
  coverage: [],
  connectors: [],
  fullViewBox: null,
  yardViewBox: null,
  viewMode: 'full',
  activeController: '',
  lastAutoController: null,
  view: { scale: 1, x: 0, y: 0 },
  drag: null,
  scheduledZone: {},
  manualZones: [],
  lastPsi: null
};

let ws = null;
let reconnectTimer = null;

function $(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value === undefined || value === null || value === '' ? '-' : value;
}

// Already falls back from znumber/zname/avgpsi to zoneNumber/zoneName/
// zoneAvgPsi -- exactly the relay's flat sensorUpdate field names -- so this
// can be handed the raw WS message directly, no renaming adapter needed.
function normalizeZone(zone) {
  if (typeof zone === 'string') {
    try { zone = JSON.parse(zone); } catch (e) { zone = {}; }
  }
  zone = zone || {};
  const pick = (primary, fallback) => primary !== undefined && primary !== null ? primary : fallback;
  return {
    znumber: Number(pick(zone.znumber, pick(zone.zoneNumber, 0))) || 0,
    zname: pick(zone.zname, pick(zone.zoneName, '')),
    controller: String(pick(zone.controller, '')).trim().toLowerCase(),
    start: pick(zone.start, ''),
    run: pick(zone.run, ''),
    avgpsi: pick(zone.avgpsi, pick(zone.zoneAvgPsi, ''))
  };
}

function normalizeColor(color) {
  return String(color || '').trim().toLowerCase();
}

function dimColor(color) {
  const hex = normalizeColor(color);
  const match = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/);
  if (!match) return '#1f2933';

  const r = Math.round(parseInt(match[1], 16) * 0.36);
  const g = Math.round(parseInt(match[2], 16) * 0.36);
  const b = Math.round(parseInt(match[3], 16) * 0.36);
  return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

function normalizeController(controller) {
  const value = String(controller || '').trim().toLowerCase();
  if (value.includes('field')) return 'field';
  if (value.includes('yard')) return 'yard';
  return value;
}

function parseTimeMinutes(timeStr) {
  const match = String(timeStr || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function formatRemaining(seconds) {
  seconds = Math.max(0, Number(seconds) || 0);
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return String(min).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}

function getZoneTimeRemaining(zone) {
  if (!zone.znumber || !zone.controller) return '-';

  const startMin = parseTimeMinutes(zone.start);
  const runMin = Math.max(0, Number(zone.run) || 0);
  if (startMin === null || runMin <= 0) return '-';

  const now = new Date();
  const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  const remainingSec = Math.max(0, (startMin + runMin) * 60 - nowSec);
  return formatRemaining(remainingSec);
}

function zoneKey(controller, zoneNumber) {
  return `${normalizeController(controller)}:${Number(zoneNumber) || 0}`;
}

function parseMappings(text) {
  const mappings = new Map();
  let currentCategory = '';

  text.split(/\r?\n/).forEach(rawLine => {
    const line = rawLine.trim();
    if (!line) return;

    if (/^yard coverage layer$/i.test(line)) {
      currentCategory = 'yard';
      return;
    }
    if (/^field coverage layer$/i.test(line)) {
      currentCategory = 'field';
      return;
    }

    const match = line.match(/^([a-z0-9_]+)\s*-\s*(yard|field)(?:\s+zone)?\s+(\d+)\s*-\s*(.+)$/i);
    if (!match || !currentCategory) return;

    const layerName = match[1].trim().toLowerCase();
    const controller = normalizeController(match[2]);
    const zoneNumber = Number(match[3]);
    const label = match[4].replace(/\s*-\s*[^-]+$/, '').trim();
    const key = zoneKey(controller, zoneNumber);
    const entry = mappings.get(key) || {
      controller,
      zoneNumber,
      category: currentCategory,
      layers: new Set(),
      labels: []
    };

    entry.layers.add(layerName);
    if (label) entry.labels.push(label);
    mappings.set(key, entry);
  });

  return mappings;
}

function getLayerName(el) {
  return el.getAttribute('qs:layer') ||
         el.getAttributeNS(QS_NS, 'layer') ||
         el.getAttribute('layer') ||
         '';
}

function getStrokeColor(el) {
  const attrStroke = el.getAttribute('stroke');
  if (attrStroke && attrStroke !== 'none') return normalizeColor(attrStroke);

  const style = el.getAttribute('style') || '';
  const strokeMatch = style.match(/(?:^|;)\s*stroke\s*:\s*(#[0-9a-f]{6})/i);
  if (strokeMatch) return normalizeColor(strokeMatch[1]);

  // Some pre-filled shapes (e.g. f_cov_9's rectangle) carry their color in
  // fill instead of stroke, with stroke:none explicitly set.
  const attrFill = el.getAttribute('fill');
  if (attrFill && attrFill !== 'none') return normalizeColor(attrFill);

  const fillMatch = style.match(/(?:^|;)\s*fill\s*:\s*(#[0-9a-f]{6})/i);
  return fillMatch ? normalizeColor(fillMatch[1]) : '';
}

function getCoverageCategory(rawLayer) {
  const value = String(rawLayer || '').trim().toLowerCase();
  if (value.startsWith('yd_cov') || value === 'yard coverage') return 'yard';
  if (value.startsWith('f_cov') || value === 'field coverage') return 'field';
  return '';
}

function indexCoverageElements() {
  if (!state.svg) return;
  const shapeSelector = 'path,circle,ellipse,line,polyline,polygon,rect';
  const shapes = Array.from(state.svg.querySelectorAll(shapeSelector)).map(el => {
    const rawLayer = getLayerName(el);
    return {
      el,
      tag: el.tagName.toLowerCase(),
      layerName: String(rawLayer || '').trim().toLowerCase(),
      category: getCoverageCategory(rawLayer),
      color: getStrokeColor(el)
    };
  }).filter(item => item.color);

  // Coverage shapes (paths/circles/etc., however the curve is drawn -- a true
  // arc command or a flattened polyline, doesn't matter) vs. the straight
  // <line> segments that close their boundary back to the shape's start.
  const covered = shapes.filter(item => item.category);
  state.coverage = covered.filter(item => item.tag !== 'line');
  state.connectors = covered.filter(item => item.tag === 'line');
}

function retintDarkMapLinework() {
  if (!state.svg) return;
  const shapeSelector = 'path,circle,ellipse,line,polyline,polygon,rect';
  Array.from(state.svg.querySelectorAll(shapeSelector)).forEach(el => {
    if (getStrokeColor(el) !== '#000000') return;

    const style = el.getAttribute('style') || '';
    if (style.includes('stroke:#000000')) {
      el.setAttribute('style', style.replace(/stroke:#000000/gi, 'stroke:#d7e2ea'));
    } else {
      el.setAttribute('stroke', '#d7e2ea');
    }
  });
}

function makeHighlightLayer() {
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('id', 'map-highlight-layer');
  g.setAttribute('pointer-events', 'none');
  state.drawingRoot.appendChild(g);
  state.highlightLayer = g;
}

function prepareSvg(svgText) {
  const host = $('map-svg-host');
  host.innerHTML = svgText;
  state.svg = host.querySelector('svg');
  state.drawingRoot = state.svg.querySelector('g[transform]') || state.svg;
  state.fullViewBox = readSvgViewBox();
  if (state.fullViewBox) state.fullViewBox[1] += FULL_VIEW_Y_SHIFT;
  state.yardViewBox = getYardViewBox();
  state.svg.removeAttribute('width');
  state.svg.removeAttribute('height');
  state.svg.style.backgroundColor = '#11181d';
  state.svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  insertMapBackground();
  makeHighlightLayer();
  indexCoverageElements();
  retintDarkMapLinework();
  applyMapViewMode('full', false);
  applyMapTransform();
}

function readSvgViewBox() {
  const viewBox = String(state.svg.getAttribute('viewBox') || '').trim().split(/\s+/).map(Number);
  if (viewBox.length !== 4 || viewBox.some(Number.isNaN)) return null;
  return viewBox;
}

function viewBoxToString(viewBox) {
  return viewBox.map(value => Number(value).toFixed(4).replace(/\.?0+$/, '')).join(' ');
}

function getYardViewBox() {
  if (!state.fullViewBox) return null;
  const [x, y, width, height] = state.fullViewBox;
  const yardHeight = (height / 2) * YARD_VIEW_HEIGHT_RATIO;
  return [x, y + yardHeight * YARD_VIEW_Y_OFFSET_RATIO, width / 2, yardHeight];
}

function insertMapBackground() {
  const viewBox = state.fullViewBox;
  if (!viewBox) return;

  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('x', viewBox[0]);
  bg.setAttribute('y', viewBox[1]);
  bg.setAttribute('width', viewBox[2]);
  bg.setAttribute('height', viewBox[3]);
  bg.setAttribute('fill', '#11181d');
  bg.setAttribute('stroke', 'none');
  bg.setAttribute('pointer-events', 'none');
  state.svg.insertBefore(bg, state.svg.firstChild);
}

function getSvgPoint(el, x, y) {
  if (state.svg.createSVGPoint) {
    const p = state.svg.createSVGPoint();
    p.x = x;
    p.y = y;
    try {
      return p.matrixTransform(el.getCTM());
    } catch (e) {
      return { x, y };
    }
  }
  return { x, y };
}

function getEndpointPairs(el) {
  const tag = el.tagName.toLowerCase();
  try {
    if (typeof el.getTotalLength === 'function' && tag !== 'circle' && tag !== 'ellipse' && tag !== 'rect' && tag !== 'polygon') {
      const len = el.getTotalLength();
      if (len <= 0) return [];
      return [
        { point: el.getPointAtLength(0), source: el },
        { point: el.getPointAtLength(len), source: el }
      ];
    }
  } catch (e) {
    return [];
  }

  if (tag === 'line') {
    return [
      { point: getSvgPoint(el, Number(el.getAttribute('x1')), Number(el.getAttribute('y1'))), source: el },
      { point: getSvgPoint(el, Number(el.getAttribute('x2')), Number(el.getAttribute('y2'))), source: el }
    ];
  }

  return [];
}

function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// Walk from an arc's end point through the zone's connector segments (the
// new map's explicit straight-line boundary pieces), matching nearby
// endpoints the same way addGapConnectors() does, until back at the arc's
// start point. Returns a closed `d` string tracing the real boundary, or
// null if the chain doesn't close (caller falls back to the old synthetic
// chord).
function buildEnclosedArcD(arcEl, connectorEls) {
  if (typeof arcEl.getTotalLength !== 'function') return null;
  const totalLength = arcEl.getTotalLength();
  if (!(totalLength > 0)) return null;

  const startPoint = arcEl.getPointAtLength(0);
  const endPoint = arcEl.getPointAtLength(totalLength);
  const d = String(arcEl.getAttribute('d') || '').trim();
  const tolerance = 0.22;

  const segments = connectorEls
    .map(el => getEndpointPairs(el).map(p => p.point))
    .filter(points => points.length === 2);

  const used = new Set();
  const chainPoints = [];
  let cursor = endPoint;
  let guard = segments.length + 1;

  while (guard-- > 0 && distance(cursor, startPoint) > tolerance) {
    let bestIdx = -1, bestPoint = null, bestDist = Infinity;
    segments.forEach((points, i) => {
      if (used.has(i)) return;
      points.forEach((p, pi) => {
        const dist = distance(cursor, p);
        if (dist <= tolerance && dist < bestDist) { bestDist = dist; bestIdx = i; bestPoint = points[1 - pi]; }
      });
    });
    if (bestIdx < 0) return null;
    used.add(bestIdx);
    chainPoints.push(bestPoint);
    cursor = bestPoint;
  }

  const lineCommands = chainPoints.map(p => `L${p.x},${p.y}`).join(' ');
  return lineCommands ? `${d} ${lineCommands} Z` : `${d} Z`;
}

function addGapConnectors(elements, color) {
  const endpoints = elements.flatMap(el => getEndpointPairs(el));
  const used = new Set();
  const connectors = [];
  const threshold = 0.22;

  endpoints.forEach((endpoint, i) => {
    if (used.has(i)) return;
    let best = null;
    endpoints.forEach((candidate, j) => {
      if (i === j || used.has(j) || endpoint.source === candidate.source) return;
      const d = distance(endpoint.point, candidate.point);
      if (d > 0.001 && d <= threshold && (!best || d < best.d)) best = { index: j, d };
    });
    if (!best) return;
    used.add(i);
    used.add(best.index);
    connectors.push([endpoint.point, endpoints[best.index].point]);
  });

  connectors.forEach(([a, b]) => {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', a.x);
    line.setAttribute('y1', a.y);
    line.setAttribute('x2', b.x);
    line.setAttribute('y2', b.y);
    line.setAttribute('class', 'ag-map-connector');
    line.setAttribute('stroke', color);
    state.highlightLayer.appendChild(line);
  });
}

function makeActiveFillClone(el, fillColor, overrideD) {
  const tag = el.tagName.toLowerCase();
  const clone = el.cloneNode(true);
  clone.removeAttribute('style');
  clone.setAttribute('class', 'ag-map-active-fill');
  clone.setAttribute('fill', tag === 'line' || tag === 'polyline' ? 'none' : fillColor);
  clone.setAttribute('stroke', fillColor);
  clone.setAttribute('stroke-width', tag === 'path' ? '0.035' : '0.03');
  clone.setAttribute('opacity', '0.72');
  clone.setAttribute('vector-effect', 'non-scaling-stroke');

  if (tag === 'path' && typeof el.getTotalLength === 'function') {
    try {
      if (overrideD) {
        clone.setAttribute('d', overrideD);
        clone.setAttribute('fill', fillColor);
      } else {
        const length = el.getTotalLength();
        if (length > 0) {
          const start = el.getPointAtLength(0);
          const d = String(el.getAttribute('d') || '').trim();
          clone.setAttribute('d', `${d} L${start.x},${start.y} Z`);
          clone.setAttribute('fill', fillColor);
        }
      }
    } catch (e) {
      clone.setAttribute('fill', 'none');
      clone.setAttribute('stroke-width', '0.22');
    }
  }

  return clone;
}

function clearHighlights() {
  if (state.highlightLayer) state.highlightLayer.replaceChildren();
  setText('footer-highlight-count', '0');
}

function highlightZones(zones) {
  clearHighlights();

  const uniqueZones = new Map();
  zones.forEach(zone => {
    if (!zone || !zone.znumber || !zone.controller) return;
    uniqueZones.set(zoneKey(zone.controller, zone.znumber), zone);
  });

  if (!uniqueZones.size) return;

  let totalCount = 0;
  const statusParts = [];

  uniqueZones.forEach(zone => {
    const mapping = state.mappings.get(zoneKey(zone.controller, zone.znumber));
    if (!mapping) {
      statusParts.push(`NO MAP ${normalizeController(zone.controller).toUpperCase()} ${zone.znumber}`);
      return;
    }

    const activeElements = state.coverage
      .filter(item => item.category === mapping.category && mapping.layers.has(item.layerName))
      .map(item => item);
    const activeConnectors = state.connectors
      .filter(item => item.category === mapping.category && mapping.layers.has(item.layerName))
      .map(item => item.el);

    activeElements.forEach(item => {
      const el = item.el;
      const activeFill = dimColor(item.color);
      const overrideD = el.tagName.toLowerCase() === 'path' ? buildEnclosedArcD(el, activeConnectors) : null;
      const fillClone = makeActiveFillClone(el, activeFill, overrideD);
      state.highlightLayer.appendChild(fillClone);

      const outlineClone = el.cloneNode(true);
      outlineClone.removeAttribute('style');
      outlineClone.setAttribute('class', 'ag-map-highlight');
      outlineClone.setAttribute('stroke', ACTIVE_HIGHLIGHT_COLOR);
      outlineClone.setAttribute('stroke-width', '0.11');
      outlineClone.setAttribute('fill', 'none');
      outlineClone.setAttribute('vector-effect', 'non-scaling-stroke');
      state.highlightLayer.appendChild(outlineClone);
    });

    addGapConnectors(activeElements.map(item => item.el), ACTIVE_HIGHLIGHT_COLOR);
    totalCount += activeElements.length;
    statusParts.push(activeElements.length ? `${mapping.controller.toUpperCase()} ${mapping.zoneNumber}` : `NO SHAPES ${mapping.controller.toUpperCase()} ${mapping.zoneNumber}`);
  });

  setText('footer-highlight-count', String(totalCount));
  setText('footer-map-status', statusParts.join(' + '));
}

function refreshMapHighlights() {
  highlightZones([state.scheduledZone, ...state.manualZones]);
}

function updateMapInfo(zone, psi) {
  const isActive = zone.znumber > 0 && zone.controller;
  const zoneLabel = isActive ? `ZONE ${zone.znumber}` : 'OFF';
  const controller = isActive ? zone.controller.toUpperCase() : '-';
  const run = zone.run ? `${zone.run} m` : '-';
  const pressure = Number.isFinite(Number(psi)) ? `${Math.round(Number(psi))} PSI` : '-';
  const remaining = isActive ? getZoneTimeRemaining(zone) : '-';

  setText('map-active-zone', zoneLabel);
  setText('map-controller', controller);
  setText('map-zone-name', isActive ? (zone.zname || zoneLabel).toUpperCase() : 'OFF');
  setText('map-zone-start', isActive ? zone.start : '-');
  setText('map-zone-run', isActive ? run : '-');
  setText('map-zone-remaining', remaining);
  setText('map-pressure', pressure);
  setText('last-read', new Date().toLocaleTimeString());
}

// Single render call used by both the sensorUpdate handler (scheduled zone)
// and the manualZoneStatus handler (manual run) so the two don't fight each
// other. Manual runs take priority -- they're shown with remainingSec from
// the firmware (refreshed every time Master broadcasts) and PSI from the
// last sensorUpdate reading. Scheduled zone resumes display once all manual
// runs have ended.
function renderActiveZone() {
  const run = state.manualZones.find(r => r.znumber > 0);
  if (run) {
    const mapping = state.mappings.get(zoneKey(run.controller, run.znumber));
    const zoneName = mapping ? (mapping.labels[mapping.labels.length - 1] || '').toUpperCase()
                             : `ZONE ${run.znumber}`;
    const pressure = Number.isFinite(Number(state.lastPsi))
      ? `${Math.round(Number(state.lastPsi))} PSI` : '-';
    setText('map-active-zone', `ZONE ${run.znumber}`);
    setText('map-controller', run.controller.toUpperCase());
    setText('map-zone-name', zoneName);
    setText('map-zone-start', 'MANUAL');
    setText('map-zone-run', run.totalRunMinutes ? `${run.totalRunMinutes} m` : '-');
    setText('map-zone-remaining', run.remainingSec != null ? formatRemaining(run.remainingSec) : '-');
    setText('map-pressure', pressure);
    setText('last-read', new Date().toLocaleTimeString());
  } else {
    updateMapInfo(state.scheduledZone, state.lastPsi);
  }
}

function updateViewButtons() {
  const fullBtn = $('map-view-full');
  const yardBtn = $('map-view-yard');
  if (fullBtn) fullBtn.classList.toggle('active', state.viewMode === 'full');
  if (yardBtn) yardBtn.classList.toggle('active', state.viewMode === 'yard');
}

function applyMapViewMode(mode, resetTransform = true) {
  if (!state.svg) return;

  const nextMode = mode === 'yard' && state.yardViewBox ? 'yard' : 'full';
  const viewBox = nextMode === 'yard' ? state.yardViewBox : state.fullViewBox;
  if (viewBox) state.svg.setAttribute('viewBox', viewBoxToString(viewBox));

  state.viewMode = nextMode;
  updateViewButtons();
  if (resetTransform) resetMap();
}

function selectMapView(mode) {
  applyMapViewMode(mode);
}

function applyControllerDefaultView(controller) {
  const normalized = normalizeController(controller);
  state.activeController = normalized;

  if (normalized === state.lastAutoController) return;
  state.lastAutoController = normalized;
  applyMapViewMode(normalized === 'yard' ? 'yard' : 'full');
}

function applyMapTransform() {
  if (!state.svg) return;
  state.svg.style.transform = `translate(${state.view.x}px, ${state.view.y}px) scale(${state.view.scale})`;
}

function zoomMap(multiplier) {
  state.view.scale = Math.max(0.4, Math.min(6, state.view.scale * multiplier));
  applyMapTransform();
}

function resetMap() {
  state.view = { scale: 1, x: 0, y: 0 };
  applyMapTransform();
}

function bindMapControls() {
  $('map-zoom-in').addEventListener('click', () => zoomMap(1.2));
  $('map-zoom-out').addEventListener('click', () => zoomMap(1 / 1.2));
  $('map-reset').addEventListener('click', resetMap);
  $('map-view-full').addEventListener('click', () => selectMapView('full'));
  $('map-view-yard').addEventListener('click', () => selectMapView('yard'));

  const stage = $('map-stage');
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    zoomMap(e.deltaY < 0 ? 1.08 : 1 / 1.08);
  }, { passive: false });

  stage.addEventListener('pointerdown', e => {
    state.drag = { x: e.clientX, y: e.clientY, viewX: state.view.x, viewY: state.view.y };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', e => {
    if (!state.drag) return;
    state.view.x = state.drag.viewX + e.clientX - state.drag.x;
    state.view.y = state.drag.viewY + e.clientY - state.drag.y;
    applyMapTransform();
  });
  stage.addEventListener('pointerup', () => { state.drag = null; });
  stage.addEventListener('pointercancel', () => { state.drag = null; });
}

async function loadMapAssets() {
  const [mappingRes, mapRes] = await Promise.all([fetch(MAPPING_URL), fetch(MAP_URL)]);
  if (!mappingRes.ok) throw new Error(`Mapping HTTP ${mappingRes.status}`);
  if (!mapRes.ok) throw new Error(`Map HTTP ${mapRes.status}`);

  state.mappings = parseMappings(await mappingRes.text());
  prepareSvg(await mapRes.text());
  setText('footer-map-status', `${state.mappings.size} ZONES`);
}

// ---------- WebSocket ----------
// Replaces the local MAP page's SSE (/events) + 5s HTTP poll (/manual-zones)
// with the one shared WebSocket the CHART/SCHEDULE pages already use. Both
// sensorUpdate and manualZoneStatus are broadcast proactively by Master on
// every sensor cycle / manual-zone change, so this page just needs to stay
// connected -- no initial-sync request or retry needed (unlike getSchedule).
function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + '/ws');

  ws.addEventListener('open', () => {
    setText('system-status', 'ONLINE');
    document.querySelector('.ag-status-dot').classList.remove('offline');
  });

  ws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    switch (m.type) {
      case 'sensorUpdate': {
        const zone = normalizeZone(m);
        state.scheduledZone = zone;
        state.lastPsi = m.psi;
        renderActiveZone();
        applyControllerDefaultView(zone.znumber > 0 ? zone.controller : '');
        refreshMapHighlights();
        break;
      }
      case 'manualZoneStatus': {
        // Field-for-field identical to Master's buildManualZoneRunsJson()
        // output that the local MAP page's pollManualZones() already mapped
        // from -- only the transport (WS push vs. HTTP poll) changed.
        const runs = Array.isArray(m.runs) ? m.runs : [];
        state.manualZones = runs.map(r => ({
          znumber: Number(r.relay) || 0,
          controller: String(r.controller || '').trim().toLowerCase(),
          remainingSec: Number(r.remainingSec) || 0,
          totalRunMinutes: Number(r.totalRunMinutes) || 0,
          programLetter: String(r.programLetter || '').trim()
        }));
        refreshMapHighlights();
        renderActiveZone();
        break;
      }
      default:
        break; // schedule / schedulesEnabled / history / ack -- ignored here
    }
  });

  ws.addEventListener('close', () => {
    setText('system-status', 'OFFLINE');
    document.querySelector('.ag-status-dot').classList.add('offline');
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 3000);
  });

  ws.addEventListener('error', () => { try { ws.close(); } catch (_) {} });
}

// ---------- wire up ----------
document.addEventListener('DOMContentLoaded', async () => {
  bindMapControls();
  try {
    await loadMapAssets();
    connect();
  } catch (e) {
    console.error('map load:', e);
    setText('system-status', 'MAP ERROR');
    setText('footer-map-status', 'ERROR');
    const loading = $('map-loading');
    if (loading) loading.textContent = 'MAP ERROR';
  }

  document.getElementById('logout-link').addEventListener('click', async (e) => {
    e.preventDefault();
    try { await fetch('/logout', { method: 'POST' }); } catch (_) {}
    window.location.href = '/login.html';
  });
});
