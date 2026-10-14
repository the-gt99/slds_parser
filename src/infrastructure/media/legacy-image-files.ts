import { opendir, lstat } from "node:fs/promises";
import { join } from "node:path";

export async function* legacyImageFiles(root: string, startDirectory?: string,
  stopping: () => boolean = () => false): AsyncGenerator<string> {
  let anchorSource: string | undefined;
  let anchorProduct: string | undefined;
  if (startDirectory !== undefined) {
    if (!/^[a-zA-Z0-9_-]+\/item_[a-zA-Z0-9_-]+$/u.test(startDirectory)) throw new Error("Invalid image resume directory");
    const info = await lstat(join(root, startDirectory));
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Image resume directory is not a regular directory");
    [anchorSource, anchorProduct] = startDirectory.split("/");
  }
  async function* files(source: string, product: string): AsyncGenerator<string> {
    const entries = await opendir(join(root, source, product));
    for await (const entry of entries) {
      if (stopping()) return;
      if (entry.isFile() && /^\d+(?:-main)?(?:\.[a-f0-9]{64})?\.webp$/u.test(entry.name)) yield `${source}/${product}/${entry.name}`;
    }
  }
  const sources = await opendir(root);
  for await (const source of sources) {
    if (stopping()) return;
    if (!source.isDirectory() || !/^[a-zA-Z0-9_-]+$/u.test(source.name)) continue;
    const anchor = source.name === anchorSource ? anchorProduct : undefined;
    let started = anchor === undefined;
    const products = await opendir(join(root, source.name));
    for await (const product of products) {
      if (stopping()) return;
      if (!product.isDirectory() || !/^item_[a-zA-Z0-9_-]+$/u.test(product.name)) continue;
      if (!started && product.name === anchor) started = true;
      if (started) yield* files(source.name, product.name);
    }
    if (anchor !== undefined) {
      if (!started) throw new Error("Image resume directory disappeared during enumeration");
      const prefix = await opendir(join(root, source.name));
      for await (const product of prefix) {
        if (stopping()) return;
        if (product.name === anchor) break;
        if (product.isDirectory() && /^item_[a-zA-Z0-9_-]+$/u.test(product.name)) yield* files(source.name, product.name);
      }
    }
  }
}
