/** Bound local waiting even when a transport does not implement cancellation. */
export async function withAbort<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error("Private request cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try { const value = await Promise.race([pending, cancelled]); signal.throwIfAborted(); return value; }
  finally { signal.removeEventListener("abort", abort); }
}

export async function receiveResponse(pending: Promise<Response>, signal?: AbortSignal): Promise<Response> {
  let received: Response | undefined;
  const discard = () => { void received?.body?.cancel().catch(() => undefined); };
  const observed = pending.then((response) => {
    received = response;
    if (signal?.aborted) { discard(); signal.throwIfAborted(); }
    return response;
  });
  try { return await withAbort(observed, signal); }
  catch (error) { if (signal?.aborted) discard(); throw error; }
}

export async function boundedJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  const limit = 1_600_000;
  if (!response.body) throw new Error();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (Number(response.headers.get("content-length")) > limit) throw new Error();
    for (;;) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error();
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
