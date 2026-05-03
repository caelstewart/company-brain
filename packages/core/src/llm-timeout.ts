export function llmRequestTimeoutMs(): number | undefined {
  const parsed = Number(process.env.COMPANY_BRAIN_LLM_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export async function withLLMTimeout<T>(
  operation: Promise<T>,
  label: string,
  timeoutMs: number | undefined = llmRequestTimeoutMs(),
): Promise<T> {
  if (!timeoutMs) return operation;

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
