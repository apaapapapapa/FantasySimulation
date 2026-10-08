import { closeSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const archive = 'https://archive.ubuntu.com/ubuntu/';
const sourcesPath = '/etc/apt/sources.list.d/ubuntu.sources';
const supportedUris = new Set([
  'mirror+file:/etc/apt/apt-mirrors.txt',
  'http://azure.archive.ubuntu.com/ubuntu/',
  archive,
]);

function exactTokens(value: string | undefined, expected: readonly string[]): boolean {
  const tokens = value?.split(/\s+/) ?? [];
  return (
    tokens.length === expected.length &&
    new Set(tokens).size === tokens.length &&
    expected.every((token) => tokens.includes(token))
  );
}

// The hosted Noble image uses deb822. Change only the official archive URI;
// unknown image/source layouts fail before writing rather than skipping dependencies.
export function officialArchiveSources(
  source: string,
  osRelease: string,
  architecture: string,
): string {
  if (
    !/^ID=ubuntu$/m.test(osRelease) ||
    !/^VERSION_ID="24\.04"$/m.test(osRelease) ||
    architecture !== 'x64'
  )
    throw new Error('Expected Ubuntu 24.04 amd64 hosted runner');
  if (Buffer.byteLength(source) > 16_384 || source.includes('\r'))
    throw new Error('Unsupported Ubuntu sources size or line endings');
  let matched = 0;
  const result = source
    .split(/(\n\n+)/)
    .map((stanza) => {
      const lines = stanza.split('\n');
      const uriLine = lines.find((line) => line.startsWith('URIs:'));
      if (
        !/(?:archive\.ubuntu\.com|mirror\+file:)/.test(uriLine ?? '') &&
        !stanza.includes('ubuntu-archive-keyring.gpg')
      )
        return stanza;
      const fields = new Map<string, string>();
      for (const line of lines) {
        if (!line || line.startsWith('#')) continue;
        const field = /^([A-Za-z-]+): (\S.*)$/.exec(line);
        if (!field || fields.has(field[1]!)) throw new Error('Ambiguous Ubuntu archive stanza');
        fields.set(field[1]!, field[2]!);
      }
      // The image may use the shared mirror list for security too. Preserve that
      // stanza exactly; this mitigation deliberately changes the archive only.
      if (fields.get('Suites') === 'noble-security') return stanza;
      const allowed = new Set([
        'Types',
        'URIs',
        'Suites',
        'Components',
        'Signed-By',
        'Architectures',
      ]);
      if (
        [...fields.keys()].some((key) => !allowed.has(key)) ||
        fields.get('Types') !== 'deb' ||
        !supportedUris.has(fields.get('URIs') ?? '') ||
        fields.get('Signed-By') !== '/usr/share/keyrings/ubuntu-archive-keyring.gpg' ||
        !exactTokens(fields.get('Suites'), ['noble', 'noble-updates', 'noble-backports']) ||
        !exactTokens(fields.get('Components'), ['main', 'restricted', 'universe', 'multiverse']) ||
        (fields.has('Architectures') && fields.get('Architectures') !== 'amd64')
      )
        throw new Error('Unknown Ubuntu archive configuration');
      matched++;
      return lines.map((line) => (line === uriLine ? `URIs: ${archive}` : line)).join('\n');
    })
    .join('');
  if (matched !== 1) throw new Error('Expected exactly one Ubuntu archive stanza');
  return result;
}

export function replaceSources(
  path: string,
  next: string,
  overrides: Partial<{
    write: typeof writeFileSync;
    rename: typeof renameSync;
    close: typeof closeSync;
  }> = {},
): void {
  const temporary = `${path}.fantasy-next`;
  const fd = openSync(temporary, 'wx', 0o644);
  let closed = false;
  try {
    (overrides.write ?? writeFileSync)(fd, next);
    (overrides.close ?? closeSync)(fd);
    closed = true;
    (overrides.rename ?? renameSync)(temporary, path);
  } catch (error) {
    try {
      if (!closed) closeSync(fd);
    } catch {
      // A failed close may already have closed the descriptor. Preserve the
      // original failure and still remove the temporary that this call owns.
    } finally {
      rmSync(temporary, { force: true });
    }
    throw error;
  }
}

function main(): void {
  if (process.argv.length !== 2) throw new Error('No arguments accepted');
  const original = readFileSync(sourcesPath, 'utf8');
  const next = officialArchiveSources(
    original,
    readFileSync('/etc/os-release', 'utf8'),
    process.arch,
  );
  if (next !== original) replaceSources(sourcesPath, next);
  console.log(
    'Playwright Ubuntu archive: official HTTPS; suites, components and signing key retained',
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
