// PressureSense remote schedule editor (Lite).
//
// Edits ONLY the live controllers.json, over the relay:
//   getSchedule  -> receive controllers array
//   saveSchedule -> write controllers array back (Master writes controllers.json)
//
// Editable: zone run (minutes), program start time, program days.
// Read-only here (edit locally): zone name, target PSI, seasonal %, zone delay,
// add/delete/reorder, calibration, weather. Those aren't on the relay by design.
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
  t.style.borderLeftColor = isError ? '#ef4444' : '#22c55e';
  t.style.color = isError ? '#ef4444' : '#22c55e';
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 3500);
}

function setLink(up) {
  const el = document.getElementById('footer-link');
  if (el) { el.textContent = up ? 'ONLINE' : 'OFFLINE'; el.style.color = up ? '#22c55e' : '#ef4444'; }
  const sys = document.getElementById('system-status');
  if (sys) { sys.textContent = up ? 'ONLINE' : 'OFFLINE'; sys.style.color = up ? '' : '#ef4444'; }
}

function setDirty(v) {
  dirty = v;
  const el = document.getElementById('unsaved-indicator');
  el.textContent = v ? 'UNSAVED' : 'NONE';
  el.style.color = v ? '#f59e0b' : '';
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
  const interval = getProgramInterval(program);   // zone-utils; neutral weather
  const endTime = minsToTime(interval.end);
  const crossesMidnight = interval.end >= 1440;
  const overlapPairs = findControllerOverlaps(controller).filter(pair => pair.includes(program.id));
  const overlapHtml = overlapPairs.length
    ? `<span class="ag-overlap-warning">&#9888; Overlaps ${overlapPairs.map(p => p.find(id => id !== program.id)).join(', ')}</span>`
    : '';
  return `
    <div class="ag-program-header" data-controller="${controller.id}" data-program="${program.id}">
      <span class="ag-program-badge">Program ${program.id}</span>
      <label class="ag-field-label" style="min-width:auto;">START
        <input class="ag-inline-input sched-start-input" type="time" value="${escapeHtml(program.start)}"
               data-controller="${controller.id}" data-program="${program.id}" style="width:110px;">
      </label>
      <span class="ag-program-days">${editableDayPips(controller.id, program.id, program.days)}</span>
      <span class="ag-program-zonecount">${(program.zones || []).length} zones</span>
      <span class="ag-program-duration">${interval.totalRun} min total</span>
      <span class="ag-program-endtime">ends ${endTime}${crossesMidnight ? ' <span class="ag-day-badge">+1</span>' : ''}</span>
      ${overlapHtml}
    </div>`;
}

function renderZoneRow(controllerId, program, zone, idx) {
  const derivedStart = getZoneDerivedStart(program, idx);   // zone-utils, neutral weather
  const startLabel = minsToTime(derivedStart) + (derivedStart >= 1440 ? ' +1' : '');
  return `
    <tr data-controller="${controllerId}" data-program="${program.id}" data-zone-idx="${idx}">
      <td>${zone.znumber}</td>
      <td class="ag-help-text">${escapeHtml(zone.zname)}</td>
      <td class="ag-help-text">${zone.avgpsi}</td>
      <td><input class="ag-inline-input sched-run-input" type="number" min="0" max="600"
                 value="${zone.run}" data-controller="${controllerId}" data-program="${program.id}"
                 data-zone-idx="${idx}" style="width:56px;"></td>
      <td class="ag-zone-starts-at">${startLabel}</td>
    </tr>`;
}

function renderProgram(controller, program) {
  const rows = (program.zones || []).map((z, i) => renderZoneRow(controller.id, program, z, i)).join('');
  return `
    <div class="ag-program-group ${ctrlBadgeClass(controller.id)}" data-controller="${controller.id}" data-program="${program.id}">
      ${renderProgramHeader(controller, program)}
      <table class="ag-zone-table">
        <thead>
          <tr><th>#</th><th>Name</th><th>Target PSI</th><th>Run (min)</th><th>Starts at</th></tr>
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

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + '/ws');

  ws.addEventListener('open', () => { setLink(true); requestSchedule(); });

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
    wsSend({ cmd: 'saveSchedule', controllers });
  });

  document.getElementById('logout-link').addEventListener('click', async (e) => {
    e.preventDefault();
    if (dirty && !confirm('You have unsaved changes. Sign out anyway?')) return;
    try { await fetch('/logout', { method: 'POST' }); } catch (_) {}
    window.location.href = '/login.html';
  });

  window.addEventListener('beforeunload', (e) => {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });
});
