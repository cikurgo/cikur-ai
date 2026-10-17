/**
 * CGO Otak Orchestrator — V1.8.0-HUB-ALIGNED-ZR
 * Satu pintu penalaran natural (skills + instruction + nalar + gaya + domain).
 * Tidak menyentuh proof chain / investigasi / guardian / mutasi source.
 * Zero network. Aditif untuk Hub & browser-adapter.
 *
 * v1.8.0 (selaras Hub 1.17.4):
 *  - Domain KB aditif: RIDE, FOOD, RESTO, CikurPay, mitra, tagline, CGO/BCGO
 *  - Percakapan & smalltalk diperkaya (tanpa menimpa skill hitung/eja/jam)
 *  - detectLang lebih sensitif multi-bahasa
 *  - Warna tambahan; API domainAnswer diekspos
 *  - Zero regresi: seluruh skill lama (math, spell, time, unit, percent) tetap
 */
(function (global) {
  "use strict";
  var VERSION = "1.8.3-UNITS-WORDMATH-ZR";
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
    if (/\b(english|in english|bahasa inggris|answer in english)\b/i.test(s)) return "en";
    if (/^(spell)\b/i.test(s)) return "en";
    if (/\b(what time is it|what is the time|what's the time|current time|what day is it|what is the date|what's the date)\b/i.test(s)) return "en";
    if (/\b(tomorrow|yesterday|what day|what time|next week|last week|next month|last month|days? ago|days? from now|hours? ago|hours? from now|minutes? ago|minutes? from now)\b/i.test(s)) return "en";
    if (/[\u3040-\u30ff\u3400-\u9faf]/.test(s) || /\b(日本語|nihongo|japanese|bahasa jepang)\b/i.test(s)) return "ja";
    if (/\b(español|spanish|bahasa spanyol)\b/i.test(s)) return "es";
    if (/\b(français|french|bahasa perancis)\b/i.test(s)) return "fr";
    if (/\b(deutsch|german|bahasa jerman)\b/i.test(s)) return "de";
    if (/\b(portugu[eê]s|portuguese|bahasa portugis)\b/i.test(s)) return "pt";
    if (/[\u0600-\u06ff]/.test(s) || /\b(arabic|bahasa arab)\b/i.test(s)) return "ar";
    // heuristic: english function words vs indonesian
    var low = s.toLowerCase();
    var enHits = (low.match(/\b(the|and|what|how|please|thanks|can|you|calculate|spell|hello)\b/g) || []).length;
    var idHits = (low.match(/\b(yang|dan|apa|bagaimana|tolong|terima|kasih|bisa|kamu|hitung|eja|halo)\b/g) || []).length;
    if (enHits >= 2 && enHits > idHits) return "en";
    if (idHits >= 2 && idHits > enHits) return "id";
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
    if (TALK_RE.test(b)) return null; // "tadi bahas apa jam berapa" = ingatan percakapan, bukan jam sekarang
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
    if (TALK_RE.test(b)) return null;
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

  /* ═══════════ TEMPORAL v1.7.0 · tanggal relatif · aritmetika jam · zona waktu ═══════════
   * Aditif: dateAnswer/timeAnswer asli tidak diubah (hari ini / jam sekarang tetap sama).
   * Hanya berjalan untuk pertanyaan relatif ("kemarin", "besok", "3 hari lagi", "2 jam lagi",
   * "jam berapa di Tokyo", "sejam sebelum jam 14.30"). Murni lokal, tanpa jaringan. */
  var TALK_RE = /\b(bahas|membahas|dibahas|bicara|dibicarakan|bicarain|ngobrol|obrol|diobrolin|omong|ngomong|ngomongin|omongin|tanya|nanya|ditanya|menanyakan|topik|cerita|diskusi|percakapan|pertanyaan|chat)\b/i;
  var UNIT_WORD = { satu: 1, dua: 2, tiga: 3, empat: 4, lima: 5, enam: 6, tujuh: 7, delapan: 8, sembilan: 9 };

  function idNumber(str) {
    var s = String(str || "").trim().toLowerCase();
    if (!s) return null;
    if (/^\d+(?:[.,]\d+)?$/.test(s)) return Number(s.replace(",", "."));
    if (s === "se" || s === "sebuah") return 1;
    if (s === "setengah") return 0.5;
    if (s === "seperempat") return 0.25;
    if (s === "sepuluh") return 10;
    if (s === "sebelas") return 11;
    if (s === "seratus") return 100;
    var n;
    var mm = s.match(/^(satu|dua|tiga|empat|lima|enam|tujuh|delapan|sembilan) belas$/);
    if (mm) return UNIT_WORD[mm[1]] + 10;
    mm = s.match(/^(se|satu|dua|tiga|empat|lima|enam|tujuh|delapan|sembilan) ?puluh(?: (satu|dua|tiga|empat|lima|enam|tujuh|delapan|sembilan))?$/);
    if (mm) {
      n = (mm[1] === "se" ? 1 : UNIT_WORD[mm[1]]) * 10;
      if (mm[2]) n += UNIT_WORD[mm[2]];
      return n;
    }
    if (UNIT_WORD[s]) return UNIT_WORD[s];
    return null;
  }

  var NUM_PAT = "(\\d+(?:[.,]\\d+)?|setengah|seperempat|sepuluh|sebelas|seratus|(?:satu|dua|tiga|empat|lima|enam|tujuh|delapan|sembilan) belas|(?:se|satu|dua|tiga|empat|lima|enam|tujuh|delapan|sembilan) ?puluh(?: (?:satu|dua|tiga|empat|lima|enam|tujuh|delapan|sembilan))?|satu|dua|tiga|empat|lima|enam|tujuh|delapan|sembilan)";

  function normTemporal(text) {
    return " " + String(text || "").toLowerCase()
      .replace(/[?!,;()"“”]/g, " ")
      .replace(/(?<!\d)[.:]|[.:](?!\d)/g, " ")
      .replace(/\bkmrn\b|\bkemaren\b/g, "kemarin")
      .replace(/\bbsk\b/g, "besok")
      .replace(/\btgl\b/g, "tanggal")
      .replace(/\bsatu\s+setengah\s+jam\b/g, "90 menit")
      .replace(/\bsetengah\s+jam\b/g, "30 menit")
      .replace(/\bseperempat\s+jam\b/g, "15 menit")
      .replace(/\bsejam\b/g, "1 jam")
      .replace(/\bsemenit\b/g, "1 menit")
      .replace(/\bsehari\b/g, "1 hari")
      .replace(/\bseminggu\b/g, "1 minggu")
      .replace(/\bsebulan\b/g, "1 bulan")
      .replace(/\bsetahun\b/g, "1 tahun")
      .replace(/\s+/g, " ") + " ";
  }

  function addDays(d, n) { var x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
  function addMonthsSafe(d, n) {
    var x = new Date(d.getTime()), day = x.getDate();
    x.setDate(1); x.setMonth(x.getMonth() + n);
    var last = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate();
    x.setDate(Math.min(day, last));
    return x;
  }

  function fmtDateFull(d, lang) {
    var day = d.getDay(), dd = d.getDate(), mm = d.getMonth(), yyyy = d.getFullYear();
    if (lang === "en") return HARI_EN[day] + ", " + BULAN_EN[mm] + " " + dd + ", " + yyyy;
    if (lang === "ja") return yyyy + "年" + (mm + 1) + "月" + dd + "日";
    return HARI_ID[day] + ", " + dd + " " + BULAN_ID[mm] + " " + yyyy;
  }

  function relDateAnswer(body, lang) {
    var raw = String(body || "");
    if (raw.length > 90) return null;
    var b = normTemporal(raw);
    if (TALK_RE.test(b)) return null; // pertanyaan memori percakapan, bukan kalender
    if (!/ (tanggal|hari|date|day|tanggalnya|harinya) /.test(b)) return null;
    var now = new Date(), target = null, label = null, labelEn = null, m;

    if (/ (kemarin lusa|kemarin dulu|day before yesterday) /.test(b) || / (dua|2) hari (yang )?(lalu|lewat|silam) /.test(b)) {
      target = addDays(now, -2); label = "Kemarin lusa"; labelEn = "The day before yesterday";
    } else if (/ (kemarin|semalam|yesterday) /.test(b)) {
      target = addDays(now, -1); label = "Kemarin"; labelEn = "Yesterday";
    } else if (/ (lusa|day after tomorrow) /.test(b)) {
      target = addDays(now, 2); label = "Lusa"; labelEn = "The day after tomorrow";
    } else if (/ (besok|esok|tomorrow) /.test(b)) {
      target = addDays(now, 1); label = "Besok"; labelEn = "Tomorrow";
    } else if (/ (minggu|pekan) (depan|lalu|kemarin) | (next|last) week /.test(b)) {
      var off = / (minggu|pekan) (lalu|kemarin) | last week /.test(b) ? -7 : 7;
      target = addDays(now, off);
      label = off > 0 ? "Minggu depan (7 hari lagi)" : "Minggu lalu (7 hari yang lalu)";
      labelEn = off > 0 ? "Next week (7 days from now)" : "Last week (7 days ago)";
    } else if (/ bulan (depan|lalu|kemarin) | (next|last) month /.test(b)) {
      var mo = / bulan (lalu|kemarin) | last month /.test(b) ? -1 : 1;
      target = addMonthsSafe(now, mo); label = mo > 0 ? "Bulan depan" : "Bulan lalu"; labelEn = mo > 0 ? "Next month" : "Last month";
    } else if (/ tahun (depan|lalu|kemarin) | (next|last) year /.test(b)) {
      var yr = / tahun (lalu|kemarin) | last year /.test(b) ? -1 : 1;
      target = addMonthsSafe(now, yr * 12); label = yr > 0 ? "Tahun depan" : "Tahun lalu"; labelEn = yr > 0 ? "Next year" : "Last year";
    } else {
      var re = new RegExp(" (?:dalam |in )?" + NUM_PAT + " (hari|minggu|pekan|bulan|tahun|days?|weeks?|months?|years?) (lagi|ke depan|kedepan|lalu|yang lalu|yg lalu|lewat|silam|sebelumnya|kemudian|dari sekarang|from now|ago|later) ");
      m = b.match(re);
      if (!m) return null;
      var n = idNumber(m[1]);
      if (n == null || !(n >= 0) || n > 100000) return null;
      var unit = m[2].replace(/s$/, ""), dir = /lalu|lewat|silam|sebelumnya|ago/.test(m[3]) ? -1 : 1;
      var uId = { hari: "hari", day: "hari", minggu: "minggu", pekan: "minggu", week: "minggu", bulan: "bulan", month: "bulan", tahun: "tahun", year: "tahun" }[unit];
      var uEn = { hari: "day", day: "day", minggu: "week", pekan: "week", week: "week", bulan: "month", month: "month", tahun: "year", year: "year" }[unit];
      if (!uId) return null;
      if (uId === "hari") target = addDays(now, dir * n);
      else if (uId === "minggu") target = addDays(now, dir * n * 7);
      else if (uId === "bulan") target = addMonthsSafe(now, dir * n);
      else target = addMonthsSafe(now, dir * n * 12);
      label = n + " " + uId + (dir > 0 ? " lagi" : " yang lalu");
      labelEn = dir > 0 ? ("In " + n + " " + uEn + (n === 1 ? "" : "s")) : (n + " " + uEn + (n === 1 ? "" : "s") + " ago");
    }
    if (!target) return null;
    var text = lang === "en"
      ? labelEn + (/ ago$/.test(labelEn) ? " it was " : " is ") + fmtDateFull(target, "en") + "."
      : label + ": " + fmtDateFull(target, lang === "ja" ? "ja" : "id") + ".";
    return { text: text, engine: "CGO_DATE_REL", tags: ["skill", "tanggal", "relatif"] };
  }

  var TZ_MAP = [
    [/\b(wib|jakarta|bandung|surabaya|medan)\b/, "Asia/Jakarta", "WIB"],
    [/\b(wita|makassar|bali|denpasar|balikpapan)\b/, "Asia/Makassar", "WITA"],
    [/\b(wit|jayapura|papua|ambon|maluku)\b/, "Asia/Jayapura", "WIT"],
    [/\b(tokyo|jepang|japan)\b/, "Asia/Tokyo", "Tokyo"],
    [/\b(seoul|korea)\b/, "Asia/Seoul", "Seoul"],
    [/\b(singapura|singapore)\b/, "Asia/Singapore", "Singapura"],
    [/\b(kuala lumpur|malaysia)\b/, "Asia/Kuala_Lumpur", "Kuala Lumpur"],
    [/\b(bangkok|thailand)\b/, "Asia/Bangkok", "Bangkok"],
    [/\b(beijing|china|cina|shanghai|tiongkok)\b/, "Asia/Shanghai", "Beijing"],
    [/\b(hong kong)\b/, "Asia/Hong_Kong", "Hong Kong"],
    [/\b(dubai|uea|emirat)\b/, "Asia/Dubai", "Dubai"],
    [/\b(mekkah|mekah|makkah|madinah|saudi|riyadh)\b/, "Asia/Riyadh", "Arab Saudi"],
    [/\b(india|delhi|mumbai)\b/, "Asia/Kolkata", "India"],
    [/\b(istanbul|turki|turkey)\b/, "Europe/Istanbul", "Istanbul"],
    [/\b(london|inggris|uk|britania)\b/, "Europe/London", "London"],
    [/\b(paris|prancis|perancis|france)\b/, "Europe/Paris", "Paris"],
    [/\b(berlin|jerman|germany|amsterdam|belanda|roma|italia|madrid|spanyol)\b/, "Europe/Berlin", "Eropa Tengah"],
    [/\b(new york|nyc|washington|miami|toronto)\b/, "America/New_York", "New York"],
    [/\b(chicago|texas|dallas)\b/, "America/Chicago", "Chicago"],
    [/\b(los angeles|california|san francisco|seattle|las vegas)\b/, "America/Los_Angeles", "Los Angeles"],
    [/\b(sydney|australia|melbourne|canberra)\b/, "Australia/Sydney", "Sydney"],
    [/\b(perth)\b/, "Australia/Perth", "Perth"],
    [/\b(auckland|selandia baru|new zealand)\b/, "Pacific/Auckland", "Auckland"],
    [/\b(utc|gmt)\b/, "UTC", "UTC"]
  ];

  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function hhmm(d) { return pad2(d.getHours()) + ":" + pad2(d.getMinutes()); }

  function durationMinutes(chunk) {
    // "2 jam 30 menit" · "90 menit" · "satu jam" · "dua puluh menit"
    var re = new RegExp(NUM_PAT + " (jam|menit|hours?|hrs?|minutes?|mins?)\\b", "g"), m, tot = 0, ok = false;
    while ((m = re.exec(chunk))) {
      var n = idNumber(m[1]);
      if (n == null) continue;
      ok = true;
      tot += /^(jam|hour|hr)/.test(m[2]) ? n * 60 : n;
    }
    return ok ? Math.round(tot) : null;
  }

  function relTimeAnswer(body, lang) {
    var raw = String(body || "");
    if (raw.length > 100) return null;
    var b = normTemporal(raw);
    if (TALK_RE.test(b)) return null;
    var now = new Date(), m;

    // (a) zona waktu: "jam berapa di tokyo" · "what time is it in london" · "jam wita sekarang"
    if ((/ (jam|pukul|waktu|time) /.test(b) && / (berapa|sekarang|now|is it) /.test(b)) || / (jam|pukul) (wib|wita|wit) /.test(b)) {
      var place = null;
      m = b.match(/ (?:di|in|untuk|for) (.+?)(?: sekarang| now| ya| dong| nih)* $/);
      var cand = m ? m[1] : b;
      for (var i = 0; i < TZ_MAP.length && !place; i++) {
        if (TZ_MAP[i][0].test(cand)) place = TZ_MAP[i];
      }
      if (!place && !m && / (wib|wita|wit|utc|gmt) /.test(b)) {
        for (var k = 0; k < TZ_MAP.length && !place; k++) { if (TZ_MAP[k][0].test(b)) place = TZ_MAP[k]; }
      }
      if (place) {
        try {
          var parts = new Intl.DateTimeFormat("en-GB", { timeZone: place[1], hour: "2-digit", minute: "2-digit", hour12: false, weekday: "long" }).formatToParts(now);
          var pv = {}; parts.forEach(function (x) { pv[x.type] = x.value; });
          var clock = pv.hour.replace(/^24$/, "00") + ":" + pv.minute;
          var theirDay = new Intl.DateTimeFormat("en-GB", { timeZone: place[1], day: "numeric" }).format(now);
          var sameDay = theirDay === String(now.getDate());
          var txt = lang === "en"
            ? "It's " + clock + " in " + place[2] + (sameDay ? "." : " (" + pv.weekday + " there).")
            : "Di " + place[2] + " sekarang pukul " + clock + (sameDay ? "." : " (hari " + pv.weekday + " di sana, tanggalnya beda dengan tempatmu).");
          return { text: txt, engine: "CGO_TIME_ZONE", tags: ["skill", "waktu", "zona"] };
        } catch (_) {}
      }
    }

    // (b) offset dari sekarang: "2 jam lagi jam berapa" · "jam berapa 30 menit lagi" · "sejam yang lalu jam berapa"
    if (/ (jam|pukul|time|clock) /.test(b) || / berapa /.test(b) || / what /.test(b)) {
      m = b.match(new RegExp("((?:" + NUM_PAT + " (?:jam|menit|hours?|hrs?|minutes?|mins?)(?: dan)? ?)+) (lagi|ke depan|kedepan|dari sekarang|from now|later|lalu|yang lalu|yg lalu|lewat|silam|tadi|ago) "));
      var inForm = false;
      if (!m) {
        m = b.match(new RegExp(" (?:in|dalam) ((?:" + NUM_PAT + " (?:jam|menit|hours?|hrs?|minutes?|mins?)(?: dan| and)? ?)+) "));
        if (m) { m.push("lagi"); inForm = true; }
      }
      if (m && !/ (sebelum|sesudah|setelah|before|after) /.test(b)) {
        var mins = durationMinutes(m[1]);
        if (mins != null && mins >= 0 && mins <= 60 * 24 * 60) {
          var past = !inForm && /lalu|yg lalu|lewat|silam|tadi|ago/.test(m[m.length - 1]);
          var t2 = new Date(now.getTime() + (past ? -1 : 1) * mins * 60000);
          var dayDiff = Math.round((new Date(t2.getFullYear(), t2.getMonth(), t2.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
          var durTxt = String(m[1]).trim();
          var dayNote = dayDiff === 0 ? "" : (dayDiff === 1 ? " (besok)" : (dayDiff === -1 ? " (kemarin)" : " (" + fmtDateFull(t2, "id") + ")"));
          var txt2 = lang === "en"
            ? (past ? durTxt + " ago it was " : "In " + durTxt + " it will be ") + hhmm(t2) + (dayDiff === 0 ? "." : " (" + fmtDateFull(t2, "en") + ").")
            : durTxt + (past ? " yang lalu" : " lagi") + " = pukul " + hhmm(t2) + dayNote + ".";
          return { text: txt2, engine: "CGO_TIME_REL", tags: ["skill", "waktu", "relatif"] };
        }
      }
    }

    // (c) aritmetika jam: "sejam sebelum jam 14.30" · "2 jam setelah jam 8 pagi" · "30 menit sebelum jam 9"
    m = b.match(new RegExp("((?:" + NUM_PAT + " (?:jam|menit|hours?|hrs?|minutes?|mins?)(?: dan| and)? ?)+) (sebelum|sesudah|setelah|before|after) (?:jam |pukul |at )?(\\d{1,2})(?:[.:](\\d{2}))?(?: (pagi|siang|sore|malam|am|pm))? "));
    if (m) {
      var dm = durationMinutes(m[1]);
      if (dm != null) {
        var H = Number(m[4]), M = m[5] ? Number(m[5]) : 0, ap = m[6] || "";
        if (H <= 24 && M < 60) {
          if (/pm|sore|malam/.test(ap) && H < 12) H += 12;
          if (/siang/.test(ap) && H < 11) H += 12;
          var base = new Date(2000, 0, 2, H % 24, M, 0);
          var sign = /sebelum|before/.test(m[3]) ? -1 : 1;
          var res = new Date(base.getTime() + sign * dm * 60000);
          var dd = Math.round((new Date(res.getFullYear(), res.getMonth(), res.getDate()) - new Date(2000, 0, 2)) / 86400000);
          var note = dd < 0 ? " (hari sebelumnya)" : (dd > 0 ? " (hari berikutnya)" : "");
          return {
            text: lang === "en"
              ? String(m[1]).trim() + " " + (sign < 0 ? "before " : "after ") + pad2(base.getHours()) + ":" + pad2(base.getMinutes()) + " is " + hhmm(res) + (dd ? (dd < 0 ? " (previous day)" : " (next day)") : "") + "."
              : String(m[1]).trim() + " " + (sign < 0 ? "sebelum" : "sesudah") + " pukul " + pad2(base.getHours()) + ":" + pad2(base.getMinutes()) + " = pukul " + hhmm(res) + note + ".",
            engine: "CGO_TIME_ARITH", tags: ["skill", "waktu", "aritmetika"]
          };
        }
      }
    }
    return null;
  }

  /* ═══ v1.7.1 · hitungan dengan angka berupa kata · konversi dengan nama satuan lengkap ═══ */
  var NW_UNIT = { nol: 0, satu: 1, dua: 2, tiga: 3, empat: 4, lima: 5, enam: 6, tujuh: 7, delapan: 8, sembilan: 9, sepuluh: 10, sebelas: 11 };
  var NW_OPS = { pangkat: "^", ditambah: "+", tambah: "+", plus: "+", dikurangi: "-", kurang: "-", minus: "-", dikali: "*", kali: "*", times: "*", dibagi: "/", bagi: "/" };
  var NW_FILLER = /^(hitung|berapa|hasil|hasilnya|adalah|sama|dengan|itu|apa|ya|dong|tolong|coba|kalau|jika|bila|sih)$/;

  function wordsToNumberRun(tokens) {
    // ["dua","ratus","lima","puluh"] -> 250 ; null bila bukan angka-kata valid
    var total = 0, cur = 0, last = 0, seen = false;
    for (var i = 0; i < tokens.length; i++) {
      var w = tokens[i];
      if (w === "seratus") { cur += 100; last = 0; seen = true; }
      else if (w === "seribu") { total += 1000; last = 0; seen = true; }
      else if (w === "sepuluh") { cur += 10; last = 0; seen = true; }
      else if (w === "sebelas") { cur += 11; last = 0; seen = true; }
      else if (Object.prototype.hasOwnProperty.call(NW_UNIT, w)) { cur += NW_UNIT[w]; last = NW_UNIT[w]; seen = true; }
      else if (w === "belas") { cur += 10; last = 0; seen = true; }
      else if (w === "puluh") { cur = cur - last + (last || 1) * 10; last = 0; seen = true; }
      else if (w === "ratus") { cur = cur - last + (last || 1) * 100; last = 0; seen = true; }
      else if (w === "ribu") { total += (cur || 1) * 1000; cur = 0; last = 0; seen = true; }
      else if (w === "juta") { total += (cur || 1) * 1000000; cur = 0; last = 0; seen = true; }
      else return null;
    }
    return seen ? total + cur : null;
  }

  function wordMathAnswer(body, lang) {
    var raw = String(body || "");
    if (raw.length > 90 || TALK_RE.test(raw)) return null;
    var toks = raw.toLowerCase().replace(/[?!,=]/g, " ").split(/\s+/).filter(Boolean);
    if (toks.length < 3) return null;
    var out = [], run = [], sawWordNum = false, sawOp = false, sawWordOp = false, i;
    function flush() {
      if (!run.length) return true;
      var n = wordsToNumberRun(run);
      if (n == null) return false;
      out.push(String(n)); sawWordNum = true; run = [];
      return true;
    }
    for (i = 0; i < toks.length; i++) {
      var w = toks[i];
      if (NW_FILLER.test(w)) { if (!flush()) return null; continue; }
      if (Object.prototype.hasOwnProperty.call(NW_OPS, w)) { if (!flush()) return null; out.push(NW_OPS[w]); sawOp = true; sawWordOp = true; continue; }
      if (/^\d+(?:[.,]\d+)?$/.test(w)) { if (!flush()) return null; out.push(w.replace(",", ".")); continue; }
      if (/^[+\-*\/x×÷]$/.test(w)) { if (!flush()) return null; out.push(w === "x" || w === "×" ? "*" : (w === "÷" ? "/" : w)); sawOp = true; continue; }
      if (wordsToNumberRun([w]) != null) { run.push(w); continue; }
      return null; // ada kata lain → bukan hitungan murni, biarkan jalur lain
    }
    if (!flush() || !sawOp || !(sawWordNum || sawWordOp)) return null;
    var expr = out.join(" ");
    var pw = expr.match(/^(\d+(?:\.\d+)?) \^ (\d+)$/);
    if (pw) {
      var base = Number(pw[1]), ex = Number(pw[2]);
      if (ex > 64) return null;
      var pv = Math.pow(base, ex);
      if (!isFinite(pv)) return null;
      return { text: formatNumberResult(pv, lang), engine: "CIKUR_HITUNG", tags: ["skill", "hitung", "pangkat"] };
    }
    if (!/^[\d.\s+\-*\/]+$/.test(expr) || !/\d\s*[+\-*\/]\s*\d/.test(expr)) return null;
    var math = evalLocaleMath(expr);
    if (!math) return null;
    return { text: formatNumberResult(math.value, lang), engine: "CIKUR_HITUNG", tags: ["skill", "hitung", "kata"] };
  }


  /* ═══ v1.8.3 · satuan imperial (mil, kaki, inci, pon, ons) dan suhu (celsius/fahrenheit/kelvin) ═══ */
  var EXT_LEN = { mile: 1609.344, miles: 1609.344, mil: 1609.344, feet: 0.3048, foot: 0.3048, kaki: 0.3048, inch: 0.0254, inches: 0.0254, inci: 0.0254, yard: 0.9144, yards: 0.9144,
    km: 1000, kilometer: 1000, m: 1, meter: 1, cm: 0.01, sentimeter: 0.01, centimeter: 0.01, mm: 0.001, milimeter: 0.001 };
  var EXT_MASS = { pound: 453.59237, pounds: 453.59237, pon: 453.59237, lb: 453.59237, lbs: 453.59237, ounce: 28.349523125, ounces: 28.349523125, ons: 28.349523125, oz: 28.349523125,
    kg: 1000, kilogram: 1000, kilo: 1000, g: 1, gram: 1, mg: 0.001, ton: 1000000 };
  var EXT_ONLY = /^(mile|miles|mil|feet|foot|kaki|inch|inches|inci|yard|yards|pound|pounds|pon|lb|lbs|ounce|ounces|ons|oz|ton|celsius|fahrenheit|kelvin)$/;
  var EXT_TEMP = { celsius: "c", fahrenheit: "f", kelvin: "k" };
  function fmtExt(n) { return String(Math.round(n * 10000) / 10000); }
  function extUnitAnswer(body, lang) {
    var raw = String(body || "").toLowerCase().replace(/[?!]/g, " ").replace(/\bderajat\b|°/g, " ").replace(/\s+/g, " ").trim();
    if (raw.length > 90 || TALK_RE.test(raw)) return null;
    var m = raw.match(/(?:konversi\s+|convert\s+|berapa\s+)?(-?\d+(?:[.,]\d+)?)\s*([a-z]+)\s+(?:ke|to|in|jadi|dalam|menjadi|sama dengan)\s+(?:berapa\s+)?([a-z]+)\b/);
    if (!m) return null;
    var n = Number(m[1].replace(",", ".")), from = m[2], to = m[3];
    if (!isFinite(n)) return null;
    if (!EXT_ONLY.test(from) && !EXT_ONLY.test(to)) return null; // satuan biasa → biarkan unitConvert lama
    var out, label;
    if (EXT_TEMP[from] && EXT_TEMP[to]) {
      var c = EXT_TEMP[from] === "c" ? n : EXT_TEMP[from] === "f" ? (n - 32) * 5 / 9 : n - 273.15;
      out = EXT_TEMP[to] === "c" ? c : EXT_TEMP[to] === "f" ? c * 9 / 5 + 32 : c + 273.15;
      var sym = { celsius: "°C", fahrenheit: "°F", kelvin: "K" };
      return { text: fmtExt(n) + " " + sym[from] + " = " + fmtExt(out) + " " + sym[to], engine: "CGO_UNIT", tags: ["skill", "satuan", "suhu"] };
    }
    var table = (EXT_LEN[from] != null && EXT_LEN[to] != null) ? EXT_LEN : (EXT_MASS[from] != null && EXT_MASS[to] != null) ? EXT_MASS : null;
    if (!table) return null;
    out = n * table[from] / table[to];
    return { text: fmtExt(n) + " " + from + " = " + fmtExt(out) + " " + to, engine: "CGO_UNIT", tags: ["skill", "satuan"] };
  }

  var UNIT_NAMES = [[/\bkilometer\b/g, "km"], [/\bsentimeter\b|\bcentimeter\b/g, "cm"], [/\bmilimeter\b|\bmillimeter\b/g, "mm"], [/\bmeter\b/g, "m"],
    [/\bkilogram\b|\bkilo\b/g, "kg"], [/\bmiligram\b/g, "mg"], [/\bgram\b/g, "g"], [/\bmililiter\b/g, "ml"], [/\bliter\b/g, "l"]];
  function unitNameAnswer(body, lang) {
    var raw = String(body || "").toLowerCase();
    if (raw.length > 80 || !/\d/.test(raw) || TALK_RE.test(raw)) return null;
    var nb = raw.replace(/[?!]/g, " ");
    var changed = false;
    UNIT_NAMES.forEach(function (u) { var r = nb.replace(u[0], u[1]); if (r !== nb) changed = true; nb = r; });
    if (!changed) return null;
    nb = nb.replace(/\b(?:sama\s+dengan\s+berapa|jadi\s+berapa|berapa)\b/, "ke").replace(/\s+/g, " ").trim();
    return unitConvert(nb, lang);
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
    var m = b.match(/(?:konversi\s+)?(\d+([.,]\d+)?)\s*(km|m|cm|mm|kg|g|mg|l|ml)(?![a-z])\s*(?:ke|to|jadi|=)\s*(km|m|cm|mm|kg|g|mg|l|ml)(?![a-z])/i);
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
    white: {id:"putih",en:"white",ja:"白",es:"blanco",fr:"blanc",de:"weiß",pt:"branco",ar:"أبيض"},
    orange: {id:"oranye",en:"orange",ja:"オレンジ",es:"naranja",fr:"orange",de:"orange",pt:"laranja",ar:"برتقالي"},
    purple: {id:"ungu",en:"purple",ja:"紫",es:"morado",fr:"violet",de:"lila",pt:"roxo",ar:"بنفسجي"},
    pink: {id:"merah muda",en:"pink",ja:"ピンク",es:"rosa",fr:"rose",de:"rosa",pt:"rosa",ar:"وردي"},
    gray: {id:"abu-abu",en:"gray",ja:"灰色",es:"gris",fr:"gris",de:"grau",pt:"cinza",ar:"رمادي"},
    brown: {id:"cokelat",en:"brown",ja:"茶色",es:"marrón",fr:"brun",de:"braun",pt:"marrom",ar:"بني"}
  };
  function colorNameML(name, lang) {
    var key = String(name || "").toLowerCase();
    var alias = {
      merah:"red",red:"red",biru:"blue",blue:"blue",hijau:"green",green:"green",
      kuning:"yellow",yellow:"yellow",hitam:"black",black:"black",putih:"white",white:"white",
      oranye:"orange",orange:"orange",ungu:"purple",purple:"purple",pink:"pink","merah muda":"pink",
      "abu-abu":"gray",gray:"gray",grey:"gray",cokelat:"brown",coklat:"brown",brown:"brown"
    };
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
    var wmAns = wordMathAnswer(body, lang);
    if (wmAns) return wmAns;
    var euAns = extUnitAnswer(body, lang);
    if (euAns) return euAns;
    var ucAns = unitNameAnswer(body, lang);
    if (ucAns) return ucAns;
    var rtAns = relTimeAnswer(body, lang);
    if (rtAns) return rtAns;
    var rdAns = relDateAnswer(body, lang);
    if (rdAns) return rdAns;
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

  /**
   * Domain knowledge selaras Hub KB — aditif, tidak menimpa skill hitung/eja/jam.
   */
  function domainAnswer(raw) {
    var text = String(raw || "").trim();
    if (!text || text.length > 240) return null;
    var b = " " + text.toLowerCase()
      .replace(/[?!,;()"“”']/g, " ")
      .replace(/\s+/g, " ") + " ";

    function pack(t, topic) {
      return { text: t, engine: "CGO_DOMAIN", tags: ["domain", topic || "cikur"] };
    }

    if (/ (apa itu|apa sih|jelaskan) (cikur go ride|cikurgo ride|layanan ride|fitur ride) | (cikur go ride|cikurgo ride) itu apa | (what is|explain) (cikur go )?ride /.test(b)) {
      var en = /\b(what is|explain)\b/.test(b) && !/\b(apa itu|jelaskan)\b/.test(b);
      return pack(en
        ? "CIKUR GO RIDE is motorbike taxi: pickup from A to B. The passenger orders, the app finds a nearby driver, fare uses configured base + per-km rates."
        : "CIKUR GO RIDE adalah layanan ojek motor: penumpang atau barang diantar dari titik ke titik. Pelanggan memesan, aplikasi mencarikan driver terdekat, tarif dari konfigurasi (dasar + per km).", "RIDE");
    }
    if (/ (apa itu|apa sih|jelaskan) (cikur go food|cikurgo food|layanan food|fitur food) | (cikur go food|cikurgo food) itu apa /.test(b)) {
      return pack("CIKUR GO FOOD adalah layanan pesan-antar makanan: pesan dari mitra resto/pedagang, driver mengambil lalu mengantar.", "FOOD");
    }
    if (/ (apa itu|apa sih|jelaskan) (cikur go resto|cikurgo resto|layanan resto) | (cikur go resto|cikurgo resto) itu apa /.test(b)) {
      return pack("CIKUR GO RESTO adalah jalur mitra restoran/warung: terima pesanan lewat aplikasi, atur menu, dipasangkan driver FOOD.", "RESTO");
    }
    if (/ (apa itu|apa sih|jelaskan) (cikurpay|cikur pay) | (cikurpay|cikur pay) itu apa | (what is|explain) (cikurpay|cikur pay) /.test(b)) {
      var en = /\b(what is|explain)\b/.test(b) && !/\b(apa itu|jelaskan)\b/.test(b);
      return pack(en
        ? "CikurPay is the payment channel in CIKUR GO for RIDE/FOOD and partner transactions. Methods follow official app configuration."
        : "CikurPay adalah kanal pembayaran di ekosistem CIKUR GO untuk pesanan RIDE/FOOD dan transaksi mitra. Metode mengikuti konfigurasi resmi aplikasi.", "CIKURPAY");
    }
    if (/ (tagline|slogan) (cikur ?go|cikurgo) | (cikur ?go|cikurgo).*(tagline|slogan) /.test(b)) {
      return pack("Tagline CIKUR GO: “Pasti Mudah, Pasti Nyaman”.", "TAGLINE");
    }
    if (/ (apa itu|apa sih|jelaskan) (mitra) | mitra itu apa /.test(b) && !/\b(driver|beda|perbedaan)\b/.test(b)) {
      return pack("Mitra di CIKUR GO: driver (RIDE/FOOD), resto/warung, dan agen. Daftar lewat menu Mitra, diverifikasi admin, lalu bisa terima order.", "MITRA");
    }
    if (/ (beda|bedanya|perbedaan) (antara )?(driver|pengemudi|mitra).*(mitra|driver|pengemudi) /.test(b)) {
      return pack("Mitra adalah payung besar kemitraan. Driver adalah salah satu jenis mitra (antar RIDE/FOOD); ada juga mitra resto dan agen. Semua driver mitra, tapi tidak semua mitra adalah driver.", "MITRA_DRIVER");
    }
    if (/ (cara|bagaimana|langkah|syarat).*(daftar|jadi|gabung|menjadi|mendaftar).*(mitra|driver|resto|agen) /.test(b)) {
      return pack("Alur umum: buat/masuk akun CIKUR GO → menu Mitra → pilih jenis (driver/resto/agen) → lengkapi data & verifikasi → kirim pengajuan → tunggu approve admin (pending sampai disetujui).", "DAFTAR_MITRA");
    }
    if (/ (cara|bagaimana|langkah).*(pesan|order|memesan).*(ride|ojek|motor|food|makanan) /.test(b)) {
      return pack("Umumnya: buka CIKUR GO → pilih RIDE atau FOOD → isi jemput/antar atau pilih resto & menu → cek tarif → konfirmasi → tunggu driver. Bayar lewat metode tersedia (termasuk CikurPay bila aktif).", "CARA_PESAN");
    }
    if (/ (layanan|fitur).*(apa saja|apa aja|ada apa|tersedia) | cikur ?go (bisa|punya) apa /.test(b)) {
      return pack("CIKUR GO punya: RIDE (ojek motor), FOOD (pesan makanan), RESTO (mitra resto), jalur Mitra (driver, resto, agen), CikurPay, dan Chat CGO sebagai asisten.", "LAYANAN");
    }
    if (/ (apa itu|apa sih|jelaskan|ceritakan|kenalkan)( tentang)? (aplikasi )?(cikur ?go|cikurgo) | (cikur ?go|cikurgo) itu apa /.test(b) && !/\b(cgo|bcgo)\b/.test(b)) {
      return pack("CIKUR GO adalah aplikasi multi-layanan: RIDE, FOOD, RESTO, jalur Mitra (driver, resto, agen), pembayaran CikurPay, dan Chat CGO. Tagline: “Pasti Mudah, Pasti Nyaman”.", "CIKURGO");
    }
    return null;
  }

    function conversationAnswer(raw) {
    var text = String(raw || "").trim();
    if (!text) return null;
    try {
      var dom = domainAnswer(text);
      if (dom && dom.text) return dom;
    } catch (_) {}
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
      if (/\b(apa\s*(itu\s*)?bcgo|what\s*is\s*bcgo|jelaskan\s*(apa\s*itu\s*)?bcgo|about\s*bcgo)\b/i.test(text))
        return pack("BCGO adalah lingkungan operasi live CIKUR GO: memantau siklus saraf, source scan, organ/modul, telemetry, dan radar agent. CGO membaca bukti dari situ untuk membantu keputusan — tanpa AI eksternal.", "ABOUT_BCGO");
    if (/\b(apa\s*(itu\s*)?cikur(\s*go)?|what\s*is\s*cikur|ceritakan\s*(tentang\s*)?cikur|about\s*cikur|tell\s*me\s*about\s*cikur)\b/i.test(text))
        return pack("CIKUR GO adalah ekosistem operasional (customer, mitra, driver, resto) dengan otak internal CGO: penalaran lokal, ejaan/angka multi-bahasa, dan monitor BCGO.", "ABOUT_CIKUR");
    if (/\b(siapa\s*(yang\s*)?(membuat|bikin|ciptakan)\w*|who\s*(made|built|created)\s*(you|this))\b/i.test(text))
        return pack("Aku bagian dari ekosistem CIKUR GO. Dibangun untuk mendampingi operasional internal — bukan chatbot umum.", "ORIGIN");
    if (/\b(apakah\s*(aman|sehat|oke)|is\s*(everything|it|all)\s*(ok|okay|safe|fine)|all\s*good)\b/i.test(text))
        return pack("Dari sisi monitor: aku pantau organ, scanner, dan telemetry. Tanya «status» untuk ringkasan live.", "SAFETY");
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
    // jangan nalar untuk sapaan / sosial
    if (/^(apa\s*kabar|how\s*are\s*you|halo|hai|hello|hi|makasih|thanks|siapa|who\s*are|what\s*can|bisa\s*bantu)/i.test(body)) return null;

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
          /* jelaskan() hanya untuk objek audit; string biasa menghasilkan "Tidak ada hasil" (keyakinan 0) — bukan jawaban */
          if (jt && !/^tidak ada hasil untuk dijelaskan/i.test(jt) && !(j.keyakinan === 0) && jt.length < 400) return { text: jt, engine: "CIKUR_JELASKAN", tags: ["reason", "jelaskan"] };
        }
      }
    } catch (_) {}

    try {
      if ((wantsExplain || /\?$/.test(body)) && typeof api.nalar === "function") {
        var n = api.nalar(body, {});
        if (n && (n.kesimpulan || n.hasil)) {
          var kt = String(n.kesimpulan || n.hasil || "").trim();
          var garbage = /teks biasa tanpa pola|tidak ada pola|input kosong|teks campuran|^Teks /i.test(kt);
          if (kt && kt.length < 320 && !garbage) {
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
  // Percakapan dasar harus dikenali sebelum parser skill/klasifikasi teknis.
  // Normalisasi ini hanya dipakai untuk pencocokan; teks asli tetap diteruskan ke memori.
  function basicConversationAnswer(raw) {
    var original = String(raw || "").trim();
    if (!original) return null;
    var normalized = original
      .normalize("NFKC")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/[!?.,。！？，]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    var compact = normalized.replace(/(.)\1{2,}/g, "$1");
    var en = /\b(hello|hi|hey|how are you|how r u|what.s up|good morning|good afternoon|good evening|lol|lmao|haha|hehe|thanks|thank you|where have you been|long time no see|can you code|can you write code)\b/i.test(compact)
      || /^(hello|hi|hey|how are you|what.s up|lol|lmao|haha|hehe|thanks|thank you|where have you been|long time no see|can you code|can you write code)/i.test(compact);
    var lang = en ? "en" : "id";

    if (/^(halo|hai|hallo|helo|hello|hi|hey|hei|pagi|siang|sore|malam|selamat (pagi|siang|sore|malam))$/.test(compact)) {
      return { text: lang === "en"
        ? "Heyyy! 😊 I’m here. What’s on your mind?"
        : "Haiiii! 😁 Aku di sini. Ada cerita apa nih?",
        engine: "CGO_SMALLTALK", tags: ["conversation", "greeting"] };
    }
    if (/^(how are you|how r u|how are you doing|what.s up|how have you been)$/.test(compact)) {
      return { text: "I’m here and ready to help 😊 How are you doing?", engine: "CGO_SMALLTALK", tags: ["conversation", "check-in"] };
    }
    if (/^(apa kabar|gimana kabar|bagaimana kabar|kabar kamu|kamu apa kabar)$/.test(compact)) {
      return { text: "Aku baik-baik saja dan siap nemenin ngobrol 😊 Kamu sendiri gimana kabarnya?", engine: "CGO_SMALLTALK", tags: ["conversation", "check-in"] };
    }
    if (/^((?:wk){2,}|(?:ha){2,}h?|(?:he){2,}h?|(?:hi){2,}h?|lol|lmao|ketawa|tertawa|coba ketawa|laugh|make me laugh)(?:\s*[😂🤣]+)?$/.test(compact) || /^[😂🤣]+$/.test(compact)) {
      return { text: /\b(lol|lmao|laugh|make me laugh)\b/.test(compact)
        ? "Haha! 😂 There, a little laugh for you. What made you laugh?"
        : "WKWKWK 😂😂 ikut ketawa aku! Ada apa nih, lucu banget?",
        engine: "CGO_SMALLTALK", tags: ["conversation", "laughter"] };
    }
    if (/^(kemana aja+|ke mana aja+|lama gak ketemu|lama tak jumpa|long time no see)$/.test(compact)) {
      return { text: lang === "en"
        ? "I’m here now 😄 Good to see you again! What have you been up to?"
        : "AKU DI SINIII 😆 Hehehe, senang kamu balik lagi! Gimana kabarmu?",
        engine: "CGO_SMALLTALK", tags: ["conversation", "reconnection"] };
    }
    if (/^(makasih|terima kasih|thanks|thank you|thx)$/.test(compact)) {
      return { text: lang === "en" ? "You’re welcome! 😊" : "Sama-samaaa! 😊",
        engine: "CGO_SMALLTALK", tags: ["conversation", "gratitude"] };
    }
    if (/^(bye|goodbye|dadah|sampai jumpa|selamat tinggal)$/.test(compact)) {
      return { text: lang === "en" ? "See you later! Take care 😊" : "Dadahhh! Sampai ngobrol lagi yaa 😊",
        engine: "CGO_SMALLTALK", tags: ["conversation", "farewell"] };
    }
    if (/^(kamu bisa coding gak|kamu bisa coding|bisa coding gak|can you code|can you write code)$/.test(compact)) {
      return { text: lang === "en"
        ? "Yes—I can help write, inspect, debug, and test code. Share the original files and I’ll make focused changes, then report what was actually tested."
        : "Bisa dong 😁 Aku bisa bantu menulis, memeriksa, memperbaiki, dan menguji kode. Kirim file aslinya; aku akan mengubah bagian yang perlu saja dan menjelaskan hasil tes yang benar-benar dijalankan.",
        engine: "CGO_SMALLTALK", tags: ["conversation", "capability"] };
    }
    // Micro-social cues — natural, not system template
    if (/^(hmm+|hm+|eh+|oh+|yaudah|ya udah|oke deh|ok deh|serius|beneran|really|yeah|yep|sip|mantap|nah)$/.test(compact)) {
      if (/serius|beneran|really/.test(compact))
        return { text: lang === "en" ? "Yes — I’m serious. What should we check?" : "Iya, serius. Mau dicek apa?", engine: "CGO_SMALLTALK", tags: ["conversation", "micro"] };
      if (/yaudah|ya udah|nah/.test(compact))
        return { text: lang === "en" ? "Okay. I’m here if you need me." : "Oke. Panggil aja kalau butuh.", engine: "CGO_SMALLTALK", tags: ["conversation", "micro"] };
      if (/sip|mantap|yeah|yep/.test(compact))
        return { text: lang === "en" ? "Glad that helps." : "Sip!", engine: "CGO_SMALLTALK", tags: ["conversation", "micro"] };
      return { text: lang === "en" ? "I’m here — what’s next?" : "Aku di sini — lanjut apa?", engine: "CGO_SMALLTALK", tags: ["conversation", "micro"] };
    }
    return null;
  }

  function think(question, context) {
    context = context || {};
    var raw = typeof question === "string" ? question : String(question && (question.text || question.question) || "");
    raw = String(raw || "").trim();
    if (!raw) return { handled: false, text: null, reason: "EMPTY" };

    var basic = basicConversationAnswer(raw);
    if (basic && basic.text) {
      var basicText = polish(basic.text, raw);
      rememberTurn(raw, basicText, basic.tags);
      return { handled: true, text: basicText, response: basicText, engine: basic.engine, version: VERSION, tags: basic.tags };
    }

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
      memoryCount: (memoryStore && memoryStore.items && memoryStore.items.length) || 0,
      domain: true,
      alignedHub: "1.17.5"
    };
  }

  var API = {
    VERSION: VERSION,
    think: think,
    status: status,
    skillAnswer: skillAnswer,
    relDateAnswer: relDateAnswer,
    relTimeAnswer: relTimeAnswer,
    conversationAnswer: conversationAnswer,
    domainAnswer: domainAnswer,
    polish: polish,
    parseVocab: parseVocab,
    detectLang: detectLang,
    evalLocaleMath: evalLocaleMath
  };

  try {
    g().CGOOtak = API;
  } catch (_) {}

  if (typeof module === "object" && module.exports) {
    module.exports = API;
  }
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this);
