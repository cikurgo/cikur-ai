/* ============================================================================
 * CIKUR GO — TEAM RIDE × DRIVER
 * File: cgo-team-ride-driver.js
 * Version: 1.0.4
 *
 * Tujuan:
 * - Mengorkestrasi Agent CGO untuk layanan perjalanan RIDE dan koordinasi DRIVER.
 * - Menjadi mitra koordinasi TEAM FOOD × RESTO untuk kebutuhan antaran makanan.
 * - Tidak mengganti alur reguler ride.html / driver.html / food.html / resto.html.
 * - Tidak membuat order, tarif, lokasi, driver, pembayaran, atau status palsu.
 * - Tidak memakai layanan AI, API jaringan, CDN, atau layanan eksternal sebagai otak.
 *
 * Integrasi dilakukan melalui fungsi lokal yang didaftarkan aplikasi (in-process).
 * Tanpa fungsi transaksi lokal, modul tetap bisa memahami intent, memvalidasi data,
 * membuat rencana, mengelola tugas, dan menerbitkan event; transaksi nyata tidak
 * akan diklaim berhasil. Modul ini tidak memanggil layanan cloud atau jaringan langsung.
 * ============================================================================
 */
(function (global) {
  "use strict";

  if (global.CGORideDriverTeam) return;

  var VERSION = "1.0.4";
  var TEAM_ID = "TEAM_RIDE_DRIVER";
  var FOOD_TEAM_ID = "TEAM_FOOD_RESTO";

  var TEAM_STATUS = Object.freeze({
    READY: "TEAM_READY", ACTIVE: "TEAM_ACTIVE", COLLABORATING: "TEAM_COLLABORATING",
    WAITING_DATA: "TEAM_WAITING_DATA", WAITING_CONFIRMATION: "TEAM_WAITING_CONFIRMATION",
    COMPLETED: "TEAM_COMPLETED", PARTIAL: "TEAM_PARTIALLY_COMPLETED",
    BLOCKED: "TEAM_BLOCKED", ERROR: "TEAM_ERROR", IDLE: "TEAM_IDLE"
  });
  var TASK_STATUS = Object.freeze({
    CREATED: "TASK_CREATED", NEEDS_DATA: "TASK_WAITING_DATA",
    NEEDS_CONFIRMATION: "TASK_WAITING_CONFIRMATION", READY: "TASK_READY",
    PROCESSING: "TASK_PROCESSING", SUBMITTED: "TASK_SUBMITTED",
    DRIVER_ASSIGNED: "DRIVER_ASSIGNED", DRIVER_ARRIVED: "DRIVER_ARRIVED",
    IN_PROGRESS: "TRIP_IN_PROGRESS", PICKED_UP: "ORDER_PICKED_UP",
    DELIVERING: "ORDER_DELIVERING", COMPLETED: "TASK_COMPLETED",
    CANCELLED: "TASK_CANCELLED", REJECTED: "TASK_REJECTED",
    FAILED: "TASK_FAILED", BLOCKED: "TASK_BLOCKED"
  });

  var AGENTS = Object.freeze([
    { id: "AGENT_RIDE_INTENT", name: "Agent Pemahami Permintaan Perjalanan", capabilities: ["intent_detection", "negation_detection", "service_routing"] },
    { id: "AGENT_RIDE_ROUTE", name: "Agent Validasi Rute", capabilities: ["pickup_validation", "destination_validation", "coordinate_validation"] },
    { id: "AGENT_RIDE_FARE", name: "Agent Validasi Tarif", capabilities: ["fare_validation", "fare_breakdown", "payment_context"] },
    { id: "AGENT_DRIVER_MATCH", name: "Agent Koordinasi Driver", capabilities: ["driver_assignment", "driver_availability", "duplicate_claim_guard"] },
    { id: "AGENT_TRIP_COORDINATOR", name: "Agent Koordinasi Perjalanan", capabilities: ["trip_lifecycle", "pickup", "trip_start", "trip_completion"] },
    { id: "AGENT_RIDE_MONITOR", name: "Agent Pemantau Perjalanan", capabilities: ["status_monitoring", "status_evidence", "customer_updates"] },
    { id: "AGENT_FOOD_DELIVERY_LINK", name: "Agent Penghubung FOOD × RESTO", capabilities: ["food_order_handoff", "delivery_context", "cross_team_coordination"] }
  ]);

  var adapter = null;
  var teamStatus = TEAM_STATUS.READY;
  var tasks = new Map();
  var listeners = new Set();
  var seenSubmissions = new Set();

  function nowISO() { return new Date().toISOString(); }
  function makeId(prefix) {
    return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }
  function clone(value) {
    if (value == null) return value;
    try { if (typeof global.structuredClone === "function") return global.structuredClone(value); } catch (_) {}
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
  }
  function textValue(value) { return String(value == null ? "" : value).trim(); }
  function emit(type, detail) {
    var event = { type: type, teamId: TEAM_ID, version: VERSION, timestamp: nowISO(), detail: clone(detail || {}) };
    listeners.forEach(function (listener) { try { listener(event); } catch (_) {} });
    try {
      if (typeof global.CustomEvent === "function" && typeof global.dispatchEvent === "function") {
        global.dispatchEvent(new global.CustomEvent("cgo:ride-driver", { detail: event }));
      }
    } catch (_) {}
    return event;
  }
  function setTeamStatus(status, reason) {
    teamStatus = status;
    emit("TEAM_STATUS_CHANGED", { status: status, reason: reason || null });
    return teamStatus;
  }
  function getAgent(id) { return AGENTS.find(function (agent) { return agent.id === id; }) || null; }
  function getTaskMutable(id) { return tasks.get(String(id || "")) || null; }
  function publicTask(task) { return task ? clone(task) : null; }
  function updateTask(task, status, note, extra) {
    task.status = status;
    task.updatedAt = nowISO();
    task.history.push({ status: status, at: task.updatedAt, note: note || null });
    if (extra && typeof extra === "object") Object.keys(extra).forEach(function (key) { task[key] = clone(extra[key]); });
    emit("TASK_UPDATED", { taskId: task.taskId, status: status, note: note || null });
    return task;
  }
  function missingLocalMethod(method) {
    if (!adapter || typeof adapter[method] !== "function") {
      return { ok: false, status: TEAM_STATUS.WAITING_DATA, code: "LOCAL_FUNCTION_UNAVAILABLE",
        message: "Fungsi aplikasi internal '" + method + "' belum tersedia. Tidak ada transaksi yang dijalankan." };
    }
    return null;
  }

  function analyzeIntent(input) {
    var source = typeof input === "string" ? input : textValue(input && (input.requestText || input.text || input.message));
    var s = source.toLocaleLowerCase("id-ID");
    // Cancel diutamakan sebelum negasi umum agar "batalkan perjalanan" tidak tertelan sebagai NEGATED.
    var cancel = /\b(batalin|batalkan|batalakan|membatalkan|cancel|batal)\b/.test(s);
    // Negasi tanpa kata batal: jangan/tidak/gak + konteks layanan.
    var negated = !cancel && /\b(jangan(?!\s+lupa)|tidak|tak|nggak|enggak|gak|ga|jgn|belum mau)\b/.test(s);
    var food = /\b(food|makanan|makan|resto|restoran|pesanan makanan|antar makanan|ambil makanan|delivery makanan|pesan makanan)\b/.test(s);
    var ride = /\b(ride|perjalanan|antar saya|jemput saya|ojek|motor|mobil|taksi|transportasi|ke\s+[a-z0-9])/i.test(s);
    var driver = /\b(driver|pengemudi|supir|sopir|pengantar|kurir)\b/.test(s);
    var track = /\b(lacak|tracking|posisi|lokasi|status|sudah sampai|di mana|dimana)\b/.test(s);
    var intent = "UNKNOWN";
    if (cancel) intent = "CANCEL_REQUEST";
    else if (negated) intent = "NEGATED_OR_DECLINED";
    else if (food && (driver || /antar makanan|delivery makanan|ambil makanan/.test(s))) intent = "FOOD_DELIVERY_COORDINATION";
    else if (track && (ride || driver || food)) intent = "TRACK_REQUEST";
    else if (ride) intent = "RIDE_REQUEST";
    else if (driver) intent = "DRIVER_COORDINATION";
    return { ok: intent !== "UNKNOWN", intent: intent, sourceText: source,
      signals: { negated: negated, food: food, ride: ride, driver: driver, tracking: track, cancellation: cancel },
      confidence: intent === "UNKNOWN" ? 0 : (cancel || negated ? 0.98 : (food && driver ? 0.94 : (ride || track ? 0.86 : 0.76))),
      requiresClarification: intent === "UNKNOWN" || (intent === "RIDE_REQUEST" && !/\b(jemput|antar|perjalanan|ride|ojek|taksi|motor|mobil)\b/.test(s)),
      note: cancel ? "Permintaan pembatalan terdeteksi." : (negated ? "Permintaan terdeteksi sebagai penyangkalan; jangan membuat transaksi." : null) };
  }

  function validCoordinates(lat, lng) {
    var a = Number(lat), b = Number(lng);
    return Number.isFinite(a) && Number.isFinite(b) && a >= -90 && a <= 90 && b >= -180 && b <= 180;
  }
  function validateRideInput(input) {
    var x = input || {}, errors = [];
    var pickup = textValue(x.pickup || x.pickupAddress);
    var destination = textValue(x.destination || x.destinationAddress);
    if (!pickup) errors.push("Lokasi jemput belum tersedia.");
    if (!destination) errors.push("Lokasi tujuan belum tersedia.");
    if (pickup && destination && pickup.toLocaleLowerCase("id-ID") === destination.toLocaleLowerCase("id-ID")) errors.push("Lokasi jemput dan tujuan sama; pastikan kembali rute.");
    if (x.pickupLat != null || x.pickupLng != null) {
      if (!validCoordinates(x.pickupLat, x.pickupLng)) errors.push("Koordinat jemput tidak valid.");
    }
    if (x.destLat != null || x.destLng != null) {
      if (!validCoordinates(x.destLat, x.destLng)) errors.push("Koordinat tujuan tidak valid.");
    }
    var fare = Number(x.fare != null ? x.fare : x.price);
    if (x.fare != null || x.price != null) {
      if (!Number.isFinite(fare) || fare < 0 || fare > Number.MAX_SAFE_INTEGER) errors.push("Tarif tidak valid.");
    }
    var distance = x.distanceKm == null ? null : Number(x.distanceKm);
    if (distance != null && (!Number.isFinite(distance) || distance < 0 || distance > 100000)) errors.push("Jarak perjalanan tidak valid.");
    return { ok: errors.length === 0, errors: errors, normalized: {
      pickup: pickup, destination: destination,
      pickupLat: x.pickupLat == null ? null : Number(x.pickupLat), pickupLng: x.pickupLng == null ? null : Number(x.pickupLng),
      destLat: x.destLat == null ? null : Number(x.destLat), destLng: x.destLng == null ? null : Number(x.destLng),
      fare: x.fare == null && x.price == null ? null : fare,
      distanceKm: distance, vehicleType: textValue(x.vehicleType || x.vehicleName) || null,
      paymentMethod: textValue(x.paymentMethod) || null
    } };
  }

  function createTask(input) {
    var x = input || {};
    var kind = textValue(x.kind || x.service || "RIDE").toUpperCase();
    if (["RIDE", "FOOD_DELIVERY", "DELIVERY"].indexOf(kind) < 0) kind = "RIDE";
    var task = {
      taskId: makeId(kind === "RIDE" ? "RIDE" : "DELIVERY"), teamId: TEAM_ID, kind: kind,
      status: TASK_STATUS.CREATED, createdAt: nowISO(), updatedAt: nowISO(),
      channel: textValue(x.channel) || "chat", customerId: x.customerId || null,
      conversationId: x.conversationId || null, requestText: textValue(x.requestText || x.text),
      rideOrderId: x.rideOrderId || x.orderId || null,
      foodOrderId: x.foodOrderId || (kind !== "RIDE" ? x.orderId : null) || null,
      foodTaskId: x.foodTaskId || null, linkedTeamId: x.foodOrderId || x.foodTaskId ? FOOD_TEAM_ID : null,
      pickup: textValue(x.pickup || x.pickupAddress), destination: textValue(x.destination || x.destinationAddress),
      pickupLat: x.pickupLat == null ? null : Number(x.pickupLat), pickupLng: x.pickupLng == null ? null : Number(x.pickupLng),
      destLat: x.destLat == null ? null : Number(x.destLat), destLng: x.destLng == null ? null : Number(x.destLng),
      fare: x.fare == null ? (x.price == null ? null : Number(x.price)) : Number(x.fare),
      distanceKm: x.distanceKm == null ? null : Number(x.distanceKm), vehicleType: textValue(x.vehicleType || x.vehicleName) || null,
      paymentMethod: textValue(x.paymentMethod) || null, driverId: x.driverId || null, driverName: x.driverName || null,
      customerConfirmed: false, confirmationAt: null, submission: null, resultEvidence: null,
      history: [{ status: TASK_STATUS.CREATED, at: nowISO(), note: "Tugas dibuat; belum ada transaksi yang dijalankan." }], errors: []
    };
    tasks.set(task.taskId, task);
    setTeamStatus(TEAM_STATUS.ACTIVE, "Tugas dibuat");
    emit("TASK_CREATED", { taskId: task.taskId, kind: kind, linkedTeamId: task.linkedTeamId });
    return publicTask(task);
  }

  function getTask(taskId) { return publicTask(getTaskMutable(taskId)); }
  function listTasks(filter) {
    var f = filter || {}, values = Array.from(tasks.values());
    if (f.kind) values = values.filter(function (t) { return t.kind === String(f.kind).toUpperCase(); });
    if (f.status) values = values.filter(function (t) { return t.status === f.status; });
    if (f.customerId) values = values.filter(function (t) { return t.customerId === f.customerId; });
    return values.map(publicTask);
  }
  function confirmTask(taskId, confirmation) {
    var task = getTaskMutable(taskId);
    if (!task) return { ok: false, code: "TASK_NOT_FOUND", message: "Tugas tidak ditemukan." };
    if (confirmation !== true && !(confirmation && confirmation.confirmed === true)) return { ok: false, code: "CONFIRMATION_REQUIRED", message: "Persetujuan eksplisit pelanggan diperlukan." };
    task.customerConfirmed = true; task.confirmationAt = nowISO();
    updateTask(task, TASK_STATUS.READY, "Pelanggan mengonfirmasi permintaan.");
    return { ok: true, task: publicTask(task) };
  }
  function planRide(input) {
    var x = input || {}, intent = analyzeIntent(x.requestText || x.text || "");
    if (intent.intent === "CANCEL_REQUEST") {
      return { ok: false, status: TEAM_STATUS.BLOCKED, code: "CANCEL_REQUEST", intent: intent,
        nextAction: "HANDLE_CANCELLATION",
        message: "Permintaan pembatalan terdeteksi; tidak membuat pesanan baru." };
    }
    if (intent.intent === "NEGATED_OR_DECLINED") return { ok: false, status: TEAM_STATUS.BLOCKED, code: "NEGATED_REQUEST", intent: intent, message: "Tidak membuat pesanan karena permintaan mengandung penyangkalan." };
    if (intent.intent !== "RIDE_REQUEST" && !x.forceRide) return { ok: false, status: TEAM_STATUS.WAITING_DATA, code: "RIDE_INTENT_NOT_CONFIRMED", intent: intent, message: "Permintaan perjalanan belum terkonfirmasi; minta klarifikasi." };
    var validation = validateRideInput(x);
    return { ok: validation.ok, status: validation.ok ? TEAM_STATUS.READY : TEAM_STATUS.WAITING_DATA,
      intent: intent, validation: validation, requiredFields: validation.ok ? [] : validation.errors,
      nextAction: validation.ok ? "CONFIRM_WITH_CUSTOMER" : "REQUEST_MISSING_RIDE_DATA",
      message: validation.ok ? "Data rute lolos validasi dasar. Tampilkan ringkasan dan minta persetujuan sebelum membuat order." : "Lengkapi data perjalanan sebelum melanjutkan." };
  }

  async function callLocal(method, payload) {
    var missing = missingLocalMethod(method);
    if (missing) return missing;
    try {
      var result = await adapter[method](clone(payload));
      return { ok: true, result: result };
    } catch (error) {
      return { ok: false, code: "LOCAL_FUNCTION_FAILED", message: textValue(error && error.message) || "Fungsi internal gagal.", error: error };
    }
  }

  async function submitRide(taskId) {
    var task = getTaskMutable(taskId);
    if (!task) return { ok: false, code: "TASK_NOT_FOUND", message: "Tugas tidak ditemukan." };
    if (task.kind !== "RIDE") return { ok: false, code: "WRONG_TASK_KIND", message: "Tugas ini bukan RIDE." };
    if (!task.customerConfirmed) return { ok: false, code: "CONFIRMATION_REQUIRED", message: "Persetujuan pelanggan belum tercatat." };
    if (task.rideOrderId || task.submission && task.submission.orderId) return { ok: false, code: "DUPLICATE_SUBMISSION_BLOCKED", message: "Tugas sudah memiliki ID pesanan; pengiriman ulang ditolak." };
    var validation = validateRideInput(task);
    if (!validation.ok) { updateTask(task, TASK_STATUS.NEEDS_DATA, "Data perjalanan belum lengkap.", { errors: validation.errors }); return { ok: false, code: "RIDE_DATA_INVALID", errors: validation.errors }; }
    var fingerprint = [task.customerId || "", task.pickup, task.destination, task.vehicleType || "", task.fare == null ? "" : task.fare].join("|").toLowerCase();
    if (seenSubmissions.has(fingerprint)) return { ok: false, code: "DUPLICATE_SUBMISSION_GUARD", message: "Permintaan yang sama baru saja dikirim; periksa order yang sudah ada sebelum mencoba lagi." };
    seenSubmissions.add(fingerprint);
    updateTask(task, TASK_STATUS.PROCESSING, "Menjalankan fungsi transaksi lokal yang terdaftar.");
    var response = await callLocal("createRideOrder", task);
    if (!response.ok) { seenSubmissions.delete(fingerprint); updateTask(task, TASK_STATUS.BLOCKED, response.message || "Fungsi transaksi lokal tidak tersedia."); return response; }
    var order = response.result || {};
    var orderId = textValue(order.id || order.orderId);
    if (order.ok === false || !orderId) {
      seenSubmissions.delete(fingerprint);
      updateTask(task, TASK_STATUS.FAILED, "Fungsi lokal tidak memberikan ID pesanan sebagai bukti transaksi.");
      return { ok: false, code: "ORDER_EVIDENCE_MISSING", message: "Pesanan tidak dinyatakan berhasil karena ID pesanan aktual tidak tersedia.", result: clone(order) };
    }
    task.rideOrderId = orderId;
    task.submissionFingerprint = fingerprint;
    task.submission = { orderId: orderId, submittedAt: nowISO(), evidence: "LOCAL_ORDER_ID", source: "LOCAL_APPLICATION_FUNCTION" };
    updateTask(task, TASK_STATUS.SUBMITTED, "Order aktual dikonfirmasi oleh fungsi lokal.");
    emit("RIDE_ORDER_SUBMITTED", { taskId: task.taskId, orderId: orderId });
    return { ok: true, task: publicTask(task), order: clone(order) };
  }

  async function updateLifecycle(taskId, action, evidence) {
    var task = getTaskMutable(taskId);
    if (!task) return { ok: false, code: "TASK_NOT_FOUND", message: "Tugas tidak ditemukan." };
    var transitions = {
      assignDriver: { method: "assignLocalDriver", status: TASK_STATUS.DRIVER_ASSIGNED, requireOrder: true },
      driverArrived: { method: "markLocalDriverArrived", status: TASK_STATUS.DRIVER_ARRIVED, requireOrder: true },
      startTrip: { method: "startLocalTrip", status: TASK_STATUS.IN_PROGRESS, requireOrder: true },
      pickupFood: { method: "markLocalFoodPickedUp", status: TASK_STATUS.PICKED_UP, requireOrder: true },
      startDelivery: { method: "startLocalFoodDelivery", status: TASK_STATUS.DELIVERING, requireOrder: true },
      complete: { method: "completeLocalTask", status: TASK_STATUS.COMPLETED, requireOrder: true },
      cancel: { method: "cancelLocalTask", status: TASK_STATUS.CANCELLED, requireOrder: true }
    };
    var transition = transitions[action];
    if (!transition) return { ok: false, code: "ACTION_NOT_ALLOWED", message: "Aksi lifecycle tidak dikenali." };
    var orderId = task.rideOrderId || task.foodOrderId;
    if (transition.requireOrder && !orderId) return { ok: false, code: "ORDER_ID_REQUIRED", message: "ID order aktual diperlukan sebelum mengubah status." };
    if (action === "complete" && !evidence) return { ok: false, code: "COMPLETION_EVIDENCE_REQUIRED", message: "Bukti penyelesaian dari aplikasi diperlukan." };
    var payload = { task: publicTask(task), orderId: orderId, evidence: clone(evidence || null), action: action };
    var response = await callLocal(transition.method, payload);
    if (!response.ok) return response;
    var result = response.result || {};
    // Jangan mengubah status menjadi sukses hanya dari respons truthy; perlu bukti eksplisit.
    var confirmed = result.ok === true && (result.confirmed === true || result.status === transition.status || result.orderId === orderId);
    if (!confirmed) return { ok: false, code: "LIFECYCLE_EVIDENCE_MISSING", message: "Fungsi lokal belum memberi bukti yang cukup untuk mengubah status.", result: clone(result) };
    updateTask(task, transition.status, "Perubahan status dikonfirmasi oleh fungsi internal aplikasi.", { resultEvidence: { action: action, orderId: orderId, confirmedAt: nowISO(), result: clone(result) } });
    // Lepaskan kunci rute setelah status terminal terkonfirmasi agar pelanggan
    // dapat membuat perjalanan baru yang sama tanpa membuka duplikasi aktif.
    if ((action === "complete" || action === "cancel") && task.submissionFingerprint) {
      seenSubmissions.delete(task.submissionFingerprint);
      task.submissionFingerprint = null;
    }
    emit("TASK_LIFECYCLE_CONFIRMED", { taskId: task.taskId, orderId: orderId, action: action, status: transition.status });
    return { ok: true, task: publicTask(task), result: clone(result) };
  }

  function createFoodDeliveryHandoff(input) {
    var x = input || {};
    var foodOrderId = textValue(x.foodOrderId || x.orderId);
    var foodTaskId = textValue(x.foodTaskId);
    if (!foodOrderId && !foodTaskId) return { ok: false, code: "FOOD_REFERENCE_REQUIRED", message: "ID order FOOD atau ID tugas FOOD × RESTO wajib ada. Tidak membuat referensi palsu." };
    var foodTeam = global.CGOFoodRestoTeam || null;
    var foodTask = null;
    if (foodTaskId && foodTeam && typeof foodTeam.getTask === "function") foodTask = foodTeam.getTask(foodTaskId);
    if (foodTaskId && !foodTask) return { ok: false, code: "FOOD_TASK_NOT_FOUND", message: "Tugas FOOD × RESTO tidak ditemukan di modul lokal yang tersedia." };
    if (foodTask && foodTask.submission && foodTask.submission.orderId && foodOrderId && foodTask.submission.orderId !== foodOrderId) {
      return { ok: false, code: "FOOD_REFERENCE_MISMATCH", message: "ID order berbeda dari bukti pengiriman tugas FOOD × RESTO." };
    }
    var task = createTask({ kind: "FOOD_DELIVERY", channel: x.channel || "food-resto-handoff", customerId: x.customerId || (foodTask && foodTask.customerId),
      foodOrderId: foodOrderId || (foodTask && foodTask.submission && foodTask.submission.orderId) || null,
      foodTaskId: foodTaskId || null, pickup: x.pickup || x.restoAddress || (foodTask && foodTask.delivery && foodTask.delivery.pickup) || "",
      destination: x.destination || x.customerAddress || (foodTask && foodTask.delivery && foodTask.delivery.destination) || "",
      requestText: "Koordinasi antaran dari FOOD × RESTO; jangan membuat ulang pesanan makanan." });
    emit("FOOD_DELIVERY_HANDOFF_CREATED", { taskId: task.taskId, foodOrderId: task.foodOrderId, foodTaskId: task.foodTaskId, linkedTeamId: FOOD_TEAM_ID });
    return { ok: true, task: task, linkedTeamId: FOOD_TEAM_ID,
      sourceTeamId: FOOD_TEAM_ID, receivingTeamId: TEAM_ID,
      handoffType: "FOOD_TO_RIDE_DRIVER", transactionCreated: false,
      note: "linkedTeamId dipertahankan untuk kompatibilitas lama; receivingTeamId menunjukkan tim penerima. Referensi tugas FOOD dipertahankan. Modul ini tidak membuat ulang pesanan makanan atau mengubah status order FOOD." };
  }

  function getStatus() {
    return { version: VERSION, teamId: TEAM_ID, status: teamStatus, internalOnly: true,
      adapterMode: adapter ? "LOCAL_FUNCTIONS_REGISTERED" : "STANDALONE_NO_TRANSACTION_FUNCTIONS",
      externalBrainDependency: false, taskCount: tasks.size, agentCount: AGENTS.length,
      foodRestoTeamDetected: !!global.CGOFoodRestoTeam };
  }
  function registerLocalAdapter(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, code: "INVALID_LOCAL_ADAPTER", message: "Adapter harus berupa objek fungsi lokal." };
    adapter = value;
    emit("LOCAL_FUNCTIONS_REGISTERED", { methods: Object.keys(value).filter(function (key) { return typeof value[key] === "function"; }) });
    return { ok: true, mode: "IN_PROCESS_LOCAL_ONLY", methods: Object.keys(value).filter(function (key) { return typeof value[key] === "function"; }) };
  }
  function clearLocalAdapter() { adapter = null; emit("LOCAL_FUNCTIONS_CLEARED", {}); return true; }
  function onEvent(listener) {
    if (typeof listener !== "function") throw new TypeError("Listener harus berupa fungsi.");
    listeners.add(listener); return function () { listeners.delete(listener); };
  }
  function auditIndependence() {
    return { ok: true, teamId: TEAM_ID, version: VERSION, internalOnly: true,
      externalBrainDependency: false, networkCallsByModule: false, transactionAdapterRegistered: !!adapter,
      note: "Modul tidak memanggil jaringan langsung. Fungsi transaksi, bila didaftarkan, harus merupakan fungsi internal aplikasi." };
  }
  function forgetTask(taskId) {
    var id = String(taskId || "");
    var existed = tasks.delete(id);
    return {
      ok: existed,
      taskId: id,
      note: "Penghapusan ini hanya menghapus catatan tugas lokal modul, bukan pesanan pada sistem lain."
    };
  }

  function selfTest() {
    var checks = [];
    function check(name, pass, detail) { checks.push({ name: name, pass: !!pass, detail: detail || null }); }
    var neg = analyzeIntent("Jangan pesan ride sekarang");
    check("negative ride request is not dispatched", neg.intent === "NEGATED_OR_DECLINED", neg.intent);
    check("jangan lupa is not mistaken for refusal", analyzeIntent("Jangan lupa pesan ride ke stasiun").intent === "RIDE_REQUEST");
    var ride = analyzeIntent("Tolong pesan ride ke stasiun");
    check("ride intent detected", ride.intent === "RIDE_REQUEST", ride.intent);
    var food = analyzeIntent("Tolong antar makanan dari resto");
    check("food delivery intent detected", food.intent === "FOOD_DELIVERY_COORDINATION", food.intent);
    var cancelTrip = analyzeIntent("batalkan perjalanan");
    check("cancel trip recognized", cancelTrip.intent === "CANCEL_REQUEST", cancelTrip.intent);
    var batalin = analyzeIntent("batalin ride");
    check("batalin ride recognized as cancel", batalin.intent === "CANCEL_REQUEST", batalin.intent);
    var bad = validateRideInput({ pickup: "", destination: "Tujuan", fare: -5 });
    check("invalid route/fare rejected", !bad.ok && bad.errors.length >= 2, bad.errors);
    var good = validateRideInput({ pickup: "Lokasi A", destination: "Lokasi B", fare: 12000, pickupLat: -6.2, pickupLng: 106.8 });
    check("valid base route accepted", good.ok, good.errors);
    var missingRef = createFoodDeliveryHandoff({});
    check("food handoff rejects missing order/task reference", !missingRef.ok && missingRef.code === "FOOD_REFERENCE_REQUIRED", missingRef.code);
    return { ok: checks.every(function (c) { return c.pass; }), total: checks.length, passed: checks.filter(function (c) { return c.pass; }).length, checks: checks };
  }

  var api = {
    version: VERSION, teamId: TEAM_ID, agents: AGENTS, statuses: TEAM_STATUS, taskStatuses: TASK_STATUS,
    getStatus: getStatus, listAgents: function () { return clone(AGENTS); }, getAgent: getAgent,
    registerLocalAdapter: registerLocalAdapter, clearLocalAdapter: clearLocalAdapter, onEvent: onEvent,
    analyzeIntent: analyzeIntent, validateRideInput: validateRideInput, planRide: planRide,
    createTask: createTask, getTask: getTask, listTasks: listTasks, confirmTask: confirmTask,
    submitRide: submitRide, updateLifecycle: updateLifecycle, createFoodDeliveryHandoff: createFoodDeliveryHandoff,
    forgetTask: forgetTask, auditIndependence: auditIndependence, selfTest: selfTest
  };
  global.CGORideDriverTeam = Object.freeze(api);
  emit("TEAM_READY", { version: VERSION, agentCount: AGENTS.length, internalOnly: true });
})(typeof globalThis !== "undefined" ? globalThis : (typeof window !== "undefined" ? window : this));
