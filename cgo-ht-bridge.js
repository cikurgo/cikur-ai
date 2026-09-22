/**
 * cgo-ht-bridge.js
 * ============================================================
 * Jembatan: HT Simulator / Agent → Transport → Gateway
 *
 * Pakai ini di test bench atau halaman BCGO supaya:
 *   - paket agent lewat outbox + sat virtual
 *   - emergency prioritas
 *   - gateway tetap satu sink
 *
 * EXPORTS: wireSimulatorToTransport, createBridgedSimulator
 * ============================================================
 */

import { createSimulator } from './ht-ptt-simulator.js';
import { getGateway } from './cgo-ht-radio-engine.js';
import { getTransport, resetTransport, PATH, PRIORITY } from './cgo-transport.js';
import { STATUS_FLAGS } from './ht-protocol.js';

const BRIDGE_WRAP = Symbol('cgoHtBridgeWrapped');

/**
 * Hubungkan onTransmit simulator ke transport.
 *
 * @param {object} simulator  hasil createSimulator()
 * @param {object} [options]
 * @param {object} [options.transport]
 * @param {object} [options.gateway]
 * @param {string} [options.path]  'auto' | 'sat' | 'local'
 */
function wireSimulatorToTransport(simulator, options = {}) {
  const gateway = options.gateway || getGateway({
    state: typeof globalThis !== 'undefined' ? globalThis.BCGO_STATE : null,
    chat: typeof globalThis !== 'undefined' ? globalThis.cgoChat : null
  });

  if (typeof globalThis !== 'undefined') {
    globalThis.__cgoGateway = gateway;
  }

  const transport = options.transport || getTransport({
    path: options.path || PATH.AUTO,
    gateway,
    constellation: options.constellation !== false,
    satMode: options.satMode || 'realistic',
    onAck: options.onAck,
    onDrop: options.onDrop,
    onQueued: options.onQueued
  });

  transport.gateway = gateway;
  if (options.physicalSatellite) transport.physicalSatellite = options.physicalSatellite;
  transport.start();

  // Override tiap agent onTransmit
  for (const agent of simulator.agents || []) {
    if (agent[BRIDGE_WRAP]) continue;
    const original = agent.onTransmit;
    const wrapped = (channel, payload) => {
      const emergency = (agent.status & STATUS_FLAGS.EMERGENCY) !== 0;
      const ptt = (agent.status & STATUS_FLAGS.PTT_ACTIVE) !== 0;

      void transport.send(channel, payload, {
        emergency,
        ptt,
        agentId: agent.agentId,
        callsign: agent.callsign
      }).catch(err => options.onError?.(err));

      // optional: tetap panggil original (mis. counter lokal)
      if (typeof original === 'function') {
        try { original(channel, payload); } catch { /* noop */ }
      }
    };
    Object.defineProperty(wrapped, BRIDGE_WRAP, { value: true });
    agent.onTransmit = wrapped;
  }

  return { transport, gateway };
}

/**
 * Buat simulator + langsung di-wire ke transport.
 */
function createBridgedSimulator(config = {}) {
  const gateway = getGateway({
    state: typeof globalThis !== 'undefined' ? globalThis.BCGO_STATE : null,
    chat: typeof globalThis !== 'undefined' ? globalThis.cgoChat : null,
    verbose: config.verbose === true
  });

  if (typeof globalThis !== 'undefined') {
    globalThis.__cgoGateway = gateway;
  }

  const transport = resetTransport({
    path: config.path || PATH.AUTO,
    gateway,
    constellation: config.constellation !== false,
    satMode: config.satMode || 'realistic',
    physicalSatellite: config.physicalSatellite || null
  });
  transport.start();

  const simulator = createSimulator({
    count: config.count ?? 12,
    channels: config.channels ?? 8,
    profiles: config.profiles,
    weights: config.weights,
    onTransmit: (channel, payload) => {
      // akan di-override per-agent di wire; fallback:
      void transport.send(channel, payload, {}).catch(err => config.onError?.(err));
    },
    onStateChange: config.onStateChange,
    onError: config.onError
  });

  wireSimulatorToTransport(simulator, {
    transport, gateway, path: config.path,
    physicalSatellite: config.physicalSatellite || null,
    onError: config.onError
  });

  return {
    simulator,
    transport,
    gateway,
    start() {
      simulator.startAll();
      transport.start();
    },
    stop() {
      simulator.stopAll();
      transport.stop();
    },
    dispose() {
      this.stop();
      simulator.disposeAll();
      transport.reset();
    },
    getStats() {
      return {
        agents: simulator.getStats(),
        transport: transport.getStats(),
        gateway: gateway.getGlobalStats()
      };
    }
  };
}

export {
  wireSimulatorToTransport,
  createBridgedSimulator,
  PATH,
  PRIORITY
};
