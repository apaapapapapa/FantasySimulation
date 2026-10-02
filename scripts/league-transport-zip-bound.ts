import { TRANSPORT_V2_LIMITS } from './league-transport-v2.ts';

/** Model only: this does not authenticate an output claim or enable transport v2.
 * Bounds include all payload AND control files; names are complete normalized ZIP
 * entry UTF-8 names. These are claims, not measurements of sealed files.
 */
export function inspectTransportZipBound(input: {
  encoder: string;
  rawBytesUpper: number;
  fileCountUpper: number;
  maxNameBytesUpper: number;
}) {
  const { encoder, rawBytesUpper, fileCountUpper, maxNameBytesUpper } = input;
  if (
    encoder !== 'actions-artifact-6.2.1-store-files-v1' ||
    !Number.isSafeInteger(rawBytesUpper) ||
    rawBytesUpper < 0 ||
    rawBytesUpper > TRANSPORT_V2_LIMITS.rawArchiveBytes ||
    !Number.isSafeInteger(fileCountUpper) ||
    fileCountUpper < 1 ||
    fileCountUpper > TRANSPORT_V2_LIMITS.producerFiles ||
    !Number.isSafeInteger(maxNameBytesUpper) ||
    maxNameBytesUpper < 1 ||
    maxNameBytesUpper > 256
  )
    throw new Error('Unsupported off-mode STORE archive envelope');
  // Pinned SDK compressionLevel=0 selects STORE. Regular files only, no comments,
  // custom extra fields, links, directories or forced ZIP64. Each streamed file:
  // local header 30 + central header 46 + data descriptor <=16 + twice UTF-8 name.
  // <=4096 entries and this total size stay below every automatic ZIP64 threshold.
  const encodedBytesUpper = rawBytesUpper + fileCountUpper * (92 + 2 * maxNameBytesUpper) + 22;
  return {
    mode: 'off' as const,
    executionEnabled: false as const,
    encodedBytesUpper,
    remainingGates: [
      'authenticated-output-proof',
      'sealed-regular-files-and-pinned-encoder',
      'metadata-transfer-retry-and-storage-budget',
      'same-source-whole-critical-path',
    ] as const,
  };
}
