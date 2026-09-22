export async function requestJson<T>(
  url: string,
  schema: { parse: (value: unknown) => T },
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message =
      body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `APIへの接続に失敗しました (${response.status})。`;
    throw new Error(message);
  }
  return schema.parse(await response.json());
}

export function jsonBody(value: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '処理に失敗しました。';
}
