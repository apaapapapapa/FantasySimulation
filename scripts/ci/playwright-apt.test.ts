import { describe, expect, it } from 'vite-plus/test';
import { closeSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { officialArchiveSources, replaceSources } from './playwright-apt.ts';

const os = 'ID=ubuntu\nVERSION_ID="24.04"\n';
const main = `Types: deb
URIs: mirror+file:/etc/apt/apt-mirrors.txt
Suites: noble noble-updates noble-backports
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
`;
const security = `Types: deb
URIs: http://security.ubuntu.com/ubuntu/
Suites: noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
`;
describe('official Playwright APT archive', () => {
  it.each(['write', 'rename', 'close'] as const)(
    'cleans its own temporary after %s failure and permits retry',
    (stage) => {
      const dir = mkdtempSync(join(tmpdir(), 'fantasy-apt-'));
      const path = join(dir, 'ubuntu.sources');
      try {
        writeFileSync(path, main);
        const fault = (fd: unknown) => {
          if (stage === 'close' && typeof fd === 'number') closeSync(fd);
          throw new Error('injected failure');
        };
        expect(() => replaceSources(path, 'candidate', { [stage]: fault })).toThrow(
          /injected failure/,
        );
        expect(readFileSync(path, 'utf8')).toBe(main);
        expect(existsSync(`${path}.fantasy-next`)).toBe(false);
        replaceSources(path, 'candidate');
        expect(readFileSync(path, 'utf8')).toBe('candidate');
        writeFileSync(`${path}.fantasy-next`, 'another owner');
        expect(() => replaceSources(path, 'replacement')).toThrow(/EEXIST/);
        expect(readFileSync(`${path}.fantasy-next`, 'utf8')).toBe('another owner');
        expect(readFileSync(path, 'utf8')).toBe('candidate');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
  it('changes only the archive URI, preserving security and third-party bytes', () => {
    const source = `${main}\n${security}\nTypes: deb\nURIs: https://packages.microsoft.com/ubuntu/24.04/prod\nSuites: noble\nComponents: main\n`;
    const expected = source.replace(
      'mirror+file:/etc/apt/apt-mirrors.txt',
      'https://archive.ubuntu.com/ubuntu/',
    );
    expect(officialArchiveSources(source, os, 'x64')).toBe(expected);
    expect(officialArchiveSources(expected, os, 'x64')).toBe(expected);
  });
  it('accepts the exact direct Azure layout', () => {
    expect(
      officialArchiveSources(
        main.replace(
          'mirror+file:/etc/apt/apt-mirrors.txt',
          'http://azure.archive.ubuntu.com/ubuntu/',
        ),
        os,
        'x64',
      ),
    ).toContain('URIs: https://archive.ubuntu.com/ubuntu/');
  });
  it('preserves ordering of the same supported suites and components', () => {
    const source = main
      .replace('main restricted universe multiverse', 'main universe restricted multiverse')
      .replace('noble noble-updates noble-backports', 'noble-backports noble noble-updates');
    expect(officialArchiveSources(source, os, 'x64')).toBe(
      source.replace('mirror+file:/etc/apt/apt-mirrors.txt', 'https://archive.ubuntu.com/ubuntu/'),
    );
  });
  it('preserves security when the image uses the same mirror list for it', () => {
    const source = `${main}\n${security.replace('http://security.ubuntu.com/ubuntu/', 'mirror+file:/etc/apt/apt-mirrors.txt')}`;
    expect(officialArchiveSources(source, os, 'x64')).toBe(
      source.replace('mirror+file:/etc/apt/apt-mirrors.txt', 'https://archive.ubuntu.com/ubuntu/'),
    );
  });
  it.each([
    main.replace('noble-updates', 'jammy-updates'),
    main.replace('main restricted universe multiverse', 'main main universe multiverse'),
    main.replace('ubuntu-archive-keyring.gpg', 'unknown.gpg'),
    main.replace('URIs:', 'URIs: https://unknown.example '),
    `${main}Trusted: yes\n`,
    `${main}Signed-By: /another/key\n`,
    `${main}Architectures: arm64\n`,
    `${main}\n${main}`,
    `${main}\n${main.replace('mirror+file:/etc/apt/apt-mirrors.txt', 'https://unknown.example/ubuntu/')}`,
    security,
    main.replace('Components:', ' Components:'),
    main.replaceAll('\n', '\r\n'),
    'x'.repeat(16_385),
  ])('rejects unsupported or ambiguous sources without mutating input', (source) => {
    const before = source;
    expect(() => officialArchiveSources(source, os, 'x64')).toThrow(
      /Expected|Unsupported|Unknown|Ambiguous/,
    );
    expect(source).toBe(before);
  });
  it.each([
    [os, 'arm64'],
    [os.replace('24.04', '26.04'), 'x64'],
    [os.replace('ubuntu', 'debian'), 'x64'],
  ])('rejects unknown runner identity', (release, arch) => {
    expect(() => officialArchiveSources(main, release, arch)).toThrow(/Expected Ubuntu/);
  });
});
