/**
 * CIKUR GO v3.0 — ESM surface
 * AUTO-GENERATED surface — otak = cikur-go.js + cikur-v3-extension.js
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);

const core = require("./cikur-go.js");
const installV3 = require("./cikur-v3-extension.js");
const api = installV3(core);

export const {
  BAHASA_DIDUKUNG, MODE_DIDUKUNG, daftarBahasa, tambahBahasa,
  angkaKeKata, angkaKeKataLengkap, angkaKeKataPresisi, angkaKeKataBigInt,
  romawiKeAngka, romawiKeKata, tanggalKeKata, hurufKeKata,
  ejaKarakter, ejaKode, lafalWarna, lafalEmoji, normalisasiInput,
  uraiAudit, urai, uraiToken, uraiPerToken, uraiPerKata, uraiTokenDetail,
  waktuKeKata, durasiKeKata, uangKeKata, satuanKeKata,
  CIKURGO, cikur, TokenHasil, HasilUrai,
  REG_BHS, WARNA, EMOJI_REG, CikurGoError, VERSION, version,
  nalar, putuskan, deteksi_pola,
  ingat, lupakan, konteks_sekarang, sarankan_lanjutan,
  jelaskan, nilai_kualitas,
  cipta_ide, usul_tindakan, susun_rencana, silangkan_ide, jelajahi_alternatif
} = api;

export default api;
