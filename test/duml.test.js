import test from 'node:test';
import assert from 'node:assert/strict';
import { crc8, crc16, buildFrame, DumlParser, parseChannels, readChannelsFrame, enableSimulatorFrame } from '../src/duml.js';

const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

test('checksums match the standard CRC-8/MAXIM and CRC-16/KERMIT check values', () => {
  assert.equal(crc8(ascii('123456789'), 9, 0), 0xa1);
  assert.equal(crc16(ascii('123456789'), 9, 0), 0x2189);
});

test('request frames have the expected header', () => {
  const f = readChannelsFrame(0x34eb);
  assert.deepEqual([...f.slice(0, 3)], [0x55, 0x0d, 0x04]);
  assert.deepEqual([...f.slice(4, 11)], [0x0a, 0x06, 0xeb, 0x34, 0x40, 0x06, 0x01]);
  assert.equal(f.length, 13);
  const e = enableSimulatorFrame(1);
  assert.equal(e.length, 14);
  assert.deepEqual([...e.slice(8, 12)], [0x40, 0x06, 0x24, 0x01]);
});

function channelReply({ rightX = 1024, rightY = 1024, leftY = 1024, leftX = 1024, wheel = 1024 }) {
  const payload = new Uint8Array(25);
  const put = (at, v) => { payload[at] = v & 0xff; payload[at + 1] = v >> 8; };
  put(2, rightX); put(5, rightY); put(8, leftY); put(11, leftX); put(14, wheel);
  return buildFrame({ sender: 0x06, receiver: 0x0a, seq: 7, cmdType: 0xc0, cmdSet: 0x06, cmdId: 0x01, payload });
}

test('parser survives noise, split chunks and corrupt frames', () => {
  const good = channelReply({ rightX: 1684, rightY: 364, leftY: 1354, leftX: 1024, wheel: 694 });
  assert.equal(good.length, 38);
  const bad = channelReply({});
  bad[20] ^= 0xff;
  const stream = Uint8Array.from([0x00, 0x55, 0x12, ...bad, ...good, 0x55]);
  const parser = new DumlParser();
  const frames = [];
  for (let i = 0; i < stream.length; i += 5) frames.push(...parser.push(stream.subarray(i, i + 5)));
  assert.equal(frames.length, 1);
  assert.deepEqual(parseChannels(frames[0]), { rightX: 1, rightY: -1, leftY: 0.5, leftX: 0, wheel: -0.5 });
});

test('other commands are not mistaken for stick data', () => {
  const [frame] = new DumlParser().push(enableSimulatorFrame(1));
  assert.equal(parseChannels(frame), null);
});
