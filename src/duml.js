// DUML framing used by DJI remote controllers on their USB serial ("VCOM For
// Protocol") port. Pure functions only, so this file runs in Node for tests.
//
// Frame layout:
//   0     0x55
//   1-2   length (10 bits, little endian) | protocol version 1 in the top 6 bits
//   3     CRC-8 of bytes 0..2
//   4     sender        5  receiver
//   6-7   sequence number (little endian)
//   8     command type  9  command set   10  command id
//   11..  payload
//   last two bytes: CRC-16 of everything before them (little endian)

const CRC8_TABLE = new Uint8Array(256);
const CRC16_TABLE = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c8 = i;
  let c16 = i;
  for (let b = 0; b < 8; b++) {
    c8 = c8 & 1 ? (c8 >>> 1) ^ 0x8c : c8 >>> 1;
    c16 = c16 & 1 ? (c16 >>> 1) ^ 0x8408 : c16 >>> 1;
  }
  CRC8_TABLE[i] = c8;
  CRC16_TABLE[i] = c16;
}

export function crc8(bytes, length = bytes.length, seed = 0x77) {
  let c = seed;
  for (let i = 0; i < length; i++) c = CRC8_TABLE[(bytes[i] ^ c) & 0xff];
  return c;
}

export function crc16(bytes, length = bytes.length, seed = 0x3692) {
  let c = seed;
  for (let i = 0; i < length; i++) c = (c >>> 8) ^ CRC16_TABLE[(bytes[i] ^ c) & 0xff];
  return c & 0xffff;
}

const HEADER_AND_CRC = 13;

export function buildFrame({ sender, receiver, seq = 0, cmdType, cmdSet, cmdId, payload = [] }) {
  const length = HEADER_AND_CRC + payload.length;
  if (length > 0x3ff) throw new Error('DUML frame too large');
  const f = new Uint8Array(length);
  f[0] = 0x55;
  f[1] = length & 0xff;
  f[2] = (length >> 8) | 0x04;
  f[3] = crc8(f, 3);
  f[4] = sender;
  f[5] = receiver;
  f[6] = seq & 0xff;
  f[7] = (seq >> 8) & 0xff;
  f[8] = cmdType;
  f[9] = cmdSet;
  f[10] = cmdId;
  f.set(payload, 11);
  const crc = crc16(f, length - 2);
  f[length - 2] = crc & 0xff;
  f[length - 1] = crc >> 8;
  return f;
}

// Incremental parser: feed it whatever chunks the serial port delivers and it
// returns the complete, checksum-verified frames found so far.
export class DumlParser {
  constructor() {
    this.buf = new Uint8Array(0);
  }

  push(chunk) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    const frames = [];
    let i = 0;
    while (i < merged.length) {
      if (merged[i] !== 0x55) { i++; continue; }
      if (merged.length - i < 4) break;
      const length = merged[i + 1] | ((merged[i + 2] & 0x03) << 8);
      const headerOk = length >= HEADER_AND_CRC && crc8(merged.subarray(i, i + 3)) === merged[i + 3];
      if (!headerOk) { i++; continue; }
      if (merged.length - i < length) break;
      const f = merged.subarray(i, i + length);
      const crc = f[length - 2] | (f[length - 1] << 8);
      if (crc16(f, length - 2) !== crc) { i++; continue; }
      frames.push({
        sender: f[4],
        receiver: f[5],
        seq: f[6] | (f[7] << 8),
        cmdType: f[8],
        cmdSet: f[9],
        cmdId: f[10],
        payload: f.slice(11, length - 2),
      });
      i += length;
    }
    this.buf = merged.slice(i);
    return frames;
  }
}

// --- RC-N1 specifics -------------------------------------------------------

const PC = 0x0a;
const RC = 0x06;
const CMD_SET_RC = 0x06;
const CMD_READ_CHANNELS = 0x01;
const CMD_SIMULATOR_MODE = 0x24;

export function enableSimulatorFrame(seq = 0) {
  return buildFrame({ sender: PC, receiver: RC, seq, cmdType: 0x40, cmdSet: CMD_SET_RC, cmdId: CMD_SIMULATOR_MODE, payload: [0x01] });
}

export function readChannelsFrame(seq = 0) {
  return buildFrame({ sender: PC, receiver: RC, seq, cmdType: 0x40, cmdSet: CMD_SET_RC, cmdId: CMD_READ_CHANNELS });
}

// Channel values are 364..1684 with 1024 at centre.
const toAxis = (lo, hi) => Math.max(-1, Math.min(1, (((hi << 8) | lo) - 1024) / 660));

// Returns stick positions in -1..1 (right/up positive) or null if the frame is
// not a channel report.
export function parseChannels(frame) {
  if (frame.cmdSet !== CMD_SET_RC || frame.cmdId !== CMD_READ_CHANNELS) return null;
  const p = frame.payload;
  if (p.length < 16) return null;
  return {
    rightX: toAxis(p[2], p[3]),
    rightY: toAxis(p[5], p[6]),
    leftY: toAxis(p[8], p[9]),
    leftX: toAxis(p[11], p[12]),
    wheel: toAxis(p[14], p[15]),
  };
}
