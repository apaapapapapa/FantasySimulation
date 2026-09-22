import { Octokit } from '@octokit/core';
import { paginateRest } from '@octokit/plugin-paginate-rest';

export interface Page {
  data: unknown[];
  next: boolean;
  total: number | null;
}
export interface Gateway {
  get(route: string, parameters?: Record<string, string | number>): Promise<unknown>;
  pages(route: string, parameters?: Record<string, string | number>): AsyncIterable<Page>;
  query(query: string, variables: Record<string, string | number | null>): Promise<unknown>;
  close(): void;
}
export interface CollectionLimits {
  requests: number;
  bytes: number;
  deadlineMs: number;
}
export const DEFAULT_LIMITS: CollectionLimits = {
  requests: 200,
  bytes: 16 * 1024 * 1024,
  deadlineMs: 120_000,
};

/** All code and URLs are selected by the collector, not by PR prose or snapshots. */
export function createGateway(token: string, limits: CollectionLimits = DEFAULT_LIMITS): Gateway {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid collection budget');
  }
  if (!token || /\s/.test(token)) throw new Error('Read-only GitHub authentication is required');
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), limits.deadlineMs);
  let requests = 0;
  let bytes = 0;
  // The SDK handles auth, JSON/GraphQL errors and REST pagination. Streaming bounds
  // are enforced before the SDK parses a response, including redirected job logs.
  const boundedFetch: typeof fetch = async (input, init) => {
    if (++requests > limits.requests) throw new Error('GitHub request budget exceeded');
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    );
    const method = init?.method ?? 'GET';
    if (
      url.origin !== 'https://api.github.com' ||
      (method !== 'GET' && !(method === 'POST' && url.pathname === '/graphql'))
    )
      throw new Error('Only GitHub reads are permitted');
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;
    const response = await fetch(input, { ...init, signal });
    const chunks: Uint8Array[] = [];
    const reader = response.body?.getReader();
    try {
      if (reader) {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > limits.bytes) {
            deadline.abort();
            throw new Error('GitHub response budget exceeded');
          }
          chunks.push(part.value);
        }
      }
    } finally {
      reader?.releaseLock();
    }
    const body = Buffer.concat(chunks);
    const bounded = new Response(response.status === 204 || response.status === 304 ? null : body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    // Response constructors have an empty URL. Octokit uses it to paginate counted
    // envelopes (check runs, workflow runs); retain transport metadata after buffering.
    Object.defineProperty(bounded, 'url', { value: response.url || url.href });
    return bounded;
  };
  const Client = Octokit.plugin(paginateRest);
  const client = new Client({
    auth: token,
    request: { fetch: boundedFetch, timeout: limits.deadlineMs },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  return {
    async get(route, parameters = {}) {
      if (!route.startsWith('GET /repos/')) throw new Error('Read route required');
      return (await client.request(route, parameters)).data as unknown;
    },
    async *pages(route, parameters = {}) {
      if (!route.startsWith('GET /repos/')) throw new Error('Read route required');
      for await (const response of client.paginate.iterator(route, {
        ...parameters,
        per_page: 100,
      })) {
        const data: unknown = response.data;
        if (!Array.isArray(data)) throw new Error('Invalid paginated response');
        const total = 'total_count' in data ? data.total_count : null;
        yield {
          data,
          next: /rel="next"/.test(response.headers.link ?? ''),
          total: typeof total === 'number' ? total : null,
        };
      }
    },
    async query(query, variables) {
      if (!/^\s*query\b/.test(query) || /\bmutation\b/.test(query)) {
        throw new Error('GraphQL reads only');
      }
      return client.graphql<unknown>(query, variables);
    },
    // No automatic retries: zero retries is a finite, explicit fail-closed policy.
    // 401/403/429, timeouts and partial GraphQL errors remain incomplete evidence.
    close() {
      clearTimeout(timer);
      deadline.abort();
    },
  };
}
