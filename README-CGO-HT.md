# BCGO HT Radio + Satellite Transport + Base PTT

## Isi paket

| File | Fungsi |
|------|--------|
| `ht-protocol.js` | Encode/decode paket HT 32-byte |
| `cgo-ht-radio-engine.js` | Gateway pusat |
| `ht-ptt-simulator.js` | Simulator agent lapangan |
| `ht-radar-layer.js` | Layer titik agent di radar |
| `ht-audio-synth.js` | Beep PTT / collision |
| `chat-radio-formatter.js` | Format log (termasuk **BASE**) |
| `cgo-satellite-virtual.js` | Digital twin LEO (Iridium-like) |
| `cgo-transport.js` | Outbox + jalur AUTO/SAT/LOCAL |
| `cgo-ht-bridge.js` | Simulator → transport → gateway |
| `cgo-base-ptt.js` | **PTT terpusat (operator BASE)** |
| `stress-test-ht.js` | Stress test |
| `test.html` | Test bench UI lengkap |

## Alur

```
Agent lapangan ──► transport.send() ──► outbox / sat ──► gateway ──► radar + log
Operator BASE  ──► basePTT.startPTT() ──► transport ──► gateway ──► log "BASE TALKING"
```

## Base PTT

1. Start simulator  
2. Pilih channel (CH-00 … CH-07)  
3. **Tahan** tombol “Hold to Talk (BASE)”  
4. Log: `[CH-xx] BASE • TALKING • …`  
5. Lepas → OVER  

## Stats satelit

- **Outbox** — paket menunggu jalur  
- **SAT State** — TRACKING / DEGRADED / SCANNING / …  
- **SAT LQM** — kualitas link (dB)  

## Quick start

```js
import { createBridgedSimulator } from './cgo-ht-bridge.js';
import { getBasePTT } from './cgo-base-ptt.js';

const app = createBridgedSimulator({
  count: 12,
  path: 'auto',
  constellation: true,
  satMode: 'realistic'
});
app.start();

const base = getBasePTT({ transport: app.transport });
base.setChannel(3);
await base.startPTT();
// ... bicara ...
base.stopPTT();
```
