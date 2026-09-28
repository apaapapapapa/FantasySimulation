import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  BundleReceiptSchema,
  ReplayManifestSchema,
  LeagueEvidenceCheckpointSchema,
  canonicalJson,
  type BundleReceipt,
} from '@fantasy/domain/spatial';
import { OperationError, readBoundedFile, sha256, type BundleRead } from '@fantasy/api/artifacts';
import { localPublicationGraph, publicationGraph, type ReplayProof } from './publication-graph.ts';
import { publicationBytes, type PublicationFile } from './publication-files.ts';

type Graph = Awaited<ReturnType<typeof publicationGraph>>;
type State = {
  graph: Graph;
  metadata: Map<string, Buffer>;
  md5: Map<string, string>;
  auditedAt: string;
};
const states = new WeakMap<PublicationEvidence, State>();
const metadataKey = (key: string) => /^(catalog|sets|leagues|pack-indexes)\//.test(key);
const publicFile = ({ key, bytes, checksum }: PublicationFile) => ({ key, bytes, checksum });
function state(evidence: PublicationEvidence) {
  const value = states.get(evidence);
  if (!value)
    throw new OperationError('DATA_INVALID', 'Missing authenticated publication capability');
  return value;
}
function mergeProofs(evidence: readonly PublicationEvidence[]) {
  const proofs = new Map<string, ReplayProof>();
  for (const item of evidence)
    for (const [key, proof] of state(item).graph.replays) {
      const old = proofs.get(key);
      if (old && canonicalJson(old) !== canonicalJson(proof))
        throw new OperationError('DATA_INVALID', 'Conflicting authenticated replay proofs');
      proofs.set(key, proof);
    }
  return proofs;
}
async function capture(
  root: string,
  graph: Graph,
  md5 = new Map<string, string>(),
  inherited = new Map<string, Buffer>(),
) {
  const metadata = new Map<string, Buffer>();
  let metadataBytes = 0;
  for (const file of graph.files.values()) {
    if (metadataKey(file.key)) {
      const cached = inherited.get(file.key);
      const data =
        cached && sha256(cached) === file.checksum
          ? cached
          : await readBoundedFile(join(root, file.key), file.bytes);
      if (data.length !== file.bytes || sha256(data) !== file.checksum)
        throw new OperationError('DATA_INVALID', 'Publication metadata changed');
      metadataBytes += data.length;
      if (metadataBytes > 128 * 1024 ** 2)
        throw new OperationError('BUDGET_EXCEEDED', 'Publication metadata bound');
      metadata.set(file.key, data);
    }
    if (!md5.has(file.key)) {
      const data =
        metadata.get(file.key) ?? (await readBoundedFile(join(root, file.key), file.bytes));
      if (data.length !== file.bytes || sha256(data) !== file.checksum)
        throw new OperationError('DATA_INVALID', 'Publication bytes changed');
      md5.set(file.key, createHash('md5').update(data).digest('hex'));
    }
  }
  return { graph, metadata, md5, auditedAt: new Date().toISOString() };
}

/** Opaque process capability. External JSON can only enter through authenticated factories. */
export class PublicationEvidence {
  private constructor(value: State) {
    states.set(this, value);
  }
  static async audit(root: string) {
    return new PublicationEvidence(await capture(root, await localPublicationGraph(root, 2)));
  }
  static async producer(root: string, authenticate: () => Promise<void>) {
    await authenticate();
    let bytes = 0;
    const graph = await publicationGraph(async (key, limit) => {
      const data = await readBoundedFile(join(root, key), limit);
      bytes += data.length;
      if (bytes > 256 * 1024 ** 2)
        throw new OperationError('BUDGET_EXCEEDED', 'Producer extraction bound');
      return data;
    });
    return new PublicationEvidence(await capture(root, graph));
  }
  static async derive(root: string, evidence: readonly PublicationEvidence[]) {
    const inherited = new Map<string, Buffer>();
    for (const item of evidence)
      for (const [key, data] of state(item).metadata)
        if (key !== 'catalog/current.json') inherited.set(key, data);
    const graph = await publicationGraph(
      async (key, limit) => {
        try {
          return await readBoundedFile(join(root, key), limit);
        } catch (error) {
          const data = inherited.get(key);
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !data || data.length > limit)
            throw error;
          return data;
        }
      },
      1,
      mergeProofs(evidence),
    );
    const md5 = new Map<string, string>();
    for (const item of evidence)
      for (const [key, value] of state(item).md5) {
        const current = graph.files.get(key),
          old = state(item).graph.files.get(key);
        if (current && old && current.checksum === old.checksum && current.bytes === old.bytes) {
          if (md5.has(key) && md5.get(key) !== value)
            throw new OperationError('DATA_INVALID', 'Conflicting authenticated physical bytes');
          md5.set(key, value);
        }
      }
    const captured = await capture(root, graph, md5, inherited);
    captured.auditedAt =
      evidence.map((item) => state(item).auditedAt).sort()[0] ?? captured.auditedAt;
    return new PublicationEvidence(captured);
  }
  static async restore(
    input: unknown,
    policy: {
      catalogHash: string;
      validatorDigest: string;
      now: number;
      maxAgeMs: number;
      authenticate(
        checkpoint: ReturnType<typeof LeagueEvidenceCheckpointSchema.parse>,
      ): Promise<void>;
    },
  ) {
    const checkpoint = LeagueEvidenceCheckpointSchema.parse(input);
    await policy.authenticate(checkpoint);
    const age = policy.now - Date.parse(checkpoint.auditedAt);
    if (
      checkpoint.catalogHash !== policy.catalogHash ||
      checkpoint.identity.validatorDigest !== policy.validatorDigest ||
      !Number.isSafeInteger(policy.maxAgeMs) ||
      policy.maxAgeMs < 1 ||
      !Number.isFinite(age) ||
      age < 0 ||
      age > policy.maxAgeMs
    )
      throw new OperationError('IDENTITY_MISMATCH', 'Stale or foreign publication checkpoint');
    const metadata = new Map<string, Buffer>();
    for (const entry of checkpoint.metadata) {
      const data = Buffer.from(entry.json);
      if (
        !metadataKey(entry.file.key) ||
        metadata.has(entry.file.key) ||
        data.length !== entry.file.bytes ||
        sha256(data) !== entry.file.checksum
      )
        throw new OperationError('DATA_INVALID', 'Invalid checkpoint metadata');
      metadata.set(entry.file.key, data);
    }
    const proofs = new Map<string, ReplayProof>();
    for (const proof of checkpoint.replays) {
      const key = canonicalJson(proof.ref);
      if (proofs.has(key)) throw new OperationError('DATA_INVALID', 'Duplicate checkpoint replay');
      proofs.set(key, proof);
    }
    const graph = await publicationGraph(
      async (key, limit) => {
        const data = metadata.get(key);
        if (!data || data.length > limit)
          throw new OperationError('DATA_INVALID', 'Missing checkpoint reference');
        return data;
      },
      1,
      proofs,
    );
    if (
      graph.current.catalogHash !== checkpoint.catalogHash ||
      graph.replays.size !== proofs.size ||
      [...metadata.keys()].some((key) => !graph.files.has(key))
    )
      throw new OperationError('DATA_INVALID', 'Checkpoint coverage mismatch');
    const md5 = new Map(checkpoint.md5);
    if (
      md5.size !== checkpoint.md5.length ||
      md5.size !== graph.files.size ||
      [...graph.files.keys()].some((key) => !md5.has(key))
    )
      throw new OperationError('DATA_INVALID', 'Checkpoint physical coverage mismatch');
    return new PublicationEvidence({ graph, metadata, md5, auditedAt: checkpoint.auditedAt });
  }
  checkpoint(identity: ReturnType<typeof LeagueEvidenceCheckpointSchema.parse>['identity']) {
    const { graph, metadata, md5 } = state(this);
    return LeagueEvidenceCheckpointSchema.parse({
      schemaVersion: 1,
      identity,
      auditedAt: state(this).auditedAt,
      catalogHash: graph.current.catalogHash,
      metadata: [...metadata].map(([key, data]) => ({
        file: publicFile(graph.files.get(key)!),
        json: data.toString('utf8'),
      })),
      replays: [...graph.replays.values()].map((proof) => ({
        ...proof,
        physical: proof.physical.map(publicFile),
        logical: proof.logical.map(publicFile),
      })),
      md5: [...md5].filter(([key]) => graph.files.has(key)),
    });
  }
  bundles(): BundleRead {
    const byHash = new Map(
      [...state(this).graph.replays.values()].map((proof) => [proof.receipt.objectHash, proof]),
    );
    const scope = (): BundleRead => {
      let closed = false;
      const lookup = (hash: string) => {
        if (closed) throw new Error('Metadata verification session is closed');
        const proof = byHash.get(hash);
        if (!proof) throw new OperationError('DATA_INVALID', 'Missing authenticated replay');
        return proof;
      };
      return {
        root: 'authenticated-publication',
        verify: async (hash) => BundleReceiptSchema.parse(lookup(hash).receipt),
        manifest: async (receipt: BundleReceipt) => {
          const proof = lookup(receipt.objectHash);
          if (canonicalJson(receipt) !== canonicalJson(proof.receipt))
            throw new Error('Metadata receipt mismatch');
          return ReplayManifestSchema.parse(proof.manifest);
        },
        read: async () => {
          throw new Error('Metadata evidence cannot read recordings');
        },
        verificationSession: scope,
        closeVerification: () => {
          closed = true;
        },
        preverify: async (hashes) => {
          hashes.forEach(lookup);
        },
      };
    };
    return scope();
  }
}

export function evidenceGraph(evidence: PublicationEvidence) {
  const { graph, metadata } = state(evidence);
  return {
    ...graph,
    files: new Map(
      [...graph.files].map(([key, file]) => [
        key,
        { ...file, ...(metadata.has(key) ? { data: Buffer.from(metadata.get(key)!) } : {}) },
      ]),
    ),
  };
}
export function evidenceMd5(evidence: PublicationEvidence, file: PublicationFile) {
  const value = state(evidence),
    original = value.graph.files.get(file.key);
  if (!original || original.checksum !== file.checksum || original.bytes !== file.bytes)
    throw new OperationError('DATA_INVALID', 'Unauthenticated physical reference');
  return value.md5.get(file.key);
}
export async function evidenceMetadata(evidence: PublicationEvidence) {
  const graph = evidenceGraph(evidence);
  return Promise.all(
    [...graph.files.values()]
      .filter((file) => metadataKey(file.key))
      .map(async (file) => ({ ...file, data: await publicationBytes(file) })),
  );
}
