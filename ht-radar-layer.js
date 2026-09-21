// FILE: ht-radar-layer.js | DEPS: cgo-ht-radio-engine, ht-protocol | EXPORTS: HTRadioRadarLayer, initRadarLayer, getRadarLayer

import { STATUS_FLAGS } from './ht-protocol.js';
import { getGateway } from './cgo-ht-radio-engine.js';

// ============================================================
// KONSTANTA
// ============================================================

const STORAGE_KEY = 'bcgo.htRadioLayer';
const BLINK_PERIOD_MS = 300;
const MAX_REDRAW_PER_FRAME = 30;
const TOOLTIP_DURATION_MS = 4000;
const SIGNAL_CHANGE_THRESHOLD = 5;
const EMERGENCY_PULSE_RADIUS = 3;

const COLOR_PTT = '#22c55e';
const COLOR_EMERGENCY = '#ef4444';
const COLOR_SIGNAL_HIGH = '#22c55e';
const COLOR_SIGNAL_MID = '#eab308';
const COLOR_SIGNAL_LOW = '#ef4444';
const COLOR_WARN = '#f59e0b';

// ============================================================
// HELPER
// ============================================================

function readLayerState() {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeLayerState(active) {
  try {
    localStorage.setItem(STORAGE_KEY, active ? 'true' : 'false');
  } catch { /* noop */ }
}

function getSignalColor(signal) {
  if (signal > 70) return COLOR_SIGNAL_HIGH;
  if (signal >= 40) return COLOR_SIGNAL_MID;
  return COLOR_SIGNAL_LOW;
}

function timeAgo(ms) {
  const diff = Math.max(0, Date.now() - ms);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h`;
}

// ============================================================
// KELAS UTAMA
// ============================================================

class HTRadioRadarLayer {
  constructor(radar, options = {}) {
    this.radar = radar;
    this.canvas = options.canvas ?? radar?.canvas ?? null;
    this.controlPanel = options.controlPanel ?? null;
    this.autoInjectButton = options.autoInjectButton !== false;

    this.active = readLayerState();
    this.gateway = getGateway();

    this.agentCache = new Map();
    this.blinkPhase = 0;
    this.lastFrameTime = 0;
    this.redrawBudget = MAX_REDRAW_PER_FRAME;

    this.tooltip = null;
    this.tooltipTimeout = null;
    this.tooltipEl = null;

    this._onSatelliteUpdate = this._handleSatelliteUpdate.bind(this);
    this._blinkTimer = null;

    this._subscribe();
    this._startBlink();

    if (this.autoInjectButton) {
      this._injectLayerButton();
    }
  }

  // ----------------------------------------------------------
  // SUBSCRIBE
  // ----------------------------------------------------------

  _subscribe() {
    const target = this.gateway?.state?.satelliteUpdates;
    if (!target || typeof target.addEventListener !== 'function') return;

    target.addEventListener('satelliteUpdates', this._onSatelliteUpdate);
  }

  _unsubscribe() {
    const target = this.gateway?.state?.satelliteUpdates;
    if (!target || typeof target.removeEventListener !== 'function') return;

    target.removeEventListener('satelliteUpdates', this._onSatelliteUpdate);
  }

  _handleSatelliteUpdate(evt) {
    if (!this.active) return;

    const detail = evt?.detail;
    if (!detail?.state) return;

    const state = detail.state;
    const cached = this.agentCache.get(state.agentId);

    const signalChanged = !cached ||
      Math.abs((cached.signal ?? 0) - (state.signalQuality ?? 0)) > SIGNAL_CHANGE_THRESHOLD;

    const shouldRender =
      state.pttActive === true ||
      state.emergency === true ||
      signalChanged;

    if (shouldRender) {
      this.agentCache.delete(state.agentId);
    }
  }

  // ----------------------------------------------------------
  // BLINK TIMER
  // ----------------------------------------------------------

  _startBlink() {
    if (this._blinkTimer !== null) return;

    this._blinkTimer = setInterval(() => {
      this.blinkPhase = (this.blinkPhase + 1) % 2;
    }, BLINK_PERIOD_MS);
  }

  // ----------------------------------------------------------
  // LAYER CONTROL
  // ----------------------------------------------------------

  toggle() {
    this.setActive(!this.active);
  }

  setActive(active) {
    this.active = Boolean(active);
    writeLayerState(this.active);

    if (this.active) {
      this._subscribe();
    } else {
      this._unsubscribe();
      this.agentCache.clear();
      this._hideTooltip();
    }

    this._updateButtonState();

    if (typeof this.radar?.requestRedraw === 'function') {
      this.radar.requestRedraw();
    }
  }

  _injectLayerButton() {
    if (!this.controlPanel) {
      this.controlPanel =
        document.querySelector('.radar-controls') ||
        document.querySelector('#radar-controls') ||
        document.querySelector('#radar-panel') ||
        null;
    }

    if (!this.controlPanel) return;
    if (document.getElementById('ht-radio-layer-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'ht-radio-layer-btn';
    btn.type = 'button';
    btn.className = 'radar-layer-btn btn';
    btn.textContent = '📻 HT Radio';
    btn.setAttribute('aria-pressed', String(this.active));

    btn.addEventListener('click', () => this.toggle());

    Object.assign(btn.style, {
      padding: '6px 12px',
      margin: '4px 0',
      border: '1px solid #2a3646',
      borderRadius: '6px',
      background: this.active ? '#22c55e' : '#1f2937',
      color: this.active ? '#04130a' : '#e5e7eb',
      cursor: 'pointer',
      fontFamily: 'ui-monospace, monospace',
      fontSize: '11px'
    });

    this.controlPanel.appendChild(btn);
    this.layerBtn = btn;
  }

  _updateButtonState() {
    if (!this.layerBtn) return;

    this.layerBtn.setAttribute('aria-pressed', String(this.active));
    this.layerBtn.style.background = this.active ? '#22c55e' : '#1f2937';
    this.layerBtn.style.color = this.active ? '#04130a' : '#e5e7eb';
  }

  // ----------------------------------------------------------
  // RENDER
  // ----------------------------------------------------------

  render(ctx, worldToScreen, viewInfo = {}) {
    if (!this.active) return;
    if (!ctx || typeof worldToScreen !== 'function') return;

    this.redrawBudget = MAX_REDRAW_PER_FRAME;
    this.lastFrameTime = performance.now();

    const satellite = this.gateway?.state?.satellite;
    if (!satellite) return;

    for (const agentId in satellite) {
      if (this.redrawBudget <= 0) break;

      const state = satellite[agentId];
      if (!state || state.source !== 'virtual_ht') continue;
      if (Number(state.agentId) === 0) continue; // BASE — bukan unit lapangan

      this._renderAgent(ctx, state, worldToScreen, viewInfo);
      this.redrawBudget--;
    }

    if (this.tooltip) {
      this._positionTooltip();
    }
  }

  _renderAgent(ctx, state, worldToScreen, viewInfo) {
    // Fallback coords if missing (prevent silent skip)
    let lat = Number(state.latitude);
    let lon = Number(state.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      // Deterministic fallback so agent still appears
      const id = Number(state.agentId) || 0;
      lat = -6.2 + ((id * 17) % 50) / 50 * 4 - 2;
      lon = 106.8 + ((id * 31) % 50) / 50 * 8 - 4;
    }

    const pos = worldToScreen(lat, lon);
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return;

    // Cull if far outside canvas (with margin)
    const margin = 40;
    if (pos.x < -margin || pos.y < -margin ||
        pos.x > (viewInfo.canvasW ?? 9999) + margin ||
        pos.y > (viewInfo.canvasH ?? 9999) + margin) {
      return;
    }

    const { x, y } = pos;
    const baseR = viewInfo.agentRadius ?? 10;

    const pttActive = (state.status & STATUS_FLAGS.PTT_ACTIVE) !== 0 || state.pttActive === true;
    const emergency = (state.status & STATUS_FLAGS.EMERGENCY) !== 0 || state.emergency === true;
    const warn = (state.status & STATUS_FLAGS.WARN) !== 0 || state.warn === true;
    const signal = Math.max(0, Math.min(100, state.signalQuality ?? 0));

    this._drawSignalArc(ctx, x, y, baseR, signal);

    if (pttActive && this.blinkPhase === 0) {
      this._drawRing(ctx, x, y, baseR + 5, COLOR_PTT, 2.5);
    }

    if (emergency) {
      const pulse = 1 + Math.sin(this.lastFrameTime / 200) * 0.5;
      this._drawRing(ctx, x, y, baseR + 7 + pulse * EMERGENCY_PULSE_RADIUS, COLOR_EMERGENCY, 2.5);
      this._drawRing(ctx, x, y, baseR + 12 + pulse * EMERGENCY_PULSE_RADIUS, COLOR_EMERGENCY, 1.5);
    }

    if (warn && !emergency) {
      ctx.fillStyle = COLOR_WARN;
      ctx.beginPath();
      ctx.arc(x + baseR + 3, y - baseR - 3, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    this._drawChannelBadge(ctx, x, y, baseR, state.channel);

    // Outer ring for visibility on dark bg
    ctx.strokeStyle = emergency ? COLOR_EMERGENCY : 'rgba(229,231,235,0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, baseR * 0.7, 0, Math.PI * 2);
    ctx.stroke();

    // Core dot — larger & brighter
    ctx.fillStyle = emergency ? COLOR_EMERGENCY : (pttActive ? COLOR_PTT : '#e5e7eb');
    ctx.beginPath();
    ctx.arc(x, y, baseR * 0.55, 0, Math.PI * 2);
    ctx.fill();
  }

  _drawSignalArc(ctx, cx, cy, baseR, signal) {
    if (signal <= 0) return;

    const radius = baseR + (signal / 100) * baseR * 1.5;
    const color = getSignalColor(signal);

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.7;

    ctx.beginPath();
    ctx.arc(cx, cy, radius, Math.PI * 0.75, Math.PI * 2.25);
    ctx.stroke();

    ctx.globalAlpha = 1;
  }

  _drawRing(ctx, cx, cy, radius, color, width) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
  }

  _drawChannelBadge(ctx, cx, cy, baseR, channel) {
    const label = `CH-${String(channel ?? 0).padStart(2, '0')}`;

    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';

    const metrics = ctx.measureText(label);
    const padX = 3;
    const w = metrics.width + padX * 2;
    const h = 11;

    const bx = cx + baseR + 1;
    const by = cy - baseR - 1 - h;

    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(bx, by, w, h);

    ctx.fillStyle = '#e5e7eb';
    ctx.fillText(label, bx + padX, by + h - 2);
  }

  // ----------------------------------------------------------
  // HIT TEST
  // ----------------------------------------------------------

  hitTest(screenX, screenY, worldToScreen, viewInfo = {}) {
    if (!this.active) return null;

    const satellite = this.gateway?.state?.satellite;
    if (!satellite) return null;

    const baseR = viewInfo.agentRadius ?? 8;
    const hitRadius = baseR + 6;
    const hitRadiusSq = hitRadius * hitRadius;

    let closest = null;
    let closestDistSq = Infinity;

    for (const agentId in satellite) {
      const state = satellite[agentId];
      if (!state || state.source !== 'virtual_ht') continue;

      const pos = worldToScreen(state.latitude, state.longitude);
      if (!pos) continue;

      const dx = pos.x - screenX;
      const dy = pos.y - screenY;
      const distSq = dx * dx + dy * dy;

      if (distSq <= hitRadiusSq && distSq < closestDistSq) {
        closest = state;
        closestDistSq = distSq;
      }
    }

    return closest;
  }

  // ----------------------------------------------------------
  // TOOLTIP
  // ----------------------------------------------------------

  showTooltip(state, screenX, screenY) {
    if (!state) {
      this._hideTooltip();
      return;
    }

    this._hideTooltip();

    const lastPtt = state.lastSeen ?? Date.now();
    const batt = state.battery == null ? '--' : Math.round(state.battery);
    const sig = Math.round(state.signalQuality ?? 0);
    const ch = String(state.channel ?? 0).padStart(2, '0');
    const id = String(state.agentId ?? 0).padStart(4, '0');

    let statusIcon = '🟢 OK';
    if (state.emergency) statusIcon = '🔴 EMERGENCY';
    else if (state.pttActive) statusIcon = '🟢 TALKING';
    else if (state.warn) statusIcon = '🟡 WARN';

    const el = document.createElement('div');
    el.className = 'ht-radio-tooltip';
    el.innerHTML = `
      <div>📻 CH-${ch} | SIG ${sig}% | LAST PTT: ${timeAgo(lastPtt)}s</div>
      <div>AGT-${id} • BATT ${batt}% • ${statusIcon}</div>
    `;

    Object.assign(el.style, {
      position: 'fixed',
      left: `${screenX}px`,
      top: `${screenY - 60}px`,
      padding: '6px 10px',
      background: 'rgba(0,0,0,0.9)',
      color: '#e5e7eb',
      fontFamily: 'ui-monospace, monospace',
      fontSize: '11px',
      lineHeight: '1.5',
      borderRadius: '6px',
      border: '1px solid #2a3646',
      pointerEvents: 'none',
      zIndex: '9999',
      boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
      whiteSpace: 'nowrap'
    });

    document.body.appendChild(el);

    this.tooltipEl = el;
    this.tooltip = { state, x: screenX, y: screenY };

    this.tooltipTimeout = setTimeout(() => {
      this._hideTooltip();
    }, TOOLTIP_DURATION_MS);
  }

  _positionTooltip() {
    if (!this.tooltipEl || !this.tooltip) return;

    const rect = this.tooltipEl.getBoundingClientRect();
    const padding = 8;

    let x = this.tooltip.x;
    let y = this.tooltip.y - 60;

    if (x + rect.width + padding > window.innerWidth) {
      x = window.innerWidth - rect.width - padding;
    }
    if (x < padding) x = padding;
    if (y < padding) y = padding;

    this.tooltipEl.style.left = `${x}px`;
    this.tooltipEl.style.top = `${y}px`;
  }

  _hideTooltip() {
    if (this.tooltipTimeout !== null) {
      clearTimeout(this.tooltipTimeout);
      this.tooltipTimeout = null;
    }

    if (this.tooltipEl && this.tooltipEl.parentNode) {
      this.tooltipEl.parentNode.removeChild(this.tooltipEl);
    }

    this.tooltipEl = null;
    this.tooltip = null;
  }

  // ----------------------------------------------------------
  // LIFECYCLE
  // ----------------------------------------------------------

  dispose() {
    this._unsubscribe();
    this._hideTooltip();

    if (this._blinkTimer !== null) {
      clearInterval(this._blinkTimer);
      this._blinkTimer = null;
    }

    this.agentCache.clear();

    if (this.layerBtn && this.layerBtn.parentNode) {
      this.layerBtn.parentNode.removeChild(this.layerBtn);
    }

    this.layerBtn = null;
    this.radar = null;
    this.canvas = null;
  }
}

// ============================================================
// SINGLETON
// ============================================================

let _radarLayer = null;

function initRadarLayer(radar, options) {
  if (_radarLayer) {
    _radarLayer.dispose();
  }
  _radarLayer = new HTRadioRadarLayer(radar, options);
  return _radarLayer;
}

function getRadarLayer() {
  return _radarLayer;
}

// Proxy agar bisa dipakai sebagai `radarLayer.render(...)` walau belum di-init
const radarLayer = new Proxy({}, {
  get(_, prop) {
    if (prop === 'HTRadioRadarLayer') return HTRadioRadarLayer;
    if (prop === 'initRadarLayer') return initRadarLayer;
    if (prop === 'getRadarLayer') return getRadarLayer;

    if (!_radarLayer) return undefined;

    const value = _radarLayer[prop];
    return typeof value === 'function'
      ? value.bind(_radarLayer)
      : value;
  }
});

export {
  HTRadioRadarLayer,
  initRadarLayer,
  getRadarLayer,
  radarLayer
};
