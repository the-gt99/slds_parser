export async function* legacyImageBatches(paths: AsyncIterable<string>, concurrency: number,
  maximumBytes: number, sizeOf: (path: string) => Promise<number>): AsyncGenerator<string[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 256
    || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error("Invalid image batch limits");
  let batch: string[] = [];
  let bytes = 0;
  for await (const path of paths) {
    const size = await sizeOf(path);
    if (!Number.isSafeInteger(size) || size < 0 || size > maximumBytes) throw new Error("Image exceeds batch byte limit; retained");
    if (batch.length > 0 && bytes + size > maximumBytes) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(path);
    bytes += size;
    if (batch.length >= concurrency) {
      yield batch;
      batch = [];
      bytes = 0;
    }
  }
  if (batch.length > 0) yield batch;
}
