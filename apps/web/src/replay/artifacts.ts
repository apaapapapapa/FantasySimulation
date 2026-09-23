import { hashBytes, type ArtifactRef } from '@fantasy/domain/spatial';

/** Viewer-facing failure categories (#79): format, missing/damaged data, delivery, cancel. */
export type ReplayLoadErrorKind = 'unsupported' | 'damaged' | 'unavailable' | 'aborted';
export class ReplayLoadError extends Error {
  constructor(
    readonly kind: ReplayLoadErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ReplayLoadError';
  }
}
/** A cancelled load is never reported as a delivery or data failure. */
export function toLoadError(
  error: unknown,
  fallback: ReplayLoadErrorKind,
  signal?: AbortSignal,
): ReplayLoadError {
  if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError'))
    return new ReplayLoadError('aborted', 'Replay loading was cancelled', { cause: error });
  if (error instanceof ReplayLoadError) return error;
  const message = error instanceof Error ? error.message : 'Replay loading failed';
  return new ReplayLoadError(fallback, message, { cause: error });
}
/** Collect at most `limit` bytes without trusting declared lengths; larger input is cancelled. */
export async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  label: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader(),
    parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      size += next.value.byteLength;
      if (size > limit) throw new ReplayLoadError('damaged', `${label} exceeds ${limit} bytes`);
      parts.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}
/** Malformed UTF-8 is damage; it is never replaced with substitute characters. */
export function strictText(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new ReplayLoadError('damaged', `${label} is not valid UTF-8`, { cause: error });
  }
}
/**
 * ADR 0006 bytes contract: check the compressed size and checksum first, then expand once
 * within the declared raw size. Transport compression must not have altered the bytes.
 */
export async function expandArtifact(
  bytes: Uint8Array<ArrayBuffer>,
  ref: ArtifactRef,
): Promise<string> {
  if (bytes.byteLength !== ref.bytes || (await hashBytes(bytes)) !== ref.checksum)
    throw new ReplayLoadError('damaged', `${ref.file} does not match its size and checksum`);
  let raw: Uint8Array;
  try {
    const gunzip = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    raw = await readBounded(gunzip, ref.rawBytes, ref.file);
  } catch (error) {
    throw toLoadError(error, 'damaged');
  }
  if (raw.byteLength !== ref.rawBytes)
    throw new ReplayLoadError('damaged', `${ref.file} expanded to an unexpected size`);
  return strictText(raw, ref.file);
}
