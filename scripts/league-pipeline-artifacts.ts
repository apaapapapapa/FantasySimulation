import { Octokit } from '@octokit/core';
import { measureAsync, currentMeasurements } from '@fantasy/api/tooling';
import {
  archiveHash,
  boundedArtifactResponse,
  extractLeagueArchive,
  LEAGUE_ARCHIVE_BYTES,
} from './league-archive.ts';
import type { PipelineIdentity } from '../apps/cli/src/league/league-producer.ts';

export type PipelineArtifact = { id: number; name: string; digest: string; bytes: number };
export class PipelineArtifacts {
  private readonly github: Octokit;
  private calls = 0;
  private reservedOtherCalls = 0;
  private readonly known = new Map<number, PipelineArtifact>();
  private authenticated = false;
  constructor(
    private readonly token: string,
    readonly identity: PipelineIdentity,
    private readonly maxCalls = 200,
    private readonly workflow = 'league-pipeline.yml',
  ) {
    this.github = new Octokit({ auth: token, request: { timeout: 30000 } });
  }
  async request(route: string, parameters: Record<string, string | number> = {}) {
    if (++this.calls + this.reservedOtherCalls > this.maxCalls)
      throw new Error('League metadata API budget exhausted');
    return (
      await this.github.request(route, {
        owner: 'apaapapapapa',
        repo: 'FantasySimulation',
        ...parameters,
      })
    ).data;
  }
  async authenticateRun() {
    const run = await this.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}', {
      run_id: this.identity.runId,
    });
    if (
      run.id !== this.identity.runId ||
      run.run_attempt !== this.identity.runAttempt ||
      run.head_sha !== this.identity.source.sha ||
      run.head_branch !== 'main' ||
      run.event !== 'workflow_dispatch' ||
      run.path !== `.github/workflows/${this.workflow}` ||
      run.head_repository?.full_name !== 'apaapapapapa/FantasySimulation'
    )
      throw new Error('Untrusted league producer run/source/attempt');
    this.authenticated = true;
    return run;
  }
  reserveOtherMetadata(calls: number) {
    if (!Number.isSafeInteger(calls) || calls < 0 || calls + this.calls > this.maxCalls)
      throw new Error('League global metadata API budget exhausted');
    this.reservedOtherCalls = calls;
  }
  async list(name?: string) {
    if (!this.authenticated) await this.authenticateRun();
    const artifacts: PipelineArtifact[] = [];
    for (let page = 1; page <= 3; page++) {
      const result = await this.request(
        'GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts',
        { run_id: this.identity.runId, per_page: 100, page, ...(name ? { name } : {}) },
      );
      if (result.total_count > 256) throw new Error('League run artifact count exceeded');
      if (
        name &&
        (result.total_count > 1 ||
          result.artifacts.some((raw: { name: string }) => raw.name !== name))
      )
        throw new Error('Ambiguous named artifact');
      for (const raw of result.artifacts) {
        if (!raw.name.startsWith(`league-${this.identity.runId}-${this.identity.runAttempt}-`))
          continue;
        if (
          !Number.isSafeInteger(raw.id) ||
          raw.id < 1 ||
          raw.expired ||
          !/^sha256:[a-f0-9]{64}$/.test(raw.digest) ||
          !Number.isSafeInteger(raw.size_in_bytes) ||
          raw.size_in_bytes < 1 ||
          raw.size_in_bytes > LEAGUE_ARCHIVE_BYTES ||
          raw.workflow_run?.head_sha !== this.identity.source.sha ||
          raw.workflow_run?.id !== this.identity.runId
        )
          throw new Error('Invalid immutable artifact metadata');
        const value = { id: raw.id, name: raw.name, digest: raw.digest, bytes: raw.size_in_bytes };
        const old = this.known.get(raw.id);
        if (old && JSON.stringify(old) !== JSON.stringify(value))
          throw new Error('Artifact metadata changed');
        this.known.set(raw.id, value);
        artifacts.push(value);
      }
      if (result.artifacts.length < 100) break;
      if (page === 3) throw new Error('Incomplete league artifact pagination');
    }
    if (new Set(artifacts.map((a) => a.name)).size !== artifacts.length)
      throw new Error('Duplicate league artifact name');
    return artifacts;
  }
  async archive(ref: PipelineArtifact) {
    if (!this.authenticated || JSON.stringify(this.known.get(ref.id)) !== JSON.stringify(ref))
      throw new Error('Artifact is not authenticated by the current run');
    const response = await fetch(
      `https://api.github.com/repos/apaapapapapa/FantasySimulation/actions/artifacts/${ref.id}/zip`,
      {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(30000),
      },
    );
    if (response.status !== 302)
      throw new Error('Artifact did not provide an immutable download redirect');
    const location = response.headers.get('location');
    if (!location || new URL(location).protocol !== 'https:')
      throw new Error('Invalid artifact download URL');
    // GitHub credentials never follow the signed storage redirect.
    const bytes = await boundedArtifactResponse(
      await fetch(location, { signal: AbortSignal.timeout(120000), redirect: 'error' }),
    );
    if (bytes.length !== ref.bytes || archiveHash(bytes) !== ref.digest)
      throw new Error('Actual artifact ZIP digest mismatch');
    return bytes;
  }
  async download(
    ref: PipelineArtifact,
    root: string,
    allow: (key: string) => boolean,
    allowDirectories = true,
  ) {
    const bytes = await measureAsync('artifact.download.transfer', () => this.archive(ref));
    currentMeasurements()?.addBytes('artifact.download.transfer', bytes.length);
    await measureAsync('artifact.download.extract', () =>
      extractLeagueArchive(bytes, root, allow, allowDirectories),
    );
    return ref;
  }
  async durableArtifact(id: number, expected: { digest: string; bytes: number }) {
    await this.authenticateRun();
    const raw = await this.request('GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}', {
      artifact_id: id,
    });
    if (
      raw.id !== id ||
      raw.digest !== expected.digest ||
      raw.size_in_bytes !== expected.bytes ||
      raw.workflow_run?.head_sha !== this.identity.source.sha ||
      raw.workflow_run?.id !== this.identity.runId ||
      raw.name !== `league-${this.identity.runId}-${this.identity.runAttempt}-checkpoint`
    )
      throw new Error('Durable checkpoint artifact provenance mismatch');
  }
  async successfulWriter() {
    const run = await this.authenticateRun();
    if (run.status !== 'completed' || run.conclusion !== 'success')
      throw new Error('Checkpoint writer did not complete successfully');
    const result = await this.request(
      'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs',
      {
        run_id: this.identity.runId,
        attempt_number: this.identity.runAttempt,
        per_page: 100,
      },
    );
    if (
      result.total_count > 100 ||
      result.jobs.length !== result.total_count ||
      result.jobs.filter(
        (job: { name: string; conclusion: string; head_sha: string }) =>
          ['transfer', 'recover'].includes(job.name) &&
          job.conclusion === 'success' &&
          job.head_sha === this.identity.source.sha,
      ).length !== 1
    )
      throw new Error('Missing successful checkpoint writer job');
  }
  async successfulProducers(runners: number) {
    await this.authenticateRun();
    const response = await this.request(
      'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs',
      { run_id: this.identity.runId, attempt_number: this.identity.runAttempt, per_page: 100 },
    );
    if (response.total_count > 100 || response.jobs.length !== response.total_count)
      throw new Error('Incomplete producer job coverage');
    for (const name of [
      'admit',
      ...Array.from({ length: runners }, (_, index) => `compute (${index})`),
    ]) {
      const jobs = response.jobs.filter((job: { name: string }) => job.name === name);
      if (
        jobs.some(
          (job: { status: string; conclusion: string }) =>
            job.status === 'completed' && job.conclusion !== 'success',
        )
      )
        throw new Error('Producer job failed; staged bytes remain unreferenced');
      if (
        jobs.length !== 1 ||
        jobs[0].status !== 'completed' ||
        jobs[0].conclusion !== 'success' ||
        jobs[0].head_sha !== this.identity.source.sha ||
        jobs[0].run_attempt !== this.identity.runAttempt
      )
        return false;
    }
    return true;
  }
  metrics() {
    return {
      metadataCalls: this.calls,
      reservedOtherMetadataCalls: this.reservedOtherCalls,
      maxMetadataCalls: this.maxCalls,
    };
  }
}
