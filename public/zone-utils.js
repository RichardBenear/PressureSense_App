// Shared site.json/controllers.json schema helpers -- the one canonical implementation of
// day-array matching, derived start/end timing, and overlap detection, used
// by config.js and index.js so these two risk areas (days encoding, overlap
// detection) aren't implemented three different ways across the site.

const DAY_PIP_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function timeToMins(str) {
  const match = String(str || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const h = Number(match[1]), m = Number(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

function minsToTime(totalMinutes) {
  const minutesInDay = 24 * 60;
  const normalized = ((totalMinutes % minutesInDay) + minutesInDay) % minutesInDay;
  return String(Math.floor(normalized / 60)).padStart(2, '0') + ':' + String(normalized % 60).padStart(2, '0');
}

// weatherPct is a multiplier expressed as a percentage where 100 = neutral
// (matches firmware's applyRunAdjustments() in main.cpp exactly) -- distinct
// from seasonalPct, which is a +/- delta. weatherPct <= 0 means
// "unset/disabled" and defaults to 100; it must never default to 0, which
// would silently zero out every scheduled run.
function applyRunAdjustments(baseRunMinutes, seasonalPct, weatherPct) {
  const base = Number(baseRunMinutes) || 0;
  if (base <= 0) return base;
  const effectiveWeatherPct = (!weatherPct || weatherPct <= 0) ? 100 : weatherPct;
  let adjusted = Math.round(base * (1 + (seasonalPct || 0) / 100) * (effectiveWeatherPct / 100));
  if (adjusted < 1) adjusted = 1;
  return adjusted;
}

// Looks up this zone's own weather_adjust_pct from the separately-fetched
// /weather-state document (never from zoneDoc -- see decision #1). Per-zone,
// not per-program -- different zones water different physical areas, so
// each tracks its own independent deficit/adjustment rather than sharing
// one program-wide (or controller-wide) value. Defaults to 100 (neutral) if
// the state doc, or this zone's entry, is missing, OR if autoAdjustEnabled
// is false -- mirrors firmware's lookupZoneWeatherAdjustPct(), which gates
// on weather.auto_adjust before ever returning a non-neutral value. Without
// this gate the UI would show/apply a percentage that firmware itself isn't
// actually applying.
function findZoneWeatherAdjustPct(weatherState, controllerId, zoneNumber, autoAdjustEnabled = true) {
  if (!autoAdjustEnabled) return 100;
  const entry = (weatherState && weatherState.zones || [])
    .find(z => z.controller === controllerId && Number(z.zone_number) === Number(zoneNumber));
  if (!entry) return 100;
  const pct = Number(entry.weather_adjust_pct);
  return (!pct || pct <= 0) ? 100 : pct;
}

// JS twin of firmware's lookupZoneAreaFt2() -- looks up this zone's
// SVG-measured area from the separately-fetched /calibration.json. Returns
// 0 (not a guessed fallback) when missing, so a zone with no calibration
// entry simply doesn't contribute to an area-weighted average rather than
// skewing it with a fabricated area.
function findZoneAreaFt2(calibrationData, controllerId, zoneNumber) {
  const entry = (calibrationData && calibrationData.zones || [])
    .find(z => z.controller === controllerId && Number(z.zone_number) === Number(zoneNumber));
  return entry ? Number(entry.area_ft2) || 0 : 0;
}

// Display-only summary for the chart/tiles: area-weighted average of this
// controller's zones' current deficit_mm (depths from different-sized zones
// aren't directly combinable any other way; area comes from calibration.json).
// Never feeds back into scheduling -- that uses each zone's own deficit
// independently via findZoneWeatherAdjustPct/firmware's per-zone lookup.
function findControllerDeficitAvg(weatherState, calibrationData, controllerId) {
  const zones = (weatherState && weatherState.zones) || [];
  let weightedSum = 0, areaSum = 0;
  zones.forEach(z => {
    if (z.controller !== controllerId) return;
    const area = findZoneAreaFt2(calibrationData, controllerId, z.zone_number);
    weightedSum += (Number(z.deficit_mm) || 0) * area;
    areaSum += area;
  });
  return areaSum > 0 ? weightedSum / areaSum : 0;
}

// Same area-weighted average as findControllerDeficitAvg, but scoped to
// just one program's zone numbers -- a controller's programs can water
// disjoint physical areas (e.g. field's program A/B split), so each
// program's deficit must be tracked independently rather than blended into
// the controller-wide average.
function findProgramDeficitAvg(weatherState, calibrationData, controllerId, zoneNumbers) {
  const zones = (weatherState && weatherState.zones) || [];
  let weightedSum = 0, areaSum = 0;
  zones.forEach(z => {
    if (z.controller !== controllerId || !zoneNumbers.includes(Number(z.zone_number))) return;
    const area = findZoneAreaFt2(calibrationData, controllerId, z.zone_number);
    weightedSum += (Number(z.deficit_mm) || 0) * area;
    areaSum += area;
  });
  return areaSum > 0 ? weightedSum / areaSum : 0;
}

// Display-only summary for the "Today's adjustment" tile: a PLAIN mean of
// this controller's zones' weather_adjust_pct -- unlike deficit, a percent
// is a dimensionless ratio, not a depth, so area-weighting doesn't apply
// (matches the same plain-mean-vs-area-weighted distinction firmware's
// ControllerLogAggregate makes). Defaults to 100 (neutral) if this
// controller has no zone entries yet.
function findControllerAdjustPctAvg(weatherState, controllerId) {
  const zones = (weatherState && weatherState.zones || []).filter(z => z.controller === controllerId);
  if (zones.length === 0) return 100;
  const sum = zones.reduce((s, z) => s + (Number(z.weather_adjust_pct) || 100), 0);
  return Math.round(sum / zones.length);
}

// JS twin of firmware's lookupZoneMmPerMin() -- looks up this zone's real
// calibrated mm_per_min from the separately-fetched /calibration.json
// (calibration.html owns it), falling back to fallbackMmPerMin
// (site.mm_per_min_default) when calibration data is missing or has no
// entry for this zone. Never returns 0 -- a 0 mm_per_min would silently
// zero out a zone's entire contribution to the weather budget/chart.
function lookupZoneMmPerMin(calibrationData, controllerId, zoneNumber, fallbackMmPerMin = 0.25) {
  const fallback = (!fallbackMmPerMin || fallbackMmPerMin <= 0) ? 0.25 : fallbackMmPerMin;
  const entry = (calibrationData && calibrationData.zones || [])
    .find(z => z.controller === controllerId && Number(z.zone_number) === Number(zoneNumber));
  if (!entry) return fallback;
  const mm = Number(entry.mm_per_min);
  return (!mm || mm <= 0) ? fallback : mm;
}

// Per-zone derived start time, accumulated the same way firmware's
// checkActiveZone() cursor advances: each zone's run is seasonally+weather
// adjusted and rounded individually before being added to the cursor, so
// this stays in exact byte-for-byte agreement with the firmware (decision:
// round-per-zone, not "sum raw then multiply the total").
//
// weatherPctFn(zone) returns THAT zone's own weather_adjust_pct -- a
// callback, not a flat number, because weather adjustment is now per-zone
// (different zones water different physical areas and carry independent
// deficits; see findZoneWeatherAdjustPct). Defaults to a neutral 100 for
// every zone, for callers that don't care about weather (e.g. overlap
// checks below).
//
// CORRECTED vs zone-config-redesign.md Section 2: zone_delay_sec is a pre-ON
// pause that shortens a zone's own actual on-time; it does NOT shift this
// schedule -- see the implementation plan's decision #1. Do not add
// zone_delay_sec here.
function getZoneDerivedStart(program, zoneIndex, weatherPctFn = () => 100) {
  const percent = program.seasonal_adjust_pct || 0;
  let cursor = timeToMins(program.start) || 0;
  for (let i = 0; i < zoneIndex; i++) {
    cursor += applyRunAdjustments(program.zones[i].run, percent, weatherPctFn(program.zones[i]));
  }
  return cursor;
}

function getZoneDerivedEnd(program, zoneIndex, weatherPctFn = () => 100) {
  const percent = program.seasonal_adjust_pct || 0;
  return getZoneDerivedStart(program, zoneIndex, weatherPctFn) +
    applyRunAdjustments(program.zones[zoneIndex].run, percent, weatherPctFn(program.zones[zoneIndex]));
}

// CORRECTED vs zone-config-redesign.md Section 3: totalRun/end do NOT include
// a `(zones.length-1)*zone_delay_sec` term -- see decision #1.
function getProgramInterval(program, weatherPctFn = () => 100) {
  const percent = program.seasonal_adjust_pct || 0;
  const startMin = timeToMins(program.start) || 0;
  const totalRun = (program.zones || []).reduce((sum, z) => sum + applyRunAdjustments(z.run, percent, weatherPctFn(z)), 0);
  return { start: startMin, end: startMin + totalRun, totalRun };
}

function dayArraysIntersect(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.some(d => b.includes(d));
}

function zoneRunsOnDate(days, date) {
  return Array.isArray(days) && days.includes(date.getDay());
}

function formatDayArray(days) {
  if (!Array.isArray(days) || days.length === 0) return 'NONE';
  return days.slice().sort((a, b) => a - b).map(d => DAY_NAMES[d] || '?').join(' ');
}

function dayPipsHtml(days) {
  const set = Array.isArray(days) ? days : [];
  return DAY_PIP_LABELS.map((lbl, i) => {
    const on = set.includes(i) ? ' on' : '';
    return `<span class="ag-days-pip${on}">${lbl}</span>`;
  }).join('');
}

// Day-intersection guard runs BEFORE the time-interval check -- two programs
// on different days can never conflict, however their times overlap. This is
// the fix for the gap in zone-config-redesign.md Section 3's own findOverlaps,
// which only checked time and left the days cross-reference as a TODO comment.
function findOverlaps(programs) {
  // each entry: { id, start, end, days: number[] }
  const overlaps = [];
  for (let i = 0; i < programs.length; i++) {
    for (let j = i + 1; j < programs.length; j++) {
      const a = programs[i], b = programs[j];
      if (!dayArraysIntersect(a.days, b.days)) continue;
      const aWraps = a.end > 1440, bWraps = b.end > 1440;
      const conflict =
        (a.start < b.end && b.start < a.end) ||
        (aWraps && b.start < a.end % 1440) ||
        (bWraps && a.start < b.end % 1440);
      if (conflict) overlaps.push([a.id, b.id]);
    }
  }
  return overlaps;
}

function findControllerOverlaps(controller) {
  const programs = (controller.programs || []).map(p => {
    const interval = getProgramInterval(p);
    return { id: p.id, start: interval.start, end: interval.end, days: p.days };
  });
  return findOverlaps(programs);
}
