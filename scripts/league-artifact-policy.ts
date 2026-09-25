export function artifactDigest(value: string | undefined) {
  const digest = value?.replace(/^sha256:/, '');
  if (!digest || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Missing Actions artifact digest');
  return 'sha256:' + digest;
}
export function leagueArtifact(
  artifacts: { id: number; name: string; size: number; digest?: string }[],
  name: string,
  expected?: { id: number; digest: string },
) {
  const found = artifacts.filter((artifact) => artifact.name === name);
  if (found.length !== 1) throw new Error('Missing or duplicate current-run artifact');
  const artifact = found[0]!;
  if (
    !Number.isSafeInteger(artifact.id) ||
    artifact.id < 1 ||
    !Number.isSafeInteger(artifact.size) ||
    artifact.size < 1 ||
    artifact.size > 8100000000
  )
    throw new Error('Invalid Actions artifact bounds');
  const digest = artifactDigest(artifact.digest);
  if (expected && (expected.id !== artifact.id || artifactDigest(expected.digest) !== digest))
    throw new Error('Actions artifact identity mismatch');
  return { id: artifact.id, digest };
}
