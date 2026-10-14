export function workspacePaste(data: DataTransfer) {
  const uriList = data.types.includes("text/uri-list") ? data.getData("text/uri-list") : "";
  const files = Array.from(data.files ?? []);
  if (!files.length) for (const item of Array.from(data.items ?? [])) {
    if (item.kind === "file") { const file = item.getAsFile(); if (file) files.push(file); }
  }
  if (uriList.split(/\r?\n/).some((line) => /^file:\/\//i.test(line.trim()))) return { kind: "uris" as const, uriList };
  // Preserve plain/rich text paste, including web pages with image data.
  if (data.types.includes("text/plain")) return null;
  if (files.some((file) => !file.type.startsWith("image/"))) return { kind: "files" as const, files };
  return null; // image-only paste stays on the existing screenshot path
}
