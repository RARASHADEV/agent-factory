// src/lib/providers/loka-http-client.ts
// Low-level HTTP wrapper for the Loka REST API.
// Uses native fetch (Node 18+). No external dependencies.

import { ProviderError, LokaUnreachableError } from '../task-provider.js';

export interface LokaHttpClientOptions {
  baseUrl: string;       // e.g. "http://localhost:3333/api/v1"
  apiKey: string;
  timeoutMs?: number;    // default 10000
  retries?: number;      // default 1 (total attempts = 2)
}

export class LokaHttpClient {
  private baseUrl: string;
  private apiKey: string;
  private timeoutMs: number;
  private retries: number;

  constructor(private opts: LokaHttpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 10000;
    this.retries = opts.retries ?? 1;
  }

  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    let url = `${this.baseUrl}${path}`;
    if (params && Object.keys(params).length > 0) {
      const qs = new URLSearchParams(params).toString();
      url = `${url}?${qs}`;
    }
    return this.request<T>('GET', url, undefined);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    return this.request<T>('POST', url, body);
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    return this.request<T>('PATCH', url, body);
  }

  private async request<T>(method: string, url: string, body: unknown, attempt = 0): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          'X-Api-Key': this.apiKey,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err: any) {
      clearTimeout(timer);
      // AbortError = timeout
      if (err?.name === 'AbortError') {
        throw new ProviderError('Loka request timed out');
      }
      // Network-level failure
      throw new LokaUnreachableError(`Loka API is unreachable: ${err?.message ?? String(err)}`);
    } finally {
      clearTimeout(timer);
    }

    // 429 Rate Limited — retry after Retry-After header
    if (response.status === 429) {
      if (attempt < 2) {
        const retryAfter = parseInt(response.headers.get('Retry-After') ?? '1', 10);
        await sleep(retryAfter * 1000);
        return this.request<T>(method, url, body, attempt + 1);
      }
      throw new ProviderError('Loka API rate limit exceeded', 429);
    }

    // 5xx — retry once with 1s backoff
    if (response.status >= 500) {
      if (attempt < this.retries) {
        await sleep(1000);
        return this.request<T>(method, url, body, attempt + 1);
      }
      const text = await response.text().catch(() => '');
      throw new ProviderError(`Loka server error (${response.status}): ${text}`, response.status);
    }

    // 401 Unauthorized
    if (response.status === 401) {
      throw new ProviderError('Invalid Loka API key', 401);
    }

    // 404 Not Found — return null for GET, throw for mutations
    if (response.status === 404) {
      if (method === 'GET') {
        return null as unknown as T;
      }
      const text = await response.text().catch(() => '');
      throw new ProviderError(`Loka resource not found: ${text}`, 404);
    }

    // Other 4xx
    if (response.status >= 400) {
      const text = await response.text().catch(() => '');
      throw new ProviderError(`Loka API error (${response.status}): ${text}`, response.status);
    }

    // Success — parse JSON (or return undefined for 204)
    if (response.status === 204) {
      return undefined as unknown as T;
    }

    return response.json() as Promise<T>;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
