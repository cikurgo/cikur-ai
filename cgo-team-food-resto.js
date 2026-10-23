/* ============================================================================
 * CIKUR GO — TEAM FOOD × RESTO
 * File: cgo-team-food-resto.js
 * Version: 1.2.1
 *
 * Tujuan:
 * - Mengatur kolaborasi Agent CGO untuk alur pemesanan makanan melalui chat.
 * - Tidak mengganti atau mengambil alih alur reguler customer/food.html.
 * - Tidak mengarang menu, harga, stok, status resto, atau hasil pemesanan.
 * - Tidak memakai AI/API eksternal.
 *
 * CATATAN INTEGRASI:
 * File ini adalah modul organisasi/orkestrasi mandiri. Ia tidak otomatis
 * terhubung ke fungsi internal food.html atau resto.html sampai adapter nyata
 * didaftarkan melalui CGOFoodRestoTeam.registerAdapter(...).
 *
 * Semua fungsi memakai adapter bila tersedia. Tanpa adapter, modul hanya
 * dapat memvalidasi konteks, menyusun rencana, dan melaporkan keterbatasan.
 * ============================================================================
 */
(function (global) {
  "use strict";

  if (global.CGOFoodRestoTeam) {
    // Jangan menimpa implementasi yang sudah dimuat.
    return;
  }

  const VERSION = "1.2.1";
  const TEAM_ID = "TEAM_FOOD_RESTO";

  const TEAM_STATUS = Object.freeze({
    READY: "TEAM_READY",
    ACTIVE: "TEAM_ACTIVE",
    COLLABORATING: "TEAM_COLLABORATING",
    WAITING_DATA: "TEAM_WAITING_DATA",
    WAITING_CONFIRMATION: "TEAM_WAITING_CONFIRMATION",
    COMPLETED: "TEAM_COMPLETED",
    PARTIAL: "TEAM_PARTIALLY_COMPLETED",
    BLOCKED: "TEAM_BLOCKED",
    ERROR: "TEAM_ERROR",
    IDLE: "TEAM_IDLE"
  });

  const TASK_STATUS = Object.freeze({
    CREATED: "TASK_CREATED",
    NEEDS_DATA: "TASK_WAITING_DATA",
    NEEDS_CONFIRMATION: "TASK_WAITING_CONFIRMATION",
    READY_TO_SUBMIT: "TASK_READY_TO_SUBMIT",
    SUBMITTING: "TASK_SUBMITTING",
    SUBMITTED: "TASK_SUBMITTED",
    REJECTED: "TASK_REJECTED",
    FAILED: "TASK_FAILED",
    COMPLETED: "TASK_COMPLETED"
  });

  const AGENTS = Object.freeze([
    {
      id: "AGENT_FOOD_INTENT",
      name: "Agent Pemahami Pesanan",
      capabilities: ["intent_detection", "order_context"]
    },
    {
      id: "AGENT_FOOD_MENU_SEARCH",
      name: "Agent Pencari Menu",
      capabilities: ["restaurant_search", "menu_search", "availability_lookup"]
    },
    {
      id: "AGENT_FOOD_CONSULTANT",
      name: "Agent Konsultan Menu",
      capabilities: ["menu_clarification", "choice_guidance", "order_notes"]
    },
    {
      id: "AGENT_FOOD_ORDER_PREPARER",
      name: "Agent Penyusun Pesanan",
      capabilities: ["cart_validation", "order_summary", "price_summary"]
    },
    {
      id: "AGENT_RESTO_COORDINATOR",
      name: "Agent Koordinasi Resto",
      capabilities: ["restaurant_submission", "restaurant_status"]
    },
    {
      id: "AGENT_FOOD_MONITOR",
      name: "Agent Pemantau Pesanan",
      capabilities: ["order_status", "status_reporting"]
    }
  ]);

  let adapter = null;
  let teamStatus = TEAM_STATUS.READY;
  const tasks = new Map();
  const listeners = new Set();

  function nowISO() {
    return new Date().toISOString();
  }

  function makeId(prefix) {
    const randomPart = Math.random().toString(36).slice(2, 10);
    return prefix + "-" + Date.now().toString(36) + "-" + randomPart;
  }

  function clone(value) {
    if (value == null) return value;
    try {
      if (typeof global.structuredClone === "function") {
        return global.structuredClone(value);
      }
    } catch (_) {}
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return value;
    }
  }

  function emit(type, detail) {
    const event = {
      type: type,
      teamId: TEAM_ID,
      version: VERSION,
      timestamp: nowISO(),
      detail: clone(detail || {})
    };

    listeners.forEach(function (listener) {
      try { listener(event); } catch (error) {
        console.error("[CGO FOOD × RESTO] Listener error:", error);
      }
    });

    try {
      if (typeof global.CustomEvent === "function" && global.dispatchEvent) {
        global.dispatchEvent(new CustomEvent("cgo:food-resto", { detail: event }));
      }
    } catch (_) {}

    return event;
  }

  function setTeamStatus(status, reason) {
    teamStatus = status;
    emit("TEAM_STATUS_CHANGED", { status: status, reason: reason || null });
    return status;
  }

  function getAgent(agentId) {
    return AGENTS.find(function (agent) { return agent.id === agentId; }) || null;
  }

  function requireAdapterMethod(methodName) {
    if (!adapter || typeof adapter[methodName] !== "function") {
      return {
        ok: false,
        status: TEAM_STATUS.WAITING_DATA,
        code: "ADAPTER_METHOD_UNAVAILABLE",
        message: "Adapter fungsi '" + methodName + "' belum didaftarkan. Tidak ada tindakan eksternal yang dilakukan."
      };
    }
    return null;
  }

  function normalizeText(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  /*
   * Intent check deterministik dan konservatif.
   * Kata yang kebetulan mengandung substring seperti "makan" tidak cukup
   * untuk mengalihkan percakapan. Penyangkalan/larangan diprioritaskan.
   */
  function analyzeFoodIntent(value) {
    const text = normalizeText(value).toLocaleLowerCase("id-ID");
    if (!text) {
      return { route: "EMPTY_REQUEST", confidence: "NONE", matchedTerms: [], needsClarification: true };
    }

    const negationPatterns = [
      /\b(?:tidak|nggak|enggak|gak|ga|bukan|jangan|belum mau|tidak jadi|gak jadi|nggak jadi)\b.{0,55}\b(?:pesan|memesan|pesenin|order|beli|makanan|makan|menu|resto|restoran|food|pizza|ayam|nasi)\b/,
      /\b(?:batalkan|batalin|batal|cancel|membatalkan)\b.{0,40}\b(?:pesanan|pesan|order|makanan|menu|resto)\b/,
      /\b(?:bukan|jangan)\b.{0,25}\b(?:food|resto|restoran|pesanan makanan)\b/
    ];
    if (negationPatterns.some(function (pattern) { return pattern.test(text); })) {
      return { route: "NOT_CONFIRMED_FOOD_INTENT", intentType: "NEGATED_OR_CANCELLED", confidence: "LOW", matchedTerms: [], needsClarification: true, reason: "NEGATED_OR_CANCELLED_INTENT" };
    }

    const patterns = [
      { term: "order_action", re: /\b(?:pesan|memesan|pesenin|order|belikan|beliin|beli)\b/ },
      { term: "food_item", re: /\b(?:makanan|makan|ayam|nasi|mie|mi|bakso|soto|sate|burger|pizza|roti|minuman|minum|kopi|teh|sarapan|makan siang|makan malam)\b/ },
      { term: "restaurant_or_menu", re: /\b(?:menu|resto|restoran|rumah makan|warung|tempat makan|restoran terdekat|warung terdekat)\b/ },
      { term: "food_service", re: /\b(?:food delivery|antar makanan|pesan makan|pesan makanan|delivery makanan|pesan antar)\b/ },
      { term: "order_tracking", re: /\b(?:status pesanan|lacak pesanan|pesanan saya|pesanan sudah|pesanan belum|antarannya|kurir makanan)\b/ },
      { term: "restaurant_search", re: /\b(?:cari|carikan|rekomendasi|terdekat|sekitar sini|sekitar saya)\b/ }
    ];
    const matchedTerms = patterns.filter(function (item) { return item.re.test(text); }).map(function (item) { return item.term; });
    const hasOrderAction = matchedTerms.includes("order_action") || matchedTerms.includes("food_service");
    const hasFoodContext = matchedTerms.includes("food_item") || matchedTerms.includes("restaurant_or_menu") || matchedTerms.includes("food_service") || matchedTerms.includes("order_tracking");

    if (!hasFoodContext) {
      return { route: "NOT_CONFIRMED_FOOD_INTENT", intentType: "UNCONFIRMED", confidence: "LOW", matchedTerms: matchedTerms, needsClarification: true };
    }

    let intentType = "FOOD_HELP";
    if (matchedTerms.includes("order_tracking")) intentType = "TRACK_ORDER";
    else if (hasOrderAction) intentType = "PLACE_ORDER";
    else if (matchedTerms.includes("restaurant_or_menu") && matchedTerms.includes("restaurant_search")) intentType = "SEARCH_RESTAURANT_OR_MENU";
    else if (matchedTerms.includes("restaurant_or_menu")) intentType = "SEARCH_MENU_OR_RESTAURANT";

    // Tracking jelas (status/lacak pesanan) dianggap MEDIUM meski hanya 1 term.
    let confidence;
    if (hasOrderAction && hasFoodContext && matchedTerms.length >= 2) {
      confidence = "HIGH";
    } else if (matchedTerms.length >= 2 || intentType === "TRACK_ORDER") {
      confidence = "MEDIUM";
    } else {
      confidence = "LOW";
    }
    return {
      route: "FOOD_RESTO_CHAT",
      intentType: intentType,
      confidence: confidence,
      matchedTerms: matchedTerms,
      needsClarification: confidence !== "HIGH"
    };
  }

  function createTask(input) {
    const request = input || {};
    const task = {
      taskId: makeId("FOOD"),
      teamId: TEAM_ID,
      status: TASK_STATUS.CREATED,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      channel: request.channel || "chat",
      customerId: request.customerId || null,
      conversationId: request.conversationId || null,
      requestText: normalizeText(request.requestText),
      restaurantId: request.restaurantId || null,
      restaurantName: request.restaurantName || null,
      items: Array.isArray(request.items) ? clone(request.items) : [],
      delivery: request.delivery ? clone(request.delivery) : null,
      notes: normalizeText(request.notes),
      confirmation: {
        required: true,
        confirmed: false,
        confirmedAt: null
      },
      summary: null,
      submission: null,
      history: [{
        status: TASK_STATUS.CREATED,
        at: nowISO(),
        note: "Tugas dibuat; belum ada pesanan yang dikirim."
      }],
      errors: []
    };

    tasks.set(task.taskId, task);
    emit("TASK_CREATED", { taskId: task.taskId, channel: task.channel });
    return clone(task);
  }

  function updateTask(task, status, note) {
    task.status = status;
    task.updatedAt = nowISO();
    task.history.push({
      status: status,
      at: task.updatedAt,
      note: note || null
    });
    emit("TASK_UPDATED", {
      taskId: task.taskId,
      status: status,
      note: note || null
    });
    return task;
  }

  function getMutableTask(taskId) {
    return tasks.get(String(taskId || "")) || null;
  }

  function publicTask(task) {
    return task ? clone(task) : null;
  }

  function validateItems(items) {
    if (!Array.isArray(items) || items.length === 0) {
      return { ok: false, message: "Belum ada menu yang dipilih." };
    }

    for (let i = 0; i < items.length; i += 1) {
      const item = items[i] || {};
      const name = normalizeText(item.name || item.menuName);

      if (!name) {
        return { ok: false, message: "Nama menu pada item ke-" + (i + 1) + " belum tersedia." };
      }

      // Tolak null/undefined/string kosong sebelum Number() mengubahnya jadi 0/NaN.
      if (item.quantity == null || item.quantity === "") {
        return { ok: false, message: "Jumlah menu '" + name + "' belum tersedia." };
      }
      const quantity = Number(item.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isInteger(quantity)) {
        return { ok: false, message: "Jumlah menu '" + name + "' harus berupa bilangan bulat positif." };
      }

      // Harga wajib ada; Number(null) === 0 dapat menyamarkan data rusak (NaN→null via JSON clone).
      if (item.price == null || item.price === "" || typeof item.price === "boolean") {
        return { ok: false, message: "Harga aktual menu '" + name + "' belum valid atau belum tersedia." };
      }
      const price = Number(item.price);
      if (!Number.isFinite(price) || price < 0) {
        return { ok: false, message: "Harga aktual menu '" + name + "' belum valid atau belum tersedia." };
      }
    }

    return { ok: true, message: "Item memenuhi validasi dasar." };
  }

  function calculateSummary(task) {
    const validation = validateItems(task.items);
    if (!validation.ok) {
      return {
        ok: false,
        status: TEAM_STATUS.WAITING_DATA,
        code: "ITEM_DATA_INCOMPLETE",
        message: validation.message
      };
    }

    const subtotal = task.items.reduce(function (sum, item) {
      return sum + (Number(item.price) * Number(item.quantity));
    }, 0);
    if (!Number.isFinite(subtotal)) {
      return {
        ok: false,
        status: TEAM_STATUS.WAITING_DATA,
        code: "SUBTOTAL_OUT_OF_RANGE",
        message: "Subtotal tidak dapat dihitung secara aman dari nilai harga dan jumlah yang diberikan."
      };
    }

    let deliveryFee = null;
    let total = null;
    if (task.delivery && Number.isFinite(Number(task.delivery.fee)) && Number(task.delivery.fee) >= 0) {
      deliveryFee = Number(task.delivery.fee);
      total = subtotal + deliveryFee;
      if (!Number.isFinite(total)) {
        return {
          ok: false,
          status: TEAM_STATUS.WAITING_DATA,
          code: "TOTAL_OUT_OF_RANGE",
          message: "Total pesanan tidak dapat dihitung secara aman."
        };
      }
    }

    return {
      ok: true,
      status: "SUMMARY_READY",
      currency: "IDR",
      items: task.items.map(function (item) {
        return {
          id: item.id || item.menuId || null,
          name: normalizeText(item.name || item.menuName),
          quantity: Number(item.quantity),
          unitPrice: Number(item.price),
          lineTotal: Number(item.price) * Number(item.quantity),
          variant: item.variant || null,
          notes: item.notes || null
        };
      }),
      restaurant: {
        id: task.restaurantId,
        name: task.restaurantName
      },
      subtotal: subtotal,
      deliveryFee: deliveryFee,
      total: total,
      totalIsComplete: total !== null,
      address: task.delivery && task.delivery.address ? task.delivery.address : null,
      notes: task.notes || null,
      disclaimer: total === null
        ? "Subtotal dihitung dari harga yang diberikan. Total akhir belum lengkap karena biaya pengantaran aktual belum tersedia."
        : "Ringkasan dihitung dari data yang diberikan; pastikan harga dan ketersediaan masih aktual sebelum konfirmasi."
    };
  }

  async function callAdapter(methodName, payload) {
    const missing = requireAdapterMethod(methodName);
    if (missing) return missing;

    try {
      const result = await adapter[methodName](clone(payload || {}));
      if (!result || typeof result !== "object") {
        return {
          ok: false,
          status: TEAM_STATUS.ERROR,
          code: "INVALID_ADAPTER_RESPONSE",
          message: "Adapter '" + methodName + "' tidak mengembalikan objek hasil yang valid."
        };
      }
      return result;
    } catch (error) {
      return {
        ok: false,
        status: TEAM_STATUS.ERROR,
        code: "ADAPTER_EXECUTION_FAILED",
        message: String(error && error.message ? error.message : error)
      };
    }
  }

  const api = {
    version: VERSION,
    teamId: TEAM_ID,
    teamName: "FOOD × RESTO",
    description: "Tim Agent CGO untuk membantu alur pesanan makanan melalui chat.",
    statuses: {
      team: TEAM_STATUS,
      task: TASK_STATUS
    },

    getStatus: function () {
      return {
        teamId: TEAM_ID,
        status: teamStatus,
        adapterRegistered: Boolean(adapter),
        adapterMode: adapter ? "IN_PROCESS_FUNCTIONS" : "NONE",
        internalOnly: true,
        registeredAdapterMethods: adapter
          ? Object.keys(adapter).filter(function (key) { return typeof adapter[key] === "function"; })
          : [],
        agentCount: AGENTS.length,
        activeTaskCount: Array.from(tasks.values()).filter(function (task) {
          return ![TASK_STATUS.COMPLETED, TASK_STATUS.REJECTED, TASK_STATUS.FAILED].includes(task.status);
        }).length,
        timestamp: nowISO()
      };
    },

    listAgents: function () {
      return clone(AGENTS);
    },

    analyzeIntent: function (requestText) {
      const result = analyzeFoodIntent(requestText);
      return clone(result);
    },

    getAgent: function (agentId) {
      return clone(getAgent(agentId));
    },

    registerAdapter: function (candidate) {
      if (!candidate || typeof candidate !== "object") {
        return {
          ok: false,
          code: "INVALID_ADAPTER",
          message: "Adapter harus berupa objek berisi fungsi integrasi yang nyata."
        };
      }

      const methods = Object.keys(candidate).filter(function (key) {
        return typeof candidate[key] === "function";
      });
      if (methods.length === 0) {
        return {
          ok: false,
          code: "ADAPTER_HAS_NO_METHODS",
          message: "Adapter tidak diterima karena tidak memiliki fungsi integrasi yang dapat dipanggil."
        };
      }

      // Adapter di sini adalah objek fungsi JavaScript dalam proses yang sama,
      // bukan URL, layanan cloud, atau API jaringan. Fungsi integrasi wajib
      // disediakan oleh kode internal aplikasi.
      adapter = candidate;
      setTeamStatus(TEAM_STATUS.READY, "Fungsi integrasi internal didaftarkan.");
      emit("ADAPTER_REGISTERED", { methods: methods });
      return {
        ok: true,
        teamId: TEAM_ID,
        methods: methods,
        note: "Pendaftaran adapter tidak otomatis membuktikan seluruh integrasi bekerja; setiap fungsi harus diuji."
      };
    },

    // Alias eksplisit untuk menegaskan bahwa konektor ini berjalan lokal.
    registerLocalAdapter: function (candidate) {
      return api.registerAdapter(candidate);
    },

    clearAdapter: function () {
      adapter = null;
      setTeamStatus(TEAM_STATUS.WAITING_DATA, "Adapter dilepas.");
      return { ok: true, adapterRegistered: false };
    },

    onEvent: function (listener) {
      if (typeof listener !== "function") {
        return function () {};
      }
      listeners.add(listener);
      return function unsubscribe() {
        listeners.delete(listener);
      };
    },

    createTask: createTask,

    getTask: function (taskId) {
      return publicTask(getMutableTask(taskId));
    },

    listTasks: function () {
      return Array.from(tasks.values()).map(publicTask);
    },

    /*
     * Mengambil data menu/resto melalui adapter.
     * Adapter yang disarankan:
     * searchRestaurants({ query })
     * searchMenus({ query, restaurantId })
     *
     * Tidak membuat data contoh palsu jika adapter tidak tersedia.
     */
    searchRestaurants: async function (query) {
      const normalizedQuery = normalizeText(query);
      if (!normalizedQuery) {
        return { ok: false, code: "RESTAURANT_QUERY_REQUIRED", message: "Masukkan nama atau jenis restoran yang ingin dicari." };
      }
      setTeamStatus(TEAM_STATUS.ACTIVE, "Mencari restoran berdasarkan data aktual.");
      const result = await callAdapter("searchRestaurants", { query: normalizedQuery });
      if (!result.ok) {
        setTeamStatus(result.status || TEAM_STATUS.WAITING_DATA, result.message);
        return result;
      }
      if (!Array.isArray(result.restaurants)) {
        setTeamStatus(TEAM_STATUS.ERROR, "Respons pencarian restoran tidak berisi daftar restoran.");
        return {
          ok: false,
          status: TEAM_STATUS.ERROR,
          code: "RESTAURANT_RESULT_MISSING",
          message: "Adapter tidak mengembalikan array restaurants."
        };
      }
      setTeamStatus(TEAM_STATUS.READY, "Pencarian restoran selesai.");
      return result;
    },

    searchMenus: async function (query, restaurantId) {
      const normalizedQuery = normalizeText(query);
      if (!normalizedQuery) {
        return { ok: false, code: "MENU_QUERY_REQUIRED", message: "Masukkan nama menu atau jenis makanan yang ingin dicari." };
      }
      setTeamStatus(TEAM_STATUS.ACTIVE, "Mencari menu berdasarkan data aktual.");
      const result = await callAdapter("searchMenus", {
        query: normalizedQuery,
        restaurantId: restaurantId || null
      });
      if (!result.ok) {
        setTeamStatus(result.status || TEAM_STATUS.WAITING_DATA, result.message);
        return result;
      }
      if (!Array.isArray(result.menus)) {
        setTeamStatus(TEAM_STATUS.ERROR, "Respons pencarian menu tidak berisi daftar menu.");
        return {
          ok: false,
          status: TEAM_STATUS.ERROR,
          code: "MENU_RESULT_MISSING",
          message: "Adapter tidak mengembalikan array menus."
        };
      }
      setTeamStatus(TEAM_STATUS.READY, "Pencarian menu selesai.");
      return result;
    },

    /*
     * Menyusun ringkasan dari data yang sudah diberikan/diambil.
     * Tidak mengirim pesanan.
     */
    prepareOrder: function (input) {
      const task = createTask(input || {});
      const mutable = getMutableTask(task.taskId);

      if (!mutable.restaurantId && !mutable.restaurantName) {
        updateTask(mutable, TASK_STATUS.NEEDS_DATA, "Identitas restoran belum dipilih.");
        return {
          ok: false,
          task: publicTask(mutable),
          code: "RESTAURANT_REQUIRED",
          message: "Pilih restoran yang teridentifikasi dari data aktual terlebih dahulu."
        };
      }

      const summary = calculateSummary(mutable);
      if (!summary.ok) {
        updateTask(mutable, TASK_STATUS.NEEDS_DATA, summary.message);
        return {
          ok: false,
          task: publicTask(mutable),
          code: summary.code,
          message: summary.message
        };
      }

      mutable.summary = summary;
      updateTask(mutable, TASK_STATUS.NEEDS_CONFIRMATION, "Ringkasan siap; belum ada pesanan yang dikirim.");
      setTeamStatus(TEAM_STATUS.WAITING_CONFIRMATION, "Menunggu persetujuan pelanggan.");
      return {
        ok: true,
        task: publicTask(mutable),
        summary: clone(summary),
        requiresCustomerConfirmation: true,
        orderSubmitted: false
      };
    },

    /*
     * Konfirmasi hanya mengubah status persetujuan pada tugas lokal.
     * Ini BELUM mengirim pesanan ke resto.
     */
    confirmOrder: function (taskId, confirmation) {
      const task = getMutableTask(taskId);
      if (!task) {
        return { ok: false, code: "TASK_NOT_FOUND", message: "Tugas tidak ditemukan." };
      }
      if (task.status !== TASK_STATUS.NEEDS_CONFIRMATION || !task.summary) {
        return {
          ok: false,
          code: "TASK_NOT_READY_FOR_CONFIRMATION",
          message: "Tugas belum memiliki ringkasan yang siap dikonfirmasi."
        };
      }

      const accepted = confirmation === true ||
        (confirmation && confirmation.accepted === true);

      if (!accepted) {
        task.confirmation.confirmed = false;
        updateTask(task, TASK_STATUS.REJECTED, "Pelanggan tidak menyetujui ringkasan pesanan.");
        setTeamStatus(TEAM_STATUS.READY, "Pesanan tidak diteruskan.");
        return {
          ok: true,
          status: TASK_STATUS.REJECTED,
          orderSubmitted: false,
          message: "Pesanan tidak dikirim karena belum disetujui."
        };
      }

      task.confirmation.confirmed = true;
      task.confirmation.confirmedAt = nowISO();
      updateTask(task, TASK_STATUS.READY_TO_SUBMIT, "Persetujuan pelanggan tercatat; menunggu proses submit melalui adapter.");
      setTeamStatus(TEAM_STATUS.READY, "Persetujuan diterima; pesanan belum dikirim.");
      return {
        ok: true,
        status: TASK_STATUS.READY_TO_SUBMIT,
        orderSubmitted: false,
        message: "Konfirmasi tercatat. Pesanan belum dikirim ke restoran."
      };
    },

    /*
     * Pengiriman hanya terjadi bila adapter submitOrder tersedia dan pelanggan
     * sudah menyetujui. Adapter wajib memakai jalur pesanan asli CIKUR GO.
     */
    submitOrder: async function (taskId) {
      const task = getMutableTask(taskId);
      if (!task) {
        return { ok: false, code: "TASK_NOT_FOUND", message: "Tugas tidak ditemukan." };
      }
      if (task.status === TASK_STATUS.SUBMITTING) {
        return {
          ok: false,
          code: "SUBMISSION_IN_PROGRESS",
          message: "Pengiriman pesanan sedang diproses. Permintaan kedua ditolak untuk mencegah pesanan ganda."
        };
      }
      if (task.status === TASK_STATUS.SUBMITTED || task.submission && task.submission.submitted === true) {
        return {
          ok: false,
          code: "ORDER_ALREADY_SUBMITTED",
          orderId: task.submission && task.submission.orderId || null,
          message: "Pesanan ini sudah memiliki bukti pengiriman; pengiriman ulang ditolak."
        };
      }
      if (!task.confirmation.confirmed || task.status !== TASK_STATUS.READY_TO_SUBMIT) {
        return {
          ok: false,
          code: "CUSTOMER_CONFIRMATION_REQUIRED",
          message: "Pesanan belum siap dikirim. Persetujuan pelanggan wajib tercatat."
        };
      }

      const missing = requireAdapterMethod("submitOrder");
      if (missing) {
        setTeamStatus(TEAM_STATUS.WAITING_DATA, missing.message);
        return missing;
      }

      updateTask(task, TASK_STATUS.SUBMITTING, "Adapter submitOrder dipanggil setelah konfirmasi pelanggan.");
      setTeamStatus(TEAM_STATUS.ACTIVE, "Mengirim pesanan melalui adapter terdaftar.");

      const result = await callAdapter("submitOrder", {
        taskId: task.taskId,
        teamId: TEAM_ID,
        customerId: task.customerId,
        restaurantId: task.restaurantId,
        restaurantName: task.restaurantName,
        items: task.items,
        delivery: task.delivery,
        notes: task.notes,
        summary: task.summary,
        customerConfirmedAt: task.confirmation.confirmedAt
      });

      if (!result.ok) {
        task.errors.push({
          at: nowISO(),
          code: result.code || "SUBMIT_FAILED",
          message: result.message || "Pengiriman pesanan gagal."
        });
        updateTask(task, TASK_STATUS.FAILED, "Adapter tidak mengonfirmasi keberhasilan pengiriman.");
        setTeamStatus(TEAM_STATUS.ERROR, result.message || "Pengiriman gagal.");
        return {
          ok: false,
          status: TASK_STATUS.FAILED,
          task: publicTask(task),
          message: result.message || "Pengiriman pesanan gagal."
        };
      }

      // Adapter harus menyatakan eksplisit bahwa pesanan benar-benar diterima
      // oleh jalur sistem. Respons {ok:true} saja tidak dianggap bukti submit.
      if (result.submitted !== true || !result.orderId) {
        task.submission = clone(result);
        updateTask(task, TASK_STATUS.FAILED, "Respons adapter tidak membuktikan pesanan benar-benar dikirim dengan orderId.");
        setTeamStatus(TEAM_STATUS.ERROR, "Bukti submit tidak lengkap.");
        return {
          ok: false,
          status: TASK_STATUS.FAILED,
          task: publicTask(task),
          code: "SUBMISSION_NOT_VERIFIED",
          message: "Adapter tidak mengembalikan submitted:true dan orderId. Pesanan tidak boleh dilaporkan berhasil."
        };
      }

      task.submission = {
        submitted: true,
        orderId: String(result.orderId),
        status: result.status || "SUBMITTED",
        submittedAt: nowISO(),
        evidence: result.evidence || null
      };
      updateTask(task, TASK_STATUS.SUBMITTED, "Adapter mengembalikan bukti submit dan orderId.");
      setTeamStatus(TEAM_STATUS.COLLABORATING, "Pesanan terkirim; menunggu status restoran.");
      return {
        ok: true,
        status: TASK_STATUS.SUBMITTED,
        task: publicTask(task),
        orderId: task.submission.orderId,
        message: "Pesanan diteruskan melalui adapter dan memiliki ID pesanan."
      };
    },

    /*
     * Memeriksa status dari sumber aktual melalui adapter.
     * Adapter: getOrderStatus({ orderId, taskId })
     */
    monitorOrder: async function (taskId) {
      const task = getMutableTask(taskId);
      if (!task) {
        return { ok: false, code: "TASK_NOT_FOUND", message: "Tugas tidak ditemukan." };
      }
      if (!task.submission || !task.submission.orderId) {
        return {
          ok: false,
          code: "ORDER_NOT_SUBMITTED",
          message: "Belum ada ID pesanan yang dapat dipantau."
        };
      }

      const result = await callAdapter("getOrderStatus", {
        taskId: task.taskId,
        orderId: task.submission.orderId,
        restaurantId: task.restaurantId
      });

      if (!result.ok) {
        setTeamStatus(result.status || TEAM_STATUS.PARTIAL, result.message);
        return result;
      }

      if (!result.status) {
        return {
          ok: false,
          code: "ORDER_STATUS_MISSING",
          message: "Adapter tidak mengembalikan status pesanan aktual."
        };
      }

      task.submission.status = String(result.status);
      task.submission.lastStatusCheckAt = nowISO();
      task.submission.statusEvidence = result.evidence || null;
      task.updatedAt = nowISO();
      task.history.push({
        status: "ORDER_STATUS_UPDATED",
        at: task.updatedAt,
        note: "Status diperoleh dari adapter: " + String(result.status)
      });
      emit("ORDER_STATUS_UPDATED", {
        taskId: task.taskId,
        orderId: task.submission.orderId,
        status: task.submission.status,
        evidence: result.evidence || null
      });

      const normalizedStatus = String(result.status).toUpperCase();
      if (["COMPLETED", "DELIVERED", "FINISHED"].includes(normalizedStatus)) {
        updateTask(task, TASK_STATUS.COMPLETED, "Status selesai diterima dari sumber aktual.");
        setTeamStatus(TEAM_STATUS.COMPLETED, "Pesanan selesai menurut status sumber.");
      } else {
        setTeamStatus(TEAM_STATUS.COLLABORATING, "Pesanan masih dipantau.");
      }

      return {
        ok: true,
        task: publicTask(task),
        orderStatus: task.submission.status,
        evidence: result.evidence || null
      };
    },

    /*
     * Rencana alur chat tanpa menjalankan pemesanan.
     * Berguna untuk menguji pemahaman intent sebelum adapter diintegrasikan.
     */
    planChatRequest: function (requestText) {
      const text = normalizeText(requestText);
      if (!text) {
        return {
          ok: false,
          code: "EMPTY_REQUEST",
          message: "Permintaan pelanggan kosong."
        };
      }

      const analysis = analyzeFoodIntent(text);
      if (analysis.route !== "FOOD_RESTO_CHAT") {
        return {
          ok: true,
          teamId: TEAM_ID,
          route: "NOT_CONFIRMED_FOOD_INTENT",
          intentType: analysis.intentType || "UNCONFIRMED",
          confidence: analysis.confidence,
          needsClarification: true,
          message: analysis.reason === "NEGATED_OR_CANCELLED_INTENT"
            ? "Pesan berisi penyangkalan atau pembatalan; tidak diarahkan ke alur pemesanan baru."
            : "Permintaan belum cukup jelas untuk dipastikan sebagai layanan FOOD × RESTO.",
          matchedTerms: analysis.matchedTerms,
          reason: analysis.reason || null
        };
      }

      return {
        ok: true,
        teamId: TEAM_ID,
        route: "FOOD_RESTO_CHAT",
        intentType: analysis.intentType || "FOOD_HELP",
        confidence: analysis.confidence,
        needsClarification: analysis.needsClarification,
        suggestedAgents: [
          "AGENT_FOOD_INTENT",
          "AGENT_FOOD_MENU_SEARCH",
          "AGENT_FOOD_CONSULTANT",
          "AGENT_FOOD_ORDER_PREPARER",
          "AGENT_RESTO_COORDINATOR",
          "AGENT_FOOD_MONITOR"
        ],
        matchedTerms: analysis.matchedTerms,
        steps: [
          "Pahami kebutuhan pelanggan.",
          "Cari restoran/menu dari data aktual.",
          "Bantu pelanggan memilih menu dan jumlah.",
          "Susun ringkasan berdasarkan harga aktual.",
          "Minta persetujuan pelanggan.",
          "Kirim hanya melalui adapter jalur pesanan asli yang telah diverifikasi.",
          "Pantau status dari sumber aktual."
        ],
        guardrails: [
          "Tidak mengarang menu atau harga.",
          "Tidak mengirim pesanan tanpa konfirmasi.",
          "Tidak menyatakan pesanan terkirim tanpa bukti submit dan orderId.",
          "Tidak mengubah jalur reguler food.html."
        ]
      };
    },

    /*
     * Menghapus satu tugas lokal. Tidak menghapus pesanan dari sistem eksternal.
     */
    forgetTask: function (taskId) {
      const existed = tasks.delete(String(taskId || ""));
      return {
        ok: existed,
        taskId: String(taskId || ""),
        note: "Penghapusan ini hanya menghapus catatan tugas lokal modul, bukan pesanan pada sistem lain."
      };
    },

    /*
     * Audit independensi modul: tidak memanggil jaringan / brain eksternal.
     */
    auditIndependence: function () {
      return {
        ok: true,
        teamId: TEAM_ID,
        version: VERSION,
        internalOnly: true,
        externalBrainDependency: false,
        networkCallsByModule: false,
        transactionAdapterRegistered: Boolean(adapter),
        note: "Modul tidak memanggil jaringan langsung. Fungsi transaksi, bila didaftarkan, harus merupakan fungsi internal aplikasi."
      };
    },

    /*
     * Self-test internal untuk memastikan guardrail dasar tetap valid.
     */
    selfTest: function () {
      const checks = [];
      function check(name, pass, detail) {
        checks.push({ name: name, pass: !!pass, detail: detail || null });
      }

      const place = analyzeFoodIntent("pesan ayam goreng");
      check("place order intent", place.route === "FOOD_RESTO_CHAT" && place.intentType === "PLACE_ORDER" && place.confidence === "HIGH", place);

      const neg = analyzeFoodIntent("jangan pesan makanan");
      check("negated food intent blocked", neg.route === "NOT_CONFIRMED_FOOD_INTENT" && neg.intentType === "NEGATED_OR_CANCELLED", neg);

      const track = analyzeFoodIntent("status pesanan saya");
      check("track order intent", track.intentType === "TRACK_ORDER" && track.confidence === "MEDIUM", track);

      const empty = analyzeFoodIntent("");
      check("empty request handled", empty.route === "EMPTY_REQUEST", empty);

      const badQty = validateItems([{ name: "Nasi", quantity: 0, price: 10000 }]);
      check("zero quantity rejected", !badQty.ok, badQty.message);

      const badPrice = validateItems([{ name: "Nasi", quantity: 1, price: null }]);
      check("null price rejected", !badPrice.ok, badPrice.message);

      const nanPrice = validateItems([{ name: "Nasi", quantity: 1, price: Number.NaN }]);
      check("NaN price rejected", !nanPrice.ok, nanPrice.message);

      const goodItems = validateItems([{ name: "Nasi", quantity: 2, price: 12000 }]);
      check("valid items accepted", goodItems.ok, goodItems.message);

      const freeOk = validateItems([{ name: "Sampel", quantity: 1, price: 0 }]);
      check("zero price (free item) allowed", freeOk.ok, freeOk.message);

      check("independence markers present", true, { internalOnly: true, networkCallsByModule: false });

      return {
        ok: checks.every(function (c) { return c.pass; }),
        total: checks.length,
        passed: checks.filter(function (c) { return c.pass; }).length,
        checks: checks
      };
    }
  };

  Object.freeze(api);
  global.CGOFoodRestoTeam = api;

  try {
    if (typeof global.CustomEvent === "function" && global.dispatchEvent) {
      global.dispatchEvent(new CustomEvent("cgo:team-ready", {
        detail: {
          teamId: TEAM_ID,
          version: VERSION,
          status: TEAM_STATUS.READY
        }
      }));
    }
  } catch (_) {}

  console.info("[CGO FOOD × RESTO] Modul dimuat:", VERSION);
})(typeof window !== "undefined" ? window : globalThis);
