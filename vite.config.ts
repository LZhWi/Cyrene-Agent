import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  base: "./",
  build: {
    outDir: resolve(__dirname, "dist/renderer"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        renderer: resolve(__dirname, "src/renderer/index.html"),
        chat: resolve(__dirname, "src/renderer/chat/index.html"),
        sidebar: resolve(__dirname, "src/renderer/sidebar/index.html"),
        tasks: resolve(__dirname, "src/renderer/tasks/index.html"),
        settings: resolve(__dirname, "src/renderer/settings/index.html"),
        stickers: resolve(__dirname, "src/renderer/sticker-manager/index.html"),
        call: resolve(__dirname, "src/renderer/call/index.html"),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
