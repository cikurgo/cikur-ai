// FILE: chat-radio-formatter.js | DEPS: none | EXPORTS: formatRadioTransmission, formatRadioAlert, getSignalBars, shouldAutoScroll, injectRadioStyles, RADIO_CSS

import { STATUS_FLAGS } from './ht-protocol.js';

// ============================================================
// KONSTANTA
// ============================================================

const SIGNAL_BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const SIGNAL_BAR_COUNT = SIGNAL_BARS.length;

const ALERT_PREFIXES = Object.freeze({
  collision:   '⚠️',
  emergency:   '🔴',
  weak_signal: '📶',
  gps_loss:    '🛰️',
  battery_low: '🔋',
  info:        '📻',
  warning:     '🟡'
});

const ALERT_LABELS = Object.freeze({
  collision:   'COLLISION',
  emergency:   'EMERGENCY',
  weak_signal: 'WEAK SIGNAL',
  gps_loss:    'GPS LOST',
  battery_low: 'BATTERY LOW',
  info:        'INFO',
  warning:     'WARNING'
});

// ============================================================
// SIGNAL BARS
// ============================================================

/**
 * Konversi 0-100 ke string unicode block (1-8 karakter).
 * idx = floor(n / 12.5), di-clamp ke 0..7
 */
function getSignalBars(n) {
  const value = Math.max(0, Math.min(100, Number(n) || 0));
  const idx = Math.min(SIGNAL_BAR_COUNT - 1, Math.floor(value / 12.5));

  // Isi dari bar terendah sampai idx (biar visualnya "tumbuh")
  let result = '';
  for (let i = 0; i <= idx; i++) {
    result += SIGNAL_BARS[i];
  }

  return result || SIGNAL_BARS[0];
}

// ============================================================
// STATUS LABEL
// ============================================================

function resolveStatusLabel(state) {
  const status = Number(state.status) || 0;

  if (status & STATUS_FLAGS.EMERGENCY) return 'EMERGENCY';
  if (status & STATUS_FLAGS.PTT_ACTIVE) return 'TALKING';
  if (status & STATUS_FLAGS.WARN) return 'WARN';
  if (status & STATUS_FLAGS.GPS_INVALID) return 'NO-GPS';

  return 'STANDBY';
}

function resolveStatusEmoji(state) {
  const status = Number(state.status) || 0;

  if (status & STATUS_FLAGS.EMERGENCY) return '🔴';
  if (status & STATUS_FLAGS.PTT_ACTIVE) return '🟢';
  if (status & STATUS_FLAGS.WARN) return '🟡';
  if (status & STATUS_FLAGS.GPS_INVALID) return '⚪';

  return '⚫';
}

// ============================================================
// FORMATTERS
// ============================================================

/**
 * Format utama untuk transmisi radio.
 *
 * Contoh output:
 *   [CH-07] AGT-0042 • 🟢 TALKING • SIG ▆▇█ • BATT 85% • OVER
 */
function formatRadioTransmission(state) {
  if (!state || typeof state !== 'object') {
    return '[CH-??] AGT-???? • INVALID • OVER';
  }

  const ch = String(Number(state.channel) || 0).padStart(2, '0');
  const id = String(Number(state.agentId) || 0).padStart(4, '0');
  const emoji = resolveStatusEmoji(state);
  const statusLabel = resolveStatusLabel(state);
  const bars = getSignalBars(state.signalQuality);
  const sig = Math.round(Number(state.signalQuality) || 0);

  const batt =
    state.battery == null
      ? '--%'
      : `${Math.round(state.battery)}%`;

  return `[CH-${ch}] AGT-${id} • ${emoji} ${statusLabel} • SIG ${bars} ${sig}% • BATT ${batt} • OVER`;
}

/**
 * Format alert pendek untuk event khusus.
 *
 * Contoh output:
 *   ⚠️ [CH-03] COLLISION DETECTED
 *   🔴 [CH-07] EMERGENCY — AGT-0042
 */
function formatRadioAlert(type, channel, meta = {}) {
  const prefix = ALERT_PREFIXES[type] ?? '📻';
  const label = ALERT_LABELS[type] ?? 'ALERT';
  const ch = String(Number(channel) || 0).padStart(2, '0');

  let suffix = '';

  if (type === 'emergency' && meta.agentId != null) {
    const id = String(Number(meta.agentId) || 0).padStart(4, '0');
    suffix = ` — AGT-${id}`;
  } else if (type === 'collision' && meta.count != null) {
    suffix = ` ×${meta.count}`;
  } else if (type === 'weak_signal' && meta.signal != null) {
    suffix = ` (${Math.round(meta.signal)}%)`;
  } else if (type === 'battery_low' && meta.battery != null) {
    suffix = ` (${Math.round(meta.battery)}%)`;
  } else if (meta.agentId != null) {
    const id = String(Number(meta.agentId) || 0).padStart(4, '0');
    suffix = ` — AGT-${id}`;
  }

  return `${prefix} [CH-${ch}] ${label}${suffix}`;
}

// ============================================================
// AUTO-SCROLL LOGIC
// ============================================================

/**
 * Return true jika chat sebaiknya auto-scroll ke bawah.
 * Aturan: user sedang di bottom ATAU pesan emergency.
 */
function shouldAutoScroll(chatEl, isEmergency = false) {
  if (isEmergency) return true;
  if (!chatEl) return true;

  const threshold = 20;
  const distanceFromBottom =
    chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight;

  return distanceFromBottom <= threshold;
}

// ============================================================
// STYLING
// ============================================================

const RADIO_CSS = `
.msg-radio {
  font-family: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace;
  background: rgba(0, 0, 0, 0.3);
  border-left: 3px solid var(--channel-color, #4ade80);
  padding: 2px 8px;
  font-size: 12px;
  line-height: 1.4;
  color: #e5e7eb;
  white-space: pre-wrap;
  word-break: break-word;
}

.msg-radio.msg-radio-emergency {
  border-left-color: #ef4444;
  background: rgba(239, 68, 68, 0.15);
  animation: radio-pulse 1.2s ease-in-out infinite;
}

.msg-radio.msg-radio-collision {
  border-left-color: #f59e0b;
  background: rgba(245, 158, 11, 0.1);
}

@keyframes radio-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.6; }
}

.radio-new-msg-badge {
  position: absolute;
  bottom: 60px;
  left: 50%;
  transform: translateX(-50%);
  background: #4ade80;
  color: #000;
  font-family: ui-monospace, monospace;
  font-size: 11px;
  padding: 4px 10px;
  border-radius: 12px;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0,0,0,0.4);
  z-index: 100;
  animation: badge-in 0.2s ease-out;
}

@keyframes badge-in {
  from { opacity: 0; transform: translateX(-50%) translateY(8px); }
  to   { opacity: 1; transform: translateX(-50%) translateY(0); }
}
`;

const STYLE_ELEMENT_ID = 'bcgo-radio-styles';
let _stylesInjected = false;

/**
 * Inject CSS ke document.head sekali saja.
 * Return true kalau baru di-inject, false kalau sudah ada.
 */
function injectRadioStyles() {
  if (_stylesInjected) return false;
  if (typeof document === 'undefined') return false;

  // Cek apakah sudah ada di DOM (kasus hot reload)
  if (document.getElementById(STYLE_ELEMENT_ID)) {
    _stylesInjected = true;
    return false;
  }

  const style = document.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.textContent = RADIO_CSS;
  document.head.appendChild(style);

  _stylesInjected = true;
  return true;
}

// ============================================================
// EXPORTS
// ============================================================

export {
  formatRadioTransmission,
  formatRadioAlert,
  getSignalBars,
  shouldAutoScroll,
  injectRadioStyles,
  RADIO_CSS,
  ALERT_PREFIXES,
  ALERT_LABELS,
  SIGNAL_BARS
};
