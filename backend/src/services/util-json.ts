/**
 * Extracts a JSON object/array from a model response that may wrap it in
 * ```json fences``` or include prose. Returns null on failure.
 */
export function extractJson<T = unknown>(raw: string): T | null {
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  try {
    return JSON.parse(candidate) as T;
  } catch {
    const start = candidate.search(/[[{]/);
    if (start === -1) return null;
    const end = Math.max(
      candidate.lastIndexOf("]"),
      candidate.lastIndexOf("}"),
    );
    if (end < start) return null;
    try {
      return JSON.parse(candidate.slice(start, end + 1)) as T;
    } catch {
      return null;
    }
  }
}
