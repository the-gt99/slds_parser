import { readFile } from "node:fs/promises";
import path from "node:path";

import type { FastifyInstance, FastifyReply } from "fastify";

const assets = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/classifier", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/assets/app.css", { file: "app.css", type: "text/css; charset=utf-8" }],
  ["/assets/admin-shell.js", { file: "admin-shell.js", type: "text/javascript; charset=utf-8" }],
  ["/assets/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/assets/classifier-rule-suggestions.js", { file: "classifier-rule-suggestions.js", type: "text/javascript; charset=utf-8" }],
  ["/assets/product.js", { file: "product.js", type: "text/javascript; charset=utf-8" }],
  ["/assets/admin-list.js", { file: "admin-list.js", type: "text/javascript; charset=utf-8" }],
  ["/assets/proxies.js", { file: "proxies.js", type: "text/javascript; charset=utf-8" }],
  ["/assets/content-templates.js", { file: "content-templates.js", type: "text/javascript; charset=utf-8" }],
  ["/assets/content-template-preview.js", { file: "content-template-preview.js", type: "text/javascript; charset=utf-8" }],
  ["/assets/export-control.js", { file: "export-control.js", type: "text/javascript; charset=utf-8" }],
  ["/assets/wordpress-catalog.js", { file: "wordpress-catalog.js", type: "text/javascript; charset=utf-8" }],
  ["/assets/wordpress-catalog-model.js", { file: "wordpress-catalog-model.js", type: "text/javascript; charset=utf-8" }],
  ["/products", { file: "admin-list.html", type: "text/html; charset=utf-8" }],
  ["/classifier-config", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/operations", { file: "admin-list.html", type: "text/html; charset=utf-8" }],
  ["/wordpress-snapshots", { file: "admin-list.html", type: "text/html; charset=utf-8" }],
  ["/runtime", { file: "admin-list.html", type: "text/html; charset=utf-8" }],
  ["/jobs", { file: "admin-list.html", type: "text/html; charset=utf-8" }],
  ["/proxies", { file: "proxies.html", type: "text/html; charset=utf-8" }],
  ["/content-templates", { file: "content-templates.html", type: "text/html; charset=utf-8" }],
  ["/export-control", { file: "export-control.html", type: "text/html; charset=utf-8" }],
  ["/wordpress-catalog", { file: "wordpress-catalog.html", type: "text/html; charset=utf-8" }],
] as const);

function securityHeaders(reply: FastifyReply): FastifyReply {
  return reply
    .header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    .header("X-Content-Type-Options", "nosniff")
    .header("Referrer-Policy", "no-referrer")
    .header("Cache-Control", "no-store");
}

export function registerStaticUi(server: FastifyInstance, publicDirectory = path.resolve(process.cwd(), "public")): void {
  for (const [route, asset] of assets) {
    server.get(route, async (_request, reply) => {
      const content = await readFile(path.join(publicDirectory, asset.file));
      return securityHeaders(reply)
        .type(asset.type)
        .send(content);
    });
  }

  server.get("/products/:productId", async (_request, reply) => {
    const content = await readFile(path.join(publicDirectory, "product.html"));
    return securityHeaders(reply)
      .type("text/html; charset=utf-8")
      .send(content);
  });
}
