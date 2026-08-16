// PressureSense remote schedule editor (Lite).
//
// Edits ONLY the live controllers.json, over the relay:
//   getSchedule  -> receive controllers array
//   saveSchedule -> write controllers array back (Master writes controllers.json)
//
// Editable: zone run (minutes), program start time, program days.
// Read-only here (edit locally): zone name, target PSI, seasonal %, zone
// delay, add/delete/reorder, calibration, weather. Seasonal %/zone delay are
// shown on each program panel (and factored into the Run Adj column) for
// visibility, but stay Master-only to actually change -- not on the relay
// as editable fields by design.
//
// Reuses zone-utils.js (dayPipsHtml, getProgramInterval, minsToTime, etc.) so
// derived start times and overlap detection match the CONFIG page exactly.

let ws = null;
let controllers = [];       // working copy (edited in place)
let dirty = false;
let reconnectTimer = null;
let scheduleLoaded = false;
let scheduleRetryTimer = null;
let scheduleRetryCount = 0;
const SCHEDULE_RETRY_LIMIT = 5; // ~15s of retries at 3s each

// Weather & Auto-Adjust panel data (weather-panel.js owns the actual
// weatherState/weatherSettings/calibrationData/weatherLogEntries/
// weatherCacheData vars and rendering; this file just requests them and
// assigns responses into those shared globals). Read-only -- never merged
// into `controllers`, never part of a saveSchedule payload.
// cmd <-> response-type pairs -- weatherLoaded is keyed by the response
// `type` (matching the switch cases below); WEATHER_REQUESTS drives both the
// outbound retry loop and the `error` case's cmd->key lookup.
const WEATHER_REQUESTS = [
  { cmd: 'getWeatherState', key: 'weatherState' },
  { cmd: 'getWeatherSettings', key: 'weatherSettings' },
  { cmd: 'getWeatherLog', key: 'weatherLog' },
  { cmd: 'getWeatherCache', key: 'weatherCache' },
  { cmd: 'getCalibration', key: 'calibration' },
];
let weatherLoaded = { weatherState: false, weatherSettings: false, weatherLog: false, weatherCache: false, calibration: false };
let weatherRetryTimer = null;
let weatherRetryCount = 0;

// ---------- helpers ----------
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Matches CONFIG page's ctrlBadgeClass() exactly, so controller sections get
// the same blue (yard) / green (field) wash here as on the Master unit.
function ctrlBadgeClass(ctrl) {
  const c = (ctrl || '').toLowerCase();
  if (c === 'yard') return 'ag-ctrl-yard';
  if (c === 'field') return 'ag-ctrl-field';
  return 'ag-ctrl-off';
}

function showToast(msg, isError = false) {
  const t = document.getElementById('toast');
  document.getElementById('toast-msg').textContent = msg;
  t.style.borderLeftColor = isError ? '#f87171' : '#34d873';
  t.style.color = isError ? '#f87171' : '#34d873';
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 3500);
}

function setLink(up) {
  const el = document.getElementById('footer-link');
  if (el) { el.textContent = up ? 'ONLINE' : 'OFFLINE'; el.style.color = up ? '#34d873' : '#f87171'; }
  const sys = document.getElementById('system-status');
  if (sys) { sys.textContent = up ? 'ONLINE' : 'OFFLINE'; sys.style.color = up ? '' : '#f87171'; }
}

function setDirty(v) {
  dirty = v;
  const el = document.getElementById('unsaved-indicator');
  el.textContent = v ? 'UNSAVED' : 'NONE';
  el.style.color = v ? '#fbbf24' : '';
}

function countZones() {
  return controllers.reduce((sum, c) =>
    sum + (c.programs || []).reduce((s, p) => s + (p.zones || []).length, 0), 0);
}

function findProgram(controllerId, programId) {
  const c = controllers.find(c => c.id === controllerId);
  return c ? (c.programs || []).find(p => p.id === programId) : null;
}

// ---------- render ----------
// Day toggle pips (editable version of dayPipsHtml from zone-utils).
function editableDayPips(controllerId, programId, days) {
  const set = Array.isArray(days) ? days : [];
  const labels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  return labels.map((lbl, i) => {
    const on = set.includes(i) ? ' on' : '';
    return `<span class="ag-days-pip${on} sched-day-pip" role="button" tabindex="0"
      data-controller="${controllerId}" data-program="${programId}" data-day="${i}">${lbl}</span>`;
  }).join('');
}

function renderProgramHeader(controller, program) {
  const weatherPctFn = weatherPctFnFor(controller.id); // weather-panel.js; neutral until weatherState/Settings load
  const interval = getProgramInterval(program, weatherPctFn);
  const endTime = minsToTime(interval.end);
  const crossesMidnight = interval.end >= 1440;
  const overlapPairs = findControllerOverlaps(controller).filter(pair => pair.includes(program.id));
  const overlapHtml = overlapPairs.length
    ? `<span class="ag-overlap-warning">&#9888; Overlaps ${overlapPairs.map(p => p.find(id => id !== program.id)).join(', ')}</span>`
    : '';
  const weatherEntry = (weatherState.programs || []).find(p => p.controller === controller.id && p.program === program.id);
  const skipBadgeHtml = (isWeatherAutoAdjustEnabled() && weatherEntry && weatherEntry.skip_next_run)
    ? `<span class="ag-weather-skip-badge">&#9748; RAIN SKIP</span>` : '';
  const seasonalPct = program.seasonal_adjust_pct || 0;
  const seasonalText = (seasonalPct > 0 ? '+' : '') + seasonalPct + '%';
  return `
    <div class="ag-program-header" data-controller="${controller.id}" data-program="${program.id}">
      <div class="ag-program-header-top">
        <span class="ag-program-badge">Program ${program.id}</span>
      </div>
      <div class="ag-program-header-schedule">
        <label class="ag-field-label" style="min-width:auto;">START
          <input class="ag-inline-input sched-start-input" type="time" value="${escapeHtml(program.start)}"
                 data-controller="${controller.id}" data-program="${program.id}" style="width:110px;">
        </label>
        <span class="ag-program-days">${editableDayPips(controller.id, program.id, program.days)}</span>
        <span class="ag-program-zonecount">${(program.zones || []).length} zones</span>
        ${skipBadgeHtml}
        <span class="ag-program-duration">${interval.totalRun} min total</span>
        <span class="ag-program-endtime">ends ${endTime}${crossesMidnight ? ' <span class="ag-day-badge">+1</span>' : ''}</span>
        ${overlapHtml}
      </div>
      <div class="ag-program-header-adjustments">
        <span class="ag-program-seasonal">Seasonal Adj: ${seasonalText}</span>
        <span class="ag-program-zonedelay">Zone Delay: ${program.zone_delay_sec || 0} sec</span>
      </div>
    </div>`;
}

// Run Adj gives seasonal_adjust_pct precedence over weather_adjust_pct: when
// a program has a non-zero seasonal adjustment, that's shown (and weather is
// ignored for THIS column) regardless of whether weather auto-adjust is on;
// when seasonal is 0%, the column falls back to showing weather's effect,
// same as it always did. Mirrors PressureSense_Master/data/config.js.
function computeRunAdj(baseRunMinutes, seasonalPct, weatherPct) {
  if (seasonalPct !== 0) return { minutes: applyRunAdjustments(baseRunMinutes, seasonalPct, 100), pct: 100 + seasonalPct };
  return { minutes: applyRunAdjustments(baseRunMinutes, 0, weatherPct), pct: weatherPct };
}

function renderZoneRow(controllerId, program, zone, idx) {
  const weatherPctFn = weatherPctFnFor(controllerId); // weather-panel.js; neutral until weatherState/Settings load
  const seasonalPct = program.seasonal_adjust_pct || 0;
  const runAdj = computeRunAdj(zone.run, seasonalPct, weatherPctFn(zone));
  const derivedStart = getZoneDerivedStart(program, idx, weatherPctFn);
  const startLabel = minsToTime(derivedStart) + (derivedStart >= 1440 ? ' +1' : '');

  const zoneStateEntry = (weatherState.zones || []).find(z => z.controller === controllerId && Number(z.zone_number) === Number(zone.znumber));
  let deficitHtml = '<span class="ag-help-text">—</span>';
  if (zoneStateEntry && weatherSettings) {
    const deficitMm = Number(zoneStateEntry.deficit_mm) || 0;
    const referenceDeficitMm = Number(weatherSettings.reference_deficit_mm) || 6.0;
    const maxDeficitMm = Number(weatherSettings.max_deficit_mm) || 25.0;
    deficitHtml = `<span class="${deficitColorClass(deficitMm, referenceDeficitMm, maxDeficitMm)}">${deficitMm.toFixed(1)} mm</span>`;
  }

  return `
    <tr data-controller="${controllerId}" data-program="${program.id}" data-zone-idx="${idx}">
      <td>${zone.znumber}</td>
      <td class="ag-help-text">${escapeHtml(zone.zname)}</td>
      <td class="ag-help-text">${zone.avgpsi}</td>
      <td><input class="ag-inline-input sched-run-input" type="number" min="0" max="600"
                 value="${zone.run}" data-controller="${controllerId}" data-program="${program.id}"
                 data-zone-idx="${idx}" style="width:56px;"></td>
      <td class="ag-zone-adj-run">${runAdj.minutes} ${adjPctHtml(runAdj.pct)}</td>
      <td class="ag-zone-starts-at">${startLabel}</td>
      <td class="ag-zone-deficit">${deficitHtml}</td>
    </tr>`;
}

function renderProgram(controller, program) {
  const rows = (program.zones || []).map((z, i) => renderZoneRow(controller.id, program, z, i)).join('');
  return `
    <div class="ag-program-group ${ctrlBadgeClass(controller.id)}" data-controller="${controller.id}" data-program="${program.id}">
      ${renderProgramHeader(controller, program)}
      <table class="ag-zone-table">
        <thead>
          <tr><th>#</th><th>Name</th><th>Target PSI</th><th>Run (min)</th><th>Run Adj</th><th>Starts at</th><th>Deficit</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderController(controller) {
  const groups = (controller.programs || []).map(p => renderProgram(controller, p)).join('');
  return `
    <div class="ag-controller-section" data-controller="${controller.id}">
      <div class="ag-controller-header ${ctrlBadgeClass(controller.id)}">${escapeHtml(controller.name || controller.id)} controller</div>
      ${groups}
    </div>`;
}

function render() {
  const container = document.getElementById('schedule-controllers');
  if (!controllers.length) {
    container.innerHTML = '<div class="ag-help-text" style="padding:16px;">No schedule loaded yet…</div>';
  } else {
    container.innerHTML = controllers.map(renderController).join('');
  }
  document.getElementById('zone-count').textContent = countZones();
}

// Re-render just enough to refresh derived start times / duration / overlap
// after an edit, without losing focus on the field being typed in. Simplest
// correct approach: full re-render, then restore focus to the same field.
function rerenderPreservingFocus() {
  const active = document.activeElement;
  const sig = active && active.dataset ? {
    cls: active.className, c: active.dataset.controller, p: active.dataset.program, z: active.dataset.zoneIdx
  } : null;
  render();
  if (sig && sig.c) {
    const sel = `.${sig.cls.split(' ').find(x => x.startsWith('sched-'))}` +
      `[data-controller="${sig.c}"][data-program="${sig.p}"]` +
      (sig.z != null ? `[data-zone-idx="${sig.z}"]` : '');
    const el = document.querySelector(sel);
    if (el) { el.focus(); if (el.select) el.select(); }
  }
}

// ---------- edit handlers ----------
function onInput(e) {
  const t = e.target;
  if (t.classList.contains('sched-run-input')) {
    const p = findProgram(t.dataset.controller, t.dataset.program);
    if (p) { p.zones[Number(t.dataset.zoneIdx)].run = Number(t.value) || 0; setDirty(true); rerenderPreservingFocus(); }
  } else if (t.classList.contains('sched-start-input')) {
    const p = findProgram(t.dataset.controller, t.dataset.program);
    if (p) { p.start = t.value; setDirty(true); rerenderPreservingFocus(); }
  }
}

function onClick(e) {
  const pip = e.target.closest('.sched-day-pip');
  if (!pip) return;
  const p = findProgram(pip.dataset.controller, pip.dataset.program);
  if (!p) return;
  const day = Number(pip.dataset.day);
  if (!Array.isArray(p.days)) p.days = [];
  const at = p.days.indexOf(day);
  if (at >= 0) p.days.splice(at, 1); else p.days.push(day);
  p.days.sort((a, b) => a - b);
  setDirty(true);
  render();
}

// ---------- WebSocket ----------
function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  else showToast('Not connected', true);
}

// The relay is a blind fan-out with no queuing, so a one-shot getSchedule can
// be silently lost if the Indoor unit's own link happens to be down at this
// exact instant -- retry until it lands, matching dashboard.js's approach.
function requestSchedule() {
  scheduleLoaded = false;
  scheduleRetryCount = 0;
  wsSend({ cmd: 'getSchedule' });
  if (scheduleRetryTimer) clearInterval(scheduleRetryTimer);
  scheduleRetryTimer = setInterval(() => {
    if (scheduleLoaded) {
      clearInterval(scheduleRetryTimer);
      scheduleRetryTimer = null;
      return;
    }
    scheduleRetryCount++;
    if (scheduleRetryCount >= SCHEDULE_RETRY_LIMIT) {
      clearInterval(scheduleRetryTimer);
      scheduleRetryTimer = null;
      showToast('No response from controller — check Indoor unit connection', true);
      return;
    }
    wsSend({ cmd: 'getSchedule' });
  }, 3000);
}

// Same "blind fan-out, no queuing" reasoning as requestSchedule() above,
// applied to the five Weather & Auto-Adjust requests -- each is retried
// independently until its own response lands, since a dropped frame for one
// shouldn't hold up the others.
function requestWeatherData() {
  weatherLoaded = { weatherState: false, weatherSettings: false, weatherLog: false, weatherCache: false, calibration: false };
  weatherRetryCount = 0;
  WEATHER_REQUESTS.forEach(r => wsSend({ cmd: r.cmd }));
  if (weatherRetryTimer) clearInterval(weatherRetryTimer);
  weatherRetryTimer = setInterval(() => {
    const pending = WEATHER_REQUESTS.filter(r => !weatherLoaded[r.key]);
    if (pending.length === 0) {
      clearInterval(weatherRetryTimer);
      weatherRetryTimer = null;
      return;
    }
    weatherRetryCount++;
    if (weatherRetryCount >= SCHEDULE_RETRY_LIMIT) {
      clearInterval(weatherRetryTimer);
      weatherRetryTimer = null;
      showToast('No response from controller — weather data unavailable', true);
      return;
    }
    pending.forEach(r => wsSend({ cmd: r.cmd }));
  }, 3000);
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + '/ws');

  ws.addEventListener('open', () => { setLink(true); requestSchedule(); requestWeatherData(); });

  ws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    switch (m.type) {
      case 'schedule':
        scheduleLoaded = true;
        if (scheduleRetryTimer) { clearInterval(scheduleRetryTimer); scheduleRetryTimer = null; }
        // Don't clobber unsaved edits if a stray schedule message arrives.
        if (!dirty) {
          controllers = Array.isArray(m.controllers) ? m.controllers : [];
          render();
        }
        renderWeatherPanel(); // no-op until weatherSettings has also landed
        break;
      case 'weatherState':
        weatherState = m; if (!Array.isArray(weatherState.programs)) weatherState.programs = [];
        weatherLoaded.weatherState = true;
        rerenderPreservingFocus(); renderWeatherPanel();
        break;
      case 'weatherSettings':
        weatherSettings = m;
        weatherLoaded.weatherSettings = true;
        rerenderPreservingFocus(); renderWeatherPanel();
        break;
      case 'weatherLog':
        weatherLogEntries = Array.isArray(m.log) ? m.log : [];
        weatherLoaded.weatherLog = true;
        renderWeatherPanel();
        break;
      case 'weatherCache':
        weatherCacheData = m; // has .daily directly (Master splices "type" onto the raw cache object)
        weatherLoaded.weatherCache = true;
        renderWeatherPanel();
        break;
      case 'calibration':
        calibrationData = m; if (!Array.isArray(calibrationData.zones)) calibrationData.zones = [];
        weatherLoaded.calibration = true;
        rerenderPreservingFocus(); renderWeatherPanel();
        break;
      case 'ack':
        if (m.cmd === 'saveSchedule') {
          showToast(m.message || (m.success ? 'Schedule saved' : 'Save failed'), !m.success);
          if (m.success) setDirty(false);
        }
        break;
      case 'error':
        if (m.cmd === 'getSchedule') {
          if (scheduleRetryTimer) { clearInterval(scheduleRetryTimer); scheduleRetryTimer = null; }
          showToast('Indoor unit not connected — schedule unavailable', true);
        } else {
          const wr = WEATHER_REQUESTS.find(r => r.cmd === m.cmd);
          if (wr) weatherLoaded[wr.key] = true; // stop retrying a command the device rejected/can't answer
        }
        break;
      default:
        break; // sensorUpdate / manualZoneStatus etc. ignored on this page
    }
  });

  ws.addEventListener('close', () => {
    setLink(false);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 3000);
  });
  ws.addEventListener('error', () => { try { ws.close(); } catch (_) {} });
}

// ---------- wire up ----------
document.addEventListener('DOMContentLoaded', () => {
  connect();

  const container = document.getElementById('schedule-controllers');
  container.addEventListener('input', onInput);
  container.addEventListener('click', onClick);

  document.getElementById('reload-btn').addEventListener('click', () => {
    if (dirty && !confirm('Discard unsaved changes and reload from the controller?')) return;
    setDirty(false);
    requestSchedule();
  });

  document.getElementById('save-btn').addEventListener('click', () => {
    // Overlap guard: warn but allow (mirrors CONFIG page behavior).
    const anyOverlap = controllers.some(c => findControllerOverlaps(c).length > 0);
    if (anyOverlap && !confirm('Some programs overlap on shared days. Save anyway?')) return;
    sendGatedCommand({ cmd: 'saveSchedule', controllers })
      .catch(err => { if (err.message !== 'cancelled') showToast(err.message || 'Failed', true); });
  });

  window.addEventListener('beforeunload', (e) => {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });
});
