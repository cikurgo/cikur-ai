/**
 * CGO Otak Orchestrator — V1.0.0-MASA-DEPAN
 * Satu pintu penalaran natural (skills + instruction + nalar + gaya).
 * Tidak menyentuh proof chain / investigasi / guardian / mutasi source.
 * Zero network. Aditif untuk Hub & browser-adapter.
 */
(function (global) {
  "use strict";
  var VERSION = "1.5.3-WARM-ZR-MATH-SAFE";
  var memoryStore = null;

  function g() {
    return typeof globalThis !== "undefined" ? globalThis : global;
  }

  function getCikur() {
    var G = g();
    return G.CIKURGO || null;
  }

  function getInstruction() {
    var G = g();
    return G.CGOInstruction || null;
  }

  function getVocab() {
    var G = g();
    return G.CGOAiLogic || null;
  }

  function getEmosi() {
    var G = g();
    return G.CGOEmosi || null;
  }

  function getNarasi() {
    var G = g();
    return G.CGONarasi || null;
  }

  function getMemoryApi() {
    var G = g();
    return G.CGOAiMemory || null;
  }

  function ensureMemory() {
    var api = getMemoryApi();
    if (!api) return null;
    if (!memoryStore) memoryStore = api.createMemory();
    return memoryStore;
  }

  function rememberTurn(q, a, tags) {
    try {
      var api = getMemoryApi();
      if (!api) return;
      memoryStore = api.remember(ensureMemory() || api.createMemory(), {
        kind: "chat",
        text: q,
        answer: a,
        tags: tags || []
      });
    } catch (_) {}
  }

  function detectLang(text) {
    var s = String(text || "");
    if (/\b(english|in english|bahasa inggris)\b/i.test(s)) return "en";
    if (/^(spell)\b/i.test(s)) return "en";
    if (/\b(what time is it|what is the time|what's the time|current time|what day is it|what is the date|what's the date)\b/i.test(s)) return "en";
    if (/\b(日本語|nihongo|japanese|bahasa jepang)\b/i.test(s)) return "ja";
    if (/\b(español|spanish|bahasa spanyol)\b/i.test(s)) return "es";
    if (/\b(français|french|bahasa perancis)\b/i.test(s)) return "fr";
    if (/\b(deutsch|german|bahasa jerman)\b/i.test(s)) return "de";
    return "id";
  }

  function stripWake(text) {
    return String(text || "")
      .replace(/^\s*(c\.?\s*g\.?\s*o|halo\s+cgo|si\s*ji\s*ou?)\s*[,:\-]?\s*/i, "")
      .trim() || String(text || "").trim();
  }


  /**
   * Normalisasi angka lokal:
   * - ID/EU: 1.000.000 = sejuta ; 1.5 atau 1,5 = desimal
   * - US: 1,000,000 = sejuta ; 1.5 = desimal
   * Jangan bilang "typo" untuk nol yang valid.
   */
  function normalizeLocaleNumber(token) {
    var s = String(token || "").trim();
    if (!s) return null;
    // strip currency words soft
    s = s.replace(/^(Rp\.?|IDR|USD|EUR)\s*/i, "");
    if (!/^[-+]?[\d.,]+%?$/.test(s)) return null;

    var neg = false;
    if (s[0] === "-") { neg = true; s = s.slice(1); }
    else if (s[0] === "+") s = s.slice(1);
    var pct = false;
    if (/%$/.test(s)) { pct = true; s = s.slice(0, -1); }

    var dots = (s.match(/\./g) || []).length;
    var commas = (s.match(/,/g) || []).length;
    var cleaned = s;

    if (dots > 1 && commas === 0) {
      // 1.000.000 or 1.000.000.50 — ID thousands
      var parts = s.split(".");
      var last = parts[parts.length - 1];
      if (last.length === 3 && parts.every(function (p, i) { return i === parts.length - 1 || p.length <= 3; })) {
        cleaned = parts.join("");
      } else if (last.length <= 2 && parts.slice(0, -1).every(function (p) { return p.length <= 3; })) {
        cleaned = parts.slice(0, -1).join("") + "." + last;
      } else {
        cleaned = parts.join("");
      }
    } else if (commas > 1 && dots === 0) {
      // 1,000,000 US
      cleaned = s.replace(/,/g, "");
    } else if (dots === 1 && commas === 0) {
      // 1.5 decimal OR 1.000 ambiguous
      var a = s.split(".");
      if (a[1].length === 3 && a[0].length <= 3 && /^\d+$/.test(a[0]) && /^\d+$/.test(a[1])) {
        // treat as thousands if exactly 3 digits after single dot and no extra: 1.000 → 1000
        // but 1.50 stays decimal (2 digits). 1.500 could be thousands in ID
        if (a[1] === "000" || (a[1].length === 3 && a[0].length >= 1)) {
          cleaned = a[0] + a[1];
        } else {
          cleaned = s; // decimal
        }
      } else {
        cleaned = s; // decimal 1.5
      }
    } else if (commas === 1 && dots === 0) {
      // 1,5 EU decimal OR 1,000 US thousands
      var b = s.split(",");
      if (b[1].length === 3 && /^\d+$/.test(b[0]) && /^\d+$/.test(b[1])) {
        cleaned = b[0] + b[1]; // thousands
      } else if (b[1].length <= 2) {
        cleaned = b[0] + "." + b[1]; // decimal
      } else {
        cleaned = b[0] + b[1];
      }
    } else if (dots === 1 && commas === 1) {
      // 1,000.50 US or 1.000,50 EU
      if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
        // EU: 1.000,50
        cleaned = s.replace(/\./g, "").replace(",", ".");
      } else {
        // US: 1,000.50
        cleaned = s.replace(/,/g, "");
      }
    } else {
      cleaned = s.replace(/,/g, "");
    }

    if (!/^[-+]?\d+(\.\d+)?$/.test((neg ? "-" : "") + cleaned)) return null;
    var num = Number((neg ? "-" : "") + cleaned);
    if (!Number.isFinite(num)) return null;
    if (pct) num = num / 100;
    return num;
  }

  function normalizeOperators(expr) {
    var s = String(expr || "");
    s = s.replace(/[×✕✖]/g, "*");
    s = s.replace(/\bx\b/gi, "*");
    s = s.replace(/[÷:]/g, "/"); // : as division in some locales when between numbers
    s = s.replace(/=/g, "");
    s = s.replace(/,/g, "."); // will be refined token-wise below
    return s;
  }

  /**
   * Parse expression with locale numbers + operators x * / + - ( )
   * Returns { value, normalizedExpr } or null
   */
  function evalLocaleMath(input) {
    var raw = String(input || "").trim();
    if (!raw) return null;
    // tokenize numbers and ops
    var s = raw
      .replace(/[×✕✖]/g, " * ")
      .replace(/\bx\b/gi, " * ")
      .replace(/[÷]/g, " / ")
      .replace(/(?<=\d)\s*:\s*(?=\d)/g, " / ")
      .replace(/=/g, " ")
      .replace(/\(/g, " ( ")
      .replace(/\)/g, " ) ")
      .replace(/\+/g, " + ")
      .replace(/(?<![eE])\-/g, " - ")
      .replace(/\*/g, " * ")
      .replace(/\//g, " / ");

    var parts = s.split(/\s+/).filter(Boolean);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (/^[+\-*/()]$/.test(p)) {
        out.push(p);
        continue;
      }
      var n = normalizeLocaleNumber(p);
      if (n == null) {
        // maybe plain digit leftover
        if (/^\d+(\.\d+)?$/.test(p)) out.push(p);
        else return null;
      } else {
        out.push(String(n));
      }
    }
    var expr = out.join("");
    // only safe chars
    if (!/^[\d+\-*/().]+$/.test(expr)) return null;
    var val = safeArith(expr);
    if (val == null) return null;
    return { value: val, normalizedExpr: expr };
  }

  function formatNumberResult(val, lang) {
    var api = getCikur();
    var spoken = String(val);
    try {
      var angkaFn = api && (api.angkaKeKata || api.angka_ke_kata);
      if (angkaFn) spoken = angkaFn(val, lang || "id");
    } catch (_) {}
    // tampilkan angka biasa tanpa ilmiah untuk bilangan bulat besar
    var display = (typeof val === "number" && Number.isInteger(val))
      ? String(val)
      : String(val);
    return display + " → dibaca: " + spoken;
  }

  function safeUrai(text, mode, language) {
    var api = getCikur();
    if (!api || typeof api.urai !== "function") return null;
    var tries = [
      function () { return api.urai(text, mode || "auto", language || "id", false); },
      function () { return api.urai(text, mode || "auto", false, language || "id"); }
    ];
    for (var i = 0; i < tries.length; i++) {
      try {
        var out = tries[i]();
        if (out && typeof out === "object" && out.teks_hasil) return String(out.teks_hasil);
        if (typeof out === "string" && out.trim()) return out.trim();
      } catch (_) {}
    }
    return null;
  }

  function safeArith(expr) {
    var s = String(expr || "").replace(/\s+/g, "");
    if (!s || !/^[\d+\-*/().]+$/.test(s) || /[a-zA-Z_$]/.test(s)) return null;
    var i = 0;
    function peek() { return s[i] || ""; }
    function get() { return s[i++] || ""; }
    function num() {
      var start = i;
      if (peek() === "+" || peek() === "-") i++;
      while (/\d/.test(peek())) i++;
      if (peek() === ".") { i++; while (/\d/.test(peek())) i++; }
      var n = Number(s.slice(start, i));
      if (!Number.isFinite(n)) throw new Error("NUM");
      return n;
    }
    function factor() {
      if (peek() === "(") { get(); var v = exprF(); if (peek() !== ")") throw new Error("PAREN"); get(); return v; }
      return num();
    }
    function term() {
      var v = factor();
      while (peek() === "*" || peek() === "/") {
        var op = get();
        var r = factor();
        v = op === "*" ? v * r : v / r;
      }
      return v;
    }
    function exprF() {
      var v = term();
      while (peek() === "+" || peek() === "-") {
        var op = get();
        var r = term();
        v = op === "+" ? v + r : v - r;
      }
      return v;
    }
    try {
      var val = exprF();
      if (i !== s.length) return null;
      return Number.isFinite(val) ? val : null;
    } catch (_) {
      return null;
    }
  }


  /* English letter names — proper pronunciation (not CIKUR hybrid eich/ou) */
  var EN_LETTERS = {
    a: "ay", b: "bee", c: "see", d: "dee", e: "ee", f: "eff",
    g: "jee", h: "aitch", i: "eye", j: "jay", k: "kay", l: "el",
    m: "em", n: "en", o: "oh", p: "pee", q: "cue", r: "ar",
    s: "ess", t: "tee", u: "you", v: "vee", w: "double-you",
    x: "ex", y: "why", z: "zee",
    "0": "zero", "1": "one", "2": "two", "3": "three", "4": "four",
    "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "nine"
  };

  var JA_LETTERS = {a:"あ",b:"びー",c:"しー",d:"でぃー",e:"いー",f:"えふ",g:"じー",h:"えいち",i:"あい",j:"じぇー",k:"けー",l:"える",m:"えむ",n:"えぬ",o:"おー",p:"ぴー",q:"きゅー",r:"あーる",s:"えす",t:"てぃー",u:"ゆー",v:"ぶい",w:"だぶりゅー",x:"えっくす",y:"わい",z:"ぜっと","0":"ぜろ","1":"いち","2":"に","3":"さん","4":"よん","5":"ご","6":"ろく","7":"なな","8":"はち","9":"きゅう"};
  var ES_LETTERS = {a:"a",b:"be",c:"ce",d:"de",e:"e",f:"efe",g:"ge",h:"hache",i:"i",j:"jota",k:"ka",l:"ele",m:"eme",n:"ene",o:"o",p:"pe",q:"cu",r:"erre",s:"ese",t:"te",u:"u",v:"uve",w:"uve doble",x:"equis",y:"ye",z:"zeta"};
  var FR_LETTERS = {a:"a",b:"bé",c:"cé",d:"dé",e:"e",f:"effe",g:"gé",h:"ache",i:"i",j:"ji",k:"ka",l:"elle",m:"emme",n:"enne",o:"o",p:"pé",q:"ku",r:"erre",s:"esse",t:"té",u:"u",v:"vé",w:"double vé",x:"ixe",y:"i grec",z:"zède"};
  var DE_LETTERS = {a:"a",b:"be",c:"ce",d:"de",e:"e",f:"ef",g:"ge",h:"ha",i:"i",j:"jot",k:"ka",l:"el",m:"em",n:"en",o:"o",p:"pe",q:"ku",r:"er",s:"es",t:"te",u:"u",v:"fau",w:"ve",x:"ix",y:"ypsilon",z:"zet"};
  var AR_LETTERS = {a:"alif",b:"ba",c:"sii",d:"daal",e:"ii",f:"if",g:"jii",h:"eich",i:"aay",j:"jaay",k:"kaay",l:"el",m:"em",n:"en",o:"oo",p:"pii",q:"kyu",r:"aar",s:"es",t:"tii",u:"yuu",v:"vii",w:"dabelyu",x:"eks",y:"waay",z:"zed"};
  var PT_LETTERS = {a:"a",b:"bê",c:"cê",d:"dê",e:"ê",f:"éfe",g:"gê",h:"agá",i:"i",j:"jota",k:"capa",l:"éle",m:"ême",n:"êne",o:"ó",p:"pê",q:"quê",r:"érre",s:"ésse",t:"tê",u:"u",v:"vê",w:"dáblio",x:"xis",y:"ípsilon",z:"zê"};

  var ID_LETTERS = {
    a: "a", b: "bé", c: "cé", d: "dé", e: "é", f: "ef",
    g: "gé", h: "ha", i: "i", j: "jé", k: "ka", l: "èl",
    m: "èm", n: "èn", o: "o", p: "pé", q: "ki", r: "èr",
    s: "ès", t: "té", u: "u", v: "vé", w: "wé",
    x: "èks", y: "yé", z: "zèt",
    "0": "nol", "1": "satu", "2": "dua", "3": "tiga", "4": "empat",
    "5": "lima", "6": "enam", "7": "tujuh", "8": "delapan", "9": "sembilan"
  };

  function spellLetters(text, lang) {
    var map = (lang === "en") ? EN_LETTERS
      : (lang === "ja") ? JA_LETTERS
      : (lang === "es") ? ES_LETTERS
      : (lang === "fr") ? FR_LETTERS
      : (lang === "de") ? DE_LETTERS
      : (lang === "pt") ? PT_LETTERS
      : (lang === "ar") ? AR_LETTERS
      : ID_LETTERS;
    var out = [];
    var chars = Array.from(String(text || ""));
    for (var i = 0; i < chars.length; i++) {
      var c = chars[i];
      if (c === " ") { out.push(lang === "en" ? "space" : "spasi"); continue; }
      if (c === "-") { out.push(lang === "en" ? "dash" : "strip"); continue; }
      if (c === ".") { out.push(lang === "en" ? "dot" : "titik"); continue; }
      var key = c.toLowerCase();
      if (map[key]) out.push(map[key]);
      else if (/\d/.test(c)) out.push(map[c] || c);
      else out.push(c);
    }
    return out.join(" ");
  }

  function formatClock(d, lang) {
    var h = d.getHours();
    var m = d.getMinutes();
    var hh = (h < 10 ? "0" : "") + h;
    var mm = (m < 10 ? "0" : "") + m;
    if (lang === "en") {
      var h12 = h % 12; if (h12 === 0) h12 = 12;
      var ampm = h < 12 ? "AM" : "PM";
      return "It's " + h12 + ":" + mm + " " + ampm + " (" + hh + ":" + mm + ")";
    }
    // ID: digital jelas + opsional lafal CIKUR
    var base = "Sekarang pukul " + hh + ":" + mm;
    var api = getCikur();
    var waktuFn = api && (api.waktuKeKata || api.waktu_ke_kata);
    if (waktuFn) {
      try {
        var spoken = waktuFn(hh + ":" + mm, "id");
        if (spoken && spoken.length < 60) return base + " — " + spoken;
      } catch (_) {}
    }
    return base;
  }

  function timeAnswer(body, lang) {
    var b = String(body || "").toLowerCase().trim();
    if (!/^(jam berapa|pukul berapa|sekarang jam berapa|jam berapa sekarang|what time is it|what is the time|what's the time|whats the time|tell me the time|current time|waktu sekarang|jam sekarang)\b/i.test(b)
        && !/^(jam berapa|what time)/i.test(b)) {
      // softer match
      if (!(/\b(jam berapa|pukul berapa|what time is it|current time)\b/i.test(b) && b.length < 48)) return null;
    }
    var now = new Date();
    return {
      text: formatClock(now, lang || "id"),
      engine: "CGO_TIME",
      tags: ["skill", "waktu"]
    };
  }


  var HARI_ID = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
  var HARI_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var BULAN_ID = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
  var BULAN_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  function dateAnswer(body, lang) {
    var b = String(body || "").toLowerCase().trim();
    if (!/\b(tanggal berapa|hari ini tanggal|hari apa|hari apa sekarang|what day is it|what is the date|what's the date|todays date|today's date)\b/i.test(b)) {
      if (!/^(tanggal|hari ini|what day|what date)\b/i.test(b)) return null;
    }
    if (b.length > 60) return null;
    var d = new Date();
    var day = d.getDay();
    var dd = d.getDate();
    var mm = d.getMonth();
    var yyyy = d.getFullYear();
    var text;
    if (lang === "en") text = HARI_EN[day] + ", " + BULAN_EN[mm] + " " + dd + ", " + yyyy;
    else if (lang === "ja") text = yyyy + "年" + (mm + 1) + "月" + dd + "日";
    else if (lang === "es") text = HARI_EN[day] + ", " + dd + " de " + BULAN_EN[mm] + " de " + yyyy;
    else if (lang === "fr") text = dd + " " + BULAN_EN[mm] + " " + yyyy;
    else if (lang === "de") text = dd + ". " + BULAN_EN[mm] + " " + yyyy;
    else if (lang === "pt") text = dd + " de " + BULAN_EN[mm] + " de " + yyyy;
    else if (lang === "ar") text = dd + "/" + (mm + 1) + "/" + yyyy;
    else text = HARI_ID[day] + ", " + dd + " " + BULAN_ID[mm] + " " + yyyy;
    return { text: text, engine: "CGO_DATE", tags: ["skill", "tanggal"] };
  }

  function percentAnswer(body, lang) {
    var b = String(body || "").trim();
    // "50% dari 1000000" | "20 persen dari 500" | "hitung 10% dari 200"
    var m = b.match(/(?:hitung\s+)?(\d+(?:[.,]\d+)?)\s*%\s*(?:dari|of)\s+(.+)$/i);
    var pctVal = null, baseRaw = null;
    if (m) {
      pctVal = normalizeLocaleNumber(m[1]);
      baseRaw = m[2];
    } else {
      m = b.match(/(?:hitung\s+)?(\d+(?:[.,]\d+)?)\s*(?:persen|percent)\s+(?:dari|of)\s+(.+)$/i);
      if (m) {
        pctVal = normalizeLocaleNumber(m[1]);
        baseRaw = m[2];
      }
    }
    if (pctVal == null || baseRaw == null) return null;
    var base = normalizeLocaleNumber(String(baseRaw).trim());
    if (base == null) return null;
    var result = base * (pctVal / 100);
    if (Math.abs(result - Math.round(result)) < 1e-9) result = Math.round(result);
    else result = Math.round(result * 1e6) / 1e6;
    return {
      text: formatNumberResult(result, lang) + "  (" + pctVal + "% × " + base + ")",
      engine: "CGO_PERCENT",
      tags: ["skill", "persen"]
    };
  }

  function powerAnswer(body, lang) {
    var b = String(body || "").trim();
    var m = b.match(/(?:berapa\s+)?(\d+([.,]\d+)?)\s*(?:\^|pangkat|\*\*)\s*(\d+)/i);
    if (!m) m = b.match(/(?:hitung\s+)?(\d+([.,]\d+)?)\s*pangkat\s*(\d+)/i);
    if (m) {
      var base = normalizeLocaleNumber(m[1]);
      var exp = Number(m[3]);
      if (base == null || !Number.isFinite(exp) || exp < 0 || exp > 12) return null;
      var val = Math.pow(base, exp);
      if (!Number.isFinite(val)) return null;
      return { text: formatNumberResult(val, lang), engine: "CGO_PANGKAT", tags: ["skill", "pangkat"] };
    }
    m = b.match(/(?:akar(?:\s+kuadrat)?|sqrt)\s*(?:dari\s+)?(\d+([.,]\d+)?)/i);
    if (m) {
      var n = normalizeLocaleNumber(m[1]);
      if (n == null || n < 0) return null;
      var r = Math.sqrt(n);
      if (Math.abs(r - Math.round(r)) < 1e-12) r = Math.round(r);
      else r = Math.round(r * 1e8) / 1e8;
      return { text: formatNumberResult(r, lang), engine: "CGO_AKAR", tags: ["skill", "akar"] };
    }
    return null;
  }

  function unitConvert(body, lang) {
    var b = String(body || "").trim();
    var m = b.match(/(?:konversi\s+)?(\d+([.,]\d+)?)\s*(km|m|cm|mm|kg|g|mg|l|ml)\s*(?:ke|to|jadi|=)\s*(km|m|cm|mm|kg|g|mg|l|ml)/i);
    if (!m) return null;
    var n = normalizeLocaleNumber(m[1]);
    if (n == null) return null;
    var from = m[3].toLowerCase();
    var to = m[4].toLowerCase();
    var factor = {
      km: 1000, m: 1, cm: 0.01, mm: 0.001,
      kg: 1000, g: 1, mg: 0.001,
      l: 1000, ml: 1
    };
    // group check
    var len = { km:1, m:1, cm:1, mm:1 };
    var mass = { kg:1, g:1, mg:1 };
    var vol = { l:1, ml:1 };
    var same =
      (len[from] && len[to]) || (mass[from] && mass[to]) || (vol[from] && vol[to]);
    if (!same || factor[from] == null || factor[to] == null) return null;
    var base = n * factor[from];
    var out = base / factor[to];
    if (Math.abs(out - Math.round(out)) < 1e-9) out = Math.round(out);
    else out = Math.round(out * 1e8) / 1e8;
    return {
      text: n + " " + from + " = " + out + " " + to,
      engine: "CGO_UNIT",
      tags: ["skill", "satuan"]
    };
  }


  var COLOR_NAMES_ML = {
    red: {id:"merah",en:"red",ja:"赤",es:"rojo",fr:"rouge",de:"rot",pt:"vermelho",ar:"أحمر"},
    blue: {id:"biru",en:"blue",ja:"青",es:"azul",fr:"bleu",de:"blau",pt:"azul",ar:"أزرق"},
    green: {id:"hijau",en:"green",ja:"緑",es:"verde",fr:"vert",de:"grün",pt:"verde",ar:"أخضر"},
    yellow: {id:"kuning",en:"yellow",ja:"黄色",es:"amarillo",fr:"jaune",de:"gelb",pt:"amarelo",ar:"أصفر"},
    black: {id:"hitam",en:"black",ja:"黒",es:"negro",fr:"noir",de:"schwarz",pt:"preto",ar:"أسود"},
    white: {id:"putih",en:"white",ja:"白",es:"blanco",fr:"blanc",de:"weiß",pt:"branco",ar:"أبيض"}
  };
  function colorNameML(name, lang) {
    var key = String(name || "").toLowerCase();
    // map common id/en words to key
    var alias = {merah:"red",red:"red",biru:"blue",blue:"blue",hijau:"green",green:"green",kuning:"yellow",yellow:"yellow",hitam:"black",black:"black",putih:"white",white:"white"};
    var k = alias[key] || key;
    var row = COLOR_NAMES_ML[k];
    if (!row) return name;
    return row[lang] || row.id || name;
  }


  // v1.5.3 — hitung mandiri: rumus aritmetika tidak butuh CIKUR. Dipakai HANYA bila CIKUR belum termuat,
  // supaya "hitung 12 x 3" tidak diam. Jalur lama (CIKUR ada) tidak berubah.
  function mathWordsToOps(s) {
    return String(s || "")
      .replace(/(\d)\s+(?:kali|dikali|times|multiplied\s+by)\s+(?=[\d(])/gi, "$1 * ")
      .replace(/(\d)\s+(?:dibagi|bagi|divided\s+by)\s+(?=[\d(])/gi, "$1 / ")
      .replace(/(\d)\s+(?:ditambah|tambah|plus)\s+(?=[\d(])/gi, "$1 + ")
      .replace(/(\d)\s+(?:dikurangi|kurang|minus)\s+(?=[\d(])/gi, "$1 - ");
  }
  function mathOnly(body, lang) {
    var b0 = mathWordsToOps(body);
    var hm = b0.match(/^(?:hitung|kalkulasi|calculate|what\s+is|what's|how\s+much\s+is|berapa(?:\s+hasil)?|berapakah)\s*[:\-]?\s*(.+)$/i);
    var expr = hm ? hm[1] : null;
    if (!expr && /^[\d.,\s()]*\d[\d.,]*\s*[x×✕*÷/+\-]\s*[\d.,(]+/i.test(b0)) expr = b0;
    if (!expr) return null;
    expr = String(expr).replace(/[?？=]+/g, " ")
      .replace(/(\d)\s*[x×✕*]\s*(?=[\d(])/gi, "$1 * ")
      .replace(/(\d)\s*[÷:]\s*(?=\d)/g, "$1 / ").trim();
    var math = evalLocaleMath(expr);
    if (!math) return null;
    return { text: formatNumberResult(math.value, lang), engine: "CIKUR_HITUNG", tags: ["skill", "hitung"] };
  }

  function skillAnswer(raw) {
    var body = stripWake(raw);
    if (!body) return null;
    var lang = detectLang(body);
    var b = body.toLowerCase();

    // jam / tanggal — tidak wajib CIKUR
    var tAns = timeAnswer(body, lang);
    if (tAns) return tAns;
    var dAns = dateAnswer(body, lang);
    if (dAns) return dAns;

    // ganti bahasa (bukan meta sistem)
    if (/^(speak\s+english|bicara\s+inggris|pakai\s+bahasa\s+inggris)\b/i.test(body)) {
      return { text: "OK — I'll reply in English for the next questions. Try: spell hello, what time is it, calculate 12 x 8.", engine: "CGO_LANG", tags: ["skill", "lang"] };
    }
    if (/^(speak\s+indonesia|bicara\s+indonesia|bahasa\s+indonesia)\b/i.test(body)) {
      return { text: "Baik — pertanyaan berikutnya saya jawab dalam bahasa Indonesia.", engine: "CGO_LANG", tags: ["skill", "lang"] };
    }

    // persen / pangkat / akar / konversi satuan
    try {
      var pAns = percentAnswer(body, lang);
      if (pAns) return pAns;
    } catch (_) {}
    try {
      var powAns = powerAnswer(body, lang);
      if (powAns) return powAns;
    } catch (_) {}
    try {
      var uAns = unitConvert(body, lang);
      if (uAns) return uAns;
    } catch (_) {}

    // eja huruf presisi EN/ID — tidak wajib CIKUR
    var ejaEarly = body.match(/^(?:eja|spell|ejaan|lafalkan|ucapkan)\s*[:\-]?\s*(.+)$/i);
    if (ejaEarly) {
      var tgt = ejaEarly[1].trim()
        .replace(/\s*(in english|bahasa inggris|in japanese|bahasa jepang|日本語|en français|bahasa perancis|en español|bahasa spanyol|auf deutsch|bahasa jerman)\s*$/i, "")
        .trim() || ejaEarly[1].trim();
      if (lang === "en" || lang === "id") {
        var prec = spellLetters(tgt, lang);
        if (prec) return { text: (lang === "en" ? "Spelling: " : "Ejaan: ") + prec, engine: "CGO_EJA", tags: ["skill", "eja"] };
      }
    }

    var api = getCikur();
    if (!api) return mathOnly(body, lang);
    var angkaFn = typeof api.angkaKeKata === "function" ? api.angkaKeKata : api.angka_ke_kata;
    var warnaFn = typeof api.lafalWarna === "function" ? api.lafalWarna : api.lafal_warna;
    var waktuFn = typeof api.waktuKeKata === "function" ? api.waktuKeKata : api.waktu_ke_kata;
    var uangFn = typeof api.uangKeKata === "function" ? api.uangKeKata : api.uang_ke_kata;
    var satuanFn = typeof api.satuanKeKata === "function" ? api.satuanKeKata : api.satuan_ke_kata;

    // eja / spell
    var ejaM = body.match(/^(?:eja|spell|ejaan|lafalkan|ucapkan)\s*[:\-]?\s*(.+)$/i);
    if (ejaM) {
      var target = ejaM[1].trim()
        .replace(/\s*(in english|bahasa inggris|in japanese|bahasa jepang|日本語|en français|bahasa perancis|en español|bahasa spanyol|auf deutsch|bahasa jerman)\s*$/i, "")
        .trim();
      if (!target) target = ejaM[1].trim();
      // English/ID letter spelling: use precise map (CIKUR en hybrid is poor)
      if (lang === "en" || lang === "id") {
        var precise = spellLetters(target, lang);
        if (precise) return { text: (lang === "en" ? "Spelling: " : "Ejaan: ") + precise, engine: "CGO_EJA", tags: ["skill", "eja"] };
      }
      var spoken = safeUrai(target, "eja", lang) || safeUrai(target, "campur", lang) || safeUrai(target, "auto", lang);
      if (spoken) return { text: "Ejaan: " + spoken, engine: "CIKUR_EJA", tags: ["skill", "eja"] };
    }

    // hitung — 1.000x2 / 1.000 x 2 / 1.000x2 itu berapa?
    function prepMathExpr(s) {
      s = String(s || "");
      // buang kata pengisi
      s = s.replace(/\b(itu|ya|yaitu|hasilnya|hasil|adalah|equals?|berapa|hitung|kalkulasi)\b/gi, " ");
      s = s.replace(/[?？]+/g, " ");
      // sisip spasi di operator menempel angka: 1.000x2 → 1.000 x 2
      s = s.replace(/(\d)\s*[x×✕*]\s*(\d)/gi, "$1 * $2");
      s = s.replace(/(\d)\s*[÷/:]\s*(\d)/g, "$1 / $2");
      s = s.replace(/(\d)\s*[+]\s*(\d)/g, "$1 + $2");
      s = s.replace(/(\d)\s*[-−]\s*(\d)/g, "$1 - $2");
      // ribuan menempel operator: 1.000x2 already handled; also 1000x2
      s = s.replace(/(\d[\d.,]*)\s*[x×✕*]\s*(\d[\d.,]*)/gi, "$1 * $2");
      s = s.replace(/(\d[\d.,]*)\s*[÷/]\s*(\d[\d.,]*)/g, "$1 / $2");
      return s.replace(/\s+/g, " ").trim();
    }
    var hitungExpr = null;
    var bodyM = mathWordsToOps(body);
    var hm = bodyM.match(/^(?:hitung|kalkulasi|calculate|what\s+is|what's|how\s+much\s+is|berapa(?:\s+hasil)?)\s*[:\-]?\s*(.+)$/i);
    if (hm) hitungExpr = hm[1];
    else {
      var trail = body.match(/^(.+?)\s+berapa\s*[?]?\s*$/i);
      if (trail && /\d/.test(trail[1]) && /[x×✕*÷/:\+\-]|\d\s*[x×✕*]\s*\d/i.test(trail[1])) hitungExpr = trail[1];
      else if (/\d/.test(body) && /[x×✕*÷/]|\d[x×✕*]\d/i.test(body) && body.length < 100) hitungExpr = body;
    }
    // pola: "1.000x2 itu berapa" sudah tertangkap trail; juga pure "1.000x2"
    if (!hitungExpr && /^[\d.,\s]*\d[\d.,]*\s*[x×✕*÷/+\-]\s*[\d.,]+/i.test(body.replace(/\b(itu|berapa)\b/gi,""))) {
      hitungExpr = body;
    }
    if (hitungExpr) {
      var math = evalLocaleMath(prepMathExpr(hitungExpr));
      if (math) {
        return { text: formatNumberResult(math.value, lang), engine: "CIKUR_HITUNG", tags: ["skill", "hitung"] };
      }
    }

    // pure number — locale aware (jangan bilang typo untuk 1.000.000)
    var pureNum = normalizeLocaleNumber(body);
    if (pureNum != null && angkaFn) {
      try {
        var spokenP = angkaFn(pureNum, lang);
        return {
          text: body + " → " + pureNum + " (dibaca: " + spokenP + ")",
          engine: "CIKUR_ANGKA",
          tags: ["skill", "angka"]
        };
      } catch (_) {}
    } else if (pureNum != null) {
      return { text: body + " → " + pureNum, engine: "CIKUR_ANGKA", tags: ["skill", "angka"] };
    }

    // waktu HH:MM
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(body) && waktuFn) {
      try {
        return { text: "Waktu: " + waktuFn(body, lang), engine: "CIKUR_WAKTU", tags: ["skill", "waktu"] };
      } catch (_) {}
    }

    // uang
    var uangM = body.match(/^(?:Rp|IDR|USD|EUR)\s*[-+]?\d[\d.,]*$/i);
    if (uangM && uangFn) {
      try {
        var cur = body.match(/^(?:Rp|IDR|USD|EUR)/i)[0].toUpperCase();
        if (cur === "RP") cur = "IDR";
        var numPart = body.replace(/^(?:Rp|IDR|USD|EUR)\s*/i, "");
        return { text: uangFn(numPart, cur, lang), engine: "CIKUR_UANG", tags: ["skill", "uang"] };
      } catch (_) {}
    }

    // satuan
    if (/^-?\d+([.,]\d+)?\s*(kg|g|km|m|cm|l|ml|c|%)$/i.test(body) && satuanFn) {
      try {
        return { text: satuanFn(body, lang), engine: "CIKUR_SATUAN", tags: ["skill", "satuan"] };
      } catch (_) {}
    }

    // warna
    if (/\b(warna|color|hex)\b/i.test(b) || /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(body)) {
      var hex = (body.match(/#([0-9a-f]{3,8})\b/i) || [])[0];
      var name = (body.match(/\b(merah|biru|hijau|kuning|hitam|putih|orange|ungu|red|blue|green|yellow|black|white|purple)\b/i) || [])[0];
      var target = hex || name;
      if (target && warnaFn) {
        try {
          var w = warnaFn(target, lang);
          var spokenW = Array.isArray(w) ? w[0] : w;
          if (spokenW) {
            var cn = colorNameML(spokenW, lang);
            return { text: "Warna " + target + " → " + (cn || spokenW), engine: "CIKUR_WARNA", tags: ["skill", "warna"] };
          }
        } catch (_) {}
      }
    }

    // emoji — termasuk multi, bintang, simbol
    var emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B50}\u{2B55}]/u;
    if (emojiRe.test(body) && !/[a-zA-Z]{3,}/.test(body.replace(/emoji|arti|eja/gi, ""))) {
      var onlyEmo = body.replace(/[^\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B50}\u{2B55}\s]/gu, "").trim();
      if (onlyEmo) {
        var se = safeUrai(onlyEmo, "emoji", lang) || safeUrai(onlyEmo, "auto", lang);
        if (se) return { text: "Emoji: " + se, engine: "CIKUR_EMOJI", tags: ["skill", "emoji"] };
      }
    }
    if (/\b(emoji|arti emoji|eja emoji)\b/i.test(b)) {
      var em = body.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}]+/u);
      if (em) {
        var se2 = safeUrai(em[0], "emoji", lang) || safeUrai(em[0], "auto", lang);
        if (se2) return { text: "Emoji: " + se2, engine: "CIKUR_EMOJI", tags: ["skill", "emoji"] };
      }
    }

    // urai explicit
    var uraiM = body.match(/^(?:urai|uraikan|parse|lafalkan)\s*[:\-]?\s*(.+)$/i);
    if (uraiM) {
      var su = safeUrai(uraiM[1].trim(), "auto", lang);
      if (su) return { text: su, engine: "CIKUR_URAI", tags: ["skill", "urai"] };
    }

    return null;
  }

  function conversationAnswer(raw) {
    var text = String(raw || "").trim();
    if (!text) return null;
    var inst = getInstruction();
    var classified = null;
    try {
      if (inst && typeof inst.classifyIntent === "function") classified = inst.classifyIntent(text, {});
      else if (inst && typeof inst.classifyDialogue === "function") classified = inst.classifyDialogue(text, {});
    } catch (_) {}

    function pack(t, topic) {
      return { text: t, engine: "CGO_INSTRUCTION", tags: ["conversation", topic || "chat"] };
    }

    if (!classified) {
      if (/^(halo|hai|hello|hi|pagi|siang|sore|malam|selamat\s+(pagi|siang|sore|malam))\b/i.test(text))
        return pack("Halo. Aku CGO. Mau coba hitung, eja, jam, tanggal, emoji, atau status sistem?", "GREETING");
      if (/\b(siapa kamu|kamu siapa|who are you)\b/i.test(text))
        return pack("Aku CGO di CIKUR GO. Aku bantu jawab dari bukti — tanpa ngarang.", "IDENTITY");
      if (/\b(kamu bisa apa|bisa ngapain|what can you)\b/i.test(text))
        return pack("Aku bisa hitung & eja multi-bahasa, jam/tanggal, emoji/warna, persen/pangkat, konversi satuan, status sistem, dan cek file berbasis bukti.", "CAPABILITY");
      if (/^(speak\s+english|bicara\s+inggris|pakai\s+bahasa\s+inggris|in\s+english\s*please)\b/i.test(text))
        return pack("OK — I'll answer in English when you ask. Try: spell hello, what time is it, or calculate 12 x 8.", "LANG_EN");
      if (/^(speak\s+indonesia|bicara\s+indonesia|pakai\s+bahasa\s+indonesia)\b/i.test(text))
        return pack("Baik — saya jawab dalam bahasa Indonesia. Coba: eja hello, jam berapa, atau hitung 12 x 8.", "LANG_ID");
      if (/^(makasih|terima kasih|thanks|thank you)\b/i.test(text))
        return pack("Sama-sama. Tinggal panggil jika butuh lagi.", "THANKS");
      if (/^(selamat tinggal|dadah|bye|goodbye)\b/i.test(text))
        return pack("Sampai jumpa. Aku tetap siaga.", "FAREWELL");
      return null;
    }

    if (classified.greeting || classified.topic === "GREETING")
      return pack("Halo. Aku CGO. Ada yang mau dicek atau dihitung?", "GREETING");
    if (classified.identity || classified.topic === "IDENTITY")
      return pack("Aku CGO di CIKUR GO. Aku baca keadaan BCGO yang hidup dan mengurai pertanyaanmu secara lokal — tanpa API eksternal.", "IDENTITY");
    if (classified.capability || classified.topic === "CAPABILITY")
      return pack("Kemampuan utama: briefing status, cek file & dependency, hitung/eja/emoji/warna multi-bahasa, radar agent, serta investigasi root cause berbasis evidence.", "CAPABILITY");
    if (classified.gratitude || classified.topic === "THANKS")
      return pack("Sama-sama. Kalau butuh cek lagi, tinggal panggil.", "THANKS");
    if (classified.farewell || classified.topic === "FAREWELL")
      return pack("Sampai jumpa. Aku tetap siaga di sisi BCGO.", "FAREWELL");
    if (classified.justChatting || classified.topic === "CASUAL_CHAT")
      return pack("Boleh. Aku siap ngobrol. Kalau nanti butuh cek sistem atau mengurai angka/emoji, langsung saja.", "CASUAL");
    if (classified.emotionalBoundary || classified.topic === "EMOTION_BOUNDARY")
      return pack("Aku bisa menyesuaikan nada bicara, tapi aku tidak memiliki perasaan manusia. Aku tetap fokus bantu dengan jelas dan jujur.", "EMOTION");
    return null;
  }

  function reasonAnswer(raw) {
    var api = getCikur();
    if (!api) return null;
    var body = stripWake(raw);
    if (!body || body.length < 6 || body.length > 220) return null;
    // jangan ambil alih pertanyaan sistem teknis
    if (/\b(file|source|telemetry|root cause|patch|dependency|bcgo|scanner|radar agent|anomaly)\b/i.test(body)) return null;
    // jangan nalar-meta untuk soal hitung/angka ("Teks didominasi angka")
    if (/\d/.test(body) && /[x×✕*÷/+\-]|berapa|hitung|pangkat|persen|%/i.test(body)) return null;
    if (/^[\d.,\sx×✕*÷/+\-?]+$/i.test(body)) return null;

    var wantsExplain = /^(kenapa|mengapa|jelaskan|terangkan|bagaimana|kok)\b/i.test(body)
      || /\b(artinya apa|maksudnya apa)\b/i.test(body);
    var wantsPattern = /\b(pola|deteksi|analisis teks|urai pola)\b/i.test(body);

    try {
      if (wantsPattern && typeof api.deteksi_pola === "function") {
        var p = api.deteksi_pola(body);
        if (p && (p.hasil || p.ringkasan)) {
          return { text: String(p.hasil || p.ringkasan), engine: "CIKUR_POLA", tags: ["reason", "pola"] };
        }
      }
    } catch (_) {}

    try {
      if (wantsExplain && typeof api.jelaskan === "function") {
        var j = api.jelaskan(body);
        if (j && (j.hasil || j.penjelasan || j.ringkasan)) {
          var jt = String(j.hasil || j.penjelasan || j.ringkasan || "").trim();
          if (jt && jt.length < 400) return { text: jt, engine: "CIKUR_JELASKAN", tags: ["reason", "jelaskan"] };
        }
      }
    } catch (_) {}

    try {
      if ((wantsExplain || /\?$/.test(body)) && typeof api.nalar === "function") {
        var n = api.nalar(body, {});
        if (n && (n.kesimpulan || n.hasil)) {
          var kt = String(n.kesimpulan || n.hasil || "").trim();
          if (kt && kt.length < 320 && !/^Input kosong/i.test(kt) && !/^Teks campuran/i.test(kt)) {
            return { text: kt, engine: "CIKUR_NALAR", tags: ["reason", "nalar"] };
          }
        }
      }
    } catch (_) {}

    return null;
  }

  function polish(text, raw) {
    var out = String(text || "").trim();
    if (!out) return out;
    try {
      var nar = getNarasi();
      if (nar && typeof nar.narrate === "function") {
        out = nar.narrate(out, { short: out.split(/\s+/).length < 22 }) || out;
      }
    } catch (_) {}
    try {
      var emo = getEmosi();
      if (emo && typeof emo.tentukanEmosi === "function") {
        var e = emo.tentukanEmosi({ text: raw, answer: out });
        if (e && typeof emo.prefiksEmosi === "function") {
          var pre = emo.prefiksEmosi(e.emosi, e.intensitas) || "";
          if (pre && out.indexOf(pre.trim()) !== 0) out = pre + out;
        }
      }
    } catch (_) {}
    return out;
  }

  function parseVocab(raw) {
    try {
      var v = getVocab();
      if (v && typeof v.parseCommandVocabulary === "function") return v.parseCommandVocabulary(raw);
    } catch (_) {}
    return null;
  }

  /**
   * think(question, context?) → { handled, text, response, engine, version, vocab, tags }
   * context.liveState opsional (BCGO) — tidak wajib.
   */
  function think(question, context) {
    context = context || {};
    var raw = typeof question === "string" ? question : String(question && (question.text || question.question) || "");
    raw = String(raw || "").trim();
    if (!raw) return { handled: false, text: null, reason: "EMPTY" };

    var vocab = parseVocab(raw);

    // 1) Skills CIKUR (multi-bahasa, hitung, eja, emoji, …)
    var skill = skillAnswer(raw);
    if (skill && skill.text) {
      var t1 = polish(skill.text, raw);
      rememberTurn(raw, t1, skill.tags);
      return { handled: true, text: t1, response: t1, engine: skill.engine, version: VERSION, vocab: vocab, tags: skill.tags };
    }

    // 2) Percakapan (instruction)
    var conv = conversationAnswer(raw);
    if (conv && conv.text) {
      var t2 = polish(conv.text, raw);
      rememberTurn(raw, t2, conv.tags);
      return { handled: true, text: t2, response: t2, engine: conv.engine, version: VERSION, vocab: vocab, tags: conv.tags };
    }

    // 3) Nalar ringan non-sistem
    var reason = reasonAnswer(raw);
    if (reason && reason.text) {
      var t3 = polish(reason.text, raw);
      rememberTurn(raw, t3, reason.tags);
      return { handled: true, text: t3, response: t3, engine: reason.engine, version: VERSION, vocab: vocab, tags: reason.tags };
    }

    // 4) Vocab DATA_RETRIEVE tanpa target → klarifikasi natural (bukan template sistem)
    if (vocab && vocab.intent === "DATA_RETRIEVE" && vocab.requiresTarget) {
      var t4 = polish("Kamu ingin tarik data — sebutkan targetnya dulu: customer, mitra, driver, resto, atau transaksi?", raw);
      return { handled: true, text: t4, response: t4, engine: "CGO_VOCAB_CLARIFY", version: VERSION, vocab: vocab, tags: ["vocab", "clarify"] };
    }

    return { handled: false, text: null, reason: "PASS_TO_SYSTEM_BRAIN", vocab: vocab, version: VERSION };
  }

  function status() {
    return {
      version: VERSION,
      cikur: !!getCikur(),
      cikurVersion: (getCikur() && getCikur().VERSION) || null,
      instruction: !!getInstruction(),
      vocab: !!getVocab(),
      emosi: !!getEmosi(),
      narasi: !!getNarasi(),
      memory: !!getMemoryApi(),
      memoryCount: (memoryStore && memoryStore.items && memoryStore.items.length) || 0
    };
  }

  var API = {
    VERSION: VERSION,
    think: think,
    status: status,
    skillAnswer: skillAnswer,
    conversationAnswer: conversationAnswer,
    polish: polish,
    parseVocab: parseVocab
  };

  try {
    g().CGOOtak = API;
  } catch (_) {}

  if (typeof module === "object" && module.exports) {
    module.exports = API;
  }
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this);
