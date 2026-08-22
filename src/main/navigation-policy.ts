export type NavigationDecision = "allow" | "external" | "deny";

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function classifyNavigation(targetValue: string, currentValue: string): NavigationDecision {
  const target = parseUrl(targetValue);
  const current = parseUrl(currentValue);
  if (!target) return "deny";

  if (target.protocol === "http:" || target.protocol === "https:") {
    if (current && target.origin === current.origin) return "allow";
    return "external";
  }

  if (target.protocol === "mailto:" || target.protocol === "tel:") {
    return "external";
  }

  if (target.protocol === "file:" && current?.protocol === "file:") {
    return target.pathname === current.pathname ? "allow" : "deny";
  }

  return "deny";
}
