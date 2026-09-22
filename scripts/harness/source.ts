import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileEvidence, freshDirectory, git, sourceIdentity, writeJson } from './artifacts.ts';
import { assessReport, ShaSchema, type HarnessCheck, type HarnessReport } from './report.ts';
export const SOURCE_REQUIREMENTS = [{id:'source:verify',scope:'source'},{id:'source:clean',scope:'source'}] as const;
const allowedEnv = ['PATH','Path','PATHEXT','SystemRoot','SYSTEMROOT','WINDIR','HOME','USERPROFILE','TEMP','TMP','TMPDIR','COMSPEC','LANG','LC_ALL','CI','GITHUB_ACTIONS','VP_HOME'];
export function sourceEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {FORCE_COLOR:'0',NO_COLOR:'1',TZ:'UTC'};
  for (const name of allowedEnv) if (environment[name] !== undefined) result[name] = environment[name];
  return result;
}
export function redactLog(text: string): string {
  return text.replace(/\b(?:gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g,'[REDACTED]').replace(/(authorization\s*[:=]\s*(?:bearer|token)\s+)[^\s]+/gi,'$1[REDACTED]');
}
export interface ProcessReceipt {
  command: string[]; exitCode: number | null; signal: string | null;
  timedOut: boolean; outputExceeded: boolean; spawnFailed: boolean;
  startedAt: string; finishedAt: string; log: string;
}
/** No shell interpolation; bounds both the process tree lifetime and captured bytes. */
export async function runBounded(command: string,args: string[],cwd: string,timeoutMs = 600_000,maxBytes = 2*1024*1024): Promise<ProcessReceipt> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900_000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8*1024*1024) throw new Error('Invalid process budget');
  const startedAt = new Date().toISOString();
  return await new Promise((resolve) => {
    const child = spawn(command,args,{cwd,env:sourceEnvironment(process.env),shell:false,detached:process.platform !== 'win32',stdio:['ignore','pipe','pipe']});
    const chunks: Buffer[] = [];
    let bytes = 0, timedOut = false, outputExceeded = false, spawnFailed = false, killed = false;
    const kill = () => {
      if (killed || !child.pid) return;
      killed = true;
      if (process.platform === 'win32') {
        try { execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',timeout:5000}); }
        catch { child.kill(); }
      } else {
        try { process.kill(-child.pid,'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); },timeoutMs);
    const capture = (chunk: Buffer) => {
      const room = Math.max(0,maxBytes-bytes);
      if (room) chunks.push(chunk.subarray(0,room));
      bytes += chunk.length;
      if (bytes > maxBytes) { outputExceeded = true; kill(); }
    };
    child.stdout.on('data',capture);
    child.stderr.on('data',capture);
    child.on('error',() => { spawnFailed = true; });
    child.on('close',(exitCode,signal) => {
      clearTimeout(timer);
      resolve({command:[command,...args],exitCode,signal,timedOut,outputExceeded,spawnFailed,startedAt,finishedAt:new Date().toISOString(),log:redactLog(Buffer.concat(chunks).toString('utf8'))});
    });
  });
}
export async function collectSource(root: string,output: string,baselineSha: string | null = null) {
  if (baselineSha !== null) {
    ShaSchema.parse(baselineSha);
    if (git(root,'rev-parse','--verify',`${baselineSha}^{commit}`) !== baselineSha) throw new Error('Baseline commit is unavailable');
    git(root,'merge-base','--is-ancestor',baselineSha,'HEAD');
  }
  const sourceSha = sourceIdentity(root);
  const startedAt = new Date().toISOString();
  const before = git(root,'status','--porcelain','--untracked-files=normal');
  const directory = freshDirectory(root,output);
  let receipt: ProcessReceipt | null = null;
  if (!before) receipt = await runBounded('vp',['run','verify'],root);
  const after = git(root,'status','--porcelain','--untracked-files=normal');
  const headAfter = sourceIdentity(root);
  const clean = !before && !after && sourceSha === headAfter;
  const {log = '',...processResult} = receipt ?? {};
  const logPath = join(directory,'verify.log');
  const receiptPath = join(directory,'runner.json');
  writeFileSync(logPath,log,{flag:'wx'});
  writeJson(receiptPath,{producer:'fantasy/source-v1',sourceSha,baselineSha,process:receipt ? processResult : null,cleanBefore:!before,cleanAfter:!after,headAfter,toolchain:{node:process.version,platform:process.platform,arch:process.arch}});
  const evidence = [fileEvidence(root,receiptPath,sourceSha),fileEvidence(root,logPath,sourceSha)];
  const checks: HarnessCheck[] = [{
    id:'source:verify',scope:'source',required:true,
    status: !receipt ? 'skipped' : receipt.spawnFailed ? 'unknown' : receipt.exitCode === 0 && !receipt.timedOut && !receipt.outputExceeded ? 'pass' : 'fail',
    reason: !receipt ? 'Dirty source was not executed' : receipt.spawnFailed ? 'Failed to start pinned verification command' : `vp run verify exit=${receipt.exitCode}; timeout=${receipt.timedOut}; outputExceeded=${receipt.outputExceeded}`,
    evidence,
  },{
    id:'source:clean',scope:'source',required:true,status:clean ? 'pass' : 'fail',
    reason:clean ? 'Clean committed source unchanged by verification' : 'Dirty checkout or source identity changed',evidence,
  }];
  const report: HarnessReport = {schemaVersion:1,producer:'fantasy/source-v1',runId:`source-${process.platform}`,sourceSha,baselineSha,pullHeadSha:null,testMergeSha:null,deploymentSha:null,startedAt,finishedAt:new Date().toISOString(),checks};
  const assessment = assessReport(report,SOURCE_REQUIREMENTS);
  writeJson(join(directory,'report.json'),assessment.report);
  return assessment;
}
