// Revision lock + fsync/rename adapted from HiFiScout store.ts; no lock stealing.
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  writeFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve, parse } from 'node:path';
import { readBoundedJson } from '../files.ts';
import { record, timestamp } from '../report.ts';
import { digest, parseContract, taskId } from './contract.ts';
import type { Contract } from './contract.ts';

export interface Event {
  sequence: number;
  at: string;
  type: string;
  data: Record<string, unknown>;
  previous: string;
  hash: string;
}
export interface Journal {
  schemaVersion: 1;
  revision: number;
  contract: Contract;
  contractHash: string;
  events: Event[];
}
export function regularPath(path: string): string {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split('/')) {
    current = join(current, part);
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error('Symlink in state path');
  }
  return absolute;
}
export function parseJournal(value: unknown): Journal {
  const r = record(value),
    contract = parseContract(r.contract),
    contractHash = digest(contract);
  if (
    r.schemaVersion !== 1 ||
    r.contractHash !== contractHash ||
    !Array.isArray(r.events) ||
    !r.events.length ||
    r.events.length > 1000 ||
    r.revision !== r.events.length
  )
    throw new Error('Invalid journal identity');
  let previous = contractHash,
    at = '';
  const events = r.events.map((value, i): Event => {
    const e = record(value);
    if (typeof e.type !== 'string' || !e.type || e.sequence !== i + 1 || e.previous !== previous)
      throw new Error('Invalid event sequence');
    const fields = {
      sequence: i + 1,
      at: timestamp(e.at),
      type: e.type,
      data: record(e.data),
      previous,
    };
    if (fields.at < at || (i === 0 ? fields.type !== 'initialized' : fields.type === 'initialized'))
      throw new Error('Invalid event interval');
    const hash = digest(fields);
    if (e.hash !== hash) throw new Error('Journal history changed');
    previous = hash;
    at = fields.at;
    return { ...fields, hash };
  });
  return { schemaVersion: 1, revision: events.length, contract, contractHash, events };
}
export const readJournal = (path: string) =>
  parseJournal(readBoundedJson(regularPath(path), 4 * 1024 * 1024));
export function withLock<T>(path: string, work: () => T): T {
  regularPath(path);
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = path + '.lock',
    fd = openSync(lockPath, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    fsyncSync(fd);
    return work();
  } finally {
    closeSync(fd);
    rmSync(lockPath);
  }
}
export function atomicWrite(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, path);
    const directory = openSync(dirname(path), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}
export function append(
  journal: Journal,
  type: string,
  data: Record<string, unknown>,
  at: string,
): Journal {
  const fields = {
    sequence: journal.revision + 1,
    at: timestamp(at),
    type,
    data,
    previous: journal.events.at(-1)?.hash ?? journal.contractHash,
  };
  return parseJournal({
    ...journal,
    revision: fields.sequence,
    events: [...journal.events, { ...fields, hash: digest(fields) }],
  });
}
export function initialize(store: string, value: unknown, at = new Date().toISOString()): string {
  if (process.platform !== 'linux') throw new Error('Loop journal/runner supports Linux only');
  const contract = parseContract(value),
    path = regularPath(join(store, taskId(contract), 'journal.json'));
  return withLock(path, () => {
    if (existsSync(path)) {
      if (readJournal(path).contractHash !== digest(contract))
        throw new Error('Existing task contract is frozen');
      return path;
    }
    const empty: Journal = {
      schemaVersion: 1,
      revision: 0,
      contract,
      contractHash: digest(contract),
      events: [],
    };
    writeJournal(path, append(empty, 'initialized', {}, at));
    return path;
  });
}
function writeJournal(path: string, journal: Journal) {
  if (Buffer.byteLength(JSON.stringify(journal, null, 2) + '\n') > 4 * 1024 * 1024)
    throw new Error('Journal size budget');
  atomicWrite(path, journal);
}
export function updateJournal(
  path: string,
  revision: number,
  type: string,
  data: Record<string, unknown>,
  at: string,
  validate: (journal: Journal, at: string) => unknown,
): Journal {
  return withLock(path, () => {
    const previous = readJournal(path);
    if (previous.revision !== revision) throw new Error('Journal revision conflict');
    const next = append(previous, type, data, at);
    validate(next, at);
    writeJournal(path, next);
    return next;
  });
}
