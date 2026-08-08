// PressureSense remote dashboard driver.
//
// Everything the local CHART page does over SSE (/events) + HTTP POST/GET is
// funneled here through ONE WebSocket to the relay Worker. Message shapes match
// the Master's build*Json() functions:
//   sensorUpdate      -> live psi/zone/status  (Master buildSensorUpdateJson)
//   manualZoneStatus  -> active manual runs    (Master buildManualZoneRunsJson)
//   schedulesEnabled  -> pause/resume state
//   schedule          -> controllers.json      (for the manual-zone dropdowns)
//   ack               -> command success/fail
//
// Outbound (all in the Indoor allowlist): manualZone, manualProgram,
// setSchedulesEnabled, getSchedule, getSchedulesEnabled.

const PRESSURE_ALERT_DEVIATION = 4.0;
const PRESSURE_WARN_DEVIATION  = 2.0;
const MAX_CHART_POINTS = 480;

// Vertical zone-change markers on the chart, matching the Master CHART
// page's scheduled-zone colors exactly (blue for yard, green for field), plus
// a higher-luminance variant of each for manual start/stop markers so a
// manual run is distinguishable from a scheduled one at a glance without
// having to read the "Z<n>" vs "M<n>" label text. Unlike Master -- which
// precomputes a whole day's scheduled start times from controllers.json +
// weather state -- this page has no access to weather state over the
// relay's WebSocket, and its chart is a rolling 24h window rather than a
// single calendar day. So markers here are drawn live, the moment an actual
// zone/controller change or manual start/stop is observed, and pruned once
// older than the chart's own 24h history window. This means markers only
// exist for transitions that happened while a browser was connected -- the
// DO's history table records psi/zoneAvgPsi only, not zone/controller, so
// the initial history backfill can't be retroactively annotated.
const ZONE_MARKER_COLOR = 'rgba(96, 165, 250, 0.72)';              // yard, scheduled -- matches .ag-ctrl-yard (#60a5fa)
const ZONE_MARKER_COLOR_FIELD = 'rgba(34, 197, 94, 0.72)';         // field, scheduled -- matches .ag-ctrl-field (#22c55e)
const MANUAL_ZONE_MARKER_COLOR = 'rgba(147, 197, 253, 0.9)';       // yard, manual -- brighter blue (#93c5fd)
const MANUAL_ZONE_MARKER_COLOR_FIELD = 'rgba(134, 239, 172, 0.9)'; // field, manual -- brighter green (#86efac)
const MARKER_MAX_AGE_MS = 24 * 3600 * 1000;

let ws = null;
let chart = null;
let chartMarkers = [];          // [{id, value}] added via addZoneMarkerLine(), for pruning
let lastZoneKey = null;         // null until the first sensorUpdate this session
let lastZoneController = '';
let manualMarkersInitialized = false;
let controllersCache = [];      // from `schedule` message
let manualRunsCache = [];       // from `manualZoneStatus`
let latestScheduledZone = {};
let reconnectTimer = null;
let scheduleLoaded = false;
let schedulesEnabledLoaded = false;
let initialSyncTimer = null;
let deviceOfflineNoticeShown = false; // dedupe the offline toast across retries

// ---------- small UI helpers ----------
function showToast(msg, isError = false) {
  const t = document.getElementById('toast');
  document.getElementById('toast-msg').textContent = msg;
  t.style.borderLeftColor = isError ? '#ef4444' : '#22c55e';
  t.style.color = isError ? '#ef4444' : '#22c55e';
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 3500);
}

function setLink(up) {
  const el = document.getElementById('footer-link');
  if (el) { el.textContent = up ? 'ONLINE' : 'OFFLINE'; el.style.color = up ? '#22c55e' : '#ef4444'; }
  const sys = document.getElementById('system-status');
  const dot = document.querySelector('.ag-status-dot');
  if (sys) { sys.textContent = up ? 'ONLINE' : 'OFFLINE'; sys.style.color = up ? '' : '#ef4444'; }
  if (dot) dot.classList.toggle('offline', !up);
}

// ---------- gauge / stats (ported from index.js) ----------
function psiToOffset(psi) {
  const clamped = Math.max(0, Math.min(100, Number(psi) || 0));
  return 157 - (157 * clamped / 100);
}

function updateGauge(psi) {
  const v = Number(psi);
  document.getElementById('gauge-arc').setAttribute('stroke-dashoffset', psiToOffset(psi));
  document.getElementById('gauge-val').textContent = Number.isFinite(v) ? v.toFixed(1) : '—';
}

function updateStatStatus(psi, avgPsi, serverStatus) {
  const el = document.getElementById('stat-status');
  // Prefer the Master-computed status when present, to stay in lockstep with
  // buildPressureStatus() -- same precedence rule the Indoor display uses.
  if (serverStatus) {
    const s = String(serverStatus).toUpperCase();
    el.textContent = s;
    el.className = 'ag-stat-value ' + (s === 'OK' ? 'ok' : (s === 'WARN' ? 'warn' : 'err'));
    return;
  }
  const target = Number(avgPsi);
  if (target > 0) {
    const dev = Number(psi) - target;
    if (Math.abs(dev) >= PRESSURE_ALERT_DEVIATION) { el.textContent = dev > 0 ? 'HIGH' : 'LOW'; el.className = 'ag-stat-value err'; }
    else if (Math.abs(dev) >= PRESSURE_WARN_DEVIATION) { el.textContent = 'WARN'; el.className = 'ag-stat-value warn'; }
    else { el.textContent = 'OK'; el.className = 'ag-stat-value ok'; }
    return;
  }
  if (psi >= 35) { el.textContent = 'OK'; el.className = 'ag-stat-value ok'; }
  else if (psi >= 25) { el.textContent = 'WARN'; el.className = 'ag-stat-value warn'; }
  else { el.textContent = 'LOW'; el.className = 'ag-stat-value err'; }
}

function formatRemaining(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60), r = s % 60;
  return m + ':' + String(r).padStart(2, '0');
}

// A manual run for the currently-selected controller takes display precedence
// over the scheduled zone, mirroring index.js findDisplayManualRun().
function findDisplayManualRun() {
  const controller = document.getElementById('program-controller-select').value.toLowerCase();
  const prog = manualRunsCache.find(r => r.program && String(r.controller || '').toLowerCase() === controller);
  if (prog) return prog;
  for (const rowEl of document.querySelectorAll('.ag-manual-zone-row')) {
    const zn = rowEl.querySelector('.manual-zone-select').value;
    if (!zn) continue;
    const run = manualRunsCache.find(r => !r.program &&
      String(r.controller || '').toLowerCase() === controller && String(r.relay) === String(zn));
    if (run) return run;
  }
  return null;
}

function updateRuntimeStats() {
  const run = findDisplayManualRun();
  if (run) {
    document.getElementById('stat-runtime').textContent = Number(run.totalRunMinutes) > 0 ? run.totalRunMinutes + 'm' : '—';
    document.getElementById('stat-zone-remaining').textContent = formatRemaining(run.remainingSec);
    return;
  }
  const z = latestScheduledZone;
  // zoneNumber/controller alone, not allOff -- see trackZoneTransition() below.
  const active = Boolean(z.zoneNumber) && String(z.controller || '').toUpperCase() !== 'OFF';
  document.getElementById('stat-runtime').textContent = active && Number(z.run) > 0 ? z.run + 'm' : '—';
  document.getElementById('stat-zone-remaining').textContent = active ? (z.remaining || '—') : '—';
}

function updateZoneCard(s) {
  latestScheduledZone = s;
  renderActiveZoneCard();
  updateRuntimeStats();
}

// A manual run takes over the Active Zone card entirely (mirrors the same
// override the Indoor unit's LVGL screen does to its equivalent card),
// scoped to the currently-selected controller like findDisplayManualRun()'s
// other callers, for consistent precedence across the whole page.
function renderActiveZoneCard() {
  const run = findDisplayManualRun();
  const label = document.getElementById('zone-card-label');

  if (run) {
    label.textContent = 'MANUAL RUN ACTIVE';
    document.getElementById('current-zone-name').textContent = run.program
      ? 'PROGRAM ' + (run.programLetter || '') + ' — MANUAL RUN'
      : 'ZONE ' + run.relay + ' — MANUAL RUN';
    document.getElementById('current-zone-number').textContent = 'RELAY ' + run.relay;
    document.getElementById('current-zone-controller').textContent = run.controller || '—';
    document.getElementById('current-zone-start').textContent = formatRemaining(run.remainingSec) + ' LEFT';
    document.getElementById('current-zone-run').textContent = run.totalRunMinutes || '—';
    document.getElementById('current-zone-days').textContent = 'MANUAL';
    document.getElementById('stat-avgpsi').textContent = latestScheduledZone.zoneAvgPsi || '—';
    return;
  }

  label.textContent = 'SCHEDULED ACTIVE ZONE';
  const s = latestScheduledZone;
  // zoneNumber alone, not allOff: allOff is a pressure-recovery heuristic on
  // the master that can still read true for a while after a scheduled zone
  // starts (if pressure hasn't yet fallen from a recent refill), which
  // showed "SYSTEM IDLE" right as a zone genuinely started.
  const idle = !s.zoneNumber || s.zoneNumber === '0';
  document.getElementById('current-zone-name').textContent = idle ? 'SYSTEM IDLE' : String(s.zoneName || '—').toUpperCase();
  document.getElementById('current-zone-number').textContent = 'ZONE ' + (idle ? '—' : s.zoneNumber);
  document.getElementById('current-zone-controller').textContent = idle ? '—' : (s.controller || '—');
  document.getElementById('current-zone-start').textContent = idle ? '—' : (s.start || '—');
  document.getElementById('current-zone-run').textContent = idle ? '—' : (s.run || '—');
  document.getElementById('current-zone-days').textContent = idle ? 'NONE' : (s.days || 'NONE');
  document.getElementById('stat-avgpsi').textContent = idle ? '—' : (s.zoneAvgPsi || '—');
}

// ---------- chart ----------
function makePoint(x, psi, avgPsi) {
  let color = '#87bef2';
  const target = Number(avgPsi);
  if (target > 0) {
    const dev = Number(psi) - target;
    if (Math.abs(dev) >= PRESSURE_ALERT_DEVIATION) color = '#ef4444';
    else if (Math.abs(dev) >= PRESSURE_WARN_DEVIATION) color = '#f59e0b';
  }
  return { x, y: Number(psi), color, marker: { enabled: true, symbol: 'circle', radius: 2, fillColor: color } };
}

// ---------- zone-change markers (vertical plot lines) ----------
function zoneMarkerColor(controller) {
  return String(controller || '').toLowerCase() === 'field' ? ZONE_MARKER_COLOR_FIELD : ZONE_MARKER_COLOR;
}

function manualZoneMarkerColor(controller) {
  return String(controller || '').toLowerCase() === 'field' ? MANUAL_ZONE_MARKER_COLOR_FIELD : MANUAL_ZONE_MARKER_COLOR;
}

function makeZonePlotLine(value, labelText, color) {
  const line = { id: 'zone-' + value + '-' + labelText, value, color, width: 1, dashStyle: 'ShortDash', zIndex: 2 };
  if (labelText) {
    line.label = { text: labelText, rotation: 0, y: 14, style: { color, fontSize: '10px', fontFamily: 'Share Tech Mono, monospace' } };
  }
  return line;
}

function makeManualZonePlotLine(value, relay, kind, color) {
  return {
    id: 'manual-' + kind + '-' + relay + '-' + value,
    value, color, width: 1, dashStyle: 'ShortDash', zIndex: 2,
    label: {
      text: 'M' + relay + (kind === 'stop' ? '▼' : '▲'),
      rotation: 0, y: 14,
      style: { color, fontSize: '10px', fontFamily: 'Share Tech Mono, monospace' }
    }
  };
}

function pruneOldMarkers() {
  if (!chart) return;
  const cutoff = Date.now() - MARKER_MAX_AGE_MS;
  chartMarkers = chartMarkers.filter(marker => {
    if (marker.value >= cutoff) return true;
    chart.xAxis[0].removePlotLine(marker.id);
    return false;
  });
}

function addZoneMarkerLine(line) {
  if (!chart) return;
  chart.xAxis[0].addPlotLine(line);
  chartMarkers.push({ id: line.id, value: line.value });
  pruneOldMarkers();
}

// Draws a labeled "Z<n>" line the moment a sensorUpdate (live, or a replayed
// history row shaped the same way) reports a different active zone/
// controller than the last one, and an unlabeled line (in the ending zone's
// color) when it goes idle again -- the live-observed equivalent of
// Master's schedule-precomputed start/end lines. `ts` defaults to now for
// live use; replayZoneMarkers() passes each row's own historical timestamp.
function trackZoneTransition(m, ts = Date.now()) {
  // zoneNumber alone, not allOff -- see updateRuntimeStats() above for why.
  const active = m.zoneNumber && String(m.zoneNumber) !== '0';
  const key = active ? String(m.controller || '').toLowerCase() + ':' + m.zoneNumber : 'off';

  if (lastZoneKey !== null && key !== lastZoneKey) {
    if (active) {
      addZoneMarkerLine(makeZonePlotLine(ts, 'Z' + m.zoneNumber, zoneMarkerColor(m.controller)));
    } else if (lastZoneController) {
      addZoneMarkerLine(makeZonePlotLine(ts, '', zoneMarkerColor(lastZoneController)));
    }
  }

  lastZoneKey = key;
  if (active) lastZoneController = m.controller;
}

function manualRunKey(r) {
  return String(r.controller || '').toLowerCase() + ':' + r.relay;
}

// Diffs the incoming manual-run list against the current manualRunsCache
// (before it's overwritten) to draw start/stop markers, mirroring Master's
// applyManualRunsUpdate(). Skips the very first message so a zone that was
// already running when the page loaded doesn't get a false "start" marker.
function trackManualZoneMarkers(newRuns) {
  if (!manualMarkersInitialized) {
    manualMarkersInitialized = true;
    return;
  }
  // A program advancing straight to its next zone (NEXT, or a zero-delay
  // natural advance) reports the switch as a single runs-list update -- the
  // old zone's "stop" and the new zone's "start" land in the same diff
  // pass. Drawing both at the exact same timestamp would stack their plot
  // lines/labels on top of each other and hide one, so the start marker
  // gets a +1s nudge -- invisible at this chart's timescale, but enough to
  // keep both legible.
  const now = Date.now();
  const newKeys = new Set(newRuns.map(manualRunKey));
  const oldKeys = new Set(manualRunsCache.map(manualRunKey));
  manualRunsCache.forEach(r => { if (!newKeys.has(manualRunKey(r))) addZoneMarkerLine(makeManualZonePlotLine(now, r.relay, 'stop', manualZoneMarkerColor(r.controller))); });
  newRuns.forEach(r => { if (!oldKeys.has(manualRunKey(r))) addZoneMarkerLine(makeManualZonePlotLine(now + 1000, r.relay, 'start', manualZoneMarkerColor(r.controller))); });
}

function clearZoneMarkers() {
  if (!chart) return;
  chartMarkers.forEach(marker => chart.xAxis[0].removePlotLine(marker.id));
  chartMarkers = [];
}

// Rebuilds every zone/manual marker from the getHistory response's now
// zone-annotated points + server-diffed manualEvents (the DO does the same
// start/stop diffing as trackManualZoneMarkers(), persisted so it survives
// across connections). Runs on every getHistory response, not just the
// first -- reconnects re-request history, so markers are always rebuilt
// from the authoritative source rather than patched, which also keeps this
// safe to call repeatedly without duplicating lines.
function replayZoneMarkers(points, manualEvents) {
  clearZoneMarkers();
  lastZoneKey = null;
  lastZoneController = '';
  points.forEach(p => trackZoneTransition(p, p.ts));
  manualEvents.forEach(ev => addZoneMarkerLine(makeManualZonePlotLine(ev.ts, ev.relay, ev.kind, manualZoneMarkerColor(ev.controller))));
  // The next live manualZoneStatus message should skip-diff (matching the
  // page-load guard) since replay already drew markers for anything
  // reflected in this getHistory snapshot -- otherwise it would diff
  // against a stale/empty manualRunsCache and redraw a spurious "start".
  manualMarkersInitialized = false;
}

function initChart() {
  Highcharts.setOptions({ time: { useUTC: false } });
  chart = Highcharts.chart('chart-pressure', {
    chart: {
      type: 'line', backgroundColor: 'transparent', animation: false, height: 340,
      zooming: { type: 'x' }, panning: true, panKey: 'shift',
      // Default position overlaps the dashed manual-start marker lines near
      // the top of the plot; nudged down 20px clear of them.
      resetZoomButton: { position: { align: 'right', x: -10, y: 30 } }
    },
    title: { text: null }, credits: { enabled: false }, legend: { enabled: false },
    accessibility: { enabled: false },
    xAxis: {
      type: 'datetime',
      labels: { style: { color: '#5f7da0', fontFamily: 'Share Tech Mono', fontSize: '10px' }, format: '{value:%H:%M:%S}' },
      gridLineColor: '#16283d', lineColor: '#1c3350'
    },
    yAxis: { min: 0, max: 70, tickInterval: 10, title: { text: null }, labels: { style: { color: '#5f7da0', fontFamily: 'Share Tech Mono', fontSize: '10px' } }, gridLineColor: '#456a84' },
    tooltip: {
      backgroundColor: '#0e1a2b', borderColor: '#1c3350', style: { color: '#e8f4fd' },
      formatter: function () {
        return `<b>${Highcharts.dateFormat('%H:%M:%S', this.x)}</b><br>${this.y.toFixed(1)} PSI`;
      }
    },
    plotOptions: { line: { lineWidth: 2, color: '#0d6efd', marker: { enabled: true, symbol: 'circle', radius: 2 }, states: { hover: { lineWidth: 2 } } } },
    series: [{ name: 'Pressure', data: [] }]
  });
}

// ---------- manual-zone dropdowns (from `schedule` message) ----------
function populateManualZoneSelects() {
  const controller = document.getElementById('program-controller-select').value.toLowerCase();
  const ctrl = controllersCache.find(c => String(c.id || '').toLowerCase() === controller);
  const zones = [];
  if (ctrl) (ctrl.programs || []).forEach(p => (p.zones || []).forEach(z => {
    if (!zones.some(existing => existing.znumber === z.znumber)) zones.push({ znumber: z.znumber, zname: z.zname });
  }));
  document.querySelectorAll('.manual-zone-select').forEach(sel => {
    const prev = sel.value;
    sel.innerHTML = '<option value="">Select Zone</option>' +
      zones.map(z => `<option value="${z.znumber}">${z.znumber} · ${z.zname}</option>`).join('');
    if (prev && zones.some(z => String(z.znumber) === prev)) sel.value = prev;
  });
}

// ---------- manual run status rendering (from manualZoneStatus) ----------
function renderManualStatus() {
  // Program status line
  const controller = document.getElementById('program-controller-select').value.toLowerCase();
  const progEl = document.getElementById('manual-program-status');
  const prog = manualRunsCache.find(r => r.program && String(r.controller || '').toLowerCase() === controller);
  if (prog) {
    progEl.textContent = 'RUNNING ZONE ' + prog.relay + ' · ' + formatRemaining(prog.remainingSec) + ' LEFT';
    progEl.className = 'ag-manual-state active';
  } else {
    progEl.textContent = 'READY';
    progEl.className = 'ag-manual-state muted';
  }
  // Start/Next toggle: while this controller's program is running, the
  // button becomes NEXT (skip to the following zone, or stop if this is the
  // last one -- master handles that fallthrough in advanceManualProgramRun());
  // it reverts to START PROGRAM once the run list no longer shows it (either
  // via STOP or the program completing on its own).
  const startBtn = document.getElementById('start-manual-program-btn');
  if (prog) {
    startBtn.textContent = 'NEXT';
    startBtn.className = 'ag-btn ag-btn-ghost ag-btn-sm';
    startBtn.dataset.mode = 'next';
  } else {
    startBtn.textContent = 'START PROGRAM';
    startBtn.className = 'ag-btn ag-btn-primary ag-btn-sm';
    startBtn.dataset.mode = 'start';
  }
  // Per-row zone status
  document.querySelectorAll('.ag-manual-zone-row').forEach(rowEl => {
    const zn = rowEl.querySelector('.manual-zone-select').value;
    const el = rowEl.querySelector('.manual-zone-status');
    const run = manualRunsCache.find(r => !r.program &&
      String(r.controller || '').toLowerCase() === controller && String(r.relay) === String(zn));
    if (zn && run) { el.textContent = 'RUNNING · ' + formatRemaining(run.remainingSec) + ' LEFT'; el.className = 'ag-manual-state active manual-zone-status'; }
    else { el.textContent = 'READY'; el.className = 'ag-manual-state muted manual-zone-status'; }
  });
  renderActiveZoneCard();
  updateRuntimeStats();
}

// ---------- WebSocket ----------
function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  else showToast('Not connected', true);
}

function requestInitialSync() {
  if (!scheduleLoaded) wsSend({ cmd: 'getSchedule' });
  if (!schedulesEnabledLoaded) wsSend({ cmd: 'getSchedulesEnabled' });
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + '/ws');

  ws.addEventListener('open', () => {
    setLink(true);
    deviceOfflineNoticeShown = false;
    // Chart history is answered directly by the Worker/DO (not dependent on
    // the Indoor/Master link), so unlike getSchedule it can't be silently
    // dropped -- no retry needed.
    wsSend({ cmd: 'getHistory' });
    // Pull the schedule (for dropdowns) and current pause state on connect.
    // The relay is a blind fan-out with no queuing, so a one-shot request can
    // be silently lost if the Indoor unit's own link happens to be down at
    // this exact instant -- retry until both land.
    requestInitialSync();
    if (initialSyncTimer) clearInterval(initialSyncTimer);
    initialSyncTimer = setInterval(() => {
      if (scheduleLoaded && schedulesEnabledLoaded) {
        clearInterval(initialSyncTimer);
        initialSyncTimer = null;
        return;
      }
      requestInitialSync();
    }, 3000);
  });

  ws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    switch (m.type) {
      case 'sensorUpdate': {
        updateGauge(m.psi);
        updateZoneCard(m);
        updateStatStatus(m.psi, m.zoneAvgPsi, m.status);
        const adc = document.getElementById('footer-adc-voltage');
        if (adc && m.adcVoltage != null) adc.textContent = Number(m.adcVoltage).toFixed(2) + ' V';
        if (m.location) document.getElementById('loc-display').textContent = m.location;
        if (m.sampleRateSec) document.getElementById('sample-rate-display').textContent = m.sampleRateSec + 's';
        document.getElementById('last-read').textContent = new Date().toLocaleTimeString();
        if (chart) {
          trackZoneTransition(m);
          const xAxis = chart.xAxis[0];
          const zoomed = xAxis.userMin != null || xAxis.userMax != null;
          const zoomWidth = xAxis.max - xAxis.min;
          const now = Date.now();
          chart.series[0].addPoint(makePoint(now, m.psi, Number(m.zoneAvgPsi)),
            true, chart.series[0].data.length >= MAX_CHART_POINTS, false);
          // Highcharts quirk (documented on their own forums): addPoint's
          // shift silently desyncs the shifted series data from a
          // user-zoomed axis range, so the chart stops visually rendering
          // new points until some other interaction forces a redraw --
          // matches Master's chart never hitting this, since it never
          // shifts (unbounded day + scrollablePlotArea instead of a
          // rolling buffer). Re-asserting extremes after every point forces
          // Highcharts to recompute and redraw within that range each time.
          // Sliding the window to end at `now` (instead of re-pinning the
          // exact old min/max) keeps a zoomed-in view following live data --
          // otherwise the window stays frozen at whatever was zoomed and new
          // points, always newer than the old max, never become visible.
          if (zoomed) xAxis.setExtremes(now - zoomWidth, now, true, false);
        }
        break;
      }
      case 'manualZoneStatus': {
        const runs = Array.isArray(m.runs) ? m.runs : [];
        trackManualZoneMarkers(runs);
        manualRunsCache = runs;
        renderManualStatus();
        break;
      }
      case 'schedule':
        controllersCache = Array.isArray(m.controllers) ? m.controllers : [];
        scheduleLoaded = true;
        populateManualZoneSelects();
        break;
      case 'schedulesEnabled':
        schedulesEnabledLoaded = true;
        setSchedulesButton(m.enabled);
        break;
      case 'history':
        if (chart && Array.isArray(m.points)) {
          chart.series[0].setData(
            m.points.map(p => makePoint(p.ts, p.psi, p.zoneAvgPsi)),
            true
          );
          replayZoneMarkers(m.points, Array.isArray(m.manualEvents) ? m.manualEvents : []);
        }
        break;
      case 'ack':
        showToast(m.message || (m.success ? 'Done' : 'Failed'), !m.success);
        break;
      case 'manualZoneAck':
      case 'manualProgramAck':
        showToast(m.message || (m.success ? 'Done' : 'Failed'), !m.success);
        break;
      case 'error':
        // Indoor unit's own link to the relay is down. Keep retrying
        // (initialSyncTimer / manual actions may still succeed once it's
        // back), just make the failure visible instead of silent.
        if ((m.cmd === 'getSchedule' || m.cmd === 'getSchedulesEnabled') && !deviceOfflineNoticeShown) {
          deviceOfflineNoticeShown = true;
          showToast('Indoor unit not connected — zone list unavailable', true);
        }
        break;
      default:
        break; // ignore unknown types
    }
  });

  ws.addEventListener('close', () => {
    setLink(false);
    if (initialSyncTimer) { clearInterval(initialSyncTimer); initialSyncTimer = null; }
    // Auto-reconnect -- /ws is public now, so a dropped connection is just a
    // network blip, never an auth failure.
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 3000);
  });

  ws.addEventListener('error', () => { try { ws.close(); } catch (_) {} });
}

// ---------- schedules pause/resume ----------
let schedulesEnabled = true;
function setSchedulesButton(enabled) {
  schedulesEnabled = enabled;
  const btn = document.getElementById('schedules-toggle-btn');
  if (enabled) { btn.textContent = 'STOP SCHEDULES'; btn.className = 'ag-btn ag-btn-danger ag-btn-sm'; }
  else { btn.textContent = 'RESUME SCHEDULES'; btn.className = 'ag-btn ag-btn-primary ag-btn-sm'; }
  btn.style.width = '100%'; btn.style.marginTop = '10px';
}

// ---------- wire up ----------
document.addEventListener('DOMContentLoaded', () => {
  initChart();
  connect();

  document.getElementById('schedules-toggle-btn').addEventListener('click', () => {
    sendGatedCommand({ cmd: 'setSchedulesEnabled', enabled: !schedulesEnabled })
      .catch(err => { if (err.message !== 'cancelled') showToast(err.message || 'Failed', true); });
  });

  document.getElementById('program-controller-select').addEventListener('change', () => { populateManualZoneSelects(); renderManualStatus(); });
  document.getElementById('program-letter-select').addEventListener('change', renderManualStatus);

  document.getElementById('start-manual-program-btn').addEventListener('click', (e) => {
    const controller = document.getElementById('program-controller-select').value;
    const cmd = e.currentTarget.dataset.mode === 'next'
      ? { cmd: 'manualProgram', action: 'next', controller }
      : { cmd: 'manualProgram', action: 'start', controller,
          program: document.getElementById('program-letter-select').value };
    sendGatedCommand(cmd)
      .catch(err => { if (err.message !== 'cancelled') showToast(err.message || 'Failed', true); });
  });
  document.getElementById('stop-manual-program-btn').addEventListener('click', () => {
    sendGatedCommand({ cmd: 'manualProgram', action: 'stop',
      controller: document.getElementById('program-controller-select').value })
      .catch(err => { if (err.message !== 'cancelled') showToast(err.message || 'Failed', true); });
  });

  document.querySelectorAll('.ag-manual-zone-row').forEach(rowEl => {
    rowEl.querySelector('.manual-zone-select').addEventListener('change', renderManualStatus);
    rowEl.querySelector('.manual-zone-start-btn').addEventListener('click', () => {
      const controller = document.getElementById('program-controller-select').value;
      const znumber = rowEl.querySelector('.manual-zone-select').value;
      const run = rowEl.querySelector('.manual-zone-run').value;
      if (!znumber) { showToast('Pick a zone first', true); return; }
      sendGatedCommand({ cmd: 'manualZone', action: 'start', controller, znumber, run })
        .catch(err => { if (err.message !== 'cancelled') showToast(err.message || 'Failed', true); });
    });
    rowEl.querySelector('.manual-zone-stop-btn').addEventListener('click', () => {
      const controller = document.getElementById('program-controller-select').value;
      const znumber = rowEl.querySelector('.manual-zone-select').value;
      if (!znumber) { showToast('Pick a zone first', true); return; }
      sendGatedCommand({ cmd: 'manualZone', action: 'stop', controller, znumber })
        .catch(err => { if (err.message !== 'cancelled') showToast(err.message || 'Failed', true); });
    });
  });

  window.addEventListener('resize', () => { if (chart) chart.reflow(); });
});
