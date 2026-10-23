/* ============================================================================
 * CIKUR GO — TEAM ASSISTANT × AGENT CGO
 * File: cgo-team-assistant-agent.js
 * Version: 1.0.5
 *
 * Peran:
 * - Mengorkestrasi permintaan pendampingan melalui Assistant dan Agent CGO.
 * - Menyediakan rencana 2IN1 yang menghubungkan konteks FOOD × RESTO,
 *   pendampingan Assistant, dan bila diperlukan koordinasi RIDE × DRIVER.
 * - Tidak mengambil alih halaman assistant.html, agentcgo.html, atau cikurgo2in1.html.
 * - Tidak membuat order, pembayaran, ketersediaan agent, atau status layanan palsu.
 * - Tidak memakai layanan AI/API jaringan/cloud eksternal sebagai otak.
 *
 * Semua fungsi di file ini berjalan lokal. Integrasi aksi nyata hanya dapat
 * dilakukan melalui fungsi aplikasi lokal yang didaftarkan secara eksplisit.
 * ============================================================================ */
(function (global) {
  "use strict";
  if (global.CGOAssistantAgentTeam) return;

  var VERSION = "1.0.5";
  var TEAM_ID = "TEAM_ASSISTANT_AGENT_CGO";
  var FOOD_TEAM_ID = "TEAM_FOOD_RESTO";
  var RIDE_TEAM_ID = "TEAM_RIDE_DRIVER";
  var STATUS = Object.freeze({
    READY: "TEAM_READY", ACTIVE: "TEAM_ACTIVE", COLLABORATING: "TEAM_COLLABORATING",
    WAITING_DATA: "TEAM_WAITING_DATA", WAITING_CONFIRMATION: "TEAM_WAITING_CONFIRMATION",
    COMPLETED: "TEAM_COMPLETED", PARTIAL: "TEAM_PARTIALLY_COMPLETED",
    BLOCKED: "TEAM_BLOCKED", ERROR: "TEAM_ERROR", IDLE: "TEAM_IDLE"
  });
  var TASK_STATUS = Object.freeze({
    CREATED: "TASK_CREATED", NEEDS_DATA: "TASK_WAITING_DATA",
    NEEDS_CONFIRMATION: "TASK_WAITING_CONFIRMATION", READY: "TASK_READY",
    PROCESSING: "TASK_PROCESSING", SUBMITTED: "TASK_SUBMITTED",
    IN_PROGRESS: "TASK_IN_PROGRESS", COMPLETED: "TASK_COMPLETED",
    CANCELLED: "TASK_CANCELLED", BLOCKED: "TASK_BLOCKED", FAILED: "TASK_FAILED"
  });
  var AGENTS = Object.freeze([
    { id: "AGENT_ASSISTANT_INTENT", name: "Agent Pemahami Permintaan Assistant", capabilities: ["intent_detection", "clarification", "negation_detection"] },
    { id: "AGENT_ASSISTANT_PLANNER", name: "Agent Perencana Pendampingan", capabilities: ["service_plan", "schedule", "duration"] },
    { id: "AGENT_ASSISTANT_CUSTOMER_CONTEXT", name: "Agent Konteks Pelanggan", capabilities: ["customer_context", "preferences", "consent_guard"] },
    { id: "AGENT_ASSISTANT_FOOD_LINK", name: "Agent Penghubung FOOD × RESTO", capabilities: ["food_bundle_context", "food_reference_validation", "2in1_coordination"] },
    { id: "AGENT_ASSISTANT_RIDE_LINK", name: "Agent Penghubung RIDE × DRIVER", capabilities: ["transport_handoff", "pickup_destination_context"] },
    { id: "AGENT_ASSISTANT_AGENT_MATCH", name: "Agent Koordinasi Agent CGO", capabilities: ["agent_request", "availability_validation", "assignment_evidence"] },
    { id: "AGENT_ASSISTANT_MONITOR", name: "Agent Pemantau Layanan", capabilities: ["lifecycle_monitoring", "evidence_validation", "status_consistency"] }
  ]);
  var adapter = null;
  var status = STATUS.READY;
  var tasks = new Map();
  var listeners = new Set();
  var recentSubmissions = new Set();

  function nowISO() { return new Date().toISOString(); }
  function makeId() { return "ASST-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9); }
  function str(v) { return String(v == null ? "" : v).trim(); }
  function clone(v) {
    if (v == null) return v;
    try { if (typeof global.structuredClone === "function") return global.structuredClone(v); } catch (_) {}
    try { return JSON.parse(JSON.stringify(v)); } catch (_) { return v; }
  }
  function emit(type, detail) {
    var event = { type: type, teamId: TEAM_ID, version: VERSION, timestamp: nowISO(), detail: clone(detail || {}) };
    listeners.forEach(function (fn) { try { fn(event); } catch (_) {} });
    try { if (typeof global.CustomEvent === "function" && typeof global.dispatchEvent === "function") global.dispatchEvent(new global.CustomEvent("cgo:assistant-agent", { detail: event })); } catch (_) {}
    return event;
  }
  function setStatus(next, reason) { status = next; emit("TEAM_STATUS_CHANGED", { status: next, reason: reason || null }); return status; }
  function publicTask(task) { return task ? clone(task) : null; }
  function getMutable(id) { return tasks.get(str(id)) || null; }
  function updateTask(task, next, note, extra) {
    task.status = next; task.updatedAt = nowISO();
    task.history.push({ status: next, at: task.updatedAt, note: note || null });
    if (extra && typeof extra === "object") Object.keys(extra).forEach(function (k) { task[k] = clone(extra[k]); });
    emit("TASK_UPDATED", { taskId: task.taskId, status: next, note: note || null });
    return task;
  }
  function analyzeIntent(input) {
    var source = typeof input === "string" ? input : str(input && (input.requestText || input.text || input.message));
    var s = source.toLocaleLowerCase("id-ID");
    var negated = /\b(jangan(?!\s+lupa)|tidak|tak|nggak|enggak|gak|ga|batal|batalkan|jgn|belum mau|tidak perlu)\b/.test(s);
    var food = /\b(food|makanan|makan|resto|restoran|menu|pesan makanan|2in1|2 in 1)\b/.test(s);
    var assistant = /\b(assistant|asisten|pendamping\w*|temani|teman|agent cgo|agent|bantuan|bantu saya)\b/.test(s);
    var ride = /\b(ride|perjalanan|antar saya|jemput saya|transportasi|driver|pengemudi|sopir|ojek|taksi)\b/.test(s);
    var track = /\b(lacak|tracking|status|posisi|di mana|dimana|sudah sampai)\b/.test(s);
    var intent = "UNKNOWN";
    if (negated) intent = "NEGATED_OR_DECLINED";
    else if (track) intent = "TRACK_REQUEST";
    else if ((food && assistant) || /\b2\s*in\s*1\b/.test(s)) intent = "2IN1_REQUEST";
    else if (assistant) intent = "ASSISTANT_REQUEST";
    else if (food) intent = "FOOD_CONTEXT_REQUEST";
    else if (ride) intent = "RIDE_CONTEXT_REQUEST";
    return { ok: intent !== "UNKNOWN", intent: intent, sourceText: source,
      signals: { negated: negated, food: food, assistant: assistant, ride: ride, tracking: track },
      confidence: intent === "UNKNOWN" ? 0 : (negated ? 0.99 : (intent === "2IN1_REQUEST" ? 0.95 : 0.82)),
      requiresClarification: intent === "UNKNOWN" || intent === "FOOD_CONTEXT_REQUEST" || intent === "RIDE_CONTEXT_REQUEST",
      note: negated ? "Permintaan ditolak/dibatalkan; tidak membuat tugas layanan." : null };
  }
  function validatePlan(input) {
    var x = input || {}, errors = [];
    var duration = x.durationMinutes == null ? (x.duration == null ? 60 : Number(x.duration)) : Number(x.durationMinutes);
    if (!Number.isFinite(duration) || [30, 60, 90].indexOf(duration) < 0) errors.push("Durasi pendampingan harus 30, 60, atau 90 menit.");
    var arrivalTime = str(x.arrivalTime || x.startTime);
    if (arrivalTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(arrivalTime)) errors.push("Format waktu kedatangan harus HH:MM.");
    var foodOrderId = str(x.foodOrderId || x.orderId);
    var foodTaskId = str(x.foodTaskId);
    var rideOrderId = str(x.rideOrderId);
    var customerConsent = x.customerConsent === true;
    return { ok: errors.length === 0, errors: errors, normalized: {
      serviceType: str(x.serviceType || x.kind || "ASSISTANT").toUpperCase(),
      durationMinutes: duration, arrivalTime: arrivalTime || null,
      location: str(x.location || x.restoAddress || x.address) || null,
      customerId: str(x.customerId) || null, conversationId: str(x.conversationId) || null,
      foodOrderId: foodOrderId || null, foodTaskId: foodTaskId || null,
      rideOrderId: rideOrderId || null, customerConsent: customerConsent,
      notes: str(x.notes || x.requestText) || null
    } };
  }
  function timeline(arrivalTime, durationMinutes) {
    if (!arrivalTime || !/^([01]\d|2[0-3]):[0-5]\d$/.test(arrivalTime) || !Number.isFinite(Number(durationMinutes)) || [30, 60, 90].indexOf(Number(durationMinutes)) < 0) return { ok: false, code: "TIME_INPUT_INVALID" };
    var p = arrivalTime.split(":").map(Number); var start = p[0] * 60 + p[1];
    function fmt(n) { n = ((n % 1440) + 1440) % 1440; return String(Math.floor(n / 60)).padStart(2, "0") + ":" + String(n % 60).padStart(2, "0"); }
    return { ok: true, standbyTime: fmt(start - 15), arrivalTime: fmt(start), endTime: fmt(start + Number(durationMinutes)), durationMinutes: Number(durationMinutes), crossesMidnight: start + Number(durationMinutes) >= 1440 };
  }
  function createTask(input) {
    var x = input || {}; var plan = validatePlan(x); var n = plan.normalized;
    var task = { taskId: makeId(), teamId: TEAM_ID, kind: n.serviceType, status: plan.ok ? TASK_STATUS.NEEDS_CONFIRMATION : TASK_STATUS.NEEDS_DATA,
      createdAt: nowISO(), updatedAt: nowISO(), customerId: n.customerId, conversationId: n.conversationId,
      requestText: str(x.requestText || x.text), plan: n, timeline: n.arrivalTime ? timeline(n.arrivalTime, n.durationMinutes) : null,
      linkedTeams: { food: n.foodOrderId || n.foodTaskId ? FOOD_TEAM_ID : null, ride: n.rideOrderId ? RIDE_TEAM_ID : null },
      history: [{ status: plan.ok ? TASK_STATUS.NEEDS_CONFIRMATION : TASK_STATUS.NEEDS_DATA, at: nowISO(), note: plan.ok ? "Rencana dibuat; menunggu persetujuan pelanggan." : plan.errors.join(" ") }],
      validation: { ok: plan.ok, errors: plan.errors }, submission: null };
    tasks.set(task.taskId, task); setStatus(plan.ok ? STATUS.WAITING_CONFIRMATION : STATUS.WAITING_DATA, "Tugas lokal dibuat; belum ada transaksi layanan.");
    emit("TASK_CREATED", { taskId: task.taskId, kind: task.kind, status: task.status, linkedTeams: task.linkedTeams });
    return publicTask(task);
  }
  function getTask(id) { return publicTask(getMutable(id)); }
  function listTasks(filter) { var f = filter || {}; return Array.from(tasks.values()).filter(function (t) { return !f.status || t.status === f.status; }).map(publicTask); }
  function confirmTask(taskId, consent) {
    var task = getMutable(taskId); if (!task) return { ok: false, code: "TASK_NOT_FOUND", message: "Tugas tidak ditemukan." };
    if (consent !== true) { updateTask(task, TASK_STATUS.BLOCKED, "Persetujuan pelanggan tidak diberikan."); setStatus(STATUS.BLOCKED, "Persetujuan tidak diberikan."); return { ok: false, code: "CUSTOMER_CONSENT_REQUIRED", task: publicTask(task) }; }
    if (!task.validation.ok) return { ok: false, code: "PLAN_INVALID", errors: clone(task.validation.errors), task: publicTask(task) };
    task.plan.customerConsent = true; updateTask(task, TASK_STATUS.READY, "Persetujuan eksplisit pelanggan tercatat secara lokal."); setStatus(STATUS.READY, "Rencana siap; belum menjalankan transaksi eksternal maupun internal.");
    return { ok: true, task: publicTask(task), note: "Persetujuan dicatat pada modul lokal; layanan belum dinyatakan dipesan." };
  }
  function read2in1Context(input) {
    var x = input || {};
    // Prefer explicit data supplied by caller. localStorage is optional and read-only.
    var bundle = x.bundleData || null;
    if (!bundle && x.readLocalBundle === true) {
      try { if (global.localStorage) { var raw = global.localStorage.getItem("cikur_bundle_cart"); bundle = raw ? JSON.parse(raw) : null; } } catch (_) { bundle = null; }
    }
    if (bundle && typeof bundle !== "object") bundle = null;
    var items = bundle && Array.isArray(bundle.items) ? bundle.items : [];
    var safeItems = items.map(function (item) { return { name: str(item && item.name), qty: Number(item && item.qty), price: Number(item && item.price), restoName: str(item && item.restoName) || null }; })
      .filter(function (item) { return item.name && Number.isFinite(item.qty) && item.qty > 0 && Number.isFinite(item.price) && item.price >= 0; });
    // Harga ringkasan dihitung dari item valid; total tersimpan tidak dipercaya
    // sebagai sumber utama karena bisa kedaluwarsa atau tidak sinkron dengan isi keranjang.
    var calculatedTotal = safeItems.reduce(function (sum, item) { return sum + item.qty * item.price; }, 0);
    var suppliedTotal = bundle && Number(bundle.totalFoodPrice);
    var total = calculatedTotal;
    var totalMismatch = Number.isFinite(suppliedTotal) && suppliedTotal >= 0 && Math.abs(suppliedTotal - calculatedTotal) > 0.009;
    return { ok: !!(bundle && safeItems.length), source: bundle ? (x.bundleData ? "CALLER_SUPPLIED_BUNDLE" : "LOCAL_STORAGE_READ_ONLY") : "NO_BUNDLE",
      bundleId: str(bundle && (bundle.bundleId || bundle.cartId)) || null, items: safeItems, totalFoodPrice: total,
      suppliedTotalFoodPrice: Number.isFinite(suppliedTotal) && suppliedTotal >= 0 ? suppliedTotal : null,
      totalMismatch: !!totalMismatch,
      foodOrderId: str(x.foodOrderId || (bundle && bundle.foodOrderId)) || null,
      foodTaskId: str(x.foodTaskId || (bundle && bundle.foodTaskId)) || null,
      restoName: str(x.restoName || (safeItems[0] && safeItems[0].restoName)) || null,
      note: bundle && safeItems.length ? "Data keranjang dibaca sebagai konteks saja; ini bukan bukti order sudah dibuat." : "Keranjang makanan belum tersedia atau tidak berisi item valid." };
  }
  function create2in1Plan(input) {
    var x = input || {}; var food = read2in1Context(x);
    var planInput = Object.assign({}, x, { serviceType: "2IN1", foodOrderId: x.foodOrderId || food.foodOrderId, foodTaskId: x.foodTaskId || food.foodTaskId });
    var validation = validatePlan(planInput);
    var needs = [];
    if (!food.ok) needs.push("Pilih menu FOOD × RESTO yang valid.");
    if (!validation.normalized.arrivalTime) needs.push("Tentukan jam kedatangan.");
    if (!validation.normalized.location) needs.push("Tentukan lokasi pendampingan.");
    return { ok: validation.ok && needs.length === 0, teamId: TEAM_ID, kind: "2IN1", status: needs.length ? STATUS.WAITING_DATA : STATUS.WAITING_CONFIRMATION,
      foodContext: food, assistantPlan: validation.normalized, timeline: validation.normalized.arrivalTime ? timeline(validation.normalized.arrivalTime, validation.normalized.durationMinutes) : null,
      linkedTeams: { food: FOOD_TEAM_ID, ride: x.rideOrderId ? RIDE_TEAM_ID : null }, missing: needs,
      transactionCreated: false, externalBrainDependency: false,
      note: "Rencana koordinasi 2IN1 saja. Tidak membuat order, menagih pembayaran, atau mengubah status FOOD/RESTO/RIDE." };
  }
  function handoffToFood(input) {
    var x = input || {}; var team = global.CGOFoodRestoTeam;
    if (!team || typeof team.getTask !== "function") return { ok: false, code: "FOOD_TEAM_UNAVAILABLE", message: "Modul FOOD × RESTO lokal belum dimuat." };
    var id = str(x.foodTaskId); if (!id) return { ok: false, code: "FOOD_TASK_ID_REQUIRED", message: "foodTaskId diperlukan untuk memeriksa tugas yang sudah ada." };
    var task = team.getTask(id); if (!task) return { ok: false, code: "FOOD_TASK_NOT_FOUND", message: "Tugas FOOD × RESTO tidak ditemukan." };
    return { ok: true, teamId: FOOD_TEAM_ID, task: clone(task), readOnly: true, note: "Referensi FOOD dibaca; tidak membuat ulang atau mengubah order." };
  }
  function handoffToRide(input) {
    var x = input || {}; var team = global.CGORideDriverTeam;
    if (!team || typeof team.createFoodDeliveryHandoff !== "function") return { ok: false, code: "RIDE_TEAM_UNAVAILABLE", message: "Modul RIDE × DRIVER lokal belum dimuat." };
    if (!str(x.foodOrderId) && !str(x.foodTaskId)) return { ok: false, code: "FOOD_REFERENCE_REQUIRED", message: "Diperlukan ID order/tugas FOOD yang nyata." };
    return team.createFoodDeliveryHandoff({ foodOrderId: x.foodOrderId, foodTaskId: x.foodTaskId, customerId: x.customerId,
      pickup: x.pickup || x.restoAddress, destination: x.destination || x.customerAddress, channel: "assistant-agent-handoff" });
  }
  async function executeLocalAction(taskId, action) {
    var task = getMutable(taskId); if (!task) return { ok: false, code: "TASK_NOT_FOUND" };
    if (!task.plan.customerConsent) return { ok: false, code: "CUSTOMER_CONSENT_REQUIRED", message: "Persetujuan pelanggan diperlukan." };
    if (!adapter || typeof adapter[action] !== "function") return { ok: false, status: STATUS.WAITING_DATA, code: "LOCAL_FUNCTION_UNAVAILABLE", message: "Fungsi aplikasi lokal '" + action + "' belum didaftarkan; tidak ada transaksi dijalankan." };
    var fingerprint = task.taskId + "|" + action;
    if (recentSubmissions.has(fingerprint)) return { ok: false, code: "DUPLICATE_ACTION_GUARD", message: "Aksi yang sama sudah pernah dicoba untuk tugas ini." };
    // Set ini menjadi kunci idempotensi saat aksi berjalan dan setelah sukses.
    // Kegagalan yang belum mengubah sistem boleh dicoba ulang, tetapi aksi sukses tidak.
    recentSubmissions.add(fingerprint); updateTask(task, TASK_STATUS.PROCESSING, "Menjalankan fungsi aplikasi lokal yang terdaftar.");
    var result;
    try { result = await adapter[action](publicTask(task)); }
    catch (error) {
      recentSubmissions.delete(fingerprint);
      updateTask(task, TASK_STATUS.FAILED, "Fungsi lokal gagal; percobaan ulang diizinkan.");
      return { ok: false, code: "LOCAL_ACTION_FAILED", retryAllowed: true, message: str(error && error.message) || "Fungsi lokal gagal." };
    }
    if (!result || result.ok !== true || result.confirmed !== true) {
      recentSubmissions.delete(fingerprint);
      updateTask(task, TASK_STATUS.FAILED, "Bukti konfirmasi tidak cukup; percobaan ulang diizinkan.");
      return { ok: false, code: "LOCAL_ACTION_EVIDENCE_MISSING", retryAllowed: true, message: "Respons lokal belum memberikan bukti konfirmasi eksplisit.", result: clone(result || null) };
    }
    task.submission = { action: action, confirmedAt: nowISO(), evidence: clone(result) };
    updateTask(task, TASK_STATUS.SUBMITTED, "Aksi dikonfirmasi fungsi internal aplikasi."); setStatus(STATUS.COLLABORATING, "Aksi internal terkonfirmasi.");
    return { ok: true, task: publicTask(task), result: clone(result) };
  }
  // Audit referensi lintas tim secara read-only. Audit tidak membuat/mengubah order.
  function auditTeamLinks(input) {
    var x = input || {}, findings = [];
    var foodTeam = global.CGOFoodRestoTeam || null;
    var rideTeam = global.CGORideDriverTeam || null;
    var foodTaskId = str(x.foodTaskId), foodOrderId = str(x.foodOrderId), rideTaskId = str(x.rideTaskId);
    var foodTask = null, rideTask = null;
    if (foodTaskId) {
      if (!foodTeam || typeof foodTeam.getTask !== "function") findings.push({ code: "FOOD_TEAM_UNAVAILABLE", severity: "warning", message: "Modul FOOD × RESTO belum tersedia untuk memverifikasi referensi." });
      else { foodTask = foodTeam.getTask(foodTaskId); if (!foodTask) findings.push({ code: "FOOD_TASK_NOT_FOUND", severity: "error", message: "ID tugas FOOD tidak ditemukan." }); }
    }
    if (rideTaskId) {
      if (!rideTeam || typeof rideTeam.getTask !== "function") findings.push({ code: "RIDE_TEAM_UNAVAILABLE", severity: "warning", message: "Modul RIDE × DRIVER belum tersedia untuk memverifikasi referensi." });
      else { rideTask = rideTeam.getTask(rideTaskId); if (!rideTask) findings.push({ code: "RIDE_TASK_NOT_FOUND", severity: "error", message: "ID tugas RIDE tidak ditemukan." }); }
    }
    var foodSubmissionEvidence = !!(foodTask && foodTask.submission && foodTask.submission.submitted === true && foodTask.submission.orderId);
    var rideOrderEvidence = !!(rideTask && (rideTask.rideOrderId || rideTask.submission && rideTask.submission.orderId));
    if (foodOrderId && !foodTaskId) {
      findings.push({ code: "FOOD_TASK_REFERENCE_REQUIRED", severity: "warning", message: "ID order FOOD diberikan tanpa ID tugas sumber; audit belum dapat mencocokkan order dengan bukti submit tim FOOD × RESTO." });
    }
    if (foodTask && foodOrderId) {
      if (foodSubmissionEvidence && foodTask.submission.orderId !== foodOrderId) {
        findings.push({ code: "FOOD_ORDER_REFERENCE_MISMATCH", severity: "error", message: "ID order tidak cocok dengan bukti submit tugas FOOD." });
      } else if (!foodSubmissionEvidence) {
        findings.push({ code: "FOOD_ORDER_EVIDENCE_MISSING", severity: "warning", message: "Tugas FOOD ditemukan, tetapi belum memiliki bukti submit dan ID order aktual untuk memverifikasi referensi." });
      }
    }
    if (rideTaskId && rideTask && !rideOrderEvidence) {
      findings.push({ code: "RIDE_ORDER_EVIDENCE_MISSING", severity: "warning", message: "Tugas RIDE ditemukan, tetapi belum memiliki ID order aktual; status tugas saja bukan bukti pemesanan." });
    }
    var errors = findings.filter(function (f) { return f.severity === "error"; });
    var warnings = findings.filter(function (f) { return f.severity === "warning"; });
    var referenceCount = [foodTaskId, foodOrderId, rideTaskId].filter(Boolean).length;
    var verified = referenceCount > 0 && errors.length === 0 && warnings.length === 0 &&
      (!foodTaskId || !!foodTask) && (!rideTaskId || !!rideTask) &&
      (!foodOrderId || !!(foodSubmissionEvidence && foodTask && foodTask.submission.orderId === foodOrderId));
    return { ok: errors.length === 0, verified: verified,
      verificationStatus: errors.length ? "FAILED" : (warnings.length || (referenceCount > 0 && !verified) ? "PARTIAL" : (verified ? "VERIFIED" : "NO_REFERENCES")),
      readOnly: true, transactionCreated: false,
      checkedAt: nowISO(), references: { foodTaskId: foodTaskId || null, foodOrderId: foodOrderId || null, rideTaskId: rideTaskId || null },
      teamsDetected: { food: !!foodTeam, ride: !!rideTeam },
      taskEvidence: { foodTaskFound: !!foodTask, rideTaskFound: !!rideTask,
        foodTaskStatus: foodTask && foodTask.status || null, rideTaskStatus: rideTask && rideTask.status || null,
        foodSubmissionEvidence: foodSubmissionEvidence, rideOrderEvidence: rideOrderEvidence },
      findings: findings, note: "ok berarti tidak ditemukan konflik keras; hanya verified:true yang menandakan semua referensi yang diberikan telah diverifikasi dengan bukti yang tersedia. Status tim dibaca saja." };
  }

  function registerLocalAdapter(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, code: "INVALID_LOCAL_ADAPTER", message: "Pendaftaran harus berupa objek berisi fungsi lokal." };
    adapter = value; var methods = Object.keys(value).filter(function (k) { return typeof value[k] === "function"; });
    emit("LOCAL_FUNCTIONS_REGISTERED", { methods: methods }); return { ok: true, mode: "IN_PROCESS_LOCAL_ONLY", methods: methods };
  }
  function clearLocalAdapter() { adapter = null; emit("LOCAL_FUNCTIONS_CLEARED", {}); return true; }
  function onEvent(fn) { if (typeof fn !== "function") throw new TypeError("Listener harus berupa fungsi."); listeners.add(fn); return function () { listeners.delete(fn); }; }
  function getStatus() { return { version: VERSION, teamId: TEAM_ID, status: status, internalOnly: true, externalBrainDependency: false,
    adapterMode: adapter ? "LOCAL_FUNCTIONS_REGISTERED" : "STANDALONE_NO_TRANSACTION_FUNCTIONS", taskCount: tasks.size, agentCount: AGENTS.length,
    foodTeamDetected: !!global.CGOFoodRestoTeam, rideTeamDetected: !!global.CGORideDriverTeam }; }
  function auditIndependence() { return { ok: true, teamId: TEAM_ID, internalOnly: true, networkCallsByModule: false, externalBrainDependency: false,
    localAdapterRegistered: !!adapter, note: "Modul tidak memanggil jaringan; aksi nyata hanya melalui fungsi internal aplikasi yang didaftarkan." }; }
  function forgetTask(taskId) {
    var id = str(taskId);
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
    check("assistant intent recognized", analyzeIntent("Saya perlu pendampingan Agent CGO").intent === "ASSISTANT_REQUEST");
    check("2IN1 intent recognized", analyzeIntent("Saya mau pesan makanan dan pendampingan 2IN1").intent === "2IN1_REQUEST");
    check("negated request blocked", analyzeIntent("Jangan pesan assistant").intent === "NEGATED_OR_DECLINED");
    check("jangan lupa is not mistaken for refusal", analyzeIntent("Jangan lupa pesan makanan").intent === "FOOD_CONTEXT_REQUEST");
    check("invalid duration rejected", !validatePlan({ durationMinutes: 45 }).ok);
    var tl = timeline("00:10", 30); check("timeline handles midnight", tl.ok && tl.standbyTime === "23:55" && tl.endTime === "00:40");
    check("timeline rejects unsupported duration", !timeline("12:00", 45).ok);
    var mismatch = read2in1Context({ bundleData: { totalFoodPrice: 1, items: [{ name: "Nasi", qty: 2, price: 10000 }] } });
    check("2IN1 total is recalculated from valid items", mismatch.ok && mismatch.totalFoodPrice === 20000 && mismatch.totalMismatch === true);
    var noBundle = create2in1Plan({ arrivalTime: "12:00", durationMinutes: 60, location: "Resto A" });
    check("2IN1 missing food is not falsely ready", !noBundle.ok && noBundle.transactionCreated === false);
    check("independence audit passes", auditIndependence().ok && auditIndependence().networkCallsByModule === false);
    var linkAudit = auditTeamLinks({ foodTaskId: "__CGO_AUDIT_MISSING_TASK__" });
    check("cross-team audit flags missing food reference when team is available", !global.CGOFoodRestoTeam || !global.CGOFoodRestoTeam.getTask || linkAudit.findings.some(function (f) { return f.code === "FOOD_TASK_NOT_FOUND"; }), linkAudit.findings);
    var noEvidenceAudit = auditTeamLinks({ foodTaskId: "__CGO_AUDIT_MISSING_EVIDENCE__", foodOrderId: "ORDER-WITHOUT-EVIDENCE" });
    check("audit does not treat an unverified order reference as verified", noEvidenceAudit.verified === false && noEvidenceAudit.verificationStatus !== "VERIFIED");
    check("audit marks empty references as NO_REFERENCES", auditTeamLinks({}).verificationStatus === "NO_REFERENCES");
    return { ok: checks.every(function (c) { return c.pass; }), total: checks.length, passed: checks.filter(function (c) { return c.pass; }).length, checks: checks };
  }
  var api = {
    version: VERSION, teamId: TEAM_ID, foodTeamId: FOOD_TEAM_ID, rideTeamId: RIDE_TEAM_ID, agents: AGENTS, statuses: STATUS, taskStatuses: TASK_STATUS,
    getStatus: getStatus, listAgents: function () { return clone(AGENTS); }, onEvent: onEvent,
    analyzeIntent: analyzeIntent, validatePlan: validatePlan, timeline: timeline, createTask: createTask, getTask: getTask, listTasks: listTasks,
    confirmTask: confirmTask, read2in1Context: read2in1Context, create2in1Plan: create2in1Plan,
    handoffToFood: handoffToFood, handoffToRide: handoffToRide, registerLocalAdapter: registerLocalAdapter, clearLocalAdapter: clearLocalAdapter,
    executeLocalAction: executeLocalAction, forgetTask: forgetTask,
    auditIndependence: auditIndependence, auditTeamLinks: auditTeamLinks, selfTest: selfTest
  };
  global.CGOAssistantAgentTeam = Object.freeze(api);
  emit("TEAM_READY", { version: VERSION, agentCount: AGENTS.length, internalOnly: true });
})(typeof globalThis !== "undefined" ? globalThis : (typeof window !== "undefined" ? window : this));
