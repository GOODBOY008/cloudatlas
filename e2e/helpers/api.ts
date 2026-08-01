/**
 * API client helper for E2E tests.
 * Wraps Playwright's APIRequestContext with CloudAtlas-specific methods.
 */
import { APIRequestContext } from '@playwright/test';

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:8080';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@acme.com';
const ADMIN_PASS = process.env.E2E_ADMIN_PASS ?? 'Password123!';

export class ApiClient {
  private token: string | null = null;

  constructor(private readonly request: APIRequestContext) {}

  private get headers() {
    return this.token
      ? { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/json' };
  }

  async authenticate(): Promise<string> {
    if (this.token) return this.token;
    const res = await this.request.post(`${API_URL}/api/v1/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASS },
    });
    if (!res.ok()) {
      throw new Error(`API login failed: ${res.status()} ${await res.text()}`);
    }
    const body = await res.json();
    // Login responds { data: { access_token } }; accept a flat body too.
    this.token = (body.data?.access_token ?? body.access_token) as string;
    if (!this.token) throw new Error('API login returned no access_token');
    return this.token;
  }

  async get<T = unknown>(path: string): Promise<T> {
    await this.authenticate();
    const res = await this.request.get(`${API_URL}${path}`, { headers: this.headers });
    if (!res.ok()) throw new Error(`GET ${path} failed: ${res.status()}`);
    return res.json() as Promise<T>;
  }

  async post<T = unknown>(path: string, data: unknown): Promise<T> {
    await this.authenticate();
    const res = await this.request.post(`${API_URL}${path}`, {
      data,
      headers: this.headers,
    });
    if (!res.ok()) throw new Error(`POST ${path} failed: ${res.status()} ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  /**
   * POST that does NOT throw on non-2xx — returns status + parsed body.
   * For asserting error contracts (409 conflict handles etc.).
   */
  async postRaw(path: string, data: unknown): Promise<{ status: number; body: any }> {
    await this.authenticate();
    const res = await this.request.post(`${API_URL}${path}`, {
      data,
      headers: this.headers,
    });
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* empty body */
    }
    return { status: res.status(), body };
  }

  async delete(path: string): Promise<void> {
    await this.authenticate();
    const res = await this.request.delete(`${API_URL}${path}`, { headers: this.headers });
    if (!res.ok()) throw new Error(`DELETE ${path} failed: ${res.status()}`);
  }

  /** Health check — used by CI wait script */
  async healthCheck(): Promise<boolean> {
    try {
      const res = await this.request.get(`${API_URL}/health`);
      return res.ok();
    } catch {
      return false;
    }
  }
}
