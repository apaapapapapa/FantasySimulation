import type { PublicationStore } from '../src/publication/publication-remote.ts';

export class MemoryStore implements PublicationStore {
  listedEtags?: () => ReadonlyMap<string, string>;
  readonly objects = new Map<string, { data: Buffer; etag: string }>();
  readonly writes: string[] = [];
  readonly removed: string[] = [];
  private version = 0;
  remainingRequests() {
    return 100_000;
  }
  async inventory() {
    return new Map([...this.objects].map(([key, value]) => [key, value.data.length]));
  }
  async read(key: string) {
    return this.objects.get(key) ?? null;
  }
  async head(key: string) {
    return this.objects.get(key)?.data.length ?? null;
  }
  async put(key: string, data: Buffer, previous: string | null) {
    const old = this.objects.get(key);
    if (previous === null ? old !== undefined : old?.etag !== previous)
      throw new Error('Conditional conflict');
    this.writes.push(key);
    this.objects.set(key, { data: Buffer.from(data), etag: String(++this.version) });
  }
  async remove(key: string) {
    this.removed.push(key);
    this.objects.delete(key);
  }
}
