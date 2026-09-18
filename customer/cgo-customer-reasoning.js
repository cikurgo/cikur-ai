/* ============================================================
 * CIKUR GO — CUSTOMER NATURAL REASONING LAYER
 * ------------------------------------------------------------
 * File    : cgo-customer-reasoning.js
 * Version : 1.1.0-natural-reasoning
 *
 * Internal deterministic language/reasoning layer.
 * No external AI/API. No answer-script database.
 *
 * V1.2.0 improvements:
 * - Expanded free-form everyday language (ID/EN)
 * - Context continuity: continue topic, affirm, refuse, thanks, confusion
 * - Deeper reference to lastTopic / detected needs
 * - Location & time soft handling without inventing facts
 * - Stronger 2in1 / single-service phrase coverage
 * - Formal test matrix companion (smoke-matrix-v2.js)
 * V1.1.0 base: state in conversation, safe math, language override
 * ============================================================ */
(function (window) {
  "use strict";

  const ROOT = window.CGO_CUSTOMER || (window.CGO_CUSTOMER = {});
  const VERSION = "1.7.1-multi-constraint-memory-aware";

  /* ----------------------------------------------------------
   * Utilities
   * ---------------------------------------------------------- */
  function clean(v) {
    return String(v ?? "").trim().replace(/\s+/g, " ");
  }
  function lower(v) {
    return clean(v).toLowerCase();
  }
  function has(v, list) {
    const s = lower(v);
    return list.some((x) => s.includes(x) || fuzzyPhraseMatch(s, x));
  }

  /* ----------------------------------------------------------
   * Fuzzy / typo-tolerant matching (tanpa AI eksternal)
   * ------------------------------------------------------------
   * Dipakai sebagai jaring pengaman KEDUA setelah exact-match gagal,
   * supaya salah ketik ringan (mis. "pesn makanan", "kmau siapa")
   * tetap kena ke pola yang sama seperti versi yang benar.
   * Kata pendek (<4 huruf) sengaja TIDAK di-fuzzy-kan supaya tidak
   * salah cocok (mis. "ok", "di", "ke", "u", "r").
   * ---------------------------------------------------------- */
  function levenshtein(a, b) {
    if (a === b) return 0;
    const al = a.length, bl = b.length;
    if (al === 0) return bl;
    if (bl === 0) return al;
    if (Math.abs(al - bl) > 3) return 99; // beda panjang jauh, pasti bukan typo ringan

    // Damerau-Levenshtein (optimal string alignment): substitusi, sisip, hapus,
    // DAN transposisi dua huruf bersebelahan dihitung 1 langkah saja.
    // Ini penting karena typo paling umum saat mengetik cepat di HP adalah
    // dua huruf yang ketuker posisi (mis. "kmau" vs "kamu", "bsia" vs "bisa").
    const d = [];
    for (let i = 0; i <= al; i++) d[i] = [i];
    for (let j = 0; j <= bl; j++) d[0][j] = j;

    for (let i = 1; i <= al; i++) {
      for (let j = 1; j <= bl; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let val = Math.min(
          d[i - 1][j] + 1,
          d[i][j - 1] + 1,
          d[i - 1][j - 1] + cost
        );
        if (
          i > 1 && j > 1 &&
          a[i - 1] === b[j - 2] &&
          a[i - 2] === b[j - 1]
        ) {
          val = Math.min(val, d[i - 2][j - 2] + 1);
        }
        d[i][j] = val;
      }
    }
    return d[al][bl];
  }

  function wordFuzzyThreshold(word) {
    if (word.length <= 2) return 0; // kata sangat pendek (ai, ok, u, r): harus persis
    if (word.length <= 6) return 1;
    return 2;
  }

  function tokenize(s) {
    return s.split(/[^a-z0-9]+/i).filter(Boolean);
  }

  function fuzzyPhraseMatch(inputLower, phrase) {
    const phraseWords = tokenize(phrase.toLowerCase());
    if (!phraseWords.length) return false;

    const inputWords = tokenize(inputLower);
    if (!inputWords.length) return false;

    // Fuzzy hanya layak dicoba kalau frasanya punya minimal satu kata "berat"
    // (>=4 huruf) — frasa yang isinya cuma kata pendek (mis. "ok", "iya")
    // tidak usah difuzzy-kan sama sekali, biar tidak jadi kelewat longgar.
    const hasSignificantWord = phraseWords.some((w) => w.length >= 4);
    if (!hasSignificantWord) return false;

    // SEMUA kata dalam frasa wajib ketemu di input — kata panjang boleh typo
    // ringan (threshold dari wordFuzzyThreshold), kata pendek (<4 huruf,
    // mis. "ai", "bot", "kok") WAJIB persis, tidak boleh ditebak-tebak.
    // Ini penting supaya frasa seperti "kamu ai" / "kamu bot" tidak collapse
    // jadi cuma mensyaratkan "kamu" saja (yang terlalu umum & bahaya salah tangkap).
    return phraseWords.every((pw) => {
      const threshold = wordFuzzyThreshold(pw);
      return inputWords.some((iw) => {
        if (iw === pw) return true;
        if (threshold === 0) return false;
        if (Math.abs(iw.length - pw.length) > threshold) return false;
        return levenshtein(iw, pw) <= threshold;
      });
    });
  }

  function hasWord(v, list) {
    const s = lower(v);
    return list.some((x) => {
      const esc = x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp("\\b" + esc + "\\b", "i").test(s);
    });
  }

  /**
   * Normalize Indonesian / mixed number formats for math.
   * - Thousand dots: 1.250.000 → 1250000
   * - Decimal comma: 3,14 → 3.14
   * - Real decimals with dot kept: 3.14 stays
   */
  function normalizeIdNumbers(text) {
    if (!text || typeof text !== "string") return text;
    let s = text;
    s = s.replace(/\b(rp\.?|rupiah|rb|ribu|jt|juta)\b/gi, " ");
    // Groups like 1.250.000 or 12.500 → strip internal thousand dots
    s = s.replace(/\b\d{1,3}(?:\.\d{3})+\b/g, (m) => m.replace(/\./g, ""));
    // Decimal comma: 3,14 or 0,5 → 3.14
    s = s.replace(/(\d),(\d{1,2})\b/g, "$1.$2");
    return s.replace(/\s+/g, " ").trim();
  }

  /* ----------------------------------------------------------
   * Safe arithmetic evaluator (no Function / eval)
   * Supports + - * / % and parentheses with standard precedence
   * ---------------------------------------------------------- */
  function safeEval(expr) {
    if (!expr || typeof expr !== "string") return null;
    const s = expr.replace(/\s+/g, "");
    if (!/^[0-9.+\-*/%()]+$/.test(s)) return null;

    let i = 0;
    function peek() {
      return s[i];
    }
    function consume() {
      return s[i++];
    }
    function parseNumber() {
      const start = i;
      while (i < s.length && /[0-9.]/.test(s[i])) i++;
      const n = Number(s.slice(start, i));
      return Number.isFinite(n) ? n : null;
    }
    function parseFactor() {
      if (peek() === "(") {
        consume();
        const v = parseExpr();
        if (peek() !== ")") return null;
        consume();
        return v;
      }
      if (peek() === "-") {
        consume();
        const v = parseFactor();
        return v === null ? null : -v;
      }
      if (peek() === "+") {
        consume();
        return parseFactor();
      }
      return parseNumber();
    }
    function parseTerm() {
      let left = parseFactor();
      if (left === null) return null;
      while (peek() === "*" || peek() === "/" || peek() === "%") {
        const op = consume();
        const right = parseFactor();
        if (right === null) return null;
        if (op === "*") left *= right;
        else if (op === "/") {
          if (right === 0) return null;
          left /= right;
        } else {
          if (right === 0) return null;
          left %= right;
        }
      }
      return left;
    }
    function parseExpr() {
      let left = parseTerm();
      if (left === null) return null;
      while (peek() === "+" || peek() === "-") {
        const op = consume();
        const right = parseTerm();
        if (right === null) return null;
        left = op === "+" ? left + right : left - right;
      }
      return left;
    }

    const value = parseExpr();
    if (i !== s.length || value === null || !Number.isFinite(value)) return null;
    return value;
  }

  /* ----------------------------------------------------------
   * Language detection
   * ---------------------------------------------------------- */
  function detectLanguage(text) {
    const s = lower(text);
    const en = [
      "the", "what", "how", "why", "can", "could", "please", "need", "want",
      "calculate", "answer", "english", "mean", "available", "help", "food",
      "ride", "where", "when", "who", "which", "this", "that", "with", "from"
    ];
    const id = [
      "aku", "saya", "kamu", "apa", "bagaimana", "kenapa", "bisa", "tolong",
      "butuh", "mau", "hitung", "bahasa", "maksud", "ada", "yang", "sekarang",
      "berapa", "dimana", "kapan", "siapa", "ini", "itu", "dengan", "dari",
      "pengin", "pengen", "nemenin", "jemput", "makan", "bantuan"
    ];
    let e = en.filter((w) => new RegExp("\\b" + w + "\\b").test(s)).length;
    let i = id.filter((w) => new RegExp("\\b" + w + "\\b").test(s)).length;
    if (has(s, ["jawab dalam bahasa inggris", "in english", "english please", "speak english"])) e += 4;
    if (has(s, ["jawab dalam bahasa indonesia", "bahasa indonesia", "in indonesian"])) i += 4;
    if (e === 0 && i === 0) return "mixed";
    return e > i ? "en" : i > e ? "id" : "mixed";
  }

  function resolveLang(input, reasoningState) {
    const s = lower(input);
    // Explicit switch wins immediately
    if (
      has(s, [
        "in english",
        "english please",
        "answer in english",
        "speak english",
        "bahasa inggris",
        "jawab dalam bahasa inggris"
      ])
    ) {
      return { lang: "en", switch: true, sticky: "en" };
    }
    if (
      has(s, [
        "in indonesian",
        "bahasa indonesia",
        "jawab bahasa indonesia",
        "jawab dalam bahasa indonesia",
        "pakai bahasa indonesia"
      ])
    ) {
      return { lang: "id", switch: true, sticky: "id" };
    }

    const detected = detectLanguage(input);
    const sticky = reasoningState?.preferredLanguage || null;

    // Clear language in this turn overrides sticky
    if (detected === "en" && sticky === "id") return { lang: "en", switch: false, sticky: null };
    if (detected === "id" && sticky === "en") return { lang: "id", switch: false, sticky: null };

    if (sticky === "en" || sticky === "id") return { lang: sticky, switch: false, sticky };
    if (detected === "en") return { lang: "en", switch: false, sticky: null };
    return { lang: "id", switch: false, sticky: null };
  }

  /* ----------------------------------------------------------
   * Math extraction
   * ---------------------------------------------------------- */
  function extractArithmetic(text) {
    // Normalize ID number formats FIRST (1.250.000 → 1250000, 3,14 → 3.14)
    const raw = normalizeIdNumbers(clean(text));
    const normalized = raw
      .replace(/×/g, "*")
      .replace(/÷/g, "/")
      .replace(/\b(times|multiplied by|kali)\b/gi, "*")
      .replace(/\b(plus|added to|add|tambah)\b/gi, "+")
      .replace(/\b(minus|subtract|kurang|dikurangi|kurangi)\b/gi, "-")
      .replace(/\b(divided by|dibagi)\b/gi, "/")
      .replace(/\b(percent of|persen dari)\b/gi, "%");

    const candidates = [];

    // 1) Extract spans that only contain math characters (supports nested parens)
    //    Scan for sequences of digits, ops, dots, spaces, and parentheses
    const mathSpan = /[0-9.+\-*/%()\s]+/g;
    let m;
    while ((m = mathSpan.exec(normalized)) !== null) {
      const span = m[0].trim();
      if (span.length < 3) continue;
      // Must contain at least one operator or paren pair with a digit
      if (!/[+\-*/%]/.test(span) && !/\(.*\d.*\)/.test(span)) continue;
      candidates.push(span.replace(/\s+/g, ""));
    }

    // 2) Also collect innermost paren groups + expand outward (legacy path)
    const paren = normalized.match(/\([^()]*\d[^()]*\)/g) || [];
    paren.forEach((p) => {
      const idx = normalized.indexOf(p);
      if (idx >= 0) {
        let start = idx;
        let end = idx + p.length;
        // Expand while surrounding is still math
        while (start > 0 && /[0-9.+\-*/%()\s]/.test(normalized[start - 1])) start--;
        while (end < normalized.length && /[0-9.+\-*/%()\s]/.test(normalized[end])) end++;
        candidates.push(normalized.slice(start, end).replace(/\s+/g, ""));
      }
      candidates.push(p.replace(/\s+/g, ""));
    });

    // 3) Plain chains without requiring parens
    const plain = normalized.match(/(?:\d+(?:\.\d+)?\s*[+\-*/%]\s*)+\d+(?:\.\d+)?/g) || [];
    candidates.push(...plain.map((c) => c.replace(/\s+/g, "")));

    if (!candidates.length) return null;

    const uniq = [...new Set(candidates)];
    // Prefer longer expressions (more complete, e.g. nested)
    uniq.sort((a, b) => b.length - a.length);

    for (const expr of uniq) {
      if (!/^[0-9.+\-*/%()]+$/.test(expr)) continue;
      // Balanced parentheses check
      let depth = 0;
      let balanced = true;
      for (const ch of expr) {
        if (ch === "(") depth++;
        else if (ch === ")") {
          depth--;
          if (depth < 0) {
            balanced = false;
            break;
          }
        }
      }
      if (!balanced || depth !== 0) continue;

      const value = safeEval(expr);
      if (value !== null) return { expression: expr, value };
    }
    return null;
  }

  function followUpMath(text, lastMath) {
    if (!lastMath || lastMath.value == null) return null;
    const s = lower(normalizeIdNumbers(text));
    const ops = [
      { keys: ["tambah", "add", "plus", "ditambah", "ditambahin"], op: "+" },
      { keys: ["kurangi", "kurang", "dikurangi", "dikurang", "kurangin", "minus", "subtract"], op: "-" },
      { keys: ["kalikan", "kali", "times", "dikali", "multiply"], op: "*" },
      { keys: ["bagi", "dibagi", "bagiin", "divide"], op: "/" }
    ];
    let matched = null;
    for (const o of ops) {
      if (has(s, o.keys)) {
        matched = o;
        break;
      }
    }
    if (!matched) return null;

    const m = s.match(
      /(?:tambah(?:in)?|add|plus|ditambah(?:in)?|kurangi|kurang(?:in)?|dikurangi|dikurang|minus|subtract|kalikan|kali|times|dikali|multiply|dibagi|bagi(?:in)?|divide)\s+(\d+(?:\.\d+)?)/i
    );
    if (!m) return null;

    // Kalau ada angka LAIN sebelum kata operatornya (mis. "12 times 3"),
    // ini kemungkinan besar ekspresi hitung baru yang berdiri sendiri,
    // bukan lanjutan dari hasil sebelumnya (mis. "kurangi 1000").
    // Biarkan extractArithmetic() yang menangani, jangan dianggap follow-up.
    const textBeforeOperator = s.slice(0, m.index);
    if (/\d/.test(textBeforeOperator)) {
      return null;
    }

    const n = Number(m[1]);
    if (!Number.isFinite(n)) return null;

    let value = lastMath.value;
    if (matched.op === "+") value += n;
    else if (matched.op === "-") value -= n;
    else if (matched.op === "*") value *= n;
    else {
      if (n === 0) return null;
      value /= n;
    }
    if (!Number.isFinite(value)) return null;

    const symbol = matched.op === "*" ? "×" : matched.op === "/" ? "÷" : matched.op;
    return {
      expression: `${lastMath.value} ${symbol} ${n}`,
      value
    };
  }

  function extractMoneyDiff(text) {
    const s = lower(text);
    if (!has(s, ["sisa", "tersisa", "kepakai", "dipakai", "spend", "spent", "left", "remaining", "habis"])) {
      return null;
    }
    // Normalize ID numbers so 1.250.000 and 478.500 parse correctly
    const normalized = normalizeIdNumbers(clean(text));
    const nums = normalized.match(/\d+(?:\.\d+)?/g) || [];
    if (nums.length < 2) return null;
    const a = Number(nums[0]);
    const b = Number(nums[1]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return { expression: `${a}-${b}`, value: a - b };
  }

  function formatNumber(n) {
    if (!Number.isFinite(n)) return String(n);
    if (Number.isInteger(n)) return String(n);
    return n.toFixed(8).replace(/\.?0+$/, "");
  }

  /**
   * Soft preference tags for multi-turn continuity (food / ride style).
   * Stored in state.reasoning.preferences and recalled on short follow-ups.
   */
  function extractPreferences(text) {
    const s = lower(text);
    const found = [];
    const rules = [
      { tag: "pedas", keys: ["pedas", "spicy", "cabe", "chili"] },
      { tag: "manis", keys: ["manis", "sweet"] },
      { tag: "asin", keys: ["asin", "salty"] },
      { tag: "murah", keys: ["murah", "hemat", "cheap", "budget", "terjangkau"] },
      { tag: "mahal", keys: ["mahal", "premium", "mewah", "expensive"] },
      { tag: "dekat", keys: ["dekat", "terdekat", "nearby", "paling deket"] },
      { tag: "cepat", keys: ["cepat", "secepatnya", "asap", "express", "fast"] },
      { tag: "halal", keys: ["halal"] },
      { tag: "besar", keys: ["porsi besar", "jumbo", "large portion"] },
      { tag: "kecil", keys: ["porsi kecil", "sedikit aja", "small portion"] }
    ];
    rules.forEach(function (r) {
      if (has(s, r.keys) && found.indexOf(r.tag) === -1) found.push(r.tag);
    });
    return found;
  }

  function mergePreferences(prev, next) {
    const out = [];
    (prev || []).concat(next || []).forEach(function (p) {
      if (out.indexOf(p) === -1) out.push(p);
    });
    return out;
  }

  function preferenceLabel(prefs, lang) {
    if (!prefs || !prefs.length) return "";
    if (lang === "en") return prefs.join(", ");
    return prefs.join(", ");
  }

  /* ----------------------------------------------------------
   * Multi-Constraint Extraction
   * Extracts structured soft constraints from free-form text.
   * Never invents facts — only records what the user stated.
   * Stored in state.reasoning.constraints for multi-turn use.
   * ---------------------------------------------------------- */
  function extractConstraints(text) {
    const s = lower(text);
    const raw = clean(text);
    const constraints = {
      budgetMax: null,
      budgetMin: null,
      timeHint: null,
      locationHint: null,
      simplicity: false,
      speed: false,
      nearMe: false,
      tags: []
    };

    // --- Budget (max) ---
    // Patterns: di bawah 50rb, max 50 ribu, budget 50k, under 50000, < 50rb
    const budgetMaxPatterns = [
      /(?:di\s*bawah|dibawah|max|maksimal|maks|under|kurang\s*dari|tidak\s*lebih|nggak\s*lebih|ga\s*lebih|gak\s*lebih)\s*(?:rp\.?\s*)?(\d[\d.]*)\s*(rb|ribu|k|ribu\s*rupiah|ribu)?/i,
      /(?:budget|anggaran|harga\s*maks|batas\s*harga)\s*(?:rp\.?\s*)?(\d[\d.]*)\s*(rb|ribu|k)?/i,
      /(?:rp\.?\s*)?(\d[\d.]*)\s*(rb|ribu|k)\s*(?:aja|saja|doang|max|maksimal)?/i
    ];
    for (const re of budgetMaxPatterns) {
      const m = raw.match(re);
      if (m) {
        let num = parseFloat(String(m[1]).replace(/\./g, ""));
        const unit = (m[2] || "").toLowerCase();
        if (unit === "rb" || unit === "ribu" || unit === "k" || unit.indexOf("ribu") !== -1) {
          num = num * 1000;
        }
        if (!isNaN(num) && num > 0) {
          constraints.budgetMax = num;
          constraints.tags.push("budget");
          break;
        }
      }
    }

    // --- Budget (min / starting from) ---
    const budgetMinPatterns = [
      /(?:mulai\s*dari|minimal|min|dari|starting\s*from|at\s*least)\s*(?:rp\.?\s*)?(\d[\d.]*)\s*(rb|ribu|k)?/i
    ];
    for (const re of budgetMinPatterns) {
      const m = raw.match(re);
      if (m) {
        let num = parseFloat(String(m[1]).replace(/\./g, ""));
        const unit = (m[2] || "").toLowerCase();
        if (unit === "rb" || unit === "ribu" || unit === "k") num = num * 1000;
        if (!isNaN(num) && num > 0) {
          constraints.budgetMin = num;
          constraints.tags.push("budget");
          break;
        }
      }
    }

    // --- Time hints ---
    const timePatterns = [
      /(?:nanti|besok|lusa|hari\s*ini|malam\s*ini|siang\s*ini|pagi\s*ini|sore\s*ini)\s*(?:jam\s*)?(\d{1,2})(?:[:.](\d{2}))?/i,
      /(?:jam|pukul)\s*(\d{1,2})(?:[:.](\d{2}))?/i,
      /(?:after|sesudah|habis|setelah)\s*(?:jam\s*)?(\d{1,2})/i,
      /(?:sebelum|before)\s*(?:jam\s*)?(\d{1,2})/i
    ];
    const softTimeHints = [
      { keys: ["nanti malam", "malam ini", "tonight"], tag: "tonight" },
      { keys: ["nanti siang", "siang ini"], tag: "afternoon" },
      { keys: ["nanti sore", "sore ini"], tag: "evening" },
      { keys: ["besok pagi", "pagi nanti", "tomorrow morning"], tag: "tomorrow_morning" },
      { keys: ["besok", "tomorrow"], tag: "tomorrow" },
      { keys: ["hari ini", "today"], tag: "today" },
      { keys: ["sekarang", "now", "langsung", "segera"], tag: "now" },
      { keys: ["weekend", "akhir pekan", "sabtu", "minggu"], tag: "weekend" }
    ];
    for (const re of timePatterns) {
      const m = raw.match(re);
      if (m) {
        const hour = parseInt(m[1], 10);
        const minute = m[2] ? parseInt(m[2], 10) : 0;
        if (hour >= 0 && hour <= 23) {
          constraints.timeHint = {
            type: "clock",
            hour,
            minute,
            raw: m[0]
          };
          constraints.tags.push("time");
          break;
        }
      }
    }
    if (!constraints.timeHint) {
      for (const t of softTimeHints) {
        if (has(s, t.keys)) {
          constraints.timeHint = { type: "soft", tag: t.tag, raw: t.keys[0] };
          constraints.tags.push("time");
          break;
        }
      }
    }

    // --- Location hints (soft, never invent coordinates) ---
    const locPatterns = [
      /(?:di|dari|dekat|sekitar|area)\s+([A-Za-zÀ-ÿ0-9 .,'-]{2,40}?)(?:\s|,|\.|$|yang|buat|mau|nanti)/i,
      /(?:lagi\s+di|posisi\s+di|saya\s+di|aku\s+di)\s+([A-Za-zÀ-ÿ0-9 .,'-]{2,40}?)(?:\s|,|\.|$)/i
    ];
    const nearMeKeys = [
      "deket sini", "dekat sini", "deket aku", "dekat aku", "dekat saya",
      "sekitar sini", "di sekitar", "near me", "nearby", "paling deket",
      "deket rumah", "dekat kantor", "deket kantor"
    ];
    if (has(s, nearMeKeys)) {
      constraints.nearMe = true;
      constraints.tags.push("near");
    }
    for (const re of locPatterns) {
      const m = raw.match(re);
      if (m && m[1]) {
        const loc = clean(m[1]);
        // Filter out common non-location words
        const noise = [
          "bawah", "atas", "sini", "situ", "sana", "rumah", "kantor",
          "saya", "aku", "kamu", "yang", "aja", "saja", "banget"
        ];
        if (loc.length >= 2 && noise.indexOf(lower(loc)) === -1) {
          constraints.locationHint = loc;
          constraints.tags.push("location");
          break;
        }
      }
    }
    // Explicit "di kantor" / "di rumah" as soft location context
    if (!constraints.locationHint) {
      if (has(s, ["di kantor", "lagi di kantor", "dari kantor"])) {
        constraints.locationHint = "kantor";
        constraints.tags.push("location");
      } else if (has(s, ["di rumah", "lagi di rumah", "dari rumah"])) {
        constraints.locationHint = "rumah";
        constraints.tags.push("location");
      }
    }

    // --- Simplicity / low-effort ---
    if (
      has(s, [
        "ga ribet", "gak ribet", "nggak ribet", "tidak ribet", "simple", "simpel",
        "yang gampang", "yang mudah", "yang simple", "yang simpel", "praktis",
        "ga susah", "gak susah", "nggak susah", "yang cepet aja", "yang cepat aja",
        "no fuss", "easy"
      ])
    ) {
      constraints.simplicity = true;
      constraints.tags.push("simple");
    }

    // --- Speed ---
    if (
      has(s, [
        "cepat", "secepatnya", "asap", "express", "fast", "buru-buru",
        "segera", "langsung", "yang cepet", "yang cepat"
      ])
    ) {
      constraints.speed = true;
      constraints.tags.push("speed");
    }

    // Clean empty tags
    constraints.tags = [...new Set(constraints.tags)];

    // Return null-ish if nothing meaningful found
    if (
      !constraints.budgetMax &&
      !constraints.budgetMin &&
      !constraints.timeHint &&
      !constraints.locationHint &&
      !constraints.simplicity &&
      !constraints.speed &&
      !constraints.nearMe
    ) {
      return null;
    }
    return constraints;
  }

  function mergeConstraints(prev, next) {
    if (!next) return prev || null;
    if (!prev) return next;
    return {
      budgetMax: next.budgetMax != null ? next.budgetMax : prev.budgetMax,
      budgetMin: next.budgetMin != null ? next.budgetMin : prev.budgetMin,
      timeHint: next.timeHint || prev.timeHint,
      locationHint: next.locationHint || prev.locationHint,
      simplicity: next.simplicity || prev.simplicity,
      speed: next.speed || prev.speed,
      nearMe: next.nearMe || prev.nearMe,
      tags: [...new Set([].concat(prev.tags || [], next.tags || []))]
    };
  }

  function constraintSummary(c, lang) {
    if (!c) return "";
    const parts = [];
    if (lang === "en") {
      if (c.budgetMax) parts.push("budget under " + formatNumber(c.budgetMax));
      if (c.budgetMin) parts.push("from " + formatNumber(c.budgetMin));
      if (c.timeHint) {
        if (c.timeHint.type === "clock") {
          parts.push("around " + c.timeHint.hour + ":" + String(c.timeHint.minute || 0).padStart(2, "0"));
        } else if (c.timeHint.tag) {
          parts.push(c.timeHint.tag.replace(/_/g, " "));
        }
      }
      if (c.locationHint) parts.push("near " + c.locationHint);
      if (c.nearMe) parts.push("nearby");
      if (c.simplicity) parts.push("simple/easy");
      if (c.speed) parts.push("fast");
    } else {
      if (c.budgetMax) parts.push("budget di bawah " + formatNumber(c.budgetMax));
      if (c.budgetMin) parts.push("mulai " + formatNumber(c.budgetMin));
      if (c.timeHint) {
        if (c.timeHint.type === "clock") {
          parts.push("sekitar jam " + c.timeHint.hour + (c.timeHint.minute ? ":" + String(c.timeHint.minute).padStart(2, "0") : ""));
        } else if (c.timeHint.tag) {
          const map = {
            tonight: "malam ini",
            afternoon: "siang ini",
            evening: "sore ini",
            tomorrow_morning: "besok pagi",
            tomorrow: "besok",
            today: "hari ini",
            now: "sekarang",
            weekend: "weekend"
          };
          parts.push(map[c.timeHint.tag] || c.timeHint.tag);
        }
      }
      if (c.locationHint) parts.push("dekat " + c.locationHint);
      if (c.nearMe) parts.push("dekat sini");
      if (c.simplicity) parts.push("yang simpel");
      if (c.speed) parts.push("yang cepat");
    }
    return parts.join(", ");
  }

  /* ----------------------------------------------------------
   * Natural service patterns (2in1 + singles)
   * ---------------------------------------------------------- */
  /**
   * Soft emotional tone prefix based on active emotion.
   * Keeps responses warm without overriding truth or inventing facts.
   */
  function emotionalTone(lang, emotion, strength) {
    if (!emotion || emotion === "neutral" || emotion === "casual") return "";
    const strong = strength === "strong";
    if (lang === "en") {
      if (emotion === "tired") return strong ? "You sound really tired. " : "You seem a bit tired. ";
      if (emotion === "stressed") return "I can tell things feel heavy right now. ";
      if (emotion === "sad") return "I'm here with you. ";
      if (emotion === "lonely") return "You're not alone in this. ";
      if (emotion === "hurried") return "Got it — keeping it brief. ";
      if (emotion === "worried") return "No rush. ";
      if (emotion === "confused") return "We'll take it step by step. ";
      if (emotion === "disappointed") return "I hear the disappointment. ";
      return "";
    }
    // Indonesian
    if (emotion === "tired") return strong ? "Kamu kelihatan lagi capek banget. " : "Kamu kelihatan lagi capek. ";
    if (emotion === "stressed") return "Aku tangkap kamu lagi stres. ";
    if (emotion === "sad") return "Aku di sini ya. ";
    if (emotion === "lonely") return "Kamu nggak sendirian kok. ";
    if (emotion === "hurried") return "Oke, aku singkat aja. ";
    if (emotion === "worried") return "Nggak usah buru-buru. ";
    if (emotion === "confused") return "Kita pelan-pelan aja. ";
    if (emotion === "disappointed") return "Aku ngerti kamu kecewa. ";
    return "";
  }

  function naturalService(text, classification, knowledge, lang, emotionCtx, constraints) {
    const needs = new Set(classification?.needs || []);
    const s = lower(text);
    const emotion = emotionCtx?.lastEmotion || null;
    const strength = emotionCtx?.emotionStrength || "soft";
    const tone = emotionalTone(lang, emotion, strength);
    const cSummary = constraintSummary(constraints, lang);
    const constraintNote = cSummary
      ? lang === "en"
        ? ` Noted constraints: ${cSummary}.`
        : ` Catatan preferensi: ${cSummary}.`
      : "";

    // Pure pricing questions should fall through to price-unknown handler
    const isPricing = has(s, [
      "berapa tarif", "berapa harga", "berapa biaya", "how much",
      "tarifnya", "harganya", "biayanya", "ongkosnya", "tarif berapa",
      "harga berapa", "biaya berapa"
    ]);
    if (isPricing) return null;

    const combinedHints = [
      "makanan sekaligus", "makan sekaligus", "food and assistant", "food sekaligus",
      "butuh makan dan ditemani", "makan sambil ditemani", "pengin makan tapi sekalian",
      "mau makan sekaligus", "makan dan ditemani", "makan sambil dibantu",
      "food + assistant", "2in1", "dua in one", "dua sekaligus",
      "nemenin sambil makan", "ditemani sambil makan", "makan sambil nemenin",
      "lapar tapi pengen ditemani", "butuh makan dan bantuan", "food sama assistant",
      "sekalian ditemani", "sekalian dibantu", "plus ditemani", "plus dibantu"
    ];
    const isDefinition = has(s, [
      "apa itu", "what is", "itu apa", "maksudnya", "explain", "arti"
    ]);
    if (
      !isDefinition &&
      (has(s, combinedHints) || (needs.has("food") && needs.has("assistant")))
    ) {
      needs.add("food");
      needs.add("assistant");
    }

    // Explicit food + ride combo (not 2in1)
    const foodRideHints = [
      "ride sekalian makan", "jemput sekalian makan", "makan sekalian ride",
      "beli makanan sekalian", "sekalian beli makanan", "sekalian makan",
      "ride dan makanan", "makanan dan ride", "food and ride", "ride and food",
      "dijemput tapi sekalian beli", "ke stasiun tapi sekalian"
    ];
    if (
      !isDefinition &&
      (has(s, foodRideHints) || (needs.has("food") && needs.has("ride")))
    ) {
      needs.add("food");
      needs.add("ride");
    }

    if (needs.has("food") && needs.has("assistant")) {
      let t =
        lang === "en"
          ? tone + "Yes 😊 If you want food together with help or companionship, that matches the CIKUR GO 2in1 concept. It combines Food and Assistant needs."
          : tone + "Bisa 😊 Kalau kamu ingin makanan sekaligus bantuan atau pendampingan, itu cocok dengan konsep CIKUR GO 2in1. Konsepnya menggabungkan kebutuhan Food dan Assistant.";
      if (constraintNote) t += constraintNote;
      return {
        handled: true,
        text: t,
        mode: "natural_service",
        shouldOfferService: true,
        needs: ["food", "assistant", "combined_need"],
        constraints: constraints || null
      };
    }

    // Food + Ride together (before single-service branches)
    if (needs.has("food") && needs.has("ride")) {
      let t =
        lang === "en"
          ? tone + "Got it 😊 You need both a Ride and Food. I can help with both — Ride after availability is verified, and Food options in parallel."
          : tone + "Oke 😊 Kamu butuh Ride sekaligus Food. Aku bisa bantu keduanya — Ride setelah ketersediaan terverifikasi, dan opsi Food bisa dilihat bareng.";
      if (constraintNote) t += constraintNote;
      return {
        handled: true,
        text: t,
        mode: "natural_service",
        shouldOfferService: true,
        needs: ["food", "ride", "combined_need"],
        constraints: constraints || null
      };
    }

    const pureAvail = has(s, [
      "ada yang bisa jemput", "available now", "ada driver", "ada mitra",
      "tersedia sekarang", "ada yang tersedia", "siapa yang bisa jemput",
      "anyone available", "siapa yang available"
    ]);

    if (
      !pureAvail &&
      (needs.has("food") ||
        has(s, [
          "pengin makan", "mau makan", "lapar", "order makanan", "pesan makanan",
          "butuh makanan", "lagi lapar", "cari makanan", "mau nasi", "mau snack",
          "hungry", "want food", "need food", "order food", "beli makanan"
        ]))
    ) {
      const foodPrefs = extractPreferences(text);
      let foodText =
        lang === "en"
          ? tone + "Got it 😊 You need food. I can help you look at the Food service options."
          : tone + "Oke 😊 Kamu butuh makanan. Aku bisa bantu lihat opsi layanan Food.";
      if (foodPrefs.length) {
        const pl = preferenceLabel(foodPrefs, lang);
        foodText =
          lang === "en"
            ? tone + `Got it 😊 You need food, with preference: ${pl}. I can help look at Food options with that in mind.`
            : tone + `Oke 😊 Kamu butuh makanan, preferensi: ${pl}. Aku bisa bantu lihat opsi Food dengan catatan itu.`;
      }
      // Soft suggestion for tired/stressed users or simplicity constraint
      if (emotion === "tired" || emotion === "stressed" || (constraints && constraints.simplicity)) {
        foodText +=
          lang === "en"
            ? " Something simple might feel easier right now."
            : " Yang simpel aja mungkin lebih enak buat sekarang.";
      }
      if (constraintNote) foodText += constraintNote;
      foodText +=
        lang === "en"
          ? " I still won't invent live listings — only use verified data when available."
          : " Aku tetap nggak mengarang daftar live — hanya pakai data terverifikasi kalau sudah ada.";
      return {
        handled: true,
        text: foodText,
        mode: "natural_service",
        shouldOfferService: true,
        needs: ["food"],
        preferences: foodPrefs,
        constraints: constraints || null
      };
    }

    if (
      !pureAvail &&
      (needs.has("assistant") ||
        has(s, [
          "butuh bantuan", "perlu dibantu", "ada yang bisa bantu", "butuh pendamping",
          "nemenin", "ditemani", "butuh temani", "pengin ditemani", "mau ditemani",
          "need help", "need assistant", "need company", "someone to help"
        ]))
    ) {
      let assistText =
        lang === "en"
          ? tone + "Okay 😊 It sounds like you need assistance or companionship. That fits the Assistant service."
          : tone + "Oke 😊 Sepertinya kamu butuh bantuan atau pendampingan. Itu cocok dengan layanan Assistant.";
      if (emotion === "lonely") {
        assistText =
          lang === "en"
            ? tone + "Okay 😊 If you'd like company or someone to talk with, the Assistant service is designed for that."
            : tone + "Oke 😊 Kalau kamu ingin ditemani atau sekadar ada yang ngobrol, layanan Assistant memang untuk itu.";
      }
      if (constraintNote) assistText += constraintNote;
      return {
        handled: true,
        text: assistText,
        mode: "natural_service",
        shouldOfferService: true,
        needs: ["assistant"],
        constraints: constraints || null
      };
    }

    if (
      !pureAvail &&
      (needs.has("ride") ||
        has(s, [
          "mau dijemput", "butuh ride", "butuh ojek", "antar jemput", "mau naik",
          "antar aku", "jemput aku", "need a ride", "need ride", "pick me up",
          "butuh kendaraan", "mau diantar", "ke stasiun", "ke bandara"
        ]))
    ) {
      let rideText =
        lang === "en"
          ? tone + "Alright 😊 You need a ride. I can help with the Ride service once we have verified availability."
          : tone + "Siap 😊 Kamu butuh ride. Aku bisa bantu lewat layanan Ride setelah ketersediaannya terverifikasi.";
      if (emotion === "hurried" || (constraints && constraints.speed)) {
        rideText =
          lang === "en"
            ? tone + "Alright 😊 You need a ride and you're in a hurry. Once availability is verified, we can move quickly."
            : tone + "Siap 😊 Kamu butuh ride dan lagi buru-buru. Setelah ketersediaan terverifikasi, kita bisa gerak cepat.";
      }
      if (constraintNote) rideText += constraintNote;
      return {
        handled: true,
        text: rideText,
        mode: "natural_service",
        shouldOfferService: true,
        needs: ["ride"],
        constraints: constraints || null
      };
    }

    return null;
  }

  /* ----------------------------------------------------------
   * Core respond
   * ---------------------------------------------------------- */
  function respond(text, ctx = {}) {
    const input = clean(text);
    if (!input) return null;

    const state = ctx.state || {};
    const classification = ctx.classification || {};
    const reasoningState = state.reasoning || {};

    // --- Language ---
    const langInfo = resolveLang(input, reasoningState);
    if (langInfo.switch) {
      return {
        handled: true,
        text: langInfo.lang === "en" ? "Sure 😊 I'll continue in English." : "Siap 😊 Aku lanjut dalam bahasa Indonesia.",
        mode: "language_switch",
        shouldOfferService: false,
        stateUpdate: {
          preferredLanguage: langInfo.sticky
        }
      };
    }
    const lang = langInfo.lang;

    // --- Preferences (multi-turn soft tags) ---
    const turnPrefs = extractPreferences(input);
    let prefs = mergePreferences(reasoningState.preferences, turnPrefs);

    // Soft durable memory: if session prefs are thin, recall long-term prefs
    try {
      const memory = ROOT.memory;
      if (memory && typeof memory.getPreferences === "function") {
        const topicHint =
          reasoningState.lastTopic ||
          (classification && classification.topic) ||
          "general";
        const memPrefs = memory.getPreferences(topicHint);
        if (memPrefs && memPrefs.length) {
          prefs = mergePreferences(memPrefs, prefs);
        }
      }
    } catch (e) {
      // memory is optional
    }

    // --- Multi-constraint extraction (budget, time, location, simplicity, speed) ---
    const turnConstraints = extractConstraints(input);
    const constraints = mergeConstraints(reasoningState.constraints, turnConstraints);

    // --- Math ---
    // Prefer follow-up when we have lastMath, so "Kurangi 1000" isn't
    // misread as a standalone unary minus expression.
    let math =
      followUpMath(input, reasoningState.lastMath) ||
      extractArithmetic(input) ||
      extractMoneyDiff(input);

    if (math) {
      const value = formatNumber(math.value);
      let text = lang === "en" ? `The result is ${value}.` : `Hasilnya ${value}.`;

      // Compound: math + explain / service knowledge in same turn
      const wantsExplain = has(input, [
        "jelasin", "jelaskan", "explain", "apa itu", "what is",
        "terus jelasin", "lalu jelasin", "terus kasih tau", "also explain"
      ]);
      if (wantsExplain) {
        if (has(input, ["2in1", "dua in one", "dua sekaligus"])) {
          text +=
            lang === "en"
              ? " And about 2in1: it combines Food and Assistant — a meal together with help or companionship."
              : " Soal 2in1: itu menggabungkan Food dan Assistant — makanan sekaligus bantuan atau pendampingan.";
        } else if (has(input, ["cikur go", "cikurgo", "ci kur go"])) {
          text +=
            lang === "en"
              ? " And CIKUR GO is the customer service platform with Food, Ride, Assistant, and 2in1."
              : " CIKUR GO sendiri platform layanan Customer dengan Food, Ride, Assistant, dan 2in1.";
        } else if (has(input, ["food", "makanan", "ride", "assistant"])) {
          text +=
            lang === "en"
              ? " I can also explain Food, Ride, Assistant, or 2in1 if you name which one."
              : " Aku juga bisa jelasin Food, Ride, Assistant, atau 2in1 — sebut aja yang mana.";
        }
      }

      return {
        handled: true,
        text,
        mode: "reasoning_math",
        math,
        shouldOfferService: false,
        stateUpdate: {
          lastMath: math,
          preferredLanguage: langInfo.sticky || reasoningState.preferredLanguage || null,
          preferences: prefs
        }
      };
    }

    // --- Preference-only follow-up while a service topic is already active ---
    // e.g. prior "Aku mau makanan pedas" → now "Yang murah aja"
    // Must NOT fire on the same turn that newly introduces a service need.
    const introducesNeed = has(input, [
      "lapar", "makan", "makanan", "food", "hungry",
      "jemput", "ride", "ojek", "diantar", "dijemput",
      "ditemani", "nemenin", "assistant", "butuh bantuan", "pendamping"
    ]);
    const hasPriorServiceTopic =
      reasoningState.lastTopic === "food" ||
      reasoningState.lastTopic === "ride" ||
      reasoningState.lastTopic === "assistant" ||
      reasoningState.lastTopic === "service" ||
      reasoningState.lastTopic === "cikurgo2in1";
    if (turnPrefs.length && hasPriorServiceTopic && !introducesNeed) {
      const topic =
        reasoningState.lastTopic === "ride"
          ? "Ride"
          : reasoningState.lastTopic === "assistant"
            ? "Assistant"
            : reasoningState.lastTopic === "cikurgo2in1"
              ? "2in1"
              : "Food";
      const label = preferenceLabel(prefs, lang);
      return {
        handled: true,
        text:
          lang === "en"
            ? `Got it 😊 I'll keep your preference (${label}) for ${topic}. When verified options are available, we can filter with that in mind — I still won't invent live listings.`
            : `Oke 😊 Aku catat preferensimu (${label}) untuk ${topic}. Nanti kalau opsi terverifikasi ada, bisa difilter sesuai itu — aku tetap nggak mengarang daftar live.`,
        mode: "natural_preference",
        shouldOfferService: true,
        stateUpdate: {
          preferredLanguage: langInfo.sticky || reasoningState.preferredLanguage || null,
          lastTopic: reasoningState.lastTopic || "food",
          activeNeeds: reasoningState.activeNeeds || ["food"],
          preferences: prefs
        }
      };
    }

    // --- Clarification / reference ---
    if (
      has(input, [
        "what did you mean", "what do you mean", "maksudnya apa", "maksud kamu apa",
        "yang tadi maksudnya", "tadi yang kamu jelasin", "maksudnya gimana",
        "what do you mean by that", "maksudnya seperti apa", "bisa dijelasin lagi"
      ])
    ) {
      const subject =
        state.context?.serviceCandidate ||
        state.context?.unresolvedTopic ||
        state.context?.previousTopic ||
        state.topic ||
        state.currentTopic ||
        reasoningState.lastTopic;
      if (subject && subject !== "conversation") {
        return {
          handled: true,
          text:
            lang === "en"
              ? `I was referring to the ${subject} topic we were discussing.`
              : `Aku tadi masih merujuk ke pembahasan ${subject} yang sedang kita bicarakan.`,
          mode: "reasoning_reference",
          shouldOfferService: false
        };
      }
      return {
        handled: true,
        text:
          lang === "en"
            ? "I was following the last thing we talked about. Which part should I clarify?"
            : "Aku masih mengikuti topik terakhir kita. Bagian mana yang mau aku jelaskan lagi?",
        mode: "reasoning_reference",
        shouldOfferService: false
      };
    }

    // --- Continue previous topic ---
    if (
      has(input, [
        "lanjut", "lanjutkan", "terus", "continue", "go on", "cerita lanjut",
        "lalu bagaimana", "lalu gimana", "terus gimana", "next",
        "jelasin", "jelaskan", "explain", "coba jelasin", "coba jelaskan",
        "tolong jelasin", "tolong jelaskan"
      ]) &&
      (reasoningState.lastTopic || state.topic) &&
      (reasoningState.lastTopic || state.topic) !== "conversation"
    ) {
      const t = reasoningState.lastTopic || state.topic;
      const topicLabels = {
        cikur_go: { id: "CIKUR GO", en: "CIKUR GO" },
        cikurgo2in1: { id: "2in1", en: "2in1" },
        food: { id: "Food", en: "Food" },
        ride: { id: "Ride", en: "Ride" },
        assistant: { id: "Assistant", en: "Assistant" },
        service: { id: "layanan CIKUR GO", en: "CIKUR GO services" }
      };
      const label = (topicLabels[t] && topicLabels[t][lang === "en" ? "en" : "id"]) || t;
      return {
        handled: true,
        text:
          lang === "en"
            ? `Sure — we can continue on ${label}. What would you like to know next?`
            : `Siap — kita lanjut soal ${label}. Bagian mana yang mau dilanjutkan?`,
        mode: "natural_continue",
        shouldOfferService: false
      };
    }

    // --- Affirm / acknowledge (word-boundary for short tokens) ---
    if (
      hasWord(input, [
        "ok", "oke", "okay", "siap", "baik", "baiklah", "alright",
        "mengerti", "paham", "sip", "yoi", "yup", "yes"
      ]) &&
      input.split(/\s+/).length <= 4 &&
      !has(input, ["siapa", "siapakah", "who are", "what is", "apa itu", "dimana", "di mana", "lokasi"])
    ) {
      return {
        handled: true,
        text:
          lang === "en"
            ? "Alright 😊 Tell me if you want to go deeper or switch topic."
            : "Oke 😊 Bilang aja kalau mau lebih detail atau pindah topik.",
        mode: "natural_ack",
        shouldOfferService: false
      };
    }

    // --- Thanks ---
    if (
      has(input, [
        "terima kasih", "makasih", "thanks", "thank you", "thx", "tq", "suwun"
      ])
    ) {
      return {
        handled: true,
        text:
          lang === "en"
            ? "You're welcome 😊 I'm here if you need anything else."
            : "Sama-sama 😊 Aku di sini kalau masih butuh bantuan.",
        mode: "natural_thanks",
        shouldOfferService: false
      };
    }

    // --- Confusion / stuck ---
    if (
      has(input, [
        "bingung", "aku bingung", "masih bingung", "confused", "i'm confused",
        "kurang ngerti", "tidak mengerti", "nggak ngerti", "gak ngerti",
        "apa maksudnya", "rumit"
      ])
    ) {
      return {
        handled: true,
        text:
          lang === "en"
            ? "No worries 😊 We can slow down. Which part feels unclear?"
            : "Nggak apa-apa 😊 Kita pelan-pelan. Bagian mana yang masih kurang jelas?",
        mode: "natural_confusion",
        shouldOfferService: false
      };
    }

    // --- Soft refuse / not now ---
    if (
      has(input, [
        "jangan dulu", "nanti saja", "nanti aja", "not now", "maybe later",
        "tidak usah", "nggak usah", "gak usah", "skip dulu", "batal"
      ])
    ) {
      return {
        handled: true,
        text:
          lang === "en"
            ? "Okay, we can skip that for now. Just tell me when you want to continue."
            : "Oke, kita tunda dulu ya. Bilang aja kalau mau dilanjutkan.",
        mode: "natural_defer",
        shouldOfferService: false
      };
    }

    // --- Just chat ---
    if (
      has(input, [
        "just want to chat", "only want to chat", "cuma mau ngobrol", "cuma mau ngobrol aja",
        "hanya mau ngobrol", "just talking", "ngobrol aja", "cuma ngobrol",
        "pengin ngobrol", "mau curhat", "sekadar ngobrol"
      ])
    ) {
      return {
        handled: true,
        text:
          lang === "en"
            ? "Of course 😄 We can just talk. Tell me what's on your mind."
            : "Boleh banget 😄 Kita bisa ngobrol aja. Cerita aja apa yang lagi di pikiranmu.",
        mode: "natural_chat",
        shouldOfferService: false
      };
    }

    // --- Help / capability ---
    if (
      has(input, [
        "what can you do", "bisa bantu apa", "kamu bisa apa", "fitur apa aja",
        "layanan apa aja", "what services", "bisa ngapain", "help me with what",
        "kamu bisa bantu apa", "bisa dibantu apa saja", "apa saja yang bisa",
        "can you help me", "can u help me", "can u help", "help me", "can you help"
      ])
    ) {
      return {
        handled: true,
        text:
          lang === "en"
            ? "I can help with CIKUR GO customer needs: Food, Ride, Assistant, and the 2in1 combination. I can also do simple calculations and explain services — without inventing live availability."
            : "Aku bisa bantu kebutuhan Customer CIKUR GO: Food, Ride, Assistant, dan kombinasi 2in1. Aku juga bisa hitung sederhana dan jelaskan layanan — tanpa mengarang ketersediaan live.",
        mode: "natural_capability",
        shouldOfferService: false
      };
    }

    // --- Who are you ---
    if (
      has(input, [
        "siapa kamu", "kamu siapa", "who are you", "what are you",
        "kamu ai", "kamu bot", "are you ai", "are you a bot",
        "who are u", "who r u", "what r u", "who is u"
      ])
    ) {
      return {
        handled: true,
        text:
          lang === "en"
            ? "I'm CGO, the customer-facing assistant for CIKUR GO. I help explain services and guide needs — without inventing live data."
            : "Aku CGO, asisten customer untuk CIKUR GO. Aku bantu jelaskan layanan dan arahkan kebutuhan — tanpa mengarang data live.",
        mode: "natural_identity",
        shouldOfferService: false
      };
    }

    // --- Location without inventing ---
    if (
      has(input, [
        "di mana", "dimana", "where is", "lokasi", "alamat", "dekat mana",
        "sekitar mana", "posisi"
      ]) &&
      !has(input, ["saya di", "aku di", "i am at", "i'm at"])
    ) {
      return {
        handled: true,
        text:
          lang === "en"
            ? "I don't invent locations. If you share where you are, I can use that context when verified runtime data is available."
            : "Aku nggak mengarang lokasi. Kalau kamu bilang posisimu, itu bisa dipakai sebagai konteks saat data runtime yang terverifikasi tersedia.",
        mode: "natural_location_unknown",
        shouldOfferService: false
      };
    }

    // --- Time / ETA without inventing ---
    if (
      has(input, [
        "berapa lama", "berapa menit", "eta", "how long", "kapan sampai",
        "berapa jam", "estimasi waktu"
      ])
    ) {
      return {
        handled: true,
        text:
          lang === "en"
            ? "I won't guess time or ETA. That needs verified runtime data first."
            : "Aku nggak mau menebak waktu atau ETA. Itu butuh data runtime yang terverifikasi dulu.",
        mode: "natural_time_unknown",
        shouldOfferService: false
      };
    }

    // --- Availability (honest + evidence-aware) ---
    if (
      classification?.intent === "availability" ||
      classification?.shouldCheckAvailability ||
      has(input, [
        "ada yang bisa jemput", "ada yang tersedia", "siapa yang bisa jemput",
        "available now", "anyone available", "ada agent", "ada driver", "ada mitra",
        "bisa jemput sekarang", "tersedia sekarang", "ada yang deket", "ada yang dekat",
        "siapa yang available", "ada orang yang bisa", "masih ada yang free",
        "ada yang empty", "ada slot"
      ])
    ) {
      const d = ctx.discovery;
      const evidence = d && (d.evidence || d.proof || null);
      const serviceLabel =
        (d && (d.serviceName || d.serviceId || d.service)) ||
        (evidence && (evidence.serviceName || evidence.name)) ||
        null;

      if (d?.verified === true && (d?.status === "available" || d?.status === "AVAILABLE")) {
        const extra =
          serviceLabel
            ? lang === "en"
              ? ` Verified result points to ${serviceLabel}.`
              : ` Hasil terverifikasi mengarah ke ${serviceLabel}.`
            : "";
        return {
          handled: true,
          text:
            (lang === "en"
              ? "I checked the available runtime data, and there is a verified service result for your request."
              : "Aku sudah cek data layanan yang tersedia, dan ada hasil layanan yang bisa dikonfirmasi untuk kebutuhanmu.") + extra,
          mode: "natural_availability",
          shouldOfferService: true,
          discovery: { status: d.status, verified: true, service: serviceLabel || null }
        };
      }
      if (d?.verified === true && (d?.status === "unavailable" || d?.status === "UNAVAILABLE")) {
        return {
          handled: true,
          text:
            lang === "en"
              ? "I checked the current runtime data, and I can't verify an available service for that request right now."
              : "Aku sudah cek data layanan saat ini, dan belum ada layanan yang bisa aku konfirmasi untuk kebutuhan itu sekarang.",
          mode: "natural_availability",
          shouldOfferService: false,
          discovery: { status: d.status, verified: true }
        };
      }
      // Connected but not verified / pending
      if (d && (d.status === "pending" || d.status === "checking" || d.runtimeConnected)) {
        return {
          handled: true,
          text:
            lang === "en"
              ? "I'm checking runtime data now. I still won't claim availability until it's verified."
              : "Aku sedang cek data runtime. Aku tetap nggak akan mengklaim ketersediaan sebelum terverifikasi.",
          mode: "natural_availability_pending",
          shouldOfferService: false
        };
      }
      return {
        handled: true,
        text:
          lang === "en"
            ? "I don't have verified live availability data yet, so I won't pretend that someone is available."
            : "Aku belum punya data ketersediaan live yang terverifikasi, jadi aku nggak mau berpura-pura bilang ada yang tersedia.",
        mode: "natural_availability_unknown",
        shouldOfferService: false
      };
    }

    // --- Service patterns (merge multi-need across turns) ---
    const priorNeeds = (state.context && state.context.detectedNeeds) || reasoningState.activeNeeds || [];
    const mergedClassification = Object.assign({}, classification, {
      needs: Array.from(
        new Set([].concat(classification.needs || [], priorNeeds || []))
      )
    });
    // Only merge prior needs when user signals continuation / addition
    const continuing =
      has(input, ["sekalian", "sekaligus", "plus", "dan juga", "tambah", "juga butuh", "also need", "as well"]) ||
      has(input, ["yang tadi", "soal tadi", "lanjut"]);
    const classForService = continuing ? mergedClassification : classification;

    // Emotional continuity: current turn mood or soft memory from recent turns
    const emotionCtx = {
      lastEmotion:
        classification.mood &&
        classification.mood !== "neutral" &&
        classification.mood !== "casual"
          ? classification.mood
          : reasoningState.lastEmotion || null,
      emotionStrength: reasoningState.emotionStrength || "soft",
      emotionTurn: reasoningState.emotionTurn || null
    };
    // Decay: if emotion is old (>3 turns) and not reinforced, soften to null influence
    if (
      emotionCtx.emotionTurn != null &&
      state.turn != null &&
      state.turn - emotionCtx.emotionTurn > 3 &&
      (!classification.mood ||
        classification.mood === "neutral" ||
        classification.mood === "casual")
    ) {
      emotionCtx.lastEmotion = null;
    }

    const service = naturalService(
      input,
      classForService,
      ctx.knowledge,
      lang,
      emotionCtx,
      constraints
    );
    if (service) {
      const activeNeeds = service.needs || classForService.needs || [];
      const servicePrefs = mergePreferences(prefs, service.preferences || turnPrefs);
      service.stateUpdate = {
        preferredLanguage: langInfo.sticky || reasoningState.preferredLanguage || null,
        lastTopic: (activeNeeds && activeNeeds[0]) || "service",
        activeNeeds: activeNeeds,
        preferences: servicePrefs,
        constraints: constraints || null,
        lastEmotion: emotionCtx.lastEmotion || reasoningState.lastEmotion || null,
        emotionStrength: emotionCtx.emotionStrength || reasoningState.emotionStrength || null,
        emotionTurn: emotionCtx.lastEmotion
          ? state.turn || reasoningState.emotionTurn || null
          : reasoningState.emotionTurn || null
      };
      return service;
    }

    // --- Context: user already expressed needs earlier ---
    const recalledNeeds = state.context?.detectedNeeds || reasoningState.activeNeeds || [];
    if (
      recalledNeeds.length &&
      has(input, ["yang tadi", "tadi itu", "soal tadi", "tentang tadi", "about earlier", "about that"])
    ) {
      const label = recalledNeeds.join(" + ");
      return {
        handled: true,
        text:
          lang === "en"
            ? `Earlier you mentioned needs around ${label}. Want to continue from there?`
            : `Tadi kamu sempat sebut kebutuhan seputar ${label}. Mau dilanjut dari situ?`,
        mode: "natural_context_need",
        shouldOfferService: true
      };
    }

    // --- Knowledge: what is CIKUR GO ---
    if (
      has(input, [
        "what is cikur go", "what's cikur go", "cikur go itu apa", "cikur go buat apa",
        "sebenarnya cikur go", "cikur go apa", "apa itu cikur go", "explain cikur go",
        "cikurgo itu apa", "cikur go berfungsi"
      ])
    ) {
      return {
        handled: true,
        text:
          lang === "en"
            ? "CIKUR GO is the service platform we're building here, with Customer services such as Food, Ride, Assistant, and the 2in1 concept. I can explain a specific part if you want."
            : "CIKUR GO adalah platform layanan yang kita bangun di sini, dengan layanan Customer seperti Food, Ride, Assistant, dan konsep 2in1. Kalau mau, aku bisa jelaskan bagian tertentu lebih dalam.",
        mode: "natural_knowledge",
        shouldOfferService: false,
        stateUpdate: { lastTopic: "cikur_go" }
      };
    }

    // --- Explain specific services ---
    if (has(input, ["apa itu food", "food itu apa", "layanan food", "what is food service"])) {
      return {
        handled: true,
        text:
          lang === "en"
            ? "Food is the CIKUR GO service for meal needs. If you also want companionship at the same time, that becomes 2in1."
            : "Food adalah layanan CIKUR GO untuk kebutuhan makan. Kalau sekalian butuh pendampingan, itu masuk konsep 2in1.",
        mode: "natural_knowledge",
        shouldOfferService: true,
        stateUpdate: { lastTopic: "food" }
      };
    }
    if (has(input, ["apa itu assistant", "assistant itu apa", "layanan assistant", "what is assistant"])) {
      return {
        handled: true,
        text:
          lang === "en"
            ? "Assistant is for help or companionship needs. Combined with Food, it becomes the 2in1 concept."
            : "Assistant untuk kebutuhan bantuan atau pendampingan. Digabung dengan Food, itu jadi konsep 2in1.",
        mode: "natural_knowledge",
        shouldOfferService: true,
        stateUpdate: { lastTopic: "assistant" }
      };
    }
    if (has(input, ["apa itu ride", "ride itu apa", "layanan ride", "what is ride"])) {
      return {
        handled: true,
        text:
          lang === "en"
            ? "Ride is the mobility service. Live pickup only after availability is verified — I won't invent it."
            : "Ride adalah layanan mobilitas. Jemput live hanya setelah ketersediaan terverifikasi — aku nggak mengarang.",
        mode: "natural_knowledge",
        shouldOfferService: true,
        stateUpdate: { lastTopic: "ride" }
      };
    }
    if (has(input, ["apa itu 2in1", "2in1 itu apa", "konsep 2in1", "what is 2in1"])) {
      return {
        handled: true,
        text:
          lang === "en"
            ? "2in1 combines Food and Assistant: you get a meal together with help or companionship."
            : "2in1 menggabungkan Food dan Assistant: kamu dapat makanan sekaligus bantuan atau pendampingan.",
        mode: "natural_knowledge",
        shouldOfferService: true,
        stateUpdate: { lastTopic: "cikurgo2in1" }
      };
    }

    // --- Price without verified data ---
    if (
      has(input, [
        "berapa harganya", "berapa biayanya", "how much", "berapa tarif",
        "biaya berapa", "price of", "ongkosnya", "tarifnya berapa", "biayanya berapa"
      ]) &&
      !extractArithmetic(input)
    ) {
      return {
        handled: true,
        text:
          lang === "en"
            ? "I can only share a price when there is verified data for it. I won't invent a number."
            : "Aku hanya bisa bilang harga kalau ada data yang terverifikasi. Aku nggak mau mengarang angka.",
        mode: "natural_price_unknown",
        shouldOfferService: false
      };
    }

    // --- Out-of-domain / world knowledge / unsupported (honest) ---
    const outOfDomain = [
      // World knowledge
      "presiden", "president", "menteri", "siapa yang", "who is the",
      "cuaca", "weather", "hari ini hujan", "forecast",
      // Entertainment
      "lelucon", "joke", "jokes", "ceritain joke", "hibur aku", "nyanyi",
      // Technical / coding
      "coding", "program", "javascript", "python", "debug", "bikin website",
      // Romance / roleplay
      "pacar", "sayang aku", "cinta", "pacaran", "jadi pacarku", "girlfriend", "boyfriend",
      // Generic AI comparison / deep
      "chatgpt", "openai", "gemini", "claude", "bedanya sama",
      // Booking outside scope
      "booking hotel", "pesan hotel", "tiket pesawat", "pesawat", "kereta api",
      // Medical / legal / finance advice
      "sakit", "obat", "diagnosis", "hukum",
      "saham", "investasi", "crypto", "bitcoin", "forex", "reksadana",
      "trading", "beli saham", "jual saham"
    ];
    if (has(input, outOfDomain)) {
      return {
        handled: true,
        text:
          lang === "en"
            ? "That's outside what I can do. I'm focused on CIKUR GO customer needs (Food, Ride, Assistant, 2in1), simple math, and explaining our services — I won't invent answers outside that."
            : "Itu di luar kemampuan aku. Aku fokus pada kebutuhan Customer CIKUR GO (Food, Ride, Assistant, 2in1), hitung sederhana, dan jelasin layanan — aku nggak mau mengarang jawaban di luar itu.",
        mode: "natural_out_of_domain",
        shouldOfferService: false
      };
    }

    // Gibberish / pure symbols → gentle redirect
    if (/^[^a-zA-Z0-9\u00C0-\u024F\u1E00-\u1EFF]+$/.test(input) || input.length < 2) {
      return {
        handled: true,
        text:
          lang === "en"
            ? "I didn't catch that 😊 Try saying it in a short sentence?"
            : "Aku belum nangkep 😊 Coba tulis dalam kalimat pendek ya?",
        mode: "natural_unclear",
        shouldOfferService: false
      };
    }

    // Nothing handled → conversation layer continues
    return null;
  }

  /* ----------------------------------------------------------
   * Public API
   * ---------------------------------------------------------- */
  function language(text) {
    return detectLanguage(text);
  }

  ROOT.reasoning = {
    version: VERSION,
    language,
    respond
  };
})(window);
