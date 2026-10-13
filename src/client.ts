
export interface ClientOptions {
  baseUrl: string;
  getAccessToken: () => Promise<string>;
  fetch?: typeof fetch;
}

export class ApiError extends Error {
  constructor(public readonly status: number) {
    super(`Application request failed (${status})`);
  }
}

export class SqlAppsClient {
  private readonly fetcher: typeof fetch;
  protected readonly origin: URL;
  constructor(private readonly options: ClientOptions) {
    this.origin = new URL(options.baseUrl);
    if (this.origin.username || this.origin.password || this.origin.pathname !== '/') {
      throw new Error('Client baseUrl must be an origin without embedded credentials');
    }
    this.fetcher = options.fetch ?? ((url, init) => fetch(url, init));
  }
  async request(path: string, options: RequestInit = {}): Promise<Response> {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin.origin) throw new Error('Cross-origin API paths are not allowed');
    const token = await this.options.getAccessToken();
    if (!token) throw new Error('Access token required');
    const headers = new Headers(options.headers);
    headers.set('authorization', `Bearer ${token}`);
    const response = await this.fetcher(url, {
      ...options, headers, redirect: 'error', signal: options.signal ?? AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new ApiError(response.status);
    return response;
  }
  /** Calls the application's read-only readiness procedure through the gateway and returns DAB's rows. */
  async readiness(path: string): Promise<unknown[]> {
    const body: unknown = await (await this.request(path)).json();
    if (!body || typeof body !== 'object' || !('value' in body) || !Array.isArray(body.value)) {
      throw new Error('Invalid readiness procedure response');
    }
    return body.value;
  }
}
