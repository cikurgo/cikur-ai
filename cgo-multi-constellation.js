// FILE: cgo-multi-constellation.js
// ═══════════════════════════════════════════════════════════════
// BCGO MULTI-CONSTELLATION REGISTRY — EXPANDED
// Multi-konstelasi · Multi-fungsi · Multi-sumber
// Cakupan: ~17.000 satelit aktif
// Zero dependency · Portable · Testable
// ═══════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────
// SECTION 0: KONSTANTA — KATEGORI
// ─────────────────────────────────────────────────────────────

const FUNCTION = Object.freeze({
  COMMUNICATION: 'communication',
  NAVIGATION:    'navigation',
  WEATHER:       'weather',
  EARTH_OBS:     'earth_obs',
  AMATEUR:       'amateur',
  SCIENCE:       'science',
  MILITARY:      'military',
  DEBRIS:        'debris',
  UNKNOWN:       'unknown',
});

const ORBIT_TYPE = Object.freeze({
  LEO: 'leo',
  MEO: 'meo',
  GEO: 'geo',
  HEO: 'heo',
  UNKNOWN: 'unknown',
});

// Source flag — dari mana TLE bisa diambil
const SOURCE = Object.freeze({
  CELESTRAK:    'celestrak',     // bisa di-load dari Celestrak
  AGGREGATE:    'aggregate',     // gabungan beberapa sumber (partial)
  UNAVAILABLE:  'unavailable',   // tidak publik (militer dll)
  MANUAL:       'manual',        // inject manual
});

// ─────────────────────────────────────────────────────────────
// SECTION 1: REGISTRY KONSTELASI — EXPANDED (~17.000)
// ─────────────────────────────────────────────────────────────
// Struktur:
//   id            : identifier unik
//   name          : nama tampil
//   function      : kategori fungsi
//   orbit         : tipe orbit utama
//   count         : jumlah satelit (estimasi)
//   band          : pita frekuensi (kalau komunikasi)
//   frequency     : frekuensi Hz (kalau komunikasi)
//   celestrakGroup: nama group Celestrak (kalau ada)
//   source        : dari mana TLE bisa diambil
//   priority      : 1 (paling penting) - 10 (paling kurang)
//   active        : apakah satelit masih aktif
//
// Total estimasi: ~17.000

const CONSTELLATION_REGISTRY = Object.freeze({

  // ═══════════════════════════════════════════════════════════════
  // KOMUNIKASI — KOMERSIAL BESAR (~11.000)
  // ═══════════════════════════════════════════════════════════════
  starlink: {
    id: 'starlink', name: 'Starlink',
    function: FUNCTION.COMMUNICATION, orbit: ORBIT_TYPE.LEO,
    count: 10000, active: true,
    band: 'Ku/Ka', frequency: 12e9,
    celestrakGroup: 'starlink',
    source: SOURCE.CELESTRAK, priority: 8,
  },
  oneweb: {
    id: 'oneweb', name: 'OneWeb',
    function: FUNCTION.COMMUNICATION, orbit: ORBIT_TYPE.LEO,
    count: 600, active: true,
    band: 'Ku', frequency: 12e9,
    celestrakGroup: 'oneweb',
    source: SOURCE.CELESTRAK, priority: 9,
  },
  iridium: {
    id: 'iridium', name: 'Iridium',
    function: FUNCTION.COMMUNICATION, orbit: ORBIT_TYPE.LEO,
    count: 80, active: true,
    band: 'L', frequency: 1621.25e6,
    celestrakGroup: 'iridium',
    source: SOURCE.CELESTRAK, priority: 1,
  },
  globalstar: {
    id: 'globalstar', name: 'Globalstar',
    function: FUNCTION.COMMUNICATION, orbit: ORBIT_TYPE.LEO,
    count: 48, active: true,
    band: 'L+S', frequency: 1615e6,
    celestrakGroup: 'globalstar',
    source: SOURCE.CELESTRAK, priority: 2,
  },
  orbcomm: {
    id: 'orbcomm', name: 'Orbcomm',
    function: FUNCTION.COMMUNICATION, orbit: ORBIT_TYPE.LEO,
    count: 30, active: true,
    band: 'VHF', frequency: 137.5e6,
    celestrakGroup: 'orbcomm',
    source: SOURCE.CELESTRAK, priority: 3,
  },

  // ═══════════════════════════════════════════════════════════════
  // KOMUNIKASI — KOMERSIAL MENENGAH (~800)
  // ═══════════════════════════════════════════════════════════════
  planet: {
    id: 'planet', name: 'Planet Labs (Flock/SkySat)',
    function: FUNCTION.EARTH_OBS, orbit: ORBIT_TYPE.LEO,
    count: 200, active: true,
    celestrakGroup: 'planet',
    source: SOURCE.CELESTRAK, priority: 6,
  },
  spire: {
    id: 'spire', name: 'Spire Global',
    function: FUNCTION.WEATHER, orbit: ORBIT_TYPE.LEO,
    count: 100, active: true,
    celestrakGroup: 'spire',
    source: SOURCE.CELESTRAK, priority: 6,
  },
  iceye: {
    id: 'iceye', name: 'ICEYE (SAR)',
    function: FUNCTION.EARTH_OBS, orbit: ORBIT_TYPE.LEO,
    count: 30, active: true,
    celestrakGroup: 'iceye',
    source: SOURCE.CELESTRAK, priority: 7,
  },
  blacksky: {
    id: 'blacksky', name: 'BlackSky',
    function: FUNCTION.EARTH_OBS, orbit: ORBIT_TYPE.LEO,
    count: 20, active: true,
    celestrakGroup: 'blacksky',
    source: SOURCE.CELESTRAK, priority: 7,
  },
  capella: {
    id: 'capella', name: 'Capella Space',
    function: FUNCTION.EARTH_OBS, orbit: ORBIT_TYPE.LEO,
    count: 10, active: true,
    celestrakGroup: 'capella',
    source: SOURCE.CELESTRAK, priority: 7,
  },
  hawk: {
    id: 'hawk', name: 'HawkEye 360',
    function: FUNCTION.EARTH_OBS, orbit: ORBIT_TYPE.LEO,
    count: 20, active: true,
    celestrakGroup: 'hawkeye',
    source: SOURCE.CELESTRAK, priority: 7,
  },
  umbra: {
    id: 'umbra', name: 'Umbra Space (SAR)',
    function: FUNCTION.EARTH_OBS, orbit: ORBIT_TYPE.LEO,
    count: 10, active: true,
    celestrakGroup: 'umbra',
    source: SOURCE.CELESTRAK, priority: 7,
  },
  tdrss: {
    id: 'tdrss', name: 'TDRSS (NASA)',
    function: FUNCTION.COMMUNICATION, orbit: ORBIT_TYPE.GEO,
    count: 10, active: true,
    band: 'Ku/Ka', frequency: 15e9,
    celestrakGroup: 'tdrss',
    source: SOURCE.CELESTRAK, priority: 5,
  },

  // ═══════════════════════════════════════════════════════════════
  // NAVIGASI — GNSS (~150)
  // ═══════════════════════════════════════════════════════════════
  gps: {
    id: 'gps', name: 'GPS (USA)',
    function: FUNCTION.NAVIGATION, orbit: ORBIT_TYPE.MEO,
    count: 31, active: true,
    band: 'L1/L2/L5', frequency: 1575.42e6,
    celestrakGroup: 'gps-ops',
    source: SOURCE.CELESTRAK, priority: 4,
  },
  galileo: {
    id: 'galileo', name: 'Galileo (EU)',
    function: FUNCTION.NAVIGATION, orbit: ORBIT_TYPE.MEO,
    count: 28, active: true,
    band: 'L1/L5', frequency: 1575.42e6,
    celestrakGroup: 'galileo',
    source: SOURCE.CELESTRAK, priority: 5,
  },
  glonass: {
    id: 'glonass', name: 'GLONASS (Russia)',
    function: FUNCTION.NAVIGATION, orbit: ORBIT_TYPE.MEO,
    count: 24, active: true,
    band: 'L1/L2', frequency: 1602e6,
    celestrakGroup: 'glo-ops',
    source: SOURCE.CELESTRAK, priority: 5,
  },
  beidou: {
    id: 'beidou', name: 'BeiDou (China)',
    function: FUNCTION.NAVIGATION, orbit: ORBIT_TYPE.MEO,
    count: 35, active: true,
    band: 'B1/B2', frequency: 1561e6,
    celestrakGroup: 'beidou',
    source: SOURCE.CELESTRAK, priority: 6,
  },
  sbas: {
    id: 'sbas', name: 'SBAS (WAAS/EGNOS)',
    function: FUNCTION.NAVIGATION, orbit: ORBIT_TYPE.GEO,
    count: 10, active: true,
    celestrakGroup: 'sbas',
    source: SOURCE.CELESTRAK, priority: 6,
  },

  // ═══════════════════════════════════════════════════════════════
  // CUACA & OBSERVASI (~150)
  // ═══════════════════════════════════════════════════════════════
  weather: {
    id: 'weather', name: 'Weather (agregat)',
    function: FUNCTION.WEATHER, orbit: ORBIT_TYPE.LEO,
    count: 50, active: true,
    band: 'VHF/L', frequency: 137.5e6,
    celestrakGroup: 'weather',
    source: SOURCE.CELESTRAK, priority: 3,
  },
  noaa: {
    id: 'noaa', name: 'NOAA (USA)',
    function: FUNCTION.WEATHER, orbit: ORBIT_TYPE.LEO,
    count: 5, active: true,
    band: 'VHF', frequency: 137.5e6,
    celestrakGroup: 'noaa',
    source: SOURCE.CELESTRAK, priority: 3,
  },
  goes: {
    id: 'goes', name: 'GOES (USA)',
    function: FUNCTION.WEATHER, orbit: ORBIT_TYPE.GEO,
    count: 4, active: true,
    band: 'L', frequency: 1694.1e6,
    celestrakGroup: 'goes',
    source: SOURCE.CELESTRAK, priority: 7,
  },
  resource: {
    id: 'resource', name: 'Resource (Landsat/Sentinel)',
    function: FUNCTION.EARTH_OBS, orbit: ORBIT_TYPE.LEO,
    count: 30, active: true,
    celestrakGroup: 'resource',
    source: SOURCE.CELESTRAK, priority: 6,
  },
  sarsat: {
    id: 'sarsat', name: 'SARSAT (Search & Rescue)',
    function: FUNCTION.EARTH_OBS, orbit: ORBIT_TYPE.LEO,
    count: 10, active: true,
    celestrakGroup: 'sarsat',
    source: SOURCE.CELESTRAK, priority: 4,
  },
  dmc: {
    id: 'dmc', name: 'DMC (Disaster Monitoring)',
    function: FUNCTION.EARTH_OBS, orbit: ORBIT_TYPE.LEO,
    count: 10, active: true,
    celestrakGroup: 'dmc',
    source: SOURCE.CELESTRAK, priority: 5,
  },

  // ═══════════════════════════════════════════════════════════════
  // AMATIR & STASIUN (~150)
  // ═══════════════════════════════════════════════════════════════
  amateur: {
    id: 'amateur', name: 'Amateur (OSCAR/AMSAT)',
    function: FUNCTION.AMATEUR, orbit: ORBIT_TYPE.LEO,
    count: 100, active: true,
    band: 'VHF/UHF', frequency: 145.8e6,
    celestrakGroup: 'amateur',
    source: SOURCE.CELESTRAK, priority: 4,
  },
  stations: {
    id: 'stations', name: 'Space Stations (ISS/Tiangong)',
    function: FUNCTION.AMATEUR, orbit: ORBIT_TYPE.LEO,
    count: 5, active: true,
    band: 'VHF/UHF', frequency: 145.8e6,
    celestrakGroup: 'stations',
    source: SOURCE.CELESTRAK, priority: 2,
  },

  // ═══════════════════════════════════════════════════════════════
  // SAINS & AKADEMIK (~100)
  // ═══════════════════════════════════════════════════════════════
  science: {
    id: 'science', name: 'Science (HST, TESS)',
    function: FUNCTION.SCIENCE, orbit: ORBIT_TYPE.LEO,
    count: 30, active: true,
    celestrakGroup: 'science',
    source: SOURCE.CELESTRAK, priority: 7,
  },
  education: {
    id: 'education', name: 'Education (universitas)',
    function: FUNCTION.SCIENCE, orbit: ORBIT_TYPE.LEO,
    count: 50, active: true,
    celestrakGroup: 'education',
    source: SOURCE.CELESTRAK, priority: 8,
  },
  engineering: {
    id: 'engineering', name: 'Engineering (test bed)',
    function: FUNCTION.SCIENCE, orbit: ORBIT_TYPE.LEO,
    count: 20, active: true,
    celestrakGroup: 'engineering',
    source: SOURCE.CELESTRAK, priority: 8,
  },

  // ═══════════════════════════════════════════════════════════════
  // CUBESAT & DEPLOYABLE (~3.400)
  // ═══════════════════════════════════════════════════════════════
  cubesat: {
    id: 'cubesat', name: 'CubeSats (agregat)',
    function: FUNCTION.SCIENCE, orbit: ORBIT_TYPE.LEO,
    count: 2400, active: true,
    celestrakGroup: 'cubesat',
    source: SOURCE.CELESTRAK, priority: 9,
  },
  'tle-new': {
    id: 'tle-new', name: 'Recently Launched (30 hari)',
    function: FUNCTION.UNKNOWN, orbit: ORBIT_TYPE.UNKNOWN,
    count: 500, active: true,
    celestrakGroup: 'last-30-days',
    source: SOURCE.CELESTRAK, priority: 9,
  },

  // ═══════════════════════════════════════════════════════════════
  // AGGREGATE — Kombinasi beberapa kelompok (~500)
  // ═══════════════════════════════════════════════════════════════
  'other-comm': {
    id: 'other-comm', name: 'Komunikasi lain',
    function: FUNCTION.COMMUNICATION, orbit: ORBIT_TYPE.LEO,
    count: 200, active: true,
    celestrakGroup: 'other-comm',
    source: SOURCE.AGGREGATE, priority: 9,
  },
  'other-weather': {
    id: 'other-weather', name: 'Cuaca lain',
    function: FUNCTION.WEATHER, orbit: ORBIT_TYPE.LEO,
    count: 100, active: true,
    celestrakGroup: 'other-weather',
    source: SOURCE.AGGREGATE, priority: 9,
  },
  'other-navigation': {
    id: 'other-navigation', name: 'Navigasi lain',
    function: FUNCTION.NAVIGATION, orbit: ORBIT_TYPE.MEO,
    count: 100, active: true,
    celestrakGroup: 'other-navigation',
    source: SOURCE.AGGREGATE, priority: 9,
  },
  gnss: {
    id: 'gnss', name: 'GNSS gabungan',
    function: FUNCTION.NAVIGATION, orbit: ORBIT_TYPE.MEO,
    count: 100, active: true,
    celestrakGroup: 'gnss',
    source: SOURCE.AGGREGATE, priority: 5,
  },

  // ═══════════════════════════════════════════════════════════════
  // MILITER — TIDAK PUBLIK (~2.000, hanya untuk tracking kasar)
  // ═══════════════════════════════════════════════════════════════
  military: {
    id: 'military', name: 'Militer (agregat)',
    function: FUNCTION.MILITARY, orbit: ORBIT_TYPE.LEO,
    count: 2000, active: true,
    celestrakGroup: null, // tidak ada di Celestrak publik
    source: SOURCE.UNAVAILABLE, priority: 10,
  },
});

// ─────────────────────────────────────────────────────────────
// SECTION 1b: TOTAL CAKUPAN
// ─────────────────────────────────────────────────────────────

function getRegistryTotal() {
  let total = 0;
  let bySource = { celestrak: 0, aggregate: 0, unavailable: 0, manual: 0 };
  let byFunction = {};

  for (const id in CONSTELLATION_REGISTRY) {
    const m = CONSTELLATION_REGISTRY[id];
    total += m.count;
    bySource[m.source] = (bySource[m.source] || 0) + m.count;
    byFunction[m.function] = (byFunction[m.function] || 0) + m.count;
  }

  return { total, bySource, byFunction };
}

// ─────────────────────────────────────────────────────────────
// SECTION 2: TLE PARSER
// ─────────────────────────────────────────────────────────────

// Field TLE seperti bstar dan nddot ditulis dengan notasi tersirat:
// tanpa titik desimal eksplisit, diakhiri kode eksponen 1 digit.
// Contoh: " 10270-3" berarti 0.10270 × 10^-3, "-12345-3" berarti -0.12345 × 10^-3,
// "00000-0" berarti 0. parseFloat() biasa TIDAK bisa membaca format ini
// (ia berhenti di tanda "-" dan mengembalikan angka mentahnya), jadi perlu parser khusus.
function parseTLEExponentField(str) {
  const s = (str || '').trim();
  if (!s) return 0;
  const match = s.match(/^([+-]?)(\d+)([+-]\d+)$/);
  if (!match) return 0;
  const [, sign, mantissa, exp] = match;
  const value = parseFloat(`${sign}0.${mantissa}e${exp}`);
  return Number.isFinite(value) ? value : 0;
}

function parseTLE(line1, line2, name = '') {
  if (!line1 || !line2) return null;
  if (line1.length < 69 || line2.length < 69) return null;
  if (!line1.startsWith('1 ') || !line2.startsWith('2 ')) return null;

  try {
    return {
      name: name.trim(),
      catalogNumber: line1.substring(2, 7).trim(),
      classification: line1.substring(7, 8).trim(),
      intlDesignator: line1.substring(9, 17).trim(),
      epochYear: parseInt(line1.substring(18, 20), 10),
      epochDay: parseFloat(line1.substring(20, 32)),
      ndot: parseFloat(line1.substring(33, 43)) || 0,
      nddot: parseTLEExponentField(line1.substring(44, 52)),
      bstar: parseTLEExponentField(line1.substring(53, 61)),
      ephemerisType: parseInt(line1.substring(62, 63), 10) || 0,
      elementNumber: parseInt(line1.substring(64, 68), 10) || 0,
      checksum1: parseInt(line1.substring(68, 69), 10) || 0,
      inclination: parseFloat(line2.substring(8, 16)),
      raan: parseFloat(line2.substring(17, 25)),
      eccentricity: parseFloat('0.' + line2.substring(26, 33).trim()),
      argPerigee: parseFloat(line2.substring(34, 42)),
      meanAnomaly: parseFloat(line2.substring(43, 51)),
      meanMotion: parseFloat(line2.substring(52, 63)),
      revNumber: parseInt(line2.substring(63, 68), 10) || 0,
      checksum2: parseInt(line2.substring(68, 69), 10) || 0,
      raw1: line1,
      raw2: line2,
    };
  } catch (e) {
    return null;
  }
}

function parseTLEBlock(block) {
  const lines = block.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('1 ') && i + 1 < lines.length &&
        lines[i + 1].startsWith('2 ')) {
      const name = i > 0 && !lines[i-1].startsWith('1 ') &&
                   !lines[i-1].startsWith('2 ') ? lines[i-1] : '';
      const tle = parseTLE(lines[i], lines[i+1], name);
      if (tle) result.push(tle);
      i++;
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────
// SECTION 3: KATEGORISASI
// ─────────────────────────────────────────────────────────────

function classifyOrbit(tle) {
  const n = tle.meanMotion;
  const e = tle.eccentricity;
  if (e > 0.25) return ORBIT_TYPE.HEO;
  if (n > 11)    return ORBIT_TYPE.LEO;
  if (n > 2)     return ORBIT_TYPE.MEO;
  if (n >= 0.9 && n <= 1.1) return ORBIT_TYPE.GEO;
  return ORBIT_TYPE.UNKNOWN;
}

function classifyFunction(tle) {
  const name = (tle.name || '').toUpperCase();
  if (/STARLINK/.test(name))     return FUNCTION.COMMUNICATION;
  if (/ONEWEB/.test(name))       return FUNCTION.COMMUNICATION;
  if (/IRIDIUM/.test(name))      return FUNCTION.COMMUNICATION;
  if (/GLOBALSTAR/.test(name))   return FUNCTION.COMMUNICATION;
  if (/ORBCOMM/.test(name))      return FUNCTION.COMMUNICATION;
  if (/NAVSTAR|GPS/.test(name))  return FUNCTION.NAVIGATION;
  if (/GALILEO/.test(name))      return FUNCTION.NAVIGATION;
  if (/GLONASS/.test(name))      return FUNCTION.NAVIGATION;
  if (/BEIDOU/.test(name))       return FUNCTION.NAVIGATION;
  if (/NOAA/.test(name))         return FUNCTION.WEATHER;
  if (/GOES|METEOSAT/.test(name)) return FUNCTION.WEATHER;
  if (/ISS|ZARYA|TIANHE/.test(name)) return FUNCTION.AMATEUR;
  if (/OSCAR|AMSAT/.test(name))  return FUNCTION.AMATEUR;
  if (/HST|HUBBLE|TESS/.test(name)) return FUNCTION.SCIENCE;
  if (/LANDSAT|SENTINEL/.test(name)) return FUNCTION.EARTH_OBS;
  if (/PLANET|FLOCK|SKYSAT/.test(name)) return FUNCTION.EARTH_OBS;
  if (/ICEYE|CAPELLA|UMBRA|HAWK/.test(name)) return FUNCTION.EARTH_OBS;
  if (/DEB|R\/B|DEBRIS/.test(name)) return FUNCTION.DEBRIS;
  return FUNCTION.UNKNOWN;
}

function isRelevantForHT(tle, profile = 'ht_primary') {
  const fn = classifyFunction(tle);
  if (profile === 'ht_primary') {
    return fn === FUNCTION.COMMUNICATION || fn === FUNCTION.AMATEUR;
  }
  if (profile === 'ht_full') {
    return fn === FUNCTION.COMMUNICATION ||
           fn === FUNCTION.AMATEUR ||
           fn === FUNCTION.NAVIGATION;
  }
  if (profile === 'all') return true;
  return false;
}

// ─────────────────────────────────────────────────────────────
// SECTION 4: CACHE
// ─────────────────────────────────────────────────────────────

class TLECache {
  constructor(ttlMs = 2 * 3600 * 1000) {
    this.store = new Map();
    this.ttlMs = ttlMs;
    this.stats = { hits: 0, misses: 0, expired: 0 };
  }
  get(key) {
    const entry = this.store.get(key);
    if (!entry) { this.stats.misses++; return null; }
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.store.delete(key);
      this.stats.expired++;
      return null;
    }
    this.stats.hits++;
    return entry.data;
  }
  set(key, data) {
    this.store.set(key, { data, timestamp: Date.now() });
  }
  clear() {
    this.store.clear();
    this.stats = { hits: 0, misses: 0, expired: 0 };
  }
  size() { return this.store.size; }
  getStats() { return { ...this.stats, size: this.store.size }; }
}

// ─────────────────────────────────────────────────────────────
// SECTION 5: MANAGER
// ─────────────────────────────────────────────────────────────

class MultiConstellationManager {
  constructor(options = {}) {
    this.cache = new TLECache(options.cacheTTLMs);
    this.loaded = new Map();
    this.filterProfile = options.filterProfile ?? 'ht_full';
    this.verbose = options.verbose === true;
    this.fetcher = options.fetcher ?? null;
    this.maxConcurrent = options.maxConcurrent ?? 3;
  }

  async loadConstellation(constellId) {
    const meta = CONSTELLATION_REGISTRY[constellId];
    if (!meta) throw new Error(`Konstelasi tidak dikenal: ${constellId}`);

    const cached = this.cache.get(`tle:${constellId}`);
    if (cached) {
      this.loaded.set(constellId, { ...cached, fromCache: true });
      if (this.verbose) {
        console.log(`[BCGO-MC] ${constellId}: ${cached.tles.length} TLE (cache)`);
      }
      return cached.tles;
    }

    let tles = [];
    if (this.fetcher && meta.celestrakGroup && meta.source !== SOURCE.UNAVAILABLE) {
      try {
        const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${meta.celestrakGroup}&FORMAT=tle`;
        const text = await this.fetcher(url);
        tles = parseTLEBlock(text);
        if (this.verbose) {
          console.log(`[BCGO-MC] ${constellId}: ${tles.length} TLE (network)`);
        }
      } catch (e) {
        if (this.verbose) {
          console.warn(`[BCGO-MC] ${constellId} load gagal:`, e.message);
        }
      }
    }

    const entry = {
      constellId,
      meta,
      tles,
      loadedAt: Date.now(),
      source: tles.length > 0 ? 'network' : (meta.source === SOURCE.UNAVAILABLE ? 'unavailable' : 'empty'),
    };

    this.cache.set(`tle:${constellId}`, entry);
    this.loaded.set(constellId, entry);
    return tles;
  }

  async loadAll(options = {}) {
    const priority = options.priority ?? null;
    const sourceFilter = options.source ?? null;
    const results = {};

    const ids = Object.keys(CONSTELLATION_REGISTRY).filter(id => {
      const m = CONSTELLATION_REGISTRY[id];
      if (priority && m.priority > priority) return false;
      if (sourceFilter && m.source !== sourceFilter) return false;
      return true;
    });

    // Sequential (hindari rate limit)
    for (const id of ids) {
      try {
        const tles = await this.loadConstellation(id);
        results[id] = tles.length;
      } catch (e) {
        results[id] = -1;
      }
    }
    return results;
  }

  injectTLE(constellId, tles) {
    if (!Array.isArray(tles)) throw new TypeError('tles harus array');
    const meta = CONSTELLATION_REGISTRY[constellId];
    if (!meta) throw new Error(`Konstelasi tidak dikenal: ${constellId}`);

    const entry = {
      constellId,
      meta,
      tles,
      loadedAt: Date.now(),
      source: 'inject',
    };
    this.cache.set(`tle:${constellId}`, entry);
    this.loaded.set(constellId, entry);
    return tles.length;
  }

  getAll(filter = {}) {
    const { function: fnFilter, orbit: orbitFilter, relevantOnly } = filter;
    const result = [];
    for (const [constellId, entry] of this.loaded) {
      for (const tle of entry.tles) {
        const fn = classifyFunction(tle);
        const orbit = classifyOrbit(tle);
        if (fnFilter && fn !== fnFilter) continue;
        if (orbitFilter && orbit !== orbitFilter) continue;
        if (relevantOnly && !isRelevantForHT(tle, this.filterProfile)) continue;
        result.push({ ...tle, constellId, function: fn, orbit });
      }
    }
    return result;
  }

  getCoverage() {
    const summary = {
      constellationsLoaded: this.loaded.size,
      constellationsTotal: Object.keys(CONSTELLATION_REGISTRY).length,
      totalSatellites: 0,
      byFunction: {},
      byOrbit: {},
      byConstellation: {},
      lastLoad: null,
    };
    for (const [id, entry] of this.loaded) {
      summary.byConstellation[id] = entry.tles.length;
      summary.totalSatellites += entry.tles.length;
      if (!summary.lastLoad || entry.loadedAt > summary.lastLoad) {
        summary.lastLoad = entry.loadedAt;
      }
      for (const tle of entry.tles) {
        const fn = classifyFunction(tle);
        const orbit = classifyOrbit(tle);
        summary.byFunction[fn] = (summary.byFunction[fn] || 0) + 1;
        summary.byOrbit[orbit] = (summary.byOrbit[orbit] || 0) + 1;
      }
    }
    return summary;
  }

  clear() {
    this.cache.clear();
    this.loaded.clear();
  }
}

// ─────────────────────────────────────────────────────────────
// SECTION 6: VALIDATION
// ─────────────────────────────────────────────────────────────

function validateTLE(tle) {
  if (!tle) return false;
  const required = ['inclination', 'raan', 'eccentricity', 'meanMotion', 'meanAnomaly'];
  for (const k of required) {
    if (!Number.isFinite(tle[k])) return false;
  }
  if (tle.meanMotion <= 0) return false;
  if (tle.eccentricity < 0 || tle.eccentricity >= 1) return false;
  return true;
}

function filterValidTLE(tles) {
  return tles.filter(validateTLE);
}

// ─────────────────────────────────────────────────────────────
// SECTION 7: FACADE
// ─────────────────────────────────────────────────────────────

function createManager(options = {}) {
  return new MultiConstellationManager(options);
}

async function quickLoad(profile = 'ht_full', fetcher = null) {
  const mgr = new MultiConstellationManager({ filterProfile: profile, fetcher });
  await mgr.loadAll();
  return mgr;
}

// ─────────────────────────────────────────────────────────────
// SECTION 8: SELF-TEST
// ─────────────────────────────────────────────────────────────

function runSelfTest() {
  const results = [];
  const assert = (name, cond, info = '') => {
    results.push({ name, pass: !!cond, info });
  };

  // Parser
  const sampleTLE1 = '1 25544U 98067A   24001.50000000  .00016717  00000-0  10270-3 0  9992';
  const sampleTLE2 = '2 25544  51.6416  62.3955 0004672  84.0683  46.4058 15.49815343 12345';
  const tle = parseTLE(sampleTLE1, sampleTLE2, 'ISS (ZARYA)');
  assert('TLE parser: ISS', tle && tle.catalogNumber === '25544', tle?.catalogNumber);
  assert('TLE inclination', tle && Math.abs(tle.inclination - 51.6416) < 1e-4);
  assert('TLE mean motion', tle && Math.abs(tle.meanMotion - 15.49815343) < 1e-8);
  assert('TLE bstar (notasi eksponen)', tle && Math.abs(tle.bstar - 0.00010270) < 1e-9, tle?.bstar);

  // Classifier
  assert('Classify LEO', classifyOrbit(tle) === ORBIT_TYPE.LEO);
  assert('Classify ISS = AMATEUR', classifyFunction(tle) === FUNCTION.AMATEUR);

  const iridiumTLE = { ...tle, name: 'IRIDIUM 100' };
  assert('IRIDIUM = COMMUNICATION', classifyFunction(iridiumTLE) === FUNCTION.COMMUNICATION);
  assert('IRIDIUM relevant HT', isRelevantForHT(iridiumTLE, 'ht_primary'));

  // Registry coverage
  const total = getRegistryTotal();
  assert('Registry total ≥ 17000', total.total >= 17000, `total=${total.total}`);
  assert('Starlink count 10000', CONSTELLATION_REGISTRY.starlink.count === 10000);
  assert('Registry ≥ 30 entries', Object.keys(CONSTELLATION_REGISTRY).length >= 30,
    `count=${Object.keys(CONSTELLATION_REGISTRY).length}`);

  // Coverage by source
  assert('Celestrak count > 10000', total.bySource.celestrak > 10000,
    `celestrak=${total.bySource.celestrak}`);
  assert('Unavailable > 0 (militer)', total.bySource.unavailable > 0);

  // Cache
  const cache = new TLECache(100);
  cache.set('k', { v: 1 });
  assert('Cache set/get', cache.get('k')?.v === 1);

  // Manager
  const mgr = createManager();
  mgr.injectTLE('iridium', [iridiumTLE, { ...iridiumTLE, catalogNumber: '2' }]);
  assert('Manager getAll', mgr.getAll().length === 2);

  const cov = mgr.getCoverage();
  assert('Coverage total', cov.totalSatellites === 2);

  // Validation
  assert('validateTLE valid', validateTLE(tle));
  assert('validateTLE null', !validateTLE(null));

  const pass = results.filter(r => r.pass).length;
  const fail = results.filter(r => !r.pass).length;

  return {
    pass, fail, total: results.length,
    verified: fail === 0,
    results,
    registry: getRegistryTotal(),
  };
}

// ─────────────────────────────────────────────────────────────
// SECTION 9: EXPORT
// ─────────────────────────────────────────────────────────────

export {
  FUNCTION,
  ORBIT_TYPE,
  SOURCE,
  CONSTELLATION_REGISTRY,
  getRegistryTotal,
  parseTLE,
  parseTLEBlock,
  parseTLEExponentField,
  classifyOrbit,
  classifyFunction,
  isRelevantForHT,
  validateTLE,
  filterValidTLE,
  TLECache,
  MultiConstellationManager,
  createManager,
  quickLoad,
  runSelfTest,
};

// Jalankan self-test otomatis saat file dieksekusi langsung (bukan saat di-import)
const __isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch (e) {
    return false;
  }
})();
if (__isMain) {
  const report = runSelfTest();
  console.log(`[BCGO-MC] Self-test: ${report.pass}/${report.total} lolos`);
  if (!report.verified) {
    for (const r of report.results) {
      if (!r.pass) console.log(`  ✗ ${r.name} ${r.info ? '(' + r.info + ')' : ''}`);
    }
  }
  console.log('[BCGO-MC] Total registry:', report.registry.total, 'satelit');
}
