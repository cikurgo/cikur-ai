"use strict";

/*
 * CIKUR GO v3.0 extension layer.
 * The v2 core remains intact; this module adds the v3 APIs without
 * duplicating the language dictionaries and emoji registry.
 */

module.exports = function installV3(core) {
  const baseAngkaKeKata = core.angkaKeKata;
  const baseAngkaKeKataLengkap = core.angkaKeKataLengkap;
  const baseLafalWarna = core.lafalWarna;
  const baseAudit = core.uraiAudit;
  const baseUrai = core.urai;
  const baseToken = core.uraiToken;

  const SCALE_NAMES = {
    id: ["", "ribu", "juta", "miliar", "triliun", "kuadriliun", "kuintiliun", "sekstiliun", "septiliun", "oktiliun", "noniliun", "desiliun"],
    en: ["", "thousand", "million", "billion", "trillion", "quadrillion", "quintillion", "sextillion", "septillion", "octillion", "nonillion", "decillion"],
    es: ["", "mil", "millón", "mil millones", "billón", "mil billones", "trillón", "mil trillones"],
    fr: ["", "mille", "million", "milliard", "billion", "billiard", "trillion"],
    de: ["", "tausend", "Millionen", "Milliarden", "Billionen", "Billiarden", "Trillionen"],
    pt: ["", "mil", "milhão", "bilhão", "trilhão", "quadrilhão", "quintilhão"],
    ar: ["", "alf", "milyun", "milyar", "trilyun", "ruba milyun", "sitt milyun"],
    ja: ["", "sen", "man", "oku", "chou", "kei", "gai", "jo", "jō"]
  };

  function cleanBigIntString(value) {
    const raw = String(value).trim().replace(/n$/i, "").replace(/_/g, "");
    if (!/^[+-]?\d+$/.test(raw)) {
      throw new TypeError(`Angka presisi tinggi harus berupa integer: ${value}`);
    }
    return raw;
  }

  function groupWords(group, language, scaleIndex) {
    if (group === 0n) return "";
    let result = baseAngkaKeKata(Number(group), language);
    if (language === "id" && scaleIndex === 1 && group === 1n) return "seribu";
    const scale = SCALE_NAMES[language]?.[scaleIndex];
    const label = scale === undefined ? `10^${scaleIndex * 3}` : scale;
    return `${result}${label ? ` ${label}` : ""}`;
  }

  function bigIntToWords(value, language = "id") {
    const b = String(language || "id").toLowerCase();
    if (!SCALE_NAMES[b]) throw new Error(`Bahasa '${b}' tidak didukung.`);
    const raw = cleanBigIntString(value);
    const negative = raw.startsWith("-");
    let digits = raw.replace(/^[+-]/, "");
    digits = digits.replace(/^0+(?=\d)/, "");
    if (digits === "0") return baseAngkaKeKata(0, b);

    let number = BigInt(digits);
    const groups = [];
    while (number > 0n) {
      groups.push(number % 1000n);
      number /= 1000n;
    }
    const parts = [];
    for (let i = groups.length - 1; i >= 0; i--) {
      if (groups[i] !== 0n) parts.push(groupWords(groups[i], b, i));
    }
    const result = parts.join(" ");
    if (!negative) return result;
    const sign = core.REG_BHS[b]?.kata_min || "minus";
    return `${sign} ${result}`;
  }

  function angkaKeKataPresisi(value, language = "id") {
    const raw = String(value).trim().replace(",", ".");
    const match = raw.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
    if (!match) throw new TypeError(`Format angka tidak valid: ${value}`);
    const sign = match[1] === "-" ? "-" : "";
    const integer = bigIntToWords(`${sign}${match[2]}`, language);
    if (!match[3]) return integer;
    const b = String(language || "id").toLowerCase();
    const separator = core.REG_BHS[b]?.kata_koma || "koma";
    const digits = [...match[3]].map((digit) => baseAngkaKeKata(Number(digit), b)).join(" ");
    return `${integer} ${separator} ${digits}`;
  }

  function angkaKeKataV3(value, language = "id") {
    if (typeof value === "bigint") return bigIntToWords(value, language);
    if (typeof value === "string" && /^[+-]?\d{16,}$/.test(value.trim())) {
      return bigIntToWords(value, language);
    }
    return baseAngkaKeKata(value, language);
  }

  function angkaKeKataLengkapV3(value, language = "id") {
    if (typeof value === "bigint" || (typeof value === "string" && /^[+-]?\d{16,}$/.test(value.trim()))) {
      return ["angka", bigIntToWords(value, language), "presisi tinggi"];
    }
    return baseAngkaKeKataLengkap(value, language);
  }

  const TIME_WORDS = {
    id: { hour: "jam", minute: "menit", second: "detik", at: "pukul" },
    en: { hour: "hour", minute: "minute", second: "second", at: "at" },
    es: { hour: "hora", minute: "minuto", second: "segundo", at: "a las" },
    fr: { hour: "heure", minute: "minute", second: "seconde", at: "à" },
    de: { hour: "Stunde", minute: "Minute", second: "Sekunde", at: "um" },
    pt: { hour: "hora", minute: "minuto", second: "segundo", at: "às" },
    ar: { hour: "sa'a", minute: "daqiiqa", second: "thaniya", at: "fi" },
    ja: { hour: "ji", minute: "fun", second: "byou", at: "jikan" }
  };

  function numberForWords(value, language) {
    return angkaKeKataV3(value, language);
  }

  function parseClock(value) {
    if (value instanceof Date) {
      return { hour: value.getHours(), minute: value.getMinutes(), second: value.getSeconds() };
    }
    const match = String(value).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) throw new TypeError(`Format waktu tidak valid: ${value}`);
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    const second = Number(match[3] || 0);
    if (hour > 23 || minute > 59 || second > 59) throw new RangeError(`Waktu di luar rentang: ${value}`);
    return { hour, minute, second };
  }

  function waktuKeKata(value, language = "id", options = {}) {
    const b = String(language || "id").toLowerCase();
    const time = parseClock(value);
    const words = TIME_WORDS[b] || TIME_WORDS.id;
    const result = [`${words.at} ${numberForWords(time.hour, b)} ${words.hour}`];
    if (time.minute || options.includeZeroMinutes) result.push(`${numberForWords(time.minute, b)} ${words.minute}`);
    if (time.second || options.includeSeconds) result.push(`${numberForWords(time.second, b)} ${words.second}`);
    return result.join(" ");
  }

  function parseDuration(value) {
    if (typeof value === "number" || typeof value === "bigint") {
      let seconds = Number(value);
      if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError(`Durasi tidak valid: ${value}`);
      const hour = Math.floor(seconds / 3600);
      seconds -= hour * 3600;
      const minute = Math.floor(seconds / 60);
      return { hour, minute, second: seconds - minute * 60 };
    }
    if (value && typeof value === "object") {
      return {
        hour: Number(value.hour ?? value.hours ?? 0),
        minute: Number(value.minute ?? value.minutes ?? 0),
        second: Number(value.second ?? value.seconds ?? 0)
      };
    }
    const match = String(value).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
    if (!match) throw new TypeError(`Format durasi tidak valid: ${value}`);
    if (match[1] === undefined) return { hour: 0, minute: Number(match[2]), second: Number(match[3]) };
    return { hour: Number(match[1]), minute: Number(match[2]), second: Number(match[3]) };
  }

  function durasiKeKata(value, language = "id") {
    const b = String(language || "id").toLowerCase();
    const duration = parseDuration(value);
    if (duration.minute > 59 || duration.second > 59) throw new RangeError(`Durasi tidak valid: ${value}`);
    const words = TIME_WORDS[b] || TIME_WORDS.id;
    const parts = [];
    if (duration.hour) parts.push(`${numberForWords(duration.hour, b)} ${words.hour}`);
    if (duration.minute) parts.push(`${numberForWords(duration.minute, b)} ${words.minute}`);
    if (duration.second || !parts.length) parts.push(`${numberForWords(duration.second, b)} ${words.second}`);
    return parts.join(" ");
  }

  const CURRENCY_NAMES = {
    IDR: { id: "rupiah", en: "Indonesian rupiah", es: "rupia indonesia", fr: "roupie indonésienne", de: "indonesische Rupiah", pt: "rupia indonésia", ar: "rupia", ja: "ルピア" },
    USD: { id: "dolar", en: "dollars", es: "dólares", fr: "dollars", de: "Dollar", pt: "dólares", ar: "dular", ja: "doru" },
    EUR: { id: "euro", en: "euros", es: "euros", fr: "euros", de: "Euro", pt: "euros", ar: "yuru", ja: "yuro" },
    JPY: { id: "yen", en: "Japanese yen", es: "yenes", fr: "yens", de: "Yen", pt: "ienes", ar: "yen", ja: "en" },
    GBP: { id: "pound sterling", en: "pounds", es: "libras", fr: "livres", de: "Pfund", pt: "libras", ar: "jnih", ja: "pondo" }
  };
  const CURRENCY_MINOR = { IDR: "sen", USD: "cents", EUR: "cents", JPY: "", GBP: "pence" };

  function decimalParts(value) {
    let raw = String(value).trim().replace(/\s/g, "");
    const negative = raw.startsWith("-");
    raw = raw.replace(/^[+-]/, "");
    if (!/^\d[\d.,]*$/.test(raw)) throw new TypeError(`Nilai uang tidak valid: ${value}`);
    if (raw.includes(",") && raw.includes(".")) {
      const decimal = raw.lastIndexOf(",") > raw.lastIndexOf(".") ? "," : ".";
      const grouping = decimal === "," ? /\./g : /,/g;
      raw = raw.replace(grouping, "").replace(decimal, ".");
    } else if (/,(\d{1,2})$/.test(raw)) {
      raw = raw.replace(",", ".");
    } else {
      raw = raw.replace(/[.,]/g, "");
    }
    const [integer, fraction = ""] = raw.split(".");
    return { negative, integer: integer || "0", fraction: fraction.padEnd(2, "0").slice(0, 2) };
  }

  function uangKeKata(value, currency = "IDR", language = "id") {
    const code = String(currency).toUpperCase();
    const b = String(language || "id").toLowerCase();
    if (!CURRENCY_NAMES[code]) throw new Error(`Mata uang '${code}' belum didukung.`);
    const parts = decimalParts(value);
    const whole = bigIntToWords(`${parts.negative ? "-" : ""}${parts.integer}`, b);
    const name = CURRENCY_NAMES[code][b] || CURRENCY_NAMES[code].en;
    const minor = Number(parts.fraction);
    const minorName = CURRENCY_MINOR[code];
    if (!minor || !minorName) return `${whole} ${name}`;
    return `${whole} ${name} ${core.REG_BHS[b]?.kata_dan || "dan"} ${numberForWords(minor, b)} ${minorName}`;
  }

  const UNIT_NAMES = {
    kg: { id: "kilogram", en: "kilogram", es: "kilogramo", fr: "kilogramme", de: "Kilogramm", pt: "quilograma", ar: "kilogram", ja: "kiroguramu" },
    g: { id: "gram", en: "gram", es: "gramo", fr: "gramme", de: "Gramm", pt: "grama", ar: "gram", ja: "guramu" },
    km: { id: "kilometer", en: "kilometer", es: "kilómetro", fr: "kilomètre", de: "Kilometer", pt: "quilômetro", ar: "kilumitr", ja: "kirometeru" },
    m: { id: "meter", en: "meter", es: "metro", fr: "mètre", de: "Meter", pt: "metro", ar: "mitr", ja: "metoru" },
    cm: { id: "sentimeter", en: "centimeter", es: "centímetro", fr: "centimètre", de: "Zentimeter", pt: "centímetro", ar: "santimetr", ja: "sentimetoru" },
    l: { id: "liter", en: "liter", es: "litro", fr: "litre", de: "Liter", pt: "litro", ar: "litr", ja: "rittoru" },
    ml: { id: "mililiter", en: "milliliter", es: "mililitro", fr: "millilitre", de: "Milliliter", pt: "mililitro", ar: "millilitr", ja: "millirittoru" },
    c: { id: "derajat Celsius", en: "degrees Celsius", es: "grados Celsius", fr: "degrés Celsius", de: "Grad Celsius", pt: "graus Celsius", ar: "darajat Celsius", ja: "do C" },
    "%": { id: "persen", en: "percent", es: "por ciento", fr: "pour cent", de: "Prozent", pt: "por cento", ar: "bil-mia", ja: "paasento" }
  };

  function satuanKeKata(value, language = "id") {
    const match = String(value).trim().match(/^(-?(?:\d+(?:[.,]\d+)?))\s*([a-zA-Z%°]+)$/);
    if (!match) throw new TypeError(`Format satuan tidak valid: ${value}`);
    let unit = match[2].toLowerCase().replace("°", "");
    if (unit === "c") unit = "c";
    if (!UNIT_NAMES[unit]) throw new Error(`Satuan '${match[2]}' belum didukung.`);
    const b = String(language || "id").toLowerCase();
    const number = angkaKeKataV3(match[1], b);
    return `${number} ${UNIT_NAMES[unit][b] || UNIT_NAMES[unit].en}`;
  }

  function hslToRgb(h, s, l) {
    s /= 100; l /= 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c / 2;
    const rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return rgb.map((v) => Math.round((v + m) * 255));
  }

  function lafalWarnaV3(value, language = "id") {
    const text = String(value).trim();
    const lower = text.toLowerCase();
    let match = lower.match(/^#([0-9a-f]{4}|[0-9a-f]{8})$/);
    if (match) {
      const expanded = match[1].length === 4
        ? [...match[1]].map((char) => char + char).join("")
        : match[1];
      const base = baseLafalWarna(`#${expanded.slice(0, 6)}`, language);
      const alpha = parseInt(expanded.slice(6, 8), 16) / 255;
      return [`${base[0]} ${core.angkaKeKata(Math.round(alpha * 100), language)} persen opasitas`, "tinggi", 1, "css hex alpha"];
    }
    match = lower.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/);
    if (match) {
      const rgb = baseLafalWarna(`rgb(${match[1]},${match[2]},${match[3]})`, language);
      if (match[4] === undefined) return rgb;
      const alpha = Math.max(0, Math.min(1, Number(match[4])));
      return [`${rgb[0]} ${core.angkaKeKata(Math.round(alpha * 100), language)} persen opasitas`, "tinggi", 1, "css rgba"];
    }
    match = lower.match(/^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%(?:\s*,\s*([\d.]+))?\s*\)$/);
    if (match) {
      const rgb = hslToRgb(Number(match[1]) % 360, Number(match[2]), Number(match[3]));
      const base = baseLafalWarna(`rgb(${rgb[0]},${rgb[1]},${rgb[2]})`, language);
      if (match[4] === undefined) return base;
      const alpha = Math.max(0, Math.min(1, Number(match[4])));
      return [`${base[0]} ${core.angkaKeKata(Math.round(alpha * 100), language)} persen opasitas`, "tinggi", 1, "css hsla"];
    }
    return baseLafalWarna(value, language);
  }

  function addTokenOffsets(result) {
    let cursor = 0;
    const original = String(result.teks_asli);
    for (const token of result.token) {
      const index = original.indexOf(token.asli, cursor);
      const start = index < 0 ? cursor : index;
      token.start = start;
      token.end = start + token.asli.length;
      token.normalized = token.asli.normalize("NFKC");
      cursor = token.end;
    }
    return result;
  }

  function uraiAuditV3(text, mode = "auto", language = "id", onFallback = null) {
    return addTokenOffsets(baseAudit(text, mode, language, onFallback));
  }

  function richExact(text, language) {
    const value = String(text).trim();
    if (/^(?:Rp|IDR|USD|EUR|JPY|GBP)\s*[-+]?\d[\d.,]*$/i.test(value)) {
      const match = value.match(/^(?:Rp|IDR|USD|EUR|JPY|GBP)/i);
      const currency = match[0].toUpperCase() === "RP" ? "IDR" : match[0].toUpperCase();
      return ["uang", uangKeKata(value.slice(match[0].length), currency, language)];
    }
    if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(value)) return ["waktu", waktuKeKata(value, language)];
    if (/^(?:\d+:)?\d{1,2}:\d{2}$/.test(value)) return ["durasi", durasiKeKata(value, language)];
    if (/^-?\d+(?:[.,]\d+)?\s*[a-zA-Z%°]+$/.test(value)) return ["satuan", satuanKeKata(value, language)];
    return null;
  }

  function makeRichAudit(text, language, type, pronunciation) {
    const token = new core.TokenHasil(type, String(text), pronunciation, "tinggi", 1, "v3");
    token.start = 0;
    token.end = String(text).length;
    token.normalized = String(text).normalize("NFKC");
    return new core.HasilUrai({
      teks_asli: String(text),
      teks_hasil: pronunciation,
      bahasa: language,
      mode: "auto",
      kebijakan: "longgar",
      token: [token],
      skor: 1,
      catatan_input: [],
      log_fallback: []
    });
  }

  function uraiV3(text, mode = "auto", language = "id", audit = false, onFallback = null) {
    const b = String(language || "id").toLowerCase();
    if (String(mode).toLowerCase() === "auto") {
      const rich = richExact(text, b);
      if (rich) return audit ? makeRichAudit(text, b, rich[0], rich[1]) : rich[1];
    }
    const result = uraiAuditV3(text, mode, b, onFallback);
    return audit ? result : result.teks_hasil;
  }

  function uraiTokenV3(text, mode = "auto", language = "id") {
    return uraiAuditV3(text, mode, language).token
      .filter((token) => token.jenis !== "spasi")
      .map((token) => [token.jenis, token.asli, token.lafal, token.start, token.end]);
  }

  const api = core;

  // Lapis 1.3/1.4: subclass instead of monkey-patch, Object.assign style
  class CIKURGO_V3 extends (api.CIKURGO || class {}) {
    constructor(bahasa = "id", nama = "CIKUR GO") {
      super(bahasa, nama);
      this.bahasa = bahasa;
      this.nama = nama;
    }
    angka(value, language) { return angkaKeKataV3(value, language || this.bahasa); }
    angkaLengkap(value, language) { return angkaKeKataLengkapV3(value, language || this.bahasa); }
    waktu(value, language) { return waktuKeKata(value, language || this.bahasa); }
    durasi(value, language) { return durasiKeKata(value, language || this.bahasa); }
    uang(value, currency, language) { return uangKeKata(value, currency, language || this.bahasa); }
    satuan(value, language) { return satuanKeKata(value, language || this.bahasa); }
    warna(value, language) { return lafalWarnaV3(value, language || this.bahasa)[0]; }
    urai(value, mode = "auto", audit = false, language, onFallback = null) {
      return uraiV3(value, mode, language || this.bahasa, audit, onFallback);
    }
    uraiToken(value, mode = "auto", language) {
      return baseToken(value, mode, language || this.bahasa);
    }
    uraiTokenDetail(value, mode = "auto", language) {
      return uraiTokenV3(value, mode, language || this.bahasa);
    }
    info() {
      return `== ${this.nama} v3.0 ==\nBahasa : ${api.BAHASA_DIDUKUNG.join(", ")}\nMode   : ${api.MODE_DIDUKUNG.join(", ")}\nEmoji  : ${Object.keys(api.EMOJI_REG || {}).length} entri\nWarna  : ${Object.keys(api.WARNA || {}).length} warna × ${api.BAHASA_DIDUKUNG.length} bahasa\nFitur  : BigInt, waktu, durasi, uang, satuan, CSS color, token offset, kognisi\nSifat  : offline, tanpa API eksternal.`;
    }
  }

  // Object.assign to new object — do not mutate original core references beyond api
  const enriched = Object.assign({}, api, {
    VERSION: "3.0.0",
    version: "3.0.0",
    angkaKeKata: angkaKeKataV3,
    angkaKeKataPresisi,
    angkaKeKataBigInt: bigIntToWords,
    angkaKeKataLengkap: angkaKeKataLengkapV3,
    waktuKeKata,
    durasiKeKata,
    uangKeKata,
    satuanKeKata,
    lafalWarna: lafalWarnaV3,
    uraiAudit: uraiAuditV3,
    urai: uraiV3,
    uraiToken: baseToken,
    uraiPerToken: baseToken,
    uraiPerKata: baseToken,
    uraiTokenDetail: uraiTokenV3,
    angka_ke_kata: angkaKeKataV3,
    angka_ke_kata_lengkap: angkaKeKataLengkapV3,
    waktu_ke_kata: waktuKeKata,
    durasi_ke_kata: durasiKeKata,
    uang_ke_kata: uangKeKata,
    satuan_ke_kata: satuanKeKata,
    lafal_warna: lafalWarnaV3,
    urai_audit: uraiAuditV3,
    CIKURGO: CIKURGO_V3,
    cikur: new CIKURGO_V3()
  });

  return enriched;
};
