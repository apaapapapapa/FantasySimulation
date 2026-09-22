import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redact, runCommand, validationEnvironment } from './process.ts';

test('source subprocesses do not inherit credentials or command injection settings', () => {
  const environment = validationEnvironment({ PATH: '/bin', HOME: '/tmp', GH_TOKEN: 'private', DATABASE_PATH: '/real.db', NODE_OPTIONS: '--import /untrusted.ts' });
  assert.equal(environment.PATH, '/bin');
  assert.equal(environment.GH_TOKEN, undefined);
  assert.equal(environment.DATABASE_PATH, undefined);
  assert.equal(environment.NODE_OPTIONS, undefined);
});
test('logs redact known credentials, including across concatenated chunks', () => {
  assert.equal(redact('begin-super-secret-end', { GH_TOKEN: 'super-secret' }), 'begin-[REDACTED]-end');
});
test('real subprocess success, failure and start failure remain distinct', async () => {
  const success = await runCommand(process.execPath, ['-e', 'console.log("verified")'], process.cwd(), 5000);
  assert.equal(success.exitCode, 0);
  assert.match(success.output, /verified/);
  assert.equal((await runCommand(process.execPath, ['-e', 'process.exit(7)'], process.cwd(), 5000)).exitCode, 7);
  assert.equal((await runCommand('fantasy-missing-command-9174', [], process.cwd(), 5000)).reason, 'process could not start');
});
test('deadline and output ceilings terminate the process without passing', async () => {
  const timeout = await runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], process.cwd(), 150);
  assert.equal(timeout.reason, 'deadline exceeded');
  assert.notEqual(timeout.exitCode, 0);
  const output = await runCommand(process.execPath, ['-e', 'console.log("x".repeat(20000))'], process.cwd(), 5000, 1000);
  assert.equal(output.reason, 'output limit exceeded');
  assert.ok(Buffer.byteLength(output.output) <= 1000);
});
