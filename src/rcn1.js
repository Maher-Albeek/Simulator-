// Reads the DJI RC-N1 sticks straight from the browser over Web Serial.
// The controller's bottom USB-C port exposes a serial port; we switch the
// controller into simulator mode and poll its channel values.

import { DumlParser, enableSimulatorFrame, readChannelsFrame, parseChannels } from './duml.js';

const DJI_USB_VENDOR_ID = 0x2ca3;
const POLL_MS = 20;

export class RCN1 {
  constructor() {
    this.supported = typeof navigator !== 'undefined' && 'serial' in navigator;
    this.connected = false;
    this.lastPacketAt = 0;
    this.packets = 0;
    this.lastPayloadHex = '';
    this.axes = { leftX: 0, leftY: 0, rightX: 0, rightY: 0, wheel: 0 };
    this.onStatus = () => {};
    this.port = null;
  }

  // True while fresh stick data is arriving.
  get live() {
    return this.connected && performance.now() - this.lastPacketAt < 500;
  }

  // Must be called from a click handler (browser requirement).
  async connect({ anyDevice = false } = {}) {
    if (!this.supported) throw new Error('Web Serial is not available in this browser. Use Chrome or Edge on a computer.');
    await this.disconnect();
    const port = await navigator.serial.requestPort(
      anyDevice ? {} : { filters: [{ usbVendorId: DJI_USB_VENDOR_ID }] },
    );
    await port.open({ baudRate: 115200 });
    this.port = port;
    this.connected = true;
    this.packets = 0;
    this.onStatus('Connected — waiting for stick data…');
    this.#readLoop(port);
    this.#pollLoop(port);
  }

  async disconnect() {
    const port = this.port;
    if (!port) return;
    this.port = null;
    this.connected = false;
    clearInterval(this.pollTimer);
    try { await this.reader?.cancel(); } catch { /* already closed */ }
    try { this.writer?.releaseLock(); } catch { /* already released */ }
    try { await port.close(); } catch { /* already closed */ }
    this.onStatus('Disconnected');
  }

  async #pollLoop(port) {
    const writer = port.writable.getWriter();
    this.writer = writer;
    let seq = 1;
    let busy = false;
    const send = async (frame) => {
      if (busy || this.port !== port) return;
      busy = true;
      try { await writer.write(frame); } catch (e) { this.#fail(port, e); }
      busy = false;
    };
    await send(enableSimulatorFrame(seq++));
    let ticks = 0;
    this.pollTimer = setInterval(() => {
      // Re-send the enable command now and then in case the first one was
      // missed or the controller was power-cycled.
      const frame = ticks++ % 100 === 99 ? enableSimulatorFrame(seq++) : readChannelsFrame(seq++);
      seq &= 0xffff;
      send(frame);
      if (ticks === 150 && this.packets === 0) {
        this.onStatus('No stick data yet. If the port list showed two DJI ports, reconnect and pick the other one.');
      }
    }, POLL_MS);
  }

  async #readLoop(port) {
    const parser = new DumlParser();
    try {
      while (this.port === port && port.readable) {
        const reader = port.readable.getReader();
        this.reader = reader;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            for (const frame of parser.push(value)) {
              const axes = parseChannels(frame);
              if (!axes) continue;
              this.axes = axes;
              this.lastPacketAt = performance.now();
              this.lastPayloadHex = Array.from(frame.payload, (b) => b.toString(16).padStart(2, '0')).join(' ');
              if (this.packets++ === 0) this.onStatus('RC-N1 live');
            }
          }
        } finally {
          reader.releaseLock();
        }
        if (this.port !== port) break;
      }
    } catch (e) {
      this.#fail(port, e);
    }
  }

  #fail(port, error) {
    if (this.port !== port) return;
    this.disconnect().then(() => this.onStatus(`Connection lost: ${error.message}`));
  }
}
