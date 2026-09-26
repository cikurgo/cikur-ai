/*
 * CGO AI VOICE OPERATOR — FEMALE AIRPORT-STYLE LOCAL VOICE
 * Local female system speech first; bundled local female-style MP3 fallback.
 * No external TTS/API/service. No male fallback.
 * Version: 2.1.0-FEMALE-AIRPORT-PRECISE
 */
(function () {
  'use strict';

  const ROOT = './audio/cgo-operator/';
  const BUILD = 'CIKUR-GO-VOICE-OPERATOR-2.1.0-FEMALE-AIRPORT-PRECISE';
  const FILES = Object.freeze({
    welcome:'welcome.mp3', live:'live.mp3', processing:'processing.mp3',
    valid:'valid.mp3', warning:'warning.mp3', error:'error.mp3', standby:'standby.mp3',
    stageA:'stageA.mp3', stageB:'stageB.mp3', stageC:'stageC.mp3', stageD:'stageD.mp3'
  });
  const TEXT = Object.freeze({
    welcome:'Selamat datang di sistem internal CIKUR GO.',
    live:'Input langsung diterima.',
    processing:'Pemrosesan dimulai.',
    valid:'Analisis selesai. Hasil tervalidasi.',
    warning:'Perhatian. Sistem memerlukan pemeriksaan.',
    error:'Terjadi kesalahan pada sistem.',
    standby:'Sistem kembali ke mode siaga.',
    stageA:'Mesin A menerima input.',
    stageB:'Analisis Mesin B dimulai.',
    stageC:'Hasil Mesin C disusun.',
    stageD:'Audit akhir sedang berjalan.'
  });
  const COOLDOWN = Object.freeze({welcome:12000,live:4500,processing:3500,valid:4500,warning:3500,error:3000,standby:7000,stageA:0,stageB:0,stageC:0,stageD:0});
  const queue=[]; const lastPlayed=new Map(); const audio=new Map();
  let unlocked=false,busy=false,pendingUnlock=false,welcomed=false,lastState='',lastStage='';
  let voicesReady=false, selectedVoice=null;

  function isFemaleVoice(v){
    const n=(v.name+' '+v.voiceURI).toLowerCase();
    const l=(v.lang||'').toLowerCase();
    if(!l.startsWith('id')) return false;
    return /(female|woman|girl|zira|samantha|ava|aria|jenny|susan|idf|female_\d)/i.test(n);
  }
  function refreshVoices(){
    if(!('speechSynthesis' in window)) return false;
    const voices=window.speechSynthesis.getVoices()||[];
    if(!voices.length) return false;
    const female=voices.filter(isFemaleVoice);
    const preferred=female.find(v=>/(google|microsoft|natural|premium|enhanced)/i.test(v.name+' '+v.voiceURI))||female[0]||null;
    selectedVoice=preferred;
    voicesReady=!!selectedVoice;
    return voicesReady;
  }
  if('speechSynthesis' in window){ refreshVoices(); window.speechSynthesis.onvoiceschanged=refreshVoices; }

  function getAudio(key){
    if(!FILES[key]) return null; let a=audio.get(key);
    if(!a){a=new Audio(ROOT+FILES[key]);a.preload='auto';a.volume=.86;audio.set(key,a);} return a;
  }
  function canPlay(key,force){if(force)return true;return Date.now()-(lastPlayed.get(key)||0)>=(COOLDOWN[key]||4000);}

  function speakFemale(key){
    if(!('speechSynthesis' in window)||!TEXT[key]||!refreshVoices()||!selectedVoice)return null;
    try{
      window.speechSynthesis.cancel();
      return new Promise(resolve=>{
        const u=new SpeechSynthesisUtterance(TEXT[key]);
        u.lang=selectedVoice.lang||'id-ID'; u.voice=selectedVoice;
        u.rate=.88; u.pitch=1.10; u.volume=1;
        let settled=false;
        const done=()=>{if(settled)return;settled=true;u.onend=u.onerror=null;resolve(true);};
        u.onend=done;u.onerror=done;window.speechSynthesis.speak(u);
      });
    }catch(_){return null;}
  }

  async function drain(){
    if(busy||!unlocked||!queue.length)return;
    busy=true; const key=queue.shift();
    const female=speakFemale(key);
    if(female){lastPlayed.set(key,Date.now());await female;busy=false;return drain();}
    const a=getAudio(key);
    if(!a){busy=false;return drain();}
    try{
      a.pause();a.currentTime=0;lastPlayed.set(key,Date.now());await a.play();
      await new Promise(r=>{const done=()=>{cleanup();r()};const cleanup=()=>{a.removeEventListener('ended',done);a.removeEventListener('error',done)};a.addEventListener('ended',done,{once:true});a.addEventListener('error',done,{once:true});});
    }catch(_){pendingUnlock=true}
    finally{busy=false;drain();}
  }
  function unlock(){if(unlocked)return;unlocked=true;pendingUnlock=false;drain();}
  ['pointerdown','touchstart','keydown'].forEach(t=>window.addEventListener(t,unlock,{passive:true,once:true}));

  function play(key,options){
    options=options||{};if(!FILES[key]||!TEXT[key])return false;if(!canPlay(key,!!options.force))return false;
    queue.push(key);if(queue.length>8)queue.splice(0,queue.length-8);drain();return true;
  }
  function welcome(){if(welcomed)return false;welcomed=true;return play('welcome',{force:true});}
  function state(name,detail){
    const s=String(name||'').toUpperCase();if(!s||s===lastState)return false;lastState=s;
    if(s==='LIVE')return play('live',detail);
    if(s==='PROCESSING'||s==='RUNNING')return play('processing',detail);
    if(s==='VALID'||s==='COMPLETE'||s==='DONE')return play('valid',detail);
    if(s==='WARNING'||s==='DEGRADED'||s==='PARTIAL')return play('warning',detail);
    if(s==='ERROR'||s==='FAILED')return play('error',detail);
    if(s==='STANDBY'||s==='IDLE')return play('standby',detail);
    return false;
  }
  function announcePipelineStage(stage,started,result){
    const st=String(stage||'').toUpperCase();
    if(started){
      if(st===lastStage)return false; lastStage=st;
      if(st==='A')return play('stageA',{force:true});
      if(st==='B')return play('stageB',{force:true});
      if(st==='C')return play('stageC',{force:true});
      if(st==='D')return play('stageD',{force:true});
      return play('processing',{force:true});
    }
    lastStage=st;
    if(st==='D')return String(result?.audit||'').toUpperCase()==='VALID'?play('valid',{force:true}):play('warning',{force:true});
    return false;
  }
  window.CGOOperatorVoice=Object.freeze({version:'2.1.0-FEMALE-AIRPORT-PRECISE',build:BUILD,play,welcome,state,announcePipelineStage,unlock,get unlocked(){return unlocked},get pendingUnlock(){return pendingUnlock},get voice(){return selectedVoice?.name||null},get voiceLanguage(){return selectedVoice?.lang||null},get femaleVoiceReady(){return !!selectedVoice}});
  document.addEventListener('DOMContentLoaded',()=>setTimeout(welcome,650),{once:true});
})();
