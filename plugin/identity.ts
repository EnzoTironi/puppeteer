/** Exact canonical handles; national numbers and fuzzy suffix matches are refused. */
export function canonicalHandle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  const phone = text.replace(/[\s().-]/g, "");
  if (/^\+[1-9]\d{6,14}$/.test(phone)) return phone;
  if (/^[^\s@<>]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(text)) return text.toLowerCase();
  return undefined;
}
