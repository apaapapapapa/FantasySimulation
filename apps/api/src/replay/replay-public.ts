import { OperationError } from '../operation-error.ts';

/** Inspect original JSON, before schema normalization can discard any private fields. */
export function assertPublicData(value: unknown): void {
  if (typeof value === 'string') {
    if (
      /(?:^|[\s="'(])(?:\/[^\s/]+[^\s]*|[a-z]:[\\/]|\\\\)|(?:^|[\\/])\.work(?:[\\/]|$)|\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]+|AKIA[A-Z0-9]{16})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:password|secret|token|api[_-]?key|authorization)\s*[:=]|https?:\/\/[^\s/@]+:[^\s/@]+@/i.test(
        value,
      )
    )
      throw new OperationError('DATA_INVALID', 'Private text is not publishable');
  } else if (Array.isArray(value)) value.forEach(assertPublicData);
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (
        /^(?:env|environment|password|secret|token|apiKey|authorization|credentials|absolutePath)$/i.test(
          key,
        )
      )
        throw new OperationError('DATA_INVALID', 'Private field is not publishable');
      assertPublicData(key);
      assertPublicData(item);
    }
  }
}
