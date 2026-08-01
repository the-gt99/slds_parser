import type { ProductOperationContext } from "../../contracts/index.js";
import type { ImageBinaryDownloader } from "../../processing/index.js";
import { GoatHttpClient, type GoatHttpEnvironment } from "./goat-http-client.js";

export class GoatImageDownloader implements ImageBinaryDownloader {
  readonly code = "goat-http";
  readonly version = "1.0.0";

  #client: GoatHttpClient | undefined;

  constructor(private readonly environment: GoatHttpEnvironment = process.env) {}

  async download(url: string, _context: ProductOperationContext): Promise<Buffer> {
    this.#client ??= new GoatHttpClient(this.environment);
    return await this.#client.getBuffer(url);
  }
}
