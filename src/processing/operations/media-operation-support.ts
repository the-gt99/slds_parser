export async function settleWithConcurrency<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  task: (value: Input) => Promise<Output>,
): Promise<readonly PromiseSettledResult<Output>[]> {
  const results: PromiseSettledResult<Output>[] = new Array(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      const value = values[index];
      if (value === undefined) continue;
      try {
        results[index] = { status: "fulfilled", value: await task(value) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export function fulfilledOrThrow<Value>(
  results: readonly PromiseSettledResult<Value>[],
  emptyMessage: string,
): Value[] {
  const fulfilled = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  if (fulfilled.length > 0) return fulfilled;
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure !== undefined) throw failure.reason;
  throw new Error(emptyMessage);
}
