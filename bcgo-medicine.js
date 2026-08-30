<!doctype html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BCGO Medicine v3.3.1 — BCGO Contract Sync</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
body{font-family:Inter,Arial,sans-serif}.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.panel{background:#0f172a;border:1px solid #1e293b;border-radius:16px}.pre{white-space:pre-wrap;word-break:break-word}.pulse{animation:pulse 1.8s infinite}@keyframes pulse{50%{opacity:.45}}
</style>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen p-3 md:p-5">
<main class="max-w-7xl mx-auto space-y-4">
<header class="panel p-4 md:p-5 flex flex-wrap justify-between items-center gap-3">
  <div><h1 class="text-xl font-bold">💊 BCGO Medicine v3.3.1 <span class="text-xs text-cyan-300 code">PRECISION ROOT-CAUSE REPAIR</span></h1><p class="text-xs text-slate-400 mt-1">BCGO_STATE → Medicine Queue • Re-trace Root Cause • Verify • Repair Plan • Human Approval • Execute • Validate</p></div>
  <div class="flex gap-2 text-[10px] code"><span id="auth" class="border border-slate-700 px-2 py-1 rounded">AUTH WAITING</span><span id="sys" class="border border-slate-700 px-2 py-1 rounded">BOOT</span><span id="executor" class="border border-slate-700 px-2 py-1 rounded">EXECUTOR WAITING</span></div>
</header>

<section class="panel p-3">
  <div class="flex items-center justify-between gap-2 mb-2"><h2 class="text-xs uppercase text-slate-400">📡 Realtime Health</h2><span id="livePulse" class="text-[9px] text-emerald-300">LIVE MONITOR</span></div>
  <div class="grid grid-cols-2 md:grid-cols-5 gap-2 text-[9px]">
    <div class="bg-slate-950 border border-slate-800 rounded-lg p-2"><span class="text-slate-500">FIRESTORE</span><b id="rtFirestore" class="block text-amber-300">WAITING</b></div>
    <div class="bg-slate-950 border border-slate-800 rounded-lg p-2"><span class="text-slate-500">TELEMETRY</span><b id="rtTelemetry" class="block text-amber-300">WAITING</b></div>
    <div class="bg-slate-950 border border-slate-800 rounded-lg p-2"><span class="text-slate-500">CHAT</span><b id="rtChat" class="block text-amber-300">WAITING</b></div>
    <div class="bg-slate-950 border border-slate-800 rounded-lg p-2"><span class="text-slate-500">AUTONOMOUS</span><b id="rtAuto" class="block text-emerald-300">ON</b></div>
    <div class="bg-slate-950 border border-slate-800 rounded-lg p-2"><span class="text-slate-500">REGISTRY</span><b id="rtRegistry" class="block text-amber-300">WAITING</b></div>
  </div>
</section>

<section class="panel p-3 border border-cyan-900/60">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <div><h2 class="text-xs uppercase text-cyan-300">🧭 Precision Repair Pipeline</h2><p class="text-[10px] text-slate-500 mt-1">Evidence → Source exact → Root cause → BEFORE → AFTER → Copy Solution → Human Review</p></div>
    <span id="pipelineState" class="text-[9px] text-amber-300">MENUNGGU CASE</span>
  </div>
</section>

<section class="grid grid-cols-2 md:grid-cols-6 gap-3">
  <div class="panel p-3"><small class="text-[9px] text-slate-400">ORGAN</small><b id="org" class="block text-2xl">0</b></div>
  <div class="panel p-3"><small class="text-[9px] text-slate-400">TELEMETRY</small><b id="logs" class="block text-2xl text-blue-400">0</b></div>
  <div class="panel p-3"><small class="text-[9px] text-slate-400">CASES</small><b id="casesN" class="block text-2xl text-amber-400">0</b></div>
  <div class="panel p-3"><small class="text-[9px] text-slate-400">ACTIVE</small><b id="active" class="block text-2xl text-rose-400">0</b></div>
  <div class="panel p-3"><small class="text-[9px] text-slate-400">FINDINGS</small><b id="findN" class="block text-2xl text-purple-400">0</b></div>
  <div class="panel p-3"><small class="text-[9px] text-slate-400">REPAIRS</small><b id="repairs" class="block text-2xl text-emerald-400">0</b></div>
</section>

<section class="grid lg:grid-cols-3 gap-4">
  <div class="panel p-4 lg:col-span-2">
    <div class="flex justify-between items-center"><div><h2 class="text-xs uppercase text-slate-400">🧠 BCGO ↔ 💊 Medicine ↔ 👤 Anda</h2><p class="text-[10px] text-slate-500">Satu kanal realtime • pesan dideduplikasi berdasarkan clientMessageId</p></div><span id="chatLive" class="text-[10px] text-emerald-400">LIVE</span></div>
    <div id="chat" class="mt-3 bg-slate-950 border border-slate-800 rounded-xl p-3 h-80 overflow-y-auto space-y-3"><div class="text-xs text-slate-500">Membuka kanal...</div></div>
    <form id="form" class="flex gap-2 mt-3"><input id="input" class="flex-1 bg-slate-950 border border-slate-700 rounded-lg p-2 text-sm outline-none" placeholder="Tanya BCGO / Medicine..."><button id="send" class="bg-indigo-600 rounded-lg px-4 text-sm">Kirim</button></form>
  </div>
  <div class="panel p-4">
    <div class="flex justify-between items-center"><h2 class="text-xs uppercase text-slate-400">🔬 Active Diagnosis</h2><span id="caseState" class="text-[9px] text-slate-500">WAITING</span></div>
    <div id="diag" class="mt-3 text-xs text-slate-400">Belum ada case.</div>
    <div class="grid grid-cols-1 gap-2 mt-3"><button id="approve" class="hidden w-full bg-emerald-700 rounded-lg py-2 text-xs">🖐️ Setujui Treatment Presisi</button><button id="apply" class="hidden w-full bg-indigo-700 rounded-lg py-2 text-xs">🔧 Jalankan Repair Executor</button><button id="validate" class="hidden w-full border border-cyan-800 text-cyan-300 rounded-lg py-2 text-xs">🧪 Validasi Ulang</button></div>
  </div>
</section>

<section class="grid lg:grid-cols-2 gap-4">
  <div class="panel p-4"><div class="flex justify-between items-center"><h2 class="text-xs uppercase text-slate-400">🧬 Cross-File Consistency</h2><button id="scan" class="text-[10px] border border-slate-700 rounded px-2 py-1">SCAN ULANG</button></div><div id="findings" class="mt-3 space-y-2 max-h-80 overflow-y-auto"></div></div>
  <div class="panel p-4"><div class="flex justify-between items-center"><h2 class="text-xs uppercase text-slate-400">💊 Prescription</h2><span id="humanMode" class="text-[9px] text-amber-400">ASSISTED</span></div><div id="rx" class="mt-3 text-xs text-slate-400">Belum ada prescription.</div></div>
</section>

<section class="panel p-4">
  <div class="flex flex-wrap justify-between gap-2 items-center"><div><h2 class="text-xs uppercase text-slate-400">🩺 REAL REPAIR / TANGAN MEDICINE</h2><p class="text-[10px] text-slate-500 mt-1">Medicine membuktikan akar masalah, evidence exact, dan operasi exact sebelum menampilkan BEFORE → AFTER.</p></div><span id="patchState" class="text-[9px] text-slate-500">NO PLAN</span></div>
  <div id="patch" class="mt-3 text-xs text-slate-500">Belum ada repair plan.</div>
  <div id="beforeAfter" class="mt-3 grid lg:grid-cols-2 gap-3"></div>
  <div id="codePrescription" class="mt-4"></div>
  <div id="validation" class="mt-3 text-xs text-slate-500"></div>
</section>

<section class="panel p-4 border border-amber-900/70">
  <div class="flex flex-wrap justify-between gap-2 items-center"><div><h2 class="text-xs uppercase text-amber-300">🛠️ RUANG OPERASI — CODE SURGERY</h2><p class="text-[10px] text-slate-500 mt-1">Manusia melihat source asli dan BEFORE → AFTER untuk menyalin solusi secara sadar.</p></div><span id="surgeryState" class="text-[9px] text-amber-300">MENUNGGU EVIDENCE</span></div>
  <div id="surgerySummary" class="mt-3 text-xs text-slate-500">Belum ada resep operasi.</div>
</section>

<section class="panel p-4">
  <div class="flex justify-between items-center gap-2"><div><h2 class="text-xs uppercase text-slate-400">🧪 Verifikasi BCGO → Medicine</h2><p class="text-[10px] text-slate-500 mt-1">Medicine menelusuri ulang seluruh dependency surface dan memindahkan target bila perlu.</p></div><span id="verifyState" class="text-[9px] text-slate-500">BELUM DIVERIFIKASI</span></div>
  <div id="verification" class="mt-3 text-xs text-slate-500">Belum ada verifikasi terarah.</div>
  <button id="verifyBtn" class="hidden mt-3 w-full border border-cyan-800 text-cyan-300 rounded-lg py-2 text-xs">🔎 Verifikasi & Telusuri Akar Masalah</button>
</section>

<section class="panel p-4">
  <div class="flex flex-wrap items-center justify-between gap-3"><div><h2 class="text-xs uppercase text-slate-400">🖐️ Human Control / Tangan Manusia</h2><p class="text-[10px] text-slate-500 mt-1">Tidak ada patch permanen tanpa persetujuan manusia.</p></div><div class="flex flex-wrap gap-2"><button id="pause" class="text-[10px] border border-amber-700 text-amber-300 rounded px-3 py-2">JEDA MEDICINE</button><button id="review" class="text-[10px] border border-cyan-700 text-cyan-300 rounded px-3 py-2">MINTA REVIEW</button><button id="reject" class="text-[10px] border border-rose-800 text-rose-300 rounded px-3 py-2">TOLAK TREATMENT</button></div></div>
  <div class="mt-3 text-[10px] text-slate-500">Status kontrol: <span id="humanStatus" class="text-emerald-400">Medicine berjalan dengan pengawasan manusia.</span></div>
</section>

<section class="panel p-4"><div class="flex justify-between"><h2 class="text-xs uppercase text-slate-400">📡 Live Medical Event Stream</h2><span id="eventN" class="text-[10px] text-slate-500">0 event</span></div><div id="events" class="mt-3 h-48 overflow-y-auto bg-slate-950 rounded-xl p-3 space-y-2"></div></section>
<section class="panel p-4"><h2 class="text-xs uppercase text-slate-400">🧾 Medical Case History</h2><div id="history" class="mt-3 grid md:grid-cols-2 xl:grid-cols-3 gap-2"></div></section>
</main>

<script type="module">
import './bcgo-medicine.js?v=3.3.1';
const $=id=>document.getElementById(id);
const setText=(id,v)=>{const e=$(id);if(e)e.textContent=String(v??'');};
const setHTML=(id,v)=>{const e=$(id);if(e)e.innerHTML=String(v??'');};
const esc=v=>String(v??'-').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
let ev=[];
const seenChat=new Set();
function event(t,d){ev.unshift({t,d,at:new Date().toLocaleTimeString('id-ID')});ev=ev.slice(0,100);setText('eventN',ev.length+' event');setHTML('events',ev.map(x=>`<div class="border-b border-slate-800 pb-1"><span class="code text-[9px] text-indigo-300">${esc(x.t)}</span> <span class="text-[9px] text-slate-600">${esc(x.at)}</span><div class="text-[10px] text-slate-400">${esc(x.d?.message||x.d?.text||x.d?.case?.diagnosis?.title||x.d?.case?.id||'event')}</div></div>`).join(''));}
function chat(role,t,key=''){if(key&&seenChat.has(key))return;if(key)seenChat.add(key);const host=$('chat');if(!host)return;const d=document.createElement('div');d.className=role==='human'?'text-right':'text-left';const tone=role==='human'?'bg-indigo-950':role==='bcgo'?'bg-cyan-950/40':'bg-emerald-950/40';d.innerHTML=`<div class="inline-block max-w-[92%] rounded-xl px-3 py-2 text-xs ${tone}"><div class="text-[9px] opacity-60">${role==='human'?'ANDA':role==='bcgo'?'BCGO':'MEDICINE'}</div><div class="pre">${esc(t)}</div></div>`;host.appendChild(d);host.scrollTop=host.scrollHeight;}

function copyMedicineCode(value, button){
  const s=String(value??'');
  if(!s)return;
  const done=()=>{if(button){const old=button.textContent;button.textContent='✓ COPIED';setTimeout(()=>button.textContent=old,1400);}};
  if(navigator.clipboard?.writeText) navigator.clipboard.writeText(s).then(done).catch(()=>{
    const ta=document.createElement('textarea');ta.value=s;document.body.appendChild(ta);ta.select();
    try{document.execCommand('copy');}catch(e){}ta.remove();done();
  });
}

function renderCodePrescription(plan){
  const el=$('codePrescription'); if(!el)return;
  const cp=plan?.codePrescription || window.BCGOMedicine?.buildCodePrescription?.(plan);
  if(!cp){el.innerHTML='';return;}
  const ready=cp.ready===true;
  const items=cp.items||[];
  el.innerHTML=`
    <div class="border ${ready?'border-emerald-900':'border-amber-900'} rounded-xl overflow-hidden">
      <div class="px-3 py-3 bg-slate-950/70 flex flex-wrap justify-between gap-2">
        <div><div class="text-[10px] uppercase text-slate-400">💊 CODE PRESCRIPTION</div>
        <div class="${ready?'text-emerald-300':'text-amber-300'} text-xs">${esc(cp.status)}</div></div>
        <div class="flex items-center gap-2"><div class="code text-[9px] text-slate-500">${esc(cp.targetFile||'-')}</div>${items.length?'<button id="copyFullPatch" class="text-[9px] border border-cyan-800 text-cyan-300 rounded px-2 py-1">📋 COPY FULL PATCH</button>':''}</div>
      </div>
      <div class="px-3 py-2 text-[10px] text-slate-400 border-t border-slate-800">${esc(cp.instruction||'')}</div>
      <div class="px-3 py-2 text-[9px] text-slate-500 border-t border-slate-800">Evidence: <b class="text-cyan-300">${esc(cp.evidenceCount||0)}</b> • Root cause: <b class="text-amber-300">${esc(cp.rootCauseStatus||'UNPROVEN')}</b></div>
      ${items.length?items.map((x,i)=>`
        <div class="border-t border-slate-800">
          <div class="px-3 py-2 bg-slate-900 flex flex-wrap justify-between gap-2 text-[9px]">
            <span class="code text-cyan-300">${esc(x.file||'-')}${x.line!=null?' • line '+esc(x.line):''}</span>
            <span class="${x.evidenceStrength==='HIGH'?'text-emerald-300':'text-amber-300'}">EVIDENCE ${esc(x.evidenceStrength)}</span>
            <span class="text-slate-500">RISK ${esc(x.risk)}</span>
          </div>
          <div class="grid lg:grid-cols-2">
            <div class="p-3 bg-rose-950/20">
              <div class="flex justify-between items-center mb-2"><b class="text-[9px] text-rose-300">🔴 KODE ASLI / BERMASALAH</b>
              <button class="copy-pres text-[9px] border border-rose-800 text-rose-300 rounded px-2 py-1" data-i="${i}" data-k="before">COPY</button></div>
              <pre class="pre code text-[9px] text-slate-300">${esc(x.before)}</pre>
            </div>
            <div class="p-3 bg-emerald-950/20">
              <div class="flex justify-between items-center mb-2"><b class="text-[9px] text-emerald-300">🟢 KODE SOLUSI</b>
              <button class="copy-pres text-[9px] border border-emerald-800 text-emerald-300 rounded px-2 py-1" data-i="${i}" data-k="after">📋 COPY SOLUSI</button></div>
              <pre class="pre code text-[9px] text-slate-200">${esc(x.after)}</pre>
            </div>
          </div>
          <div class="px-3 py-3 text-[10px] text-slate-400"><b class="text-cyan-300">WHY:</b> ${esc(x.reason||'-')}</div>
        </div>`).join(''):'<div class="p-3 text-xs text-amber-300">Belum ada operasi exact yang aman.</div>'}
    </div>`;
  el.querySelectorAll('.copy-pres').forEach(b=>b.onclick=()=>{
    const x=items[Number(b.dataset.i)]; if(x)copyMedicineCode(b.dataset.k==='after'?x.after:x.before,b);
  });
  const full=el.querySelector('#copyFullPatch');
  if(full) full.onclick=()=>{
    const patch=items.map((x)=>`// ${x.file||'-'}\n// BEFORE\n${x.before}\n// AFTER\n${x.after}`).join('\n\n');
    copyMedicineCode(patch,full);
  };
}

window.addEventListener('bcgo:medicine', e => {
  const d = e.detail;
  if (!d) return;
  event(d.event, d);
  const st = window.BCGOMedicine?.getState?.();
  if (!st) return;

  setText('org', Object.keys(st.registry || {}).length);
  setText('logs', (st.logs || []).length);
  setText('casesN', (st.cases || []).length);
  setText('active', (st.cases || []).filter(c => !['RECOVERED', 'REJECTED', 'FIXED_VERIFIED'].includes(c.status)).length);
  setText('findN', (st.findings || []).length);
  setText('repairs', (st.patchProposals || []).filter(p => p.status === 'APPLIED' || p.status === 'VERIFIED_FIXED').length);

  const authUser = st.human?.uid;
  setText('auth', authUser ? 'AUTH OK' : 'NO AUTH');
  setText('sys', st.bcgoSynced ? 'BCGO SYNCED' : 'STANDALONE');
  setText('executor', window.BCGOPatchExecutor?.apply ? 'EXECUTOR READY' : 'NO EXECUTOR');

  if (st.messages) {
    st.messages.forEach(m => chat(m.role, m.text, m.clientMessageId || m.id));
  }

  const active = (st.cases || []).find(c => !['RECOVERED', 'REJECTED', 'FIXED_VERIFIED'].includes(c.status)) || st.cases?.[0];
  if (active) {
    setHTML('diag', `<div class="space-y-1"><div><b>${esc(active.source)}</b></div><div class="text-rose-400">${esc(active.diagnosis?.title)}</div><div class="text-[10px] text-slate-500">Status: ${esc(active.status)}</div></div>`);
    renderCodePrescription(active.repairPlan);
    const canApprove = active.status === 'VERIFIED_DIAGNOSIS';
    const canApply = active.status === 'READY_FOR_PATCH';
    const canValidate = active.status === 'PATCH_APPLIED' || active.repairPlan;
    if($('approve')) $('approve').className = canApprove ? 'w-full bg-emerald-700 rounded-lg py-2 text-xs' : 'hidden';
    if($('apply')) $('apply').className = canApply ? 'w-full bg-indigo-700 rounded-lg py-2 text-xs' : 'hidden';
    if($('validate')) $('validate').className = canValidate ? 'w-full border border-cyan-800 text-cyan-300 rounded-lg py-2 text-xs' : 'hidden';
  } else {
    setHTML('diag', '<div class="text-xs text-slate-400">Belum ada case aktif.</div>');
    renderCodePrescription(null);
    if($('approve')) $('approve').className = 'hidden';
    if($('apply')) $('apply').className = 'hidden';
    if($('validate')) $('validate').className = 'hidden';
  }
});

const form = $('form');
if (form) form.onsubmit = async e => {
  e.preventDefault();
  const input = $('input');
  if (!input) return;
  const v = input.value.trim();
  if (!v) return;
  input.value = '';
  chat('human', v);
  try { await window.BCGOMedicine?.sendMessage?.(v, 'human'); } catch (err) { event('send_error', { message: err.message }); }
};

if($('scan')) $('scan').onclick = () => window.BCGOMedicine?.scanConsistency?.();
if($('approve')) $('approve').onclick = () => { const a = window.BCGOMedicine?.activeCase; if(a) window.BCGOMedicine.approveTreatment(a.id); };
if($('apply')) $('apply').onclick = () => { const a = window.BCGOMedicine?.activeCase; if(a) window.BCGOMedicine.applyPatch(a.id); };
if($('validate')) $('validate').onclick = () => { const a = window.BCGOMedicine?.activeCase; if(a) window.BCGOMedicine.validateAfterPatch(a.id); };
if($('pause')) $('pause').onclick = () => { const p = window.BCGOMedicine?.getState?.().human?.paused; window.BCGOMedicine?.setHumanMode?.(!p); };
</script>
</body>
</html>
