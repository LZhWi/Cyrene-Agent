const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  json: "json",
  css: "css",
  scss: "scss",
  html: "markup",
  xml: "markup",
  md: "markdown",
  yml: "yaml",
  yaml: "yaml",
  sh: "bash",
  ps1: "powershell",
  py: "python",
  java: "java",
  go: "go",
  rs: "rust",
  c: "c",
  cpp: "cpp",
  cs: "csharp",
  php: "php",
  rb: "ruby",
  sql: "sql",
};

export function languageForCodeDiffPath(path: string): string {
  const filename = path.replace(/\\/g, "/").split("/").at(-1) ?? "";
  const extension = filename.includes(".") ? filename.split(".").at(-1)?.toLowerCase() : undefined;
  return extension ? LANGUAGE_BY_EXTENSION[extension] ?? "none" : "none";
}
