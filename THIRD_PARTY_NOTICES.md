# Third-party notices

## Git for Windows MinGit 2.55.0.3

Windows release builds include [Git for Windows MinGit 2.55.0.3](https://github.com/git-for-windows/git/releases/tag/v2.55.0.windows.3) only as a fallback when the user's system Git is unavailable. The archive is downloaded from the official Git for Windows release and SHA-256 verified before packaging.

Git for Windows and Git are distributed under GPL-2.0. The bundled MinGit archive retains its own license files. Source and license information are available from the [Git for Windows project](https://github.com/git-for-windows/git).

## Bundled UI fonts

The renderer includes JetBrains Mono 2.304 (normal weights 400 and 500) from the [official JetBrains repository](https://github.com/JetBrains/JetBrainsMono/tree/cd5227bd1f61dff3bbd6c814ceaf7ffd95e947d9) and Noto Sans SC 2.004 (Simplified Chinese regional variable font, used at weights 400–700) from the [official Noto CJK repository](https://github.com/notofonts/noto-cjk/tree/f8d157532fbfaeda587e826d4cd5b21a49186f7c). Both are distributed under the SIL Open Font License 1.1.

Complete upstream licenses, copyright statements, fixed source URLs, file sizes, SHA256 checksums and the Noto WOFF2 conversion details are retained in `src/renderer/public/fonts/`. Vite copies these files to `dist/renderer/fonts/`, which is included in the application package. The Noto conversion changes only the webfont container; it does not subset glyphs or alter weight axes. No online font service is required.
