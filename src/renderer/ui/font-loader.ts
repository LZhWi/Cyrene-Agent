const GOOGLE_FONTS_URL = "https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap";

function loadRemoteFonts(): void {
  if (document.querySelector('link[data-cyrene-remote-fonts="true"]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = GOOGLE_FONTS_URL;
  link.dataset.cyreneRemoteFonts = "true";
  document.head.appendChild(link);
}

if (document.readyState === "complete") {
  loadRemoteFonts();
} else {
  window.addEventListener("load", loadRemoteFonts, { once: true });
}
