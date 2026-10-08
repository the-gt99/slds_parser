import type { ProductOperationContext } from "../../contracts/index.js";
import type { ImageBinaryDownloader } from "../../processing/index.js";
import type { ImageDownload, ImageRefreshClient, ImageValidators } from "../../processing/media/image-refresh-client.js";
import { IntegrationContractError } from "../../core/errors/index.js";
import { GoatHttpClient, type GoatHttpEnvironment } from "./goat-http-client.js";
import type { GoatProxyLease, GoatProxyPool } from "./goat-proxy-pool.js";

interface GoatImageHttpClient {
  getBuffer(url: string): Promise<Buffer>;
  getImage?: GoatHttpClient["getImage"];
}

export interface GoatImageDownloaderOptions {
  readonly concurrency: number;
}

export type GoatImageHttpClientFactory = (environment: GoatHttpEnvironment) => GoatImageHttpClient;
export type GoatImagePooledHttpClientFactory = (lease: GoatProxyLease, cookieJarSuffix: string) => GoatImageHttpClient;

export class GoatImageDownloader implements ImageBinaryDownloader, ImageRefreshClient {
  readonly code = "goat-http";
  readonly version = "1.2.0";

  readonly #clients: (GoatImageHttpClient | undefined)[];
  readonly #available: number[];
  readonly #waiters: ((slot: number) => void)[] = [];

  constructor(
    private readonly environment: GoatHttpEnvironment = process.env,
    private readonly options: GoatImageDownloaderOptions = { concurrency: 1 },
    private readonly clientFactory: GoatImageHttpClientFactory = (clientEnvironment) => new GoatHttpClient(clientEnvironment),
    private readonly proxyPool?: GoatProxyPool,
    private readonly pooledClientFactory: GoatImagePooledHttpClientFactory = (lease, cookieJarSuffix) => lease.client(cookieJarSuffix),
  ) {
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 16) {
      throw new Error("GOAT image transport concurrency must be an integer from 1 to 16");
    }
    this.#clients = new Array(options.concurrency);
    this.#available = Array.from({ length: options.concurrency }, (_, index) => index);
  }

  async download(url: string, _context: ProductOperationContext): Promise<Buffer> {
    return this.#request((client) => client.getBuffer(url));
  }

  async inspect(url: string, validators: ImageValidators): Promise<ImageValidators & { readonly unchanged: boolean }> {
    return this.#request(async (client) => {
      if (client.getImage === undefined) throw new IntegrationContractError("GOAT image refresh transport is not configured");
      const response = await client.getImage(url, validators, true);
      return { ...imageValidators(response.headers), unchanged: response.status === 304 };
    });
  }

  async downloadImage(url: string): Promise<ImageDownload> {
    return this.#request(async (client) => {
      if (client.getImage === undefined) throw new IntegrationContractError("GOAT image refresh transport is not configured");
      const response = await client.getImage(url);
      return { ...imageValidators(response.headers), body: response.body };
    });
  }

  async #request<T>(request: (client: GoatImageHttpClient) => Promise<T>): Promise<T> {
    const slot = await this.#acquire();
    try {
      const lease = await this.proxyPool?.acquireForImage();
      const started = Date.now();
      try {
        const result = await request(lease === undefined || lease === null
          ? this.#client(slot) : this.pooledClientFactory(lease, ".images"));
        await lease?.release(true, Date.now() - started);
        return result;
      } catch (error) {
        await lease?.release(false, Date.now() - started);
        throw error;
      }
    } finally {
      this.#release(slot);
    }
  }

  #client(slot: number): GoatImageHttpClient {
    const existing = this.#clients[slot];
    if (existing !== undefined) return existing;
    const baseCookieJar = this.environment.GOAT_COOKIE_JAR_PATH?.trim();
    const clientEnvironment = baseCookieJar === undefined || baseCookieJar === ""
      ? this.environment
      : { ...this.environment, GOAT_COOKIE_JAR_PATH: `${baseCookieJar}.images-${slot + 1}` };
    const created = this.clientFactory(clientEnvironment);
    this.#clients[slot] = created;
    return created;
  }

  #acquire(): Promise<number> {
    const slot = this.#available.shift();
    return slot === undefined ? new Promise((resolve) => this.#waiters.push(resolve)) : Promise.resolve(slot);
  }

  #release(slot: number): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#available.push(slot);
    else waiter(slot);
  }
}

function imageValidators(headers: Readonly<Record<string, string>> | undefined): ImageValidators {
  return {
    ...(headers?.etag ? { etag: headers.etag } : {}),
    ...(headers?.["last-modified"] ? { lastModified: headers["last-modified"] } : {}),
  };
}
