import { describe, expect, it } from 'vite-plus/test';
import { assessReport, bindRequiredChecks, ReportSchema, validEvidenceUri, validTimestamp, type HarnessReport } from './report.ts';
const sha = 'a'.repeat(40);
function report(): HarnessReport {
  return {schemaVersion:1,producer:'test',runId:'fixture',sourceSha:sha,baselineSha:null,pullHeadSha:null,testMergeSha:null,deploymentSha:null,startedAt:'2026-09-22T00:00:00Z',finishedAt:'2026-09-22T00:00:01Z',checks:[{id:'verify',scope:'source',required:true,status:'pass',reason:'Executed',evidence:[{uri:'.generated/result.json',sourceSha:sha}]}]};
}
describe('SHA-bound evidence',() => {
  it('distinguishes pass, fail, unknown and required skips',() => {
    for (const [status,exitCode] of [['pass',0],['fail',1],['unknown',2],['skipped',2]] as const) {
      const value = report(); value.checks[0]!.status = status;
      expect(assessReport(value).exitCode).toBe(exitCode);
    }
  });
  it('binds missing required checks and changed scopes to unknown',() => {
    expect(assessReport(report(),[{id:'missing',scope:'source'}]).status).toBe('unknown');
    expect(assessReport(report(),[{id:'verify',scope:'deployment'}]).status).toBe('unknown');
    expect(() => bindRequiredChecks([{id:'x',scope:'source'},{id:'x',scope:'source'}],[])).toThrow(Error);
  });
  it('requires evidence and matching SHAs',() => {
    const missing = report(); missing.checks[0]!.evidence = [];
    expect(assessReport(missing).status).toBe('unknown');
    const stale = report(); stale.checks[0]!.evidence[0]!.sourceSha = 'b'.repeat(40);
    expect(assessReport(stale).status).toBe('unknown');
  });
  it('requires deployment identity only for non-source checks',() => {
    const value = report(); value.checks[0]!.scope = 'deployment';
    expect(assessReport(value).status).toBe('unknown');
    value.deploymentSha = sha; expect(assessReport(value).status).toBe('pass');
  });
  it('does not let optional skips fail source delivery or empty requirements pass',() => {
    const value = report(); value.checks.push({id:'future',scope:'observation',required:false,status:'skipped',reason:'Not requested',evidence:[]});
    expect(assessReport(value).status).toBe('pass');
    value.checks[0]!.required = false; expect(assessReport(value).status).toBe('unknown');
  });
  it('rejects duplicate checks, empty checks, zero/short SHAs and inverted intervals',() => {
    const duplicate = report(); duplicate.checks.push(duplicate.checks[0]!);
    expect(() => ReportSchema.parse(duplicate)).toThrow(Error);
    expect(() => ReportSchema.parse({...report(),checks:[]})).toThrow(Error);
    for (const sourceSha of ['abc','0'.repeat(40),'g'.repeat(40)]) expect(() => ReportSchema.parse({...report(),sourceSha})).toThrow(Error);
    expect(() => ReportSchema.parse({...report(),finishedAt:'2026-09-21T00:00:00Z'})).toThrow(Error);
  });
  it('rejects impossible dates and accepts offsets',() => {
    expect(validTimestamp('2026-02-30T00:00:00Z')).toBe(false);
    expect(validTimestamp('2026-09-22T00:00:00+09:00')).toBe(true);
    expect(validTimestamp('2026-09-22')).toBe(false);
  });
  it('rejects unsafe evidence paths and URLs',() => {
    for (const uri of ['../a','/tmp/a','a/../b','a//b','file:///x','https://u:p@example.org/a','https://example.org/has space','C:\\a']) expect(validEvidenceUri(uri)).toBe(false);
    for (const uri of ['.generated/report.json','https://github.com/a/b/actions/runs/1']) expect(validEvidenceUri(uri)).toBe(true);
  });
});
