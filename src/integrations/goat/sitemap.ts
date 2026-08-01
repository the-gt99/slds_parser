import { gunzipSync } from "node:zlib";

import { SaxesParser } from "saxes";

import type { JsonObject } from "../../contracts/index.js";
import { IntegrationContractError } from "../../core/errors/index.js";

export interface GoatSitemapProduct {
  readonly slug: string;
  readonly url: string;
  readonly route: "sneakers" | "apparel";
  readonly lastmod?: string;
  readonly title?: string;
  readonly images: readonly string[];
}

function xmlText(buffer: Buffer): string {
  const uncompressed = buffer[0] === 0x1f && buffer[1] === 0x8b ? gunzipSync(buffer) : buffer;
  return uncompressed.toString("utf8");
}

interface XmlEntry { loc?: string; lastmod?: string; title?: string; images: string[] }

function entries(buffer: Buffer, entryName: "sitemap" | "url"): XmlEntry[] {
  const result: XmlEntry[] = [];
  const parser = new SaxesParser({ xmlns: true });
  let entry: XmlEntry | undefined;
  let field: "loc" | "lastmod" | "title" | "image" | undefined;
  let text = "";
  parser.on("opentag", (tag) => {
    if (tag.local === entryName) entry = { images: [] };
    if (!entry) return;
    if (tag.local === "loc") field = tag.prefix === "image" ? "image" : "loc";
    else if (tag.local === "lastmod") field = "lastmod";
    else if (tag.local === "title" && tag.prefix === "image") field = "title";
    if (field) text = "";
  });
  parser.on("text", (value) => { if (field) text += value; });
  parser.on("cdata", (value) => { if (field) text += value; });
  parser.on("closetag", (tag) => {
    if (entry && field && ((field === "image" && tag.local === "loc") || (field !== "image" && tag.local === field))) {
      const value = text.trim();
      if (field === "image") { if (value) entry.images.push(value); }
      else if (value) entry[field] = value;
      field = undefined;
    }
    if (tag.local === entryName && entry) { result.push(entry); entry = undefined; field = undefined; }
  });
  try { parser.write(xmlText(buffer)).close(); } catch (cause) {
    throw new IntegrationContractError("GOAT sitemap XML is malformed", { cause });
  }
  return result;
}

export function parseSitemapIndex(buffer: Buffer): string[] {
  return entries(buffer, "sitemap").flatMap((entry) => entry.loc && /sitemap_(?:sneakers|apparel)[^/]*\.xml(?:\.gz)?(?:\?|$)/i.test(entry.loc) ? [entry.loc] : []);
}

export function parseProductSitemap(buffer: Buffer): GoatSitemapProduct[] {
  return entries(buffer, "url").flatMap((entry) => {
    if (!entry.loc) return [];
    let url: URL;
    try { url = new URL(entry.loc); } catch { return []; }
    const match = url.pathname.match(/^\/(sneakers|apparel)\/([^/]+)\/?$/);
    if (!match?.[1] || !match[2]) return [];
    const route = match[1] as "sneakers" | "apparel";
    const metadata: GoatSitemapProduct = { slug: decodeURIComponent(match[2]), url: url.toString(), route, images: entry.images,
      ...(entry.lastmod ? { lastmod: entry.lastmod } : {}), ...(entry.title ? { title: entry.title } : {}) };
    return [metadata];
  });
}

export function sitemapMetadata(product: GoatSitemapProduct): JsonObject {
  return { route: product.route, images: product.images, ...(product.lastmod ? { lastmod: product.lastmod } : {}), ...(product.title ? { title: product.title } : {}) };
}
