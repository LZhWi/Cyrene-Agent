export const RENDERER_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https: local-sticker:",
  "media-src 'self' data: blob: https:",
  "font-src 'self' data: local-font: https://fonts.gstatic.com",
  "connect-src 'self' https: http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
].join("; ");

export function shouldProtectRendererDocument(urlValue: string): boolean {
  try {
    const url = new URL(urlValue);
    const pathname = url.pathname.replace(/\\/g, "/").toLowerCase();
    // GameBot is outside the requested audit and remains byte-for-byte compatible.
    return !pathname.includes("/gamebot/");
  } catch {
    return false;
  }
}
