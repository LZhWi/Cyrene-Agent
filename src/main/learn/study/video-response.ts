import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

/** A bounded local stream with byte ranges, so seeking does not load the whole video. */
export async function videoResponse(file: string, request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
  const size = (await stat(file)).size;
  const headers = new Headers({ "Accept-Ranges": "bytes", "Content-Type": path.extname(file).toLowerCase() === ".webm" ? "video/webm" : path.extname(file).toLowerCase() === ".ogv" ? "video/ogg" : "video/mp4" });
  const range = request.headers.get("range");
  let start = 0; let end = size - 1;
  if (range) {
    const match = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    if (match[1]) { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : end; }
    else { start = Math.max(0, size - Number(match[2])); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  }
  headers.set("Content-Length", String(Math.max(0, end - start + 1)));
  const body = request.method === "HEAD" || size === 0 ? null : Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>;
  return new Response(body, { status: range ? 206 : 200, headers });
}
