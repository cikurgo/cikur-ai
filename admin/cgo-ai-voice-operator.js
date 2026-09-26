/*
 * CGO OPERATOR VOICE v3.0 — structured · quiet live · airport PA style
 * No stage spam on live cycles. Status-change only for VALID/WARNING/ERROR.
 */
(function () {
  'use strict';
  const VERSION = '3.0.0-STRUCTURED-QUIET';
  const BUILD = 'CIKUR-GO-OPERATOR-3.0.0';
  const ROOTS = ['./audio/cgo-operator/', './'];
  const EVENTS = Object.freeze({
    SYSTEM_BOOT:'SYSTEM_BOOT', SYSTEM_READY:'SYSTEM_READY',
    COMMAND_ACCEPTED:'COMMAND_ACCEPTED', COMMAND_DUPLICATE:'COMMAND_DUPLICATE',
    PROCESSING:'PROCESSING', PROCESSING_WAIT:'PROCESSING_WAIT',
    ABC_STAGE_A:'ABC_STAGE_A', ABC_STAGE_B:'ABC_STAGE_B',
    ABC_STAGE_C:'ABC_STAGE_C', ABC_STAGE_D:'ABC_STAGE_D',
    LIVE_INPUT:'LIVE_INPUT', STANDBY:'STANDBY', VALID:'VALID',
    WARNING:'WARNING', ERROR:'ERROR', RECOVERY:'RECOVERY',
    RESET:'RESET', ABORT:'ABORT', SYSTEM_IDLE:'SYSTEM_IDLE'
  });
  const TEXT = Object.freeze({
    SYSTEM_BOOT:'Perhatian. Sistem CIKUR GO dinyalakan.',
    SYSTEM_READY:'Sistem siap. Operator siap.',
    COMMAND_ACCEPTED:'Perintah diterima.',
    COMMAND_DUPLICATE:'Perintah sama. Dilewati.',
    PROCESSING:'Memproses.',
    PROCESSING_WAIT:'Masih memproses. Mohon tunggu.',
    ABC_STAGE_A:'Tahap representasi.',
    ABC_STAGE_B:'Tahap analisis.',
    ABC_STAGE_C:'Tahap hasil.',
    ABC_STAGE_D:'Tahap audit.',
    LIVE_INPUT:'Mode siaran langsung aktif.',
    STANDBY:'Sistem dalam mode siaga.',
    VALID:'Pemeriksaan selesai. Hasil valid.',
    WARNING:'Perhatian. Diperlukan pemeriksaan.',
    ERROR:'Kesalahan sistem.',
    RECOVERY:'Pemulihan berjalan.',
    RESET:'Sistem direset.',
    ABORT:'Proses dibatalkan.',
    SYSTEM_IDLE:'Sistem menganggur.'
  });
  const MP3 = Object.freeze({
    SYSTEM_BOOT:'welcome.mp3', SYSTEM_READY:'welcome.mp3',
    COMMAND_ACCEPTED:'live.mp3', COMMAND_DUPLICATE:'standby.mp3',
    PROCESSING:'processing.mp3', PROCESSING_WAIT:'processing.mp3',
    ABC_STAGE_A:'stageA.mp3', ABC_STAGE_B:'stageB.mp3',
    ABC_STAGE_C:'stageC.mp3', ABC_STAGE_D:'stageD.mp3',
    LIVE_INPUT:'live.mp3', STANDBY:'standby.mp3', VALID:'valid.mp3',
    WARNING:'warning.mp3', ERROR:'error.mp3', RECOVERY:'valid.mp3',
    RESET:'standby.mp3', ABORT:'error.mp3', SYSTEM_IDLE:'standby.mp3'
  });
  const COOLDOWN = Object.freeze({
    SYSTEM_BOOT:60000, SYSTEM_READY:60000, COMMAND_ACCEPTED:8000,
    COMMAND_DUPLICATE:15000, PROCESSING:12000, PROCESSING_WAIT:20000,
    ABC_STAGE_A:45000, ABC_STAGE_B:45000, ABC_STAGE_C:45000, ABC_STAGE_D:45000,
    LIVE_INPUT:30000, STANDBY:25000, VALID:15000, WARNING:12000, ERROR:8000,
    RECOVERY:20000, RESET:10000, ABORT:8000, SYSTEM_IDLE:40000
  });
  const PRIORITY = Object.freeze({
    ERROR:100, ABORT:95, WARNING:80, VALID:70, RECOVERY:65, LIVE_INPUT:60,
    SYSTEM_READY:55, SYSTEM_BOOT:50, COMMAND_ACCEPTED:40, PROCESSING:30,
    PROCESSING_WAIT:25, ABC_STAGE_D:20, ABC_STAGE_C:18, ABC_STAGE_B:16,
    ABC_STAGE_A:14, COMMAND_DUPLICATE:10, RESET:10, STANDBY:8, SYSTEM_IDLE:5
  });
  let unlocked=false, busy=false, enabled=true, quietLive=true, selectedVoice=null;
  let lastEvent='', lastSpokenAt=0, lastStatusSpoken='';
  const lastPlayed=new Map(), queue=[], audioCache=new Map();
  const MIN_GAP_MS=4500;

  function isIdVoice(v){const l=String(v.lang||'').toLowerCase();return l.startsWith('id')||l.includes('indonesia');}
  function rankVoice(v){
    const n=(v.name+' '+(v.voiceURI||'')).toLowerCase(); let s=0;
    if(/female|woman|girl|zira|samantha|ava|aria|jenny|susan|linda|karen/i.test(n)) s+=40;
    if(/google|microsoft|natural|neural|premium|enhanced/i.test(n)) s+=30;
    if(/id-id|indonesia/i.test(n)) s+=15;
    if(/male|man|boy|david|mark/i.test(n)&&!/female/i.test(n)) s-=50;
    return s;
  }
  function refreshVoices(){
    if(!('speechSynthesis' in window)) return false;
    const voices=window.speechSynthesis.getVoices()||[];
    if(!voices.length) return false;
    const id=voices.filter(isIdVoice).sort((a,b)=>rankVoice(b)-rankVoice(a));
    selectedVoice=id[0]||null;
    return !!selectedVoice;
  }
  if('speechSynthesis' in window){refreshVoices();window.speechSynthesis.onvoiceschanged=refreshVoices;}

  function canPlay(key, force){
    if(!enabled||!TEXT[key]) return false;
    if(force) return true;
    const now=Date.now();
    if(now-lastSpokenAt<MIN_GAP_MS) return false;
    const cd=COOLDOWN[key]??10000;
    return now-(lastPlayed.get(key)||0)>=cd;
  }
  function loadAudio(key){
    const file=MP3[key]; if(!file) return null;
    if(audioCache.has(key)) return audioCache.get(key);
    const a=new Audio(); a.preload='auto';
    const urls=ROOTS.map(r=>r+file); a.src=urls[0]; let i=0;
    a.addEventListener('error',()=>{i+=1;if(i<urls.length){a.src=urls[i];a.load();}});
    audioCache.set(key,a); return a;
  }
  function speakTts(key){
    return new Promise(resolve=>{
      if(!('speechSynthesis' in window)||!TEXT[key]) return resolve(false);
      refreshVoices();
      try{window.speechSynthesis.cancel();}catch(_){}
      const u=new SpeechSynthesisUtterance(TEXT[key]);
      u.lang=(selectedVoice&&selectedVoice.lang)||'id-ID';
      if(selectedVoice) u.voice=selectedVoice;
      u.rate=0.84; u.pitch=1.02; u.volume=1.0;
      let done=false;
      const fin=ok=>{if(!done){done=true;resolve(!!ok);}};
      u.onend=()=>fin(true); u.onerror=()=>fin(false);
      try{
        window.speechSynthesis.speak(u);
        setTimeout(()=>fin(true), Math.min(10000, 600+TEXT[key].length*70));
      }catch(_){fin(false);}
    });
  }
  function playMp3(key){
    return new Promise(resolve=>{
      const a=loadAudio(key); if(!a) return resolve(false);
      try{
        a.pause(); a.currentTime=0;
        const p=a.play();
        if(p&&p.then){
          p.then(()=>{
            a.addEventListener('ended',()=>resolve(true),{once:true});
            a.addEventListener('error',()=>resolve(false),{once:true});
            setTimeout(()=>resolve(true),7000);
          }).catch(()=>resolve(false));
        } else resolve(true);
      }catch(_){resolve(false);}
    });
  }
  async function drain(){
    if(busy||!unlocked||!queue.length) return;
    busy=true;
    queue.sort((a,b)=>(PRIORITY[b]||0)-(PRIORITY[a]||0));
    const key=queue.shift();
    while(queue.length>3) queue.pop();
    try{
      if(canPlay(key,false)||key!==lastEvent){
        if(canPlay(key,true)||canPlay(key,false)){
          lastPlayed.set(key,Date.now()); lastSpokenAt=Date.now(); lastEvent=key;
          let ok=await speakTts(key); if(!ok) await playMp3(key);
        }
      }
    }catch(_){}
    finally{busy=false; if(queue.length) setTimeout(drain,80);}
  }
  function unlock(){
    if(unlocked) return; unlocked=true;
    try{
      if('speechSynthesis' in window){
        const w=new SpeechSynthesisUtterance(' '); w.volume=0;
        window.speechSynthesis.speak(w); window.speechSynthesis.cancel();
      }
    }catch(_){}
    drain();
  }
  ['pointerdown','touchstart','keydown','click'].forEach(t=>window.addEventListener(t,unlock,{passive:true}));

  function emit(key, options){
    options=options||{};
    const force=!!options.force;
    if(!TEXT[key]) return false;
    if(!canPlay(key,force)) return false;
    if(queue[queue.length-1]===key) return false;
    queue.push(key);
    if(queue.length>6){queue.sort((a,b)=>(PRIORITY[b]||0)-(PRIORITY[a]||0)); queue.length=6;}
    drain(); return true;
  }

  function state(name, detail){
    detail=detail||{};
    const s=String(name||'').toUpperCase();
    if(!s) return false;
    if(quietLive&&!detail.force){
      if(s===lastStatusSpoken&&['VALID','WELL_FORMED','PROCESSED','PARTIAL','WARNING','DEGRADED','ERROR','FAILED','LIVE','STANDBY'].includes(s))
        return false;
    }
    if(s==='BOOT'||s==='SYSTEM_BOOT') return emit(EVENTS.SYSTEM_BOOT, detail);
    if(s==='READY'||s==='SYSTEM_READY') return emit(EVENTS.SYSTEM_READY, detail);
    if(s==='COMMAND_ACCEPTED'||s==='ACCEPTED') return emit(EVENTS.COMMAND_ACCEPTED, detail);
    if(s==='COMMAND_DUPLICATE'||s==='DUPLICATE'||s==='DEDUP') return emit(EVENTS.COMMAND_DUPLICATE, detail);
    if(s==='PROCESSING'||s==='RUNNING') return emit(EVENTS.PROCESSING, detail);
    if(s==='PROCESSING_WAIT'||s==='WAIT') return emit(EVENTS.PROCESSING_WAIT, detail);
    if(s==='LIVE'||s==='LIVE_INPUT'){lastStatusSpoken=s; return emit(EVENTS.LIVE_INPUT, detail);}
    if(s==='STANDBY'||s==='IDLE'){lastStatusSpoken=s; return emit(EVENTS.STANDBY, detail);}
    if(s==='VALID'||s==='COMPLETE'||s==='DONE'||s==='WELL_FORMED'||s==='PROCESSED'){lastStatusSpoken='VALID'; return emit(EVENTS.VALID, detail);}
    if(s==='WARNING'||s==='DEGRADED'||s==='PARTIAL'){
      if(s==='PARTIAL'&&quietLive&&lastStatusSpoken==='PARTIAL'&&!detail.force) return false;
      lastStatusSpoken=s==='PARTIAL'?'PARTIAL':'WARNING';
      return emit(EVENTS.WARNING, detail);
    }
    if(s==='ERROR'||s==='FAILED'){lastStatusSpoken='ERROR'; return emit(EVENTS.ERROR, detail);}
    if(s==='RECOVERY') return emit(EVENTS.RECOVERY, detail);
    if(s==='RESET') return emit(EVENTS.RESET, detail);
    if(s==='ABORT') return emit(EVENTS.ABORT, detail);
    if(s==='SYSTEM_IDLE') return emit(EVENTS.SYSTEM_IDLE, detail);
    return false;
  }

  function announcePipelineStage(stage, started, result, options){
    options=options||{};
    if(!(options.announceStages===true||options.force===true)) return false;
    if(!started){
      if(String(stage).toUpperCase()==='D'){
        const audit=String(result&&result.audit||'').toUpperCase();
        return audit==='VALID'?emit(EVENTS.VALID,{force:true}):emit(EVENTS.WARNING,{force:true});
      }
      return false;
    }
    const st=String(stage||'').toUpperCase();
    if(st==='A') return emit(EVENTS.ABC_STAGE_A, options);
    if(st==='B') return emit(EVENTS.ABC_STAGE_B, options);
    if(st==='C') return emit(EVENTS.ABC_STAGE_C, options);
    if(st==='D') return emit(EVENTS.ABC_STAGE_D, options);
    return emit(EVENTS.PROCESSING, options);
  }

  function welcome(){
    emit(EVENTS.SYSTEM_BOOT,{force:true});
    setTimeout(()=>emit(EVENTS.SYSTEM_READY),1600);
    return true;
  }

  window.CGOOperatorVoice=Object.freeze({
    version:VERSION, build:BUILD, EVENTS, emit,
    play:(key,opt)=>emit(String(key).toUpperCase().replace(/-/g,'_'), opt),
    welcome, state, announcePipelineStage, unlock,
    setQuietLive(v){quietLive=!!v;}, setEnabled(v){enabled=!!v; if(!enabled) queue.length=0;},
    get unlocked(){return unlocked;}, get enabled(){return enabled;}, get quietLive(){return quietLive;},
    get voice(){return selectedVoice&&selectedVoice.name||null;},
    get voiceLanguage(){return selectedVoice&&selectedVoice.lang||null;},
    get femaleVoiceReady(){return !!selectedVoice;}
  });
  document.addEventListener('DOMContentLoaded',()=>{setTimeout(()=>{if(unlocked) welcome();},900);},{once:true});
})();
