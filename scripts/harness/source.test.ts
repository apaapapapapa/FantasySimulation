import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { freshDirectory } from './artifacts.ts';
import { collectSource, redactLog, runBounded, sourceEnvironment } from './source.ts';
const paths: string[] = [];
function temp() { const path = mkdtempSync(join(tmpdir(),'fantasy-harness-')); paths.push(path); return path; }
afterEach(() => { for (const path of paths.splice(0)) rmSync(path,{recursive:true,force:true}); });
describe('bounded source runner',() => {
  it('does not inherit tokens, cloud credentials or database configuration',() => {
    expect(sourceEnvironment({PATH:'path',GH_TOKEN:'secret',GITHUB_TOKEN:'secret',AWS_ACCESS_KEY_ID:'secret',DATABASE_PATH:'/real.db',NODE_OPTIONS:'--import=bad'})).toEqual({PATH:'path',FORCE_COLOR:'0',NO_COLOR:'1',TZ:'UTC'});
  });
  it('preserves exit status and redacts output',async () => {
    const result = await runBounded(process.execPath,['-e',`console.log('ghp_' + 'x'.repeat(30));process.exitCode=3`],temp());
    expect(result.exitCode).toBe(3);
    expect(result.log).toContain('[REDACTED]');
    expect(result.log).not.toContain('x'.repeat(30));
    expect(redactLog('Authorization: Bearer abc')).toContain('[REDACTED]');
  });
  it('terminates on deadline and excessive output',async () => {
    expect((await runBounded(process.execPath,['-e','setInterval(()=>{},100)'],temp(),150)).timedOut).toBe(true);
    const big = await runBounded(process.execPath,['-e',`console.log('x'.repeat(10000))`],temp(),5000,512);
    expect(big.outputExceeded).toBe(true);
    expect(Buffer.byteLength(big.log)).toBeLessThanOrEqual(512);
  });
  it('marks spawn errors rather than reporting success',async () => {
    expect((await runBounded('fantasy-command-that-does-not-exist',[],temp())).spawnFailed).toBe(true);
  });
  it('refuses dirty source without executing project code',async () => {
    const root = temp();
    const git = (...args: string[]) => execFileSync('git',args,{cwd:root,stdio:'pipe'});
    git('init'); git('config','user.name','Fixture'); git('config','user.email','fixture@localhost');
    writeFileSync(join(root,'.gitignore'),'.generated/\n'); writeFileSync(join(root,'file.txt'),'before');
    git('add','.'); git('commit','-m','fixture'); writeFileSync(join(root,'file.txt'),'dirty');
    const result = await collectSource(root,'.generated/dirty');
    expect(result.status).toBe('fail');
    expect(result.report.checks.find((check) => check.id === 'source:verify')?.status).toBe('skipped');
  });
  it('rejects traversal, reused directories and symlink output',() => {
    const root = temp(); expect(() => freshDirectory(root,'../escape')).toThrow(Error);
    freshDirectory(root,'.generated/attempt');
    expect(() => freshDirectory(root,'.generated/attempt')).toThrow(Error);
    mkdirSync(join(root,'target'));
    symlinkSync(join(root,'target'),join(root,'.generated','link'),process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => freshDirectory(root,'.generated/link/run')).toThrow(Error);
  });
});
