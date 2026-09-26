import { existsSync, readFileSync } from 'node:fs';
import { array, isMain, main, object, requireCondition, text } from './common.ts';
import type { Outcome } from './common.ts';

function exact(value: unknown): string {
  const version = text(value);
  requireCondition(/^\d+\.\d+\.\d+$/.test(version), 'TOOLCHAIN_VERSION_MUST_BE_EXACT');
  return version;
}

function capture(value: string, pattern: RegExp): string {
  const matches = [...value.matchAll(pattern)];
  requireCondition(matches.length === 1, 'TOOLCHAIN_SETTING_MISSING_OR_DUPLICATED');
  return exact(matches[0]?.[1]);
}

export function toolchainOutcome(
  manifestValue: unknown,
  workspace: string,
  nodeVersion: string,
  compatibilityValue: unknown,
): Outcome {
  const manifest = object(manifestValue);
  const dependencies = object(manifest.devDependencies);
  const compatibility = object(compatibilityValue);
  const vitePlus = exact(dependencies['vite-plus']);
  const alias = capture(workspace, /^  vite: npm:@voidzero-dev\/vite-plus-core@(\d+\.\d+\.\d+)$/gm);
  const peer = capture(workspace, /^    vite: (\d+\.\d+\.\d+)$/gm);
  const vitest = capture(workspace, /^  vitest: (\d+\.\d+\.\d+)$/gm);
  requireCondition(vitePlus === alias && alias === peer, 'VITE_PLUS_ALIAS_PEER_DRIFT');
  requireCondition(
    vitePlus === exact(compatibility.vitePlus) && vitest === exact(compatibility.vitest),
    'BUNDLED_VITEST_COMPATIBILITY_REVIEW_REQUIRED',
  );
  requireCondition(text(compatibility.evidence).length >= 30, 'TOOLCHAIN_REVIEW_EVIDENCE_REQUIRED');
  exact(nodeVersion);
  const manager = text(manifest.packageManager);
  requireCondition(/^pnpm@\d+\.\d+\.\d+$/.test(manager), 'PNPM_VERSION_MUST_BE_EXACT');
  const engine = text(object(manifest.engines).node);
  const bounds = /^>=(\d+)\.(\d+)\.(\d+) <(\d+)$/.exec(engine);
  requireCondition(bounds !== null, 'NODE_ENGINE_POLICY_REVIEW_REQUIRED');
  const version = nodeVersion.split('.').map(Number);
  const minimum = bounds.slice(1, 4).map(Number);
  const [major = 0, minor = 0, patch = 0] = version;
  const [minMajor = 0, minMinor = 0, minPatch = 0] = minimum;
  const lower = major * 1_000_000 + minor * 1_000 + patch;
  const required = minMajor * 1_000_000 + minMinor * 1_000 + minPatch;
  requireCondition(lower >= required && major < Number(bounds[4]), 'NODE_ENGINE_PIN_MISMATCH');
  return { status: 'pass', reason: 'TOOLCHAIN_PINS_MATCH_REVIEWED_PAIR', counts: { checks: 6 } };
}

export function renovateOutcome(value: unknown): Outcome {
  const config = object(value);
  requireCondition(config.automerge === false, 'AUTOMERGE_MUST_BE_FALSE');
  requireCondition(config.platformAutomerge === false, 'PLATFORM_AUTOMERGE_MUST_BE_FALSE');
  requireCondition(
    object(config.vulnerabilityAlerts).automerge === false,
    'VULNERABILITY_AUTOMERGE_FORBIDDEN',
  );
  requireCondition(
    object(config.lockFileMaintenance).automerge === false,
    'LOCKFILE_AUTOMERGE_FORBIDDEN',
  );
  requireCondition(config.dependencyDashboard === true, 'DEPENDENCY_DASHBOARD_REQUIRED');
  requireCondition(
    config.dependencyDashboardApproval === false,
    'PR_CREATION_APPROVAL_MUST_BE_DISABLED',
  );
  const schedule = array(config.schedule);
  requireCondition(
    schedule.length === 1 && schedule[0] === 'at any time',
    'NORMAL_UPDATE_SCHEDULE_MUST_BE_UNRESTRICTED',
  );
  for (const value of array(config.packageRules)) {
    const rule = object(value);
    requireCondition(rule.automerge === false, 'RULE_AUTOMERGE_FORBIDDEN');
  }
  function inspect(value: unknown): void {
    if (Array.isArray(value)) {
      for (const entry of value) inspect(entry);
    } else if (value !== null && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        if (key === 'automerge' || key === 'platformAutomerge') {
          requireCondition(entry === false, 'NESTED_AUTOMERGE_FORBIDDEN');
        }
        if (key === 'dependencyDashboardApproval') {
          requireCondition(entry === false, 'NESTED_PR_CREATION_APPROVAL_FORBIDDEN');
        }
        inspect(entry);
      }
    }
  }
  inspect(config);
  return {
    status: 'pass',
    reason: 'RENOVATE_AUTOMERGE_DISABLED',
    counts: { rules: array(config.packageRules).length },
  };
}

function evaluate(): Outcome {
  requireCondition(!existsSync('.github/dependabot.yml'), 'DUPLICATE_DEPENDENCY_BOT_CONFIG');
  requireCondition(!existsSync('.github/dependabot.yaml'), 'DUPLICATE_DEPENDENCY_BOT_CONFIG');
  requireCondition(!existsSync('renovate.json5'), 'DUPLICATE_RENOVATE_CONFIG');
  renovateOutcome(JSON.parse(readFileSync('renovate.json', 'utf8')) as unknown);
  const node = readFileSync('.node-version', 'utf8').trim();
  requireCondition(process.versions.node === node, 'NODE_RUNTIME_PIN_MISMATCH');
  return toolchainOutcome(
    JSON.parse(readFileSync('package.json', 'utf8')) as unknown,
    readFileSync('pnpm-workspace.yaml', 'utf8'),
    node,
    JSON.parse(readFileSync('.github/security/toolchain-compatibility.json', 'utf8')) as unknown,
  );
}

if (isMain(import.meta.url)) main('toolchain-policy', evaluate);
