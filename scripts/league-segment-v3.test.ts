import { expect, it } from 'vite-plus/test';
import { pipelineActionsFixture } from './test-support/league-actions.ts';
import {
  encodeSegmentV3,
  decodeSegmentV3,
  segmentV3Hash,
  type SegmentV3Binding,
  SEGMENT_V3_PAYLOAD_BYTES,
  SEGMENT_V3_DATA_COUNT,
  SEGMENT_V3_STREAM_BYTES,
} from './league-segment-v3.ts';
function fixture(payload = Buffer.from('exact stream bytes')) {
  const hash = 'sha256:' + 'c'.repeat(64);
  const binding: SegmentV3Binding = {
    identity: pipelineActionsFixture().identity,
    runner: 0,
    index: 0,
    count: 1,
    totalBytes: payload.length,
    planHash: hash,
    inventoryHash: hash,
    streamHash: segmentV3Hash(payload),
    runtimeHash: hash,
  };
  return { payload, binding, expected: { ...binding, payloadHash: segmentV3Hash(payload) } };
}
it('roundtrips exact bytes with a fixed zero-reserved 256-byte header and isolated output', () => {
  const f = fixture(),
    encoded = encodeSegmentV3(f.payload, f.binding);
  expect(encoded.length).toBe(256 + f.payload.length);
  const decoded = decodeSegmentV3(encoded, f.expected);
  expect(decoded).toEqual(f.payload);
  decoded.fill(0);
  expect(decodeSegmentV3(encoded, f.expected)).toEqual(f.payload);
});
it('supports full payload and exact final segment without allocating a whole stream', () => {
  const f = fixture(Buffer.alloc(48 * 1024 ** 2 - 256, 7));
  expect(decodeSegmentV3(encodeSegmentV3(f.payload, f.binding), f.expected).equals(f.payload)).toBe(
    true,
  );
  const tail = fixture(Buffer.from('tail'));
  Object.assign(tail.binding, {
    index: 46,
    count: 47,
    totalBytes: 46 * (48 * 1024 ** 2 - 256) + 4,
  });
  Object.assign(tail.expected, tail.binding);
  expect(decodeSegmentV3(encodeSegmentV3(tail.payload, tail.binding), tail.expected)).toEqual(
    tail.payload,
  );
  expect(SEGMENT_V3_PAYLOAD_BYTES).toBe(48 * 1024 ** 2 - 256);
  expect(SEGMENT_V3_DATA_COUNT).toBe(47);
  expect(SEGMENT_V3_STREAM_BYTES).toBe(47 * (48 * 1024 ** 2 - 256));
});
it.each([0, 8, 12, 16, 20, 24, 28, 32, 40, 72, 104, 136, 168, 200, 232, 255, 256])(
  'rejects a changed header or payload byte at %i',
  (offset) => {
    const f = fixture(),
      encoded = encodeSegmentV3(f.payload, f.binding);
    encoded[offset] = encoded[offset]! ^ 1;
    expect(() => decodeSegmentV3(encoded, f.expected)).toThrow();
  },
);
it.each(['source', 'attempt', 'runtime', 'plan', 'inventory', 'stream', 'index', 'count'])(
  'rejects foreign expected %s metadata',
  (field) => {
    const f = fixture(),
      encoded = encodeSegmentV3(f.payload, f.binding);
    if (field === 'source') f.expected.identity.source.sha = 'd'.repeat(40);
    else if (field === 'attempt') f.expected.identity.runAttempt++;
    else if (field === 'index') f.expected.index++;
    else if (field === 'count') f.expected.count++;
    else f.expected[(field + 'Hash') as 'runtimeHash'] = 'sha256:' + 'd'.repeat(64);
    expect(() => decodeSegmentV3(encoded, f.expected)).toThrow();
  },
);
it('rejects truncated/excess buffers, invalid totals, quota counts and missing payload', () => {
  const f = fixture(),
    encoded = encodeSegmentV3(f.payload, f.binding);
  for (const bytes of [
    Buffer.alloc(0),
    encoded.subarray(0, 255),
    encoded.subarray(0, -1),
    Buffer.concat([encoded, Buffer.from([0])]),
  ])
    expect(() => decodeSegmentV3(bytes, f.expected)).toThrow();
  for (const totalBytes of [0, -1, NaN, Number.MAX_SAFE_INTEGER, SEGMENT_V3_STREAM_BYTES + 1])
    expect(() => encodeSegmentV3(f.payload, { ...f.binding, totalBytes })).toThrow();
  expect(() => encodeSegmentV3(f.payload, { ...f.binding, count: 48 })).toThrow();
  expect(() => encodeSegmentV3(Buffer.alloc(0), f.binding)).toThrow();
});
