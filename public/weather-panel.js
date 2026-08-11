// Weather & Auto-Adjust panel (tiles + deficit chart per controller) for the
// remote SCHEDULE page — read-only mirror of the Master's CONFIG page panel
// of the same name. Ported closely from PressureSense_Master/data/config.js
// (renderControllerWeatherBlockHtml/buildChartData/renderWeatherDeficitChart/
// updateWeatherTiles and friends), adapted so data comes from WS-delivered
// module vars here instead of zoneDoc/fetch() (the App has no HTTP path to
// the Master's SPIFFS files, only the WS relay). No editing here — settings
// stay editable only on the Master's own CONFIG page.
//
// schedule.js owns the WebSocket and the `controllers` schedule array (as it
// already does); it assigns into the module vars below directly by name as
// each get* response arrives, then calls renderWeatherPanel(). Both files
// are plain (non-module) scripts sharing one global scope, same as
// zone-utils.js's functions are already shared with schedule.js -- this
// file must load after zone-utils.js and before schedule.js.

// Firmware-owned runtime state from getWeatherState -- never merged into the
// schedule's `controllers` array, never part of a saveSchedule payload.
let weatherState = { zones: [], programs: [] };
// Narrow, read-only subset of site.json's weather block from
// getWeatherSettings. null until it arrives -- gates all rendering below,
// since without it we can't tell whether auto_adjust is even on.
let weatherSettings = null;
// Per-zone irrigation calibration from getCalibration.
let calibrationData = { zones: [] };
// weather_log.json's `log` array from getWeatherLog.
let weatherLogEntries = [];
// Raw Open-Meteo cache object from getWeatherCache (has .daily).
let weatherCacheData = null;

let weatherDeficitCharts = {};
let weatherChartDataCaches = {};
let weatherPanelBuilt = false;

// ---------- shared gates/formatters (verbatim ports) ----------

// Mirrors firmware's gate exactly (lookupZoneWeatherAdjustPct/
// consumeSkipNextRun in main.cpp both check weather.auto_adjust before doing
// anything) -- must use the same gate everywhere weatherState is read, or
// this page shows/applies a percentage the firmware itself isn't applying.
function isWeatherAutoAdjustEnabled() {
  return Boolean(weatherSettings && weatherSettings.auto_adjust);
}

// Colors an adjustment % using this codebase's existing red/green convention
// -- red below 100 (less water), green above 100 (more water), neutral at
// 100.
function adjPctHtml(pctIn) {
  const pct = Math.round(pctIn);
  if (pct < 100) return `<span class="ag-adj-pct-low">${pct}%</span>`;
  if (pct > 100) return `<span class="ag-adj-pct-high">${pct}%</span>`;
  return `${pct}%`;
}

// Same red/amber/green thresholds as the chart's deficit gauge below --
// diagnostic only, shown regardless of whether auto_adjust is on (the
// firmware computes deficit_mm either way).
function deficitColorClass(deficitMm, referenceDeficitMm, maxDeficitMm) {
  if (deficitMm < referenceDeficitMm) return 'ag-deficit-low';
  if (deficitMm < maxDeficitMm * 0.8) return 'ag-deficit-mid';
  return 'ag-deficit-high';
}

// Per-zone weatherPctFn, for schedule.js's row rendering to thread into
// applyRunAdjustments()/getZoneDerivedStart() the same way config.js does.
function weatherPctFnFor(controllerId) {
  const autoAdjustEnabled = isWeatherAutoAdjustEnabled();
  return (zone) => findZoneWeatherAdjustPct(weatherState, controllerId, zone.znumber, autoAdjustEnabled);
}

// ---------- per-controller tiles+chart block ----------

function renderControllerWeatherBlockHtml(controllerId) {
  return `
    <div class="ag-controller-section" data-controller="${controllerId}">
      <div class="ag-controller-header ${ctrlBadgeClass(controllerId)}">${escapeHtml(controllerId)} controller</div>
      <div class="ag-weather-tiles" id="weather-tiles-${controllerId}">
        <div class="ag-weather-tile">
          <div class="ag-weather-tile-label">Current deficit</div>
          <div class="ag-weather-tile-value"><span id="weather-deficit-out-${controllerId}">—</span> mm</div>
          <div class="ag-weather-tile-sub">reference <span id="weather-reference-out-${controllerId}">—</span> mm</div>
          <div class="ag-weather-gauge"><div class="ag-weather-gauge-fill" id="weather-deficit-gauge-${controllerId}"></div></div>
        </div>
        <div class="ag-weather-tile">
          <div class="ag-weather-tile-label">Today's adjustment</div>
          <div class="ag-weather-tile-value" id="weather-adjust-out-${controllerId}">—</div>
        </div>
        <div class="ag-weather-tile">
          <div class="ag-weather-tile-label">Forecast rain 24h</div>
          <div class="ag-weather-tile-value"><span id="weather-rain24-out-${controllerId}">—</span> mm</div>
        </div>
        <div class="ag-weather-tile">
          <div class="ag-weather-tile-label">Projected</div>
          <div class="ag-weather-tile-value" id="weather-projected-out-${controllerId}">—</div>
        </div>
      </div>
      <div class="ag-weather-legend" title="Evapotranspiration: water lost from soil evaporation plus plant transpiration -- this is what drives the soil deficit up each day, offset by rain and irrigation.">
        <span class="ag-legend-item"><span class="ag-legend-swatch" style="background:#2a78d6;"></span>ET&#8320;</span>
        <span class="ag-legend-item"><span class="ag-legend-swatch" style="background:#1baf7a;"></span>Irrigation</span>
        <span class="ag-legend-item"><span class="ag-legend-swatch" style="background:#7ab3e0;"></span>Rain</span>
        <span class="ag-legend-item"><span class="ag-legend-swatch ag-legend-swatch-forecast"></span>Forecast (translucent)</span>
        <span class="ag-legend-item"><span class="ag-legend-line"></span>Deficit</span>
      </div>
      <div class="ag-weather-chart-wrap">
        <canvas id="weather-deficit-chart-${controllerId}" height="360"></canvas>
        <div id="weather-chart-msg-${controllerId}" class="ag-help-text ag-weather-chart-msg" style="display:none;">No weather cache yet.</div>
      </div>
      <label class="ag-help-text" style="display:flex; align-items:center; gap:5px; cursor:pointer; margin-top:8px; min-width:auto;">
        <input type="checkbox" class="weather-include-rain-toggle" data-controller="${controllerId}" checked />
        Include forecast rain in deficit projection
      </label>
    </div>`;
}

function renderAllControllerWeatherBlocks() {
  const container = document.getElementById('weather-controller-blocks');
  if (!container) return;
  container.innerHTML = (controllers || []).map(c => renderControllerWeatherBlockHtml(c.id)).join('');
  container.querySelectorAll('.weather-include-rain-toggle').forEach(input => {
    input.addEventListener('change', () => {
      const controllerId = input.dataset.controller;
      const cache = weatherChartDataCaches[controllerId];
      if (!cache) return;
      cache.deficitLine = calcDeficitLine(cache.pastDays, cache.forecastDays, input.checked, controllerId);
      const chart = weatherDeficitCharts[controllerId];
      if (chart) {
        chart.data.datasets.find(d => d.label === 'Deficit').data = cache.deficitLine;
        chart.update();
      }
      updateWeatherTiles(cache, controllerId);
    });
  });
}

// ---------- ET0 / deficit math (ported verbatim from config.js, zoneDoc.* swapped for weatherSettings/controllers) ----------

function toSupply(val) {
  return (val === null || val === undefined || val === 0) ? null : -val;
}

function irrigationScheduledMmForPrograms(dateStr, controllerId, programs) {
  const dow = new Date(dateStr + 'T00:00:00').getDay();
  const autoAdjustEnabled = isWeatherAutoAdjustEnabled();
  const fallbackMmPerMin = (weatherSettings && weatherSettings.mm_per_min_default) || 0.25;
  let weightedSum = 0, areaSum = 0;
  programs.forEach(program => {
    if (!Array.isArray(program.days) || !program.days.includes(dow)) return;
    (program.zones || []).forEach(zone => {
      const weatherPct = findZoneWeatherAdjustPct(weatherState, controllerId, zone.znumber, autoAdjustEnabled);
      const mmPerMin = lookupZoneMmPerMin(calibrationData, controllerId, zone.znumber, fallbackMmPerMin);
      const zoneDepthMm = applyRunAdjustments(zone.run, program.seasonal_adjust_pct || 0, weatherPct) * mmPerMin;
      const area = findZoneAreaFt2(calibrationData, controllerId, zone.znumber);
      weightedSum += zoneDepthMm * area;
      areaSum += area;
    });
  });
  const avgMm = areaSum > 0 ? weightedSum / areaSum : 0;
  return Math.round(avgMm * 100) / 100;
}

function irrigationScheduledMm(dateStr, controllerId) {
  const controller = (controllers || []).find(c => c.id === controllerId);
  if (!controller) return 0;
  return irrigationScheduledMmForPrograms(dateStr, controllerId, controller.programs || []);
}

function irrigationScheduledMmForProgram(dateStr, controllerId, programId) {
  const controller = (controllers || []).find(c => c.id === controllerId);
  if (!controller) return 0;
  const program = (controller.programs || []).find(p => p.id === programId);
  if (!program) return 0;
  return irrigationScheduledMmForPrograms(dateStr, controllerId, [program]);
}

function calcDeficitLine(pastDays, forecastDays, includeRain, controllerId) {
  const line = pastDays.map(d => d.deficit);
  if (forecastDays.length === 0) return line;

  const maxDeficitMm = Number(weatherSettings && weatherSettings.max_deficit_mm) || 25.0;
  let d = findControllerDeficitAvg(weatherState, calibrationData, controllerId);
  line.push(Math.round(d * 100) / 100); // today

  forecastDays.slice(1).forEach(day => {
    const rain = includeRain ? day.rain : 0;
    d += day.et0 - day.irrigation - rain;
    d = Math.max(0, Math.min(maxDeficitMm, d));
    line.push(Math.round(d * 100) / 100);
  });
  return line;
}

function buildProgramDeficitLine(forecastDaysTemplate, logEntries, includeRain, controllerId, program) {
  const zoneNumbers = (program.zones || []).map(z => Number(z.znumber));

  const pastDays = (logEntries || []).slice(-5).map(entry => {
    const ctrlEntry = (entry.controllers || []).find(c => c.controller === controllerId);
    const progEntry = ctrlEntry ? (ctrlEntry.programs || []).find(p => p.program === program.id) : null;
    return { deficit: progEntry ? Number(progEntry.deficit_mm) || 0 : 0 };
  });

  const line = pastDays.map(d => d.deficit);
  if (forecastDaysTemplate.length === 0) return line;

  const maxDeficitMm = Number(weatherSettings && weatherSettings.max_deficit_mm) || 25.0;
  let d = findProgramDeficitAvg(weatherState, calibrationData, controllerId, zoneNumbers);
  line.push(Math.round(d * 100) / 100); // today

  forecastDaysTemplate.slice(1).forEach(day => {
    const rain = includeRain ? day.rain : 0;
    const irrigation = irrigationScheduledMmForProgram(day.date, controllerId, program.id);
    d += day.et0 - irrigation - rain;
    d = Math.max(0, Math.min(maxDeficitMm, d));
    line.push(Math.round(d * 100) / 100);
  });
  return line;
}

function buildChartData(cacheData, logEntries, includeRain, controllerId) {
  const daily = cacheData && cacheData.daily;
  const pastDays = (logEntries || []).slice(-5).map(entry => {
    const ctrlEntry = (entry.controllers || []).find(c => c.controller === controllerId);
    return {
      date: String(entry.date || ''),
      et0: Number(entry.et0_mm) || 0,
      rain: Number(entry.precip_mm) || 0,
      irrigation: ctrlEntry ? Number(ctrlEntry.water_applied_mm) || 0 : 0,
      deficit: ctrlEntry ? Number(ctrlEntry.deficit_mm) || 0 : 0
    };
  });

  const forecastDays = [];
  const rainProbabilityForecast = [];
  if (daily && Array.isArray(daily.time) && daily.time.length > 1) {
    const et0Arr = daily.et0_fao_evapotranspiration || [];
    const precipArr = daily.precipitation_sum || [];
    const probArr = daily.precipitation_probability_max || [];
    const upper = Math.min(daily.time.length, 7);
    for (let i = 1; i < upper; i++) {
      const date = String(daily.time[i] || '');
      forecastDays.push({ date, et0: Number(et0Arr[i]) || 0, rain: Number(precipArr[i]) || 0, irrigation: irrigationScheduledMm(date, controllerId) });
      rainProbabilityForecast.push(Number(probArr[i]) || 0);
    }
  }

  if (pastDays.length === 0 && forecastDays.length === 0) return null;

  const todayIndex = forecastDays.length > 0 ? pastDays.length : null;
  const n = pastDays.length + forecastDays.length;
  const categories = pastDays.map(d => d.date.slice(5))
    .concat(forecastDays.map((d, j) => j === 0 ? 'TODAY' : d.date.slice(5)));

  const et0Actual = new Array(n).fill(null);
  const et0Forecast = new Array(n).fill(null);
  const irrigActual = new Array(n).fill(null);
  const rainActual = new Array(n).fill(null);
  const irrigForecast = new Array(n).fill(null);
  const rainForecast = new Array(n).fill(null);
  const rainProbability = new Array(n).fill(null);

  pastDays.forEach((d, i) => {
    et0Actual[i] = d.et0;
    irrigActual[i] = toSupply(d.irrigation);
    rainActual[i] = toSupply(d.rain);
  });
  forecastDays.forEach((d, j) => {
    const i = pastDays.length + j;
    et0Forecast[i] = d.et0;
    irrigForecast[i] = toSupply(d.irrigation);
    rainForecast[i] = toSupply(d.rain);
    rainProbability[i] = rainProbabilityForecast[j];
  });

  const controller = (controllers || []).find(c => c.id === controllerId);
  const programLines = ((controller && controller.programs) || []).map(program => ({
    id: program.id,
    label: 'Program ' + program.id,
    deficitLine: buildProgramDeficitLine(forecastDays, logEntries, includeRain, controllerId, program)
  }));

  return {
    categories, todayIndex, pastDays, forecastDays,
    et0Actual, et0Forecast, irrigActual, rainActual, irrigForecast, rainForecast, rainProbability,
    deficitLine: calcDeficitLine(pastDays, forecastDays, includeRain, controllerId),
    programLines
  };
}

// ---------- chart (Chart.js, ported verbatim from config.js) ----------

const WX_CHART_COLORS = {
  et0: '#2a78d6', et0ForecastFill: 'rgba(42, 120, 214, 0.3)',
  irrig: '#1baf7a', irrigForecastFill: 'rgba(27, 175, 122, 0.3)',
  rain: '#7ab3e0', rainForecastFill: 'rgba(122, 179, 224, 0.3)',
  deficit: '#e34948', target: '#f59e0b'
};

const WX_PROGRAM_LINE_COLORS = ['#e34948', '#3b82f6', '#a855f7', '#f59e0b'];

const wxZeroLinePlugin = {
  id: 'wxZeroLine',
  afterDraw(chart) {
    const { ctx, chartArea, scales: { y } } = chart;
    const yZero = y.getPixelForValue(0);
    ctx.save();
    ctx.strokeStyle = '#8ab0ca';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(chartArea.left, yZero);
    ctx.lineTo(chartArea.right, yZero);
    ctx.stroke();
    ctx.font = "600 9px 'Share Tech Mono', monospace";
    ctx.fillStyle = '#8ab0ca';
    ctx.textAlign = 'left';
    ctx.fillText('demand ↑', chartArea.left + 2, yZero - 4);
    ctx.fillText('supply ↓', chartArea.left + 2, yZero + 11);
    ctx.restore();
  }
};

const wxNowMarkerPlugin = {
  id: 'wxNowMarker',
  afterDraw(chart) {
    const opts = (chart.options.plugins && chart.options.plugins.wxNowMarker) || {};
    if (opts.todayIndex == null) return;
    const { ctx, chartArea, scales: { x } } = chart;
    const xPos = x.getPixelForValue(opts.todayIndex);
    ctx.save();
    ctx.strokeStyle = WX_CHART_COLORS.target;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(xPos, chartArea.top);
    ctx.lineTo(xPos, chartArea.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = "700 9px 'Share Tech Mono', monospace";
    ctx.fillStyle = WX_CHART_COLORS.target;
    ctx.textAlign = 'center';
    ctx.fillText('NOW', xPos, chartArea.top - 4);
    ctx.restore();
  }
};

const wxReferenceLinePlugin = {
  id: 'wxReferenceLine',
  afterDraw(chart) {
    const opts = (chart.options.plugins && chart.options.plugins.wxReferenceLine) || {};
    if (opts.referenceMm == null) return;
    const { ctx, chartArea, scales: { y } } = chart;
    const yPos = y.getPixelForValue(opts.referenceMm);
    if (yPos < chartArea.top || yPos > chartArea.bottom) return;
    ctx.save();
    ctx.strokeStyle = WX_CHART_COLORS.target;
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    ctx.moveTo(chartArea.left, yPos);
    ctx.lineTo(chartArea.right, yPos);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = "600 9px 'Share Tech Mono', monospace";
    ctx.fillStyle = WX_CHART_COLORS.target;
    ctx.textAlign = 'right';
    ctx.fillText('reference ' + opts.referenceMm + 'mm', chartArea.right - 2, yPos - 4);
    ctx.restore();
  }
};

const wxRainProbPlugin = {
  id: 'wxRainProbLabels',
  afterDatasetsDraw(chart) {
    const opts = (chart.options.plugins && chart.options.plugins.wxRainProbLabels) || {};
    const probs = opts.probabilities || [];
    const dsIndex = chart.data.datasets.findIndex(d => d.label === 'Forecast rain');
    if (dsIndex === -1) return;
    const ds = chart.data.datasets[dsIndex];
    const meta = chart.getDatasetMeta(dsIndex);
    const { ctx } = chart;
    ds.data.forEach((val, idx) => {
      if (val === null || Math.abs(val) <= 0.5) return;
      const prob = probs[idx];
      if (!prob) return;
      const point = meta.data[idx];
      if (!point) return;
      ctx.save();
      ctx.font = "500 9px 'Share Tech Mono', monospace";
      ctx.fillStyle = WX_CHART_COLORS.rain;
      ctx.textAlign = 'center';
      ctx.fillText(prob + '%', point.x, point.y + 12);
      ctx.restore();
    });
  }
};

function renderWeatherDeficitChart(chartData, controllerId) {
  const canvas = document.getElementById('weather-deficit-chart-' + controllerId);
  const msgEl = document.getElementById('weather-chart-msg-' + controllerId);
  if (!canvas) return;

  if (!chartData) {
    canvas.style.display = 'none';
    if (msgEl) { msgEl.textContent = 'No weather cache yet.'; msgEl.style.display = ''; }
    if (weatherDeficitCharts[controllerId]) { weatherDeficitCharts[controllerId].destroy(); delete weatherDeficitCharts[controllerId]; }
    return;
  }

  canvas.style.display = '';
  if (msgEl) {
    if (chartData.forecastDays.length === 0) {
      msgEl.textContent = 'No forecast data available.';
      msgEl.style.display = '';
    } else if (chartData.pastDays.length === 0) {
      msgEl.textContent = 'No actual history yet.';
      msgEl.style.display = '';
    } else {
      msgEl.style.display = 'none';
    }
  }

  if (typeof Chart === 'undefined') return;

  const todayIndex = chartData.todayIndex;
  const maxDeficitMm = Number(weatherSettings && weatherSettings.max_deficit_mm) || 25.0;
  const programLines = chartData.programLines || [];
  const allProgramDeficitValues = programLines.flatMap(pl => pl.deficitLine);
  const demandValues = chartData.et0Actual.concat(chartData.et0Forecast).map(v => v || 0).concat(allProgramDeficitValues);
  const supplyValues = chartData.irrigActual.concat(chartData.rainActual, chartData.irrigForecast, chartData.rainForecast).map(v => Math.abs(v || 0));
  const maxDemand = Math.max(12, maxDeficitMm * 1.1, ...demandValues);
  const maxSupplyMag = Math.max(10, ...supplyValues);

  const programLineDatasets = programLines.map((pl, i) => {
    const color = WX_PROGRAM_LINE_COLORS[i % WX_PROGRAM_LINE_COLORS.length];
    return {
      label: pl.label, type: 'line', data: pl.deficitLine, borderColor: color, borderWidth: 2.5,
      pointRadius: (ctx) => todayIndex != null && ctx.dataIndex === todayIndex ? 6 : 3,
      pointBackgroundColor: color, pointBorderColor: '#fff', pointBorderWidth: 1.5,
      tension: 0.35, fill: false, order: 1,
      segment: { borderDash: (ctx) => todayIndex != null && ctx.p0DataIndex >= todayIndex ? [5, 3] : [] }
    };
  });

  const datasets = [
    { label: 'ET₀ actual', data: chartData.et0Actual, backgroundColor: WX_CHART_COLORS.et0,
      borderRadius: { topLeft: 3, topRight: 3 }, barPercentage: 0.55, categoryPercentage: 0.75, stack: 'demand', order: 3 },
    { label: 'ET₀ forecast', data: chartData.et0Forecast, backgroundColor: WX_CHART_COLORS.et0ForecastFill,
      borderColor: WX_CHART_COLORS.et0, borderWidth: { top: 1.5, left: 0, right: 0, bottom: 0 },
      borderRadius: { topLeft: 3, topRight: 3 }, barPercentage: 0.55, categoryPercentage: 0.75, stack: 'demand', order: 3 },
    { label: 'Irrigation actual', data: chartData.irrigActual, backgroundColor: WX_CHART_COLORS.irrig,
      borderRadius: { bottomLeft: 3, bottomRight: 3 }, barPercentage: 0.55, categoryPercentage: 0.75, stack: 'supply', order: 3 },
    { label: 'Rain actual', data: chartData.rainActual, backgroundColor: WX_CHART_COLORS.rain,
      borderRadius: { bottomLeft: 3, bottomRight: 3 }, barPercentage: 0.55, categoryPercentage: 0.75, stack: 'supply', order: 3 },
    { label: 'Irrigation scheduled', data: chartData.irrigForecast, backgroundColor: WX_CHART_COLORS.irrigForecastFill,
      borderColor: WX_CHART_COLORS.irrig, borderWidth: { top: 0, left: 0, right: 0, bottom: 1.5 },
      borderRadius: { bottomLeft: 3, bottomRight: 3 }, barPercentage: 0.55, categoryPercentage: 0.75, stack: 'supply', order: 3 },
    { label: 'Forecast rain', data: chartData.rainForecast, backgroundColor: WX_CHART_COLORS.rainForecastFill,
      borderColor: WX_CHART_COLORS.rain, borderWidth: { top: 0, left: 0, right: 0, bottom: 1.5 },
      borderRadius: { bottomLeft: 3, bottomRight: 3 }, barPercentage: 0.55, categoryPercentage: 0.75, stack: 'supply', order: 3 },
    ...programLineDatasets
  ];

  if (weatherDeficitCharts[controllerId]) { weatherDeficitCharts[controllerId].destroy(); delete weatherDeficitCharts[controllerId]; }

  weatherDeficitCharts[controllerId] = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: { labels: chartData.categories, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: { padding: { top: 14, bottom: 4 } },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: '#8ab0ca', font: { family: "'Share Tech Mono', monospace", size: 10 } } },
        y: {
          stacked: true,
          suggestedMin: -maxSupplyMag * 1.15,
          suggestedMax: maxDemand * 1.15,
          grid: { color: (ctx) => ctx.tick.value === 0 ? 'transparent' : 'rgba(42,63,84,0.5)' },
          ticks: {
            color: '#8ab0ca', font: { family: "'Share Tech Mono', monospace", size: 10 },
            callback: (val) => val === 0 ? '' : Math.abs(val) + 'mm'
          }
        }
      },
      plugins: {
        legend: {
          display: programLineDatasets.length > 1,
          labels: {
            filter: (item, data) => data.datasets[item.datasetIndex].type === 'line',
            color: '#8ab0ca', font: { family: "'Share Tech Mono', monospace", size: 10 }, boxWidth: 16
          }
        },
        tooltip: {
          callbacks: {
            title: (items) => items[0].label,
            label(item) {
              if (item.raw === null) return null;
              const absVal = Math.abs(item.raw);
              if (absVal === 0) return null;
              if (item.dataset.label === 'Forecast rain') {
                const prob = chartData.rainProbability[item.dataIndex];
                return ' Forecast rain: ' + absVal.toFixed(1) + 'mm' + (prob ? ' (' + prob + '% confidence)' : '');
              }
              if (item.dataset.type === 'line') return ' ' + item.dataset.label + ' deficit: ' + Number(item.raw).toFixed(1) + 'mm';
              return ' ' + item.dataset.label + ': ' + absVal.toFixed(1) + 'mm';
            },
            filter: (item) => item.raw !== null && Math.abs(item.raw) > 0
          }
        },
        wxNowMarker: { todayIndex },
        wxReferenceLine: { referenceMm: Number(weatherSettings && weatherSettings.reference_deficit_mm) || null },
        wxRainProbLabels: { probabilities: chartData.rainProbability }
      }
    },
    plugins: [wxZeroLinePlugin, wxNowMarkerPlugin, wxReferenceLinePlugin, wxRainProbPlugin]
  });
}

function updateWeatherTiles(chartData, controllerId) {
  const autoAdjustEnabled = isWeatherAutoAdjustEnabled();
  const settings = weatherSettings || {};
  const maxDeficit = Number(settings.max_deficit_mm) || 25.0;
  const reference = Number(settings.reference_deficit_mm) || 6.0;
  const deficit = findControllerDeficitAvg(weatherState, calibrationData, controllerId);

  const deficitOut = document.getElementById('weather-deficit-out-' + controllerId);
  if (deficitOut) deficitOut.textContent = deficit.toFixed(1);
  const referenceOut = document.getElementById('weather-reference-out-' + controllerId);
  if (referenceOut) referenceOut.textContent = reference.toFixed(1);

  const gaugeFill = document.getElementById('weather-deficit-gauge-' + controllerId);
  if (gaugeFill) {
    const pct = Math.max(0, Math.min(100, (deficit / maxDeficit) * 100));
    gaugeFill.style.width = pct + '%';
    gaugeFill.style.background = deficit < reference ? '#22c55e' : (deficit < maxDeficit * 0.8 ? '#f59e0b' : '#ef4444');
  }

  const adjustOut = document.getElementById('weather-adjust-out-' + controllerId);
  if (adjustOut) {
    adjustOut.textContent = autoAdjustEnabled ? findControllerAdjustPctAvg(weatherState, controllerId) + '% avg' : 'off';
  }

  const rain24Out = document.getElementById('weather-rain24-out-' + controllerId);
  if (rain24Out) rain24Out.textContent = Number(weatherState.forecast_rain_24h_mm || 0).toFixed(1);

  const projectedEl = document.getElementById('weather-projected-out-' + controllerId);
  if (!projectedEl) return;
  if (!chartData || chartData.todayIndex == null) {
    projectedEl.textContent = '—';
    projectedEl.style.color = '';
    return;
  }
  const futureLine = chartData.deficitLine.slice(chartData.todayIndex + 1);
  const criticalIdx = futureLine.findIndex(v => v >= maxDeficit);
  if (criticalIdx === -1) {
    projectedEl.textContent = 'Safe ' + (futureLine.length || 0) + 'd';
    projectedEl.style.color = '#22c55e';
  } else {
    projectedEl.textContent = 'Critical in ' + (criticalIdx + 1) + 'd';
    projectedEl.style.color = '#ef4444';
  }
}

// Replaces config.js's loadWeatherChart() -- no fetch() here, reads the
// already-WS-delivered weatherCacheData/weatherLogEntries instead.
function renderWeatherChartsFromCache() {
  (controllers || []).forEach(controller => {
    const controllerId = controller.id;
    const toggle = document.querySelector(`.weather-include-rain-toggle[data-controller="${controllerId}"]`);
    const includeRain = toggle ? toggle.checked !== false : true;
    const chartData = buildChartData(weatherCacheData, weatherLogEntries, includeRain, controllerId);
    weatherChartDataCaches[controllerId] = chartData;
    renderWeatherDeficitChart(chartData, controllerId);
    updateWeatherTiles(chartData, controllerId);
  });
}

// ---------- entry point, called by schedule.js after every weather WS message ----------
function renderWeatherPanel() {
  // Needs the schedule (for the controller list) and settings (to gate
  // auto_adjust-dependent display) before there's anything meaningful to
  // build. Log/cache/calibration arrive independently and each just
  // improves the chart/tiles as they land (same partial-availability
  // tolerance buildChartData already has).
  if (!weatherSettings || !Array.isArray(controllers) || controllers.length === 0) return;
  if (!weatherPanelBuilt) {
    renderAllControllerWeatherBlocks();
    weatherPanelBuilt = true;
  }
  renderWeatherChartsFromCache();
}
