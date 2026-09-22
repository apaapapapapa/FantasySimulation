import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { ShaSchema, type EvidenceReference } from './report.ts';
export const digest = (content: string | Uint8Array) => createHash('sha256').update(content).digest('hex');
export function git(root: string, ...args: string[]): string {
  return execFileSync('git',args,{cwd:root,encoding:'utf8',timeout:15_000,maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe']}).trim();
}
export function sourceIdentity(root: string) { return ShaSchema.parse(git(root,'rev-parse','--verify','HEAD')); }
export function repositoryRoot() { return realpathSync(git(process.cwd(),'rev-parse','--show-toplevel')); }
export function freshDirectory(root: string, path: string): string {
  if (!/^\.generated\/[\w./-]+$/.test(path) || path.split('/').some((p) => p === '..' || p === '.' || !p)) throw new Error('Artifacts must use a fresh path below .generated/');
  const absolute = resolve(root,path);
  const parts = relative(root,absolute).split(sep);
  let current = root;
  for (const part of parts) {
    current = resolve(current,part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('Symlink artifact path');
  }
  if (existsSync(absolute)) throw new Error('Artifact directory already exists; choose a fresh attempt');
  mkdirSync(absolute,{recursive:true});
  return absolute;
}
export function writeJson(path: string,value: unknown) { writeFileSync(path,`${JSON.stringify(value,null,2)}\n`,{flag:'wx'}); }
export function fileEvidence(root: string,path: string,sourceSha: string): EvidenceReference {
  return {uri:relative(root,path).split(sep).join('/'),sourceSha,sha256:digest(readFileSync(path))};
}
export function readJson(path: string,maxBytes = 8*1024*1024): unknown {
  if (statSync(path).size > maxBytes) throw new Error('JSON artifact exceeds byte budget');
  const data = readFileSync(path);
  if (data.length > maxBytes) throw new Error('JSON artifact exceeds byte budget');
  return JSON.parse(data.toString('utf8')) as unknown;
}
