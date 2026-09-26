/* ============================================================
 * CIKUR GO — Customer CGO App Bootstrap
 * Navigation + Discovery runtime (mata Otak CGO)
 * ============================================================ */
(function (window) {
  "use strict";

  const FRESH_MS = 3 * 60 * 1000; // presence GPS dianggap fresh 3 menit
  const DEFAULT_RADIUS_KM = 50;

  function safeOpen(url) {
    try {
      window.location.href = url;
      return { success: true, url: url };
    } catch (e) {
      return { success: false, reason: String(e && e.message || e) };
    }
  }

  function haversineKm(a, b) {
    if (!a || !b) return null;
    if (![a.lat, a.lng, b.lat, b.lng].every(Number.isFinite)) return null;
    const R = 6371;
    const p1 = a.lat * Math.PI / 180;
    const p2 = b.lat * Math.PI / 180;
    const dlat = (b.lat - a.lat) * Math.PI / 180;
    const dlng = (b.lng - a.lng) * Math.PI / 180;
    const h = Math.sin(dlat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dlng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  let customerLocation = null;
  let customerLocationSource = "NONE";

  function ensureCustomerLocation() {
    return new Promise((resolve) => {
      if (customerLocation && customerLocationSource === "GPS") {
        resolve(customerLocation);
        return;
      }
      if (!navigator.geolocation) {
        customerLocationSource = "UNAVAILABLE";
        resolve(null);
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const lat = Number(pos.coords.latitude);
          const lng = Number(pos.coords.longitude);
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            customerLocation = { lat, lng, accuracy: pos.coords.accuracy };
            customerLocationSource = "GPS";
          }
          resolve(customerLocation);
        },
        () => {
          customerLocationSource = "DENIED";
          resolve(null);
        },
        { maximumAge: 120000, timeout: 8000, enableHighAccuracy: true }
      );
    });
  }

  function connectNavigation() {
    if (!window.CGO || typeof window.CGO.connectNavigation !== "function") return;
    window.CGO.connectNavigation({
      openService: function (service) {
        const id = (service && (service.id || (service.handoff && service.handoff.target))) || "";
        const map = {
          food: "./customer/food.html",
          ride: "./customer/ride.html",
          assistant: "./customer/assistant.html",
          cikurgo2in1: "./customer/cikurgo2in1.html"
        };
        const url = map[String(id).toLowerCase()];
        if (!url) return { success: false, reason: "UNKNOWN_SERVICE", service: service };
        return safeOpen(url);
      }
    });
  }

  /**
   * Discovery adapter = "mata" Otak CGO.
   * Membaca Firestore via CikurCloud (tidak mengarang).
   */
  function connectDiscovery() {
    if (!window.CGO || typeof window.CGO.connectDiscovery !== "function") return;
    if (!window.CGO_CUSTOMER || !window.CGO_CUSTOMER.discovery) return;

    async function runCheck(request) {
      const req = request && typeof request === "object" ? request : {};
      const requestId = req.requestId || ("disc-" + Date.now());
      const types = Array.isArray(req.types) ? req.types.map((t) => String(t).toLowerCase()) : [];
      const serviceId = String(req.serviceId || req.service || "").toLowerCase();
      const wantsAgent =
        !types.length ||
        types.some((t) => t === "agent" || t === "mitra") ||
        serviceId === "assistant" ||
        serviceId === "cikurgo2in1" ||
        /agent|asisten|assistant|dekat|nearby|tersedia/i.test(String(req.query || ""));
      const wantsFood =
        types.some((t) => t === "restaurant" || t === "mitra") ||
        serviceId === "food" ||
        serviceId === "cikurgo2in1" ||
        /makan|food|resto|lapar/i.test(String(req.query || ""));

      const origin =
        (req.location && Number.isFinite(req.location.lat) && req.location) ||
        (await ensureCustomerLocation());

      const radiusKm = Number(req.radiusKm) > 0 ? Number(req.radiusKm) : DEFAULT_RADIUS_KM;
      const cloud = window.CikurCloud;
      const items = [];
      const evidence = { sources: [], origin: origin || null, radiusKm };

      try {
        if (wantsAgent && cloud && typeof cloud.listOnlineAgentsOnce === "function") {
          const agents = await cloud.listOnlineAgentsOnce();
          evidence.sources.push("mitra_applications");
          for (const a of agents) {
            let distanceKm = null;
            if (origin && a.location) distanceKm = haversineKm(origin, a.location);
            const fresh =
              a.location &&
              (a.ageMs == null || a.ageMs <= FRESH_MS);
            // Tanpa lokasi customer: tetap laporkan agent online (tanpa ranking km)
            const inRange = distanceKm == null ? true : distanceKm <= radiusKm;
            if (!inRange) continue;
            items.push({
              id: a.id,
              agentId: a.agentId,
              name: a.name,
              type: "agent",
              status: fresh && a.location ? (a.available === false ? "BUSY" : "READY") : a.location ? "STALE" : "STANDBY",
              distanceKm: distanceKm != null ? Number(distanceKm.toFixed(2)) : null,
              location: a.location,
              presenceVerified: Boolean(fresh && a.location)
            });
          }
        }
      } catch (err) {
        evidence.agentError = String(err && err.message || err).slice(0, 180);
      }

      try {
        if (wantsFood && cloud && typeof cloud.listApprovedRestosOnce === "function") {
          const restos = await cloud.listApprovedRestosOnce();
          evidence.sources.push("resto_profiles");
          evidence.restoCount = restos.length;
          // Resto: cukup hitung yang approved (detail menu di food.html)
          if (restos.length && !items.some((i) => i.type === "restaurant")) {
            items.push({
              id: "resto-summary",
              type: "restaurant",
              name: "Resto approved CIKUR GO",
              count: restos.length,
              status: "AVAILABLE",
              presenceVerified: true
            });
          }
        }
      } catch (err) {
        evidence.restoError = String(err && err.message || err).slice(0, 180);
      }

      items.sort((a, b) => {
        if (a.distanceKm == null && b.distanceKm == null) return 0;
        if (a.distanceKm == null) return 1;
        if (b.distanceKm == null) return -1;
        return a.distanceKm - b.distanceKm;
      });

      const readyAgents = items.filter((i) => i.type === "agent" && i.status === "READY");
      const anyVerified = items.some((i) => i.presenceVerified);

      if (!evidence.sources.length && (evidence.agentError || evidence.restoError)) {
        return {
          ok: false,
          status: "error",
          verified: false,
          source: "cikur-cloud",
          requestId,
          message: "Sensor runtime belum bisa dibaca (izin/koneksi). Tidak mengklaim ketersediaan.",
          items: [],
          count: 0,
          evidence,
          metadata: { customerLocationSource }
        };
      }

      if (anyVerified && (readyAgents.length > 0 || evidence.restoCount > 0)) {
        const parts = [];
        if (readyAgents.length) {
          const nearest = readyAgents[0];
          parts.push(
            nearest.distanceKm != null
              ? readyAgents.length + " Agent READY (terdekat ~" + nearest.distanceKm + " km)"
              : readyAgents.length + " Agent READY online"
          );
        }
        if (evidence.restoCount > 0) {
          parts.push(evidence.restoCount + " resto approved");
        }
        return {
          ok: true,
          status: "available",
          verified: true,
          source: "cikur-cloud",
          requestId,
          message: parts.join("; "),
          items,
          count: items.length,
          data: {
            readyAgentCount: readyAgents.length,
            restoCount: evidence.restoCount || 0,
            nearestAgentKm: readyAgents[0] && readyAgents[0].distanceKm != null ? readyAgents[0].distanceKm : null
          },
          evidence,
          metadata: { customerLocationSource, radiusKm }
        };
      }

      if (items.length && !anyVerified) {
        return {
          ok: true,
          status: "unknown",
          verified: false,
          source: "cikur-cloud",
          requestId,
          message: "Ada sinyal mitra, tetapi belum cukup bukti GPS fresh untuk diklaim tersedia.",
          items,
          count: items.length,
          evidence,
          metadata: { customerLocationSource }
        };
      }

      return {
        ok: true,
        status: "unavailable",
        verified: true,
        source: "cikur-cloud",
        requestId,
        message: "Belum ada Agent online ber-GPS fresh / resto approved yang cocok dengan permintaan saat ini.",
        items: [],
        count: 0,
        evidence,
        metadata: { customerLocationSource, radiusKm }
      };
    }

    window.CGO.connectDiscovery({
      check: function (request) {
        // Sync path: jangan block UI — UNKNOWN + minta async
        return {
          ok: true,
          status: "unknown",
          verified: false,
          source: "bootstrap-sync",
          requestId: request && request.requestId,
          message: "Pemeriksaan live membutuhkan jalur async.",
          items: [],
          count: 0
        };
      },
      checkAsync: function (request) {
        return runCheck(request);
      },
      findNearby: function (request) {
        return runCheck(request);
      }
    });
  }

  function installAbcObservability() {
    if (window.__CGO_ABC_OBSERVABILITY_INSTALLED) return;
    const engine = window.CGOMachineABC;
    if (!engine || typeof engine.observeTelemetry !== "function") return;
    window.__CGO_ABC_OBSERVABILITY_INSTALLED = true;

    const style = document.createElement("style");
    style.textContent = `
      #cgo-abc-neural-hud{position:fixed;right:12px;bottom:12px;z-index:2147483000;width:min(330px,calc(100vw - 24px));font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:#d9f7ff;background:rgba(3,12,23,.94);border:1px solid rgba(43,190,255,.28);border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.35),0 0 28px rgba(0,180,255,.08);backdrop-filter:blur(12px);overflow:hidden;transform:translateY(0);transition:opacity .2s,transform .2s}
      #cgo-abc-neural-hud[data-state="hidden"]{opacity:.5;transform:translateY(calc(100% - 34px))}
      #cgo-abc-neural-hud .cgo-nh-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid rgba(43,190,255,.16);cursor:pointer}
      #cgo-abc-neural-hud .cgo-nh-pulse{width:8px;height:8px;border-radius:50%;background:#334155;box-shadow:none}
      #cgo-abc-neural-hud[data-running="1"] .cgo-nh-pulse{background:#22d3ee;box-shadow:0 0 12px #22d3ee;animation:cgoAbcPulse .65s ease-in-out infinite}
      #cgo-abc-neural-hud[data-running="0"] .cgo-nh-pulse{background:#16d98b;box-shadow:0 0 8px #16d98b}
      #cgo-abc-neural-hud[data-error="1"] .cgo-nh-pulse{background:#fb7185;box-shadow:0 0 10px #fb7185}
      #cgo-abc-neural-hud .cgo-nh-title{font-weight:800;letter-spacing:.08em;color:#b9efff}
      #cgo-abc-neural-hud .cgo-nh-status{margin-left:auto;color:#7dd3fc;font-size:10px}
      #cgo-abc-neural-hud .cgo-nh-body{padding:9px 10px}
      #cgo-abc-neural-hud .cgo-nh-route{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
      #cgo-abc-neural-hud .cgo-nh-node{padding:7px 5px;text-align:center;border:1px solid rgba(71,85,105,.5);border-radius:9px;color:#64748b;background:#06111e}
      #cgo-abc-neural-hud .cgo-nh-node[data-state="active"]{color:#fde68a;border-color:#8b6b18;background:#201b08;box-shadow:0 0 12px rgba(250,204,21,.14)}
      #cgo-abc-neural-hud .cgo-nh-node[data-state="done"]{color:#86efac;border-color:#176a50;background:#062a1c}
      #cgo-abc-neural-hud .cgo-nh-node[data-state="bad"]{color:#fda4af;border-color:#7f1d1d;background:#2b0a10}
      #cgo-abc-neural-hud .cgo-nh-meta{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-top:7px;color:#64748b;font-size:9px}
      #cgo-abc-neural-hud .cgo-nh-meta b{display:block;color:#cbd5e1;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #cgo-abc-neural-hud .cgo-nh-controls{display:flex;gap:5px;margin-top:8px}
      #cgo-abc-neural-hud button{flex:1;border:1px solid rgba(71,85,105,.55);border-radius:7px;background:#081521;color:#94a3b8;padding:5px 6px;font:9px ui-monospace,SFMono-Regular,Menlo,monospace}
      #cgo-abc-neural-hud button[data-on="1"]{color:#86efac;border-color:#176a50}
      @keyframes cgoAbcPulse{50%{transform:scale(1.45);opacity:.65}}
      @media(max-width:560px){#cgo-abc-neural-hud{right:8px;bottom:8px;width:calc(100vw - 16px)}}`;
    document.head.appendChild(style);

    const hud = document.createElement("section");
    hud.id = "cgo-abc-neural-hud";
    hud.setAttribute("aria-label", "CGO Mesin ABC neural telemetry");
    hud.dataset.running = "0";
    hud.innerHTML = `
      <div class="cgo-nh-head" id="cgoAbcHudHead">
        <span class="cgo-nh-pulse"></span><span class="cgo-nh-title">CGO NEURAL CORE</span><span class="cgo-nh-status" id="cgoAbcHudStatus">STANDBY</span>
      </div>
      <div class="cgo-nh-body">
        <div class="cgo-nh-route">
          <div class="cgo-nh-node" data-stage="A">A · REPRESENTASI</div>
          <div class="cgo-nh-node" data-stage="B">B · PROSES</div>
          <div class="cgo-nh-node" data-stage="C">C · HASIL</div>
          <div class="cgo-nh-node" data-stage="D">D · AUDIT</div>
        </div>
        <div class="cgo-nh-meta">
          <div>EVENT<b id="cgoAbcHudEvent">—</b></div><div>CYCLE<b id="cgoAbcHudCycle">—</b></div>
          <div>DURATION<b id="cgoAbcHudDuration">—</b></div><div>ROUTE<b id="cgoAbcHudRoute">A>B>C>D</b></div>
          <div>FINGERPRINT<b id="cgoAbcHudFp">—</b></div><div>ENGINE<b id="cgoAbcHudEngine">${String(engine.version || "unknown")}</b></div>
        </div>
        <div class="cgo-nh-controls"><button id="cgoAbcHudSound" type="button">🔇 SOUND OFF</button><button id="cgoAbcHudHaptic" type="button" data-on="1">📳 HAPTIC AUTO</button></div>
      </div>`;
    document.body.appendChild(hud);

    let sound=false,haptic=true,audio=null,master=null,audioReady=false,soundQueueUntil=0,ambientNodes=[],ambientState="normal",noiseBuffer=null;
    const AUDIO_GAIN=.46;
    const ensureAudio=async()=>{const AC=window.AudioContext||window.webkitAudioContext;if(!AC)throw new Error("Web Audio API tidak tersedia di browser ini");if(!audio){audio=new AC({latencyHint:"interactive"});master=audio.createGain();master.gain.value=AUDIO_GAIN;const comp=audio.createDynamicsCompressor();comp.threshold.value=-18;comp.knee.value=12;comp.ratio.value=8;comp.attack.value=.003;comp.release.value=.12;master.connect(comp);comp.connect(audio.destination);audio.onstatechange=()=>{if(sound&&audio.state==='running'){audioReady=true;startAmbient()}}}if(audio.state!=="running")await audio.resume();if(audio.state!=="running")throw new Error("AudioContext belum running");audioReady=true;return audio};
    const ambientProfile=s=>s==="error"?{a:110,b:220,c:440,p:.62,g:.12,h:.034}:s==="warn"?{a:132,b:264,c:528,p:1.25,g:.095,h:.027}:s==="processing"?{a:148,b:296,c:592,p:2.4,g:.072,h:.022}:{a:120,b:240,c:480,p:.88,g:.055,h:.018};
    const setAmbientState=s=>{ambientState=["error","warn","processing"].includes(s)?s:"normal";if(!audioReady||!audio||audio.state!=="running"||!ambientNodes.length)return;const q=ambientProfile(ambientState),now=audio.currentTime;try{ambientNodes[0].osc.frequency.setTargetAtTime(q.a,now,.12);ambientNodes[1].osc.frequency.setTargetAtTime(q.b,now,.12);ambientNodes[2].osc.frequency.setTargetAtTime(q.c,now,.12);ambientNodes[3].osc.frequency.setTargetAtTime(q.p,now,.18);ambientNodes[0].gain.gain.setTargetAtTime(q.g,now,.14);ambientNodes[1].gain.gain.setTargetAtTime(q.h,now,.14);ambientNodes[2].gain.gain.setTargetAtTime(q.h*.5,now,.14)}catch(_){} };
    const startAmbient=()=>{if(!audioReady||!audio||audio.state!=="running"||ambientNodes.length)return;const c=audio,q=ambientProfile(ambientState),bus=c.createBiquadFilter();bus.type="lowpass";bus.frequency.value=1250;bus.Q.value=.45;bus.connect(master);const mk=(f,g,t)=>{const o=c.createOscillator(),gn=c.createGain();o.type=t;o.frequency.value=f;gn.gain.value=g;o.connect(gn);gn.connect(bus);o.start();return{osc:o,gain:gn}};const x=mk(q.a,q.g,"sine"),y=mk(q.b,q.h,"triangle"),z=mk(q.c,q.h*.5,"sine"),l=c.createOscillator(),lg=c.createGain();l.frequency.value=q.p;lg.gain.value=q.g*.55;l.connect(lg);lg.connect(x.gain.gain);l.start();ambientNodes=[x,y,z,{osc:l,gain:lg}]};
    const stopAmbient=()=>{for(const n of ambientNodes){try{n.osc.stop()}catch(_){}}ambientNodes=[]};
    const noise=(ctx,when,duration,level,center=1900)=>{try{if(!noiseBuffer){const len=Math.floor(ctx.sampleRate*.18);noiseBuffer=ctx.createBuffer(1,len,ctx.sampleRate);const d=noiseBuffer.getChannelData(0);for(let i=0;i<d.length;i++)d[i]=(Math.random()*2-1)*.85}const src=ctx.createBufferSource(),bp=ctx.createBiquadFilter(),g=ctx.createGain();src.buffer=noiseBuffer;bp.type='bandpass';bp.frequency.value=center;bp.Q.value=2.2;g.gain.setValueAtTime(.0001,when);g.gain.exponentialRampToValueAtTime(level,when+.004);g.gain.exponentialRampToValueAtTime(.0001,when+duration);src.connect(bp);bp.connect(g);g.connect(master);src.start(when);src.stop(when+duration+.01)}catch(_){} };
    const scheduleVoice=(ctx,when,f,d,type="sine",level=.20,glide=null,pan=0)=>{const o=ctx.createOscillator(),g=ctx.createGain(),fl=ctx.createBiquadFilter(),p=ctx.createStereoPanner?ctx.createStereoPanner():null;o.type=type;o.frequency.setValueAtTime(f,when);if(glide)o.frequency.exponentialRampToValueAtTime(glide,when+d*.72);fl.type="lowpass";fl.frequency.value=Math.max(1200,f*4.5);g.gain.setValueAtTime(.0001,when);g.gain.exponentialRampToValueAtTime(level,when+.008);g.gain.exponentialRampToValueAtTime(Math.max(.0001,level*.34),when+d*.60);g.gain.exponentialRampToValueAtTime(.0001,when+d);o.connect(fl);fl.connect(g);if(p){p.pan.value=pan;g.connect(p);p.connect(master)}else g.connect(master);o.start(when);o.stop(when+d+.025)};
    const playNeuralSound=(kind="tick",force=false)=>{if(!sound||!audioReady||!audio||!master||audio.state!=="running")return false;try{const q={start:[110,.52,.26,"sine",220],A:[180,.30,.20,"sine",270],B:[240,.34,.20,"triangle",360],C:[320,.38,.20,"triangle",480],D:[430,.44,.22,"sine",650],done:[520,.68,.24,"sine",1040],ok:[300,.58,.21,"sine",900],warn:[180,.50,.21,"triangle",132],bad:[108,.72,.26,"sawtooth",68],tick:[210,.18,.12,"sine",315]}[kind]||[210,.18,.12,"sine",315];const when=Math.max(audio.currentTime+.012,soundQueueUntil);scheduleVoice(audio,when,q[0],q[1],q[3],q[2],q[4],-.10);scheduleVoice(audio,when+.022,q[0]*2,q[1]*.76,"sine",q[2]*.42,q[4]*1.28,.12);if(kind!=="bad")noise(audio,when,.055,.026,kind==="warn"?1200:kind==="done"?3000:1900);if(kind==="bad")noise(audio,when,.13,.055,650);soundQueueUntil=when+q[1]+(kind==="bad"||kind==="done"?.14:.06);return true}catch(_){return false}};
    const armSound=async()=>{try{await ensureAudio();sound=true;soundQueueUntil=0;startAmbient();setAmbientState("normal");playNeuralSound("start",true);const b=hud.querySelector("#cgoAbcHudSound");if(b){b.dataset.on="1";b.textContent="🔊 SYSTEM AUDIO · STANDBY"}return true}catch(e){sound=false;const b=hud.querySelector("#cgoAbcHudSound");if(b){b.dataset.on="0";b.textContent="🔇 AUDIO UNAVAILABLE"}console.warn("[CGO ABC AUDIO]",e);return false}};
    const disarmSound=()=>{sound=false;audioReady=false;soundQueueUntil=0;stopAmbient();try{audio?.suspend?.()}catch(_){}const b=hud.querySelector("#cgoAbcHudSound");if(b){b.dataset.on="0";b.textContent="🔇 SOUND OFF"}};
    const recoverAudio=async()=>{if(!sound||!audio)return false;try{if(audio.state!=="running")await audio.resume();if(audio.state==="running"){audioReady=true;startAmbient();setAmbientState(ambientState);return true}}catch(_){}return false};
    document.addEventListener("visibilitychange",()=>{if(!document.hidden)recoverAudio()});window.addEventListener("pageshow",()=>recoverAudio());
    const buzz = kind => { if(!haptic || typeof navigator.vibrate!=="function")return; try{navigator.vibrate(kind==='done'?[10,18,10]:kind==='bad'?[28,16,35]:9)}catch(_){ } };
    const render = ev => {
      if(!ev || ev.type!=="ABC_TELEMETRY")return;
      const stage=String(ev.stage||"");
      hud.dataset.running=ev.event==="PHASE_START"?"1":"0";
      hud.dataset.error=ev.status==="FAILED"?"1":"0";
      const status=hud.querySelector("#cgoAbcHudStatus");
      if(status) status.textContent=ev.event==="PHASE_START"?`${stage} ACTIVE`:`${stage||"SYSTEM"} ${ev.status||"DONE"}`;
      const event=hud.querySelector("#cgoAbcHudEvent");if(event)event.textContent=`${ev.event} · ${stage||"SYS"}`;
      const cycle=hud.querySelector("#cgoAbcHudCycle");if(cycle)cycle.textContent=String(ev.cycleIndex ?? "—");
      const dur=hud.querySelector("#cgoAbcHudDuration");if(dur)dur.textContent=ev.durationMs!=null?`${ev.durationMs} ms`:"running…";
      if(stage && node(stage)){
        ["A","B","C","D"].forEach(k=>{if(k!==stage && ev.event==="PHASE_START")setStage(k,"done")});
        setStage(stage,ev.event==="PHASE_START"?"active":ev.status==="FAILED"?"bad":"done");
        if(ev.event==="PHASE_START") { setAmbientState("normal"); playNeuralSound(stage||"tick"); }
        else if(ev.event==="PHASE_END" && ev.status==="FAILED") { setAmbientState("error"); playNeuralSound("bad", true); }
        else if(stage==="D" && ev.event==="PHASE_END") { const healthy=ev.audit==="VALID"; setAmbientState(healthy?"normal":"warn"); playNeuralSound(healthy?"done":"warn", true); }
        else if(ev.status==="DEGRADED" || ev.status==="PARTIAL") { setAmbientState("warn"); playNeuralSound("warn", true); }
        buzz(ev.status==="FAILED"?"bad":stage==="D"?"done":"tick");
      }
      try{window.dispatchEvent(new CustomEvent("cgo:abc-neural-telemetry",{detail:ev}))}catch(_){ }
    };
    const off=engine.observeTelemetry(render);
    window.addEventListener("beforeunload",()=>{try{off()}catch(_){ }try{stopAmbient()}catch(_){ }try{audio?.close?.()}catch(_){ }} ,{once:true});
    hud.querySelector("#cgoAbcHudHead").addEventListener("click",()=>{hud.dataset.state=hud.dataset.state==="hidden"?"visible":"hidden"});
    hud.querySelector("#cgoAbcHudSound").addEventListener("click",async()=>{if(sound){disarmSound();return;}await armSound();});
    hud.querySelector("#cgoAbcHudHaptic").addEventListener("click",()=>{haptic=!haptic;const b=hud.querySelector("#cgoAbcHudHaptic");b.dataset.on=haptic?"1":"0";b.textContent=haptic?"📳 HAPTIC AUTO":"📴 HAPTIC OFF"});

    try{
      const bus=new BroadcastChannel("CGO_MACHINE_ABC_TELEMETRY");
      bus.onmessage=e=>render(e.data);
      window.addEventListener("beforeunload",()=>bus.close(),{once:true});
    }catch(_){ }
    console.info("[CGO ABC OBSERVABILITY] live A→B→C→D telemetry connected");
  }

  function boot() {
    connectNavigation();
    connectDiscovery();
    // Pre-warm GPS (opsional, tidak memaksa)
    try { ensureCustomerLocation(); } catch (_) {}
    const ready = window.CGO && typeof window.CGO.isReady === "function" ? window.CGO.isReady() : false;
    const modules = window.CGO && typeof window.CGO.getModuleStatus === "function" ? window.CGO.getModuleStatus() : {};
    console.info("[CGO Bootstrap] ready=", ready, "modules=", modules, "discovery=live-cloud");
    try {
      try {
        const abcOk = !!(window.CGOAbcCognition?.isReady?.() || window.CGOMachineABC || window.CGOMachineABCBridge);
        if (modules && typeof modules === "object") {
          modules.machineAbc = abcOk;
          modules.abcCognition = !!(window.CGOAbcCognition);
        }
        if (abcOk) { console.log("[CGO BOOT] Mesin ABC + kognisi formal siap untuk Chat CGO"); installAbcObservability(); }
        else console.warn("[CGO BOOT] Mesin ABC tidak terdeteksi (chat tetap normal)");
      } catch (_abc) {}
      // Pre-warm semantic embedding (gratis, non-blocking) — bantu knowledge matching
      try {
        if (window.CGOSemantic && typeof window.CGOSemantic.ensureReady === "function") {
          window.CGOSemantic.ensureReady().then(function (ok) {
            if (ok && window.CGO_CUSTOMER && window.CGO_CUSTOMER.knowledge &&
                typeof window.CGO_CUSTOMER.knowledge.ensureSemanticIndex === "function") {
              return window.CGO_CUSTOMER.knowledge.ensureSemanticIndex();
            }
          }).then(function (idx) {
            if (idx && idx.ok) console.log("[CGO BOOT] Semantic index siap · docs", idx.indexed);
            else if (window.CGOSemantic && window.CGOSemantic.isReady()) console.log("[CGO BOOT] Semantic engine siap (index menyusul)");
          }).catch(function () {});
        }
      } catch (_sem) {}
      window.dispatchEvent(new CustomEvent("cgo-customer-ready", { detail: { ready, modules } }));
    } catch (_) {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(window);
