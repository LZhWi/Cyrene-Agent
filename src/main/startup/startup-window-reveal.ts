export interface StartupWindowLike {
  close(): void;
  isDestroyed(): boolean;
  isVisible(): boolean;
  show(): void;
}

export interface RevealStartupWindowsOptions {
  splashWindow: StartupWindowLike;
  petWindow: StartupWindowLike;
  petVisible: boolean;
  markStartupReady(): void;
}

export function revealStartupWindows(options: RevealStartupWindowsOptions): void {
  if (!options.splashWindow.isDestroyed()) {
    options.splashWindow.close();
  }
  if (
    options.petVisible
    && !options.petWindow.isDestroyed()
    && !options.petWindow.isVisible()
  ) {
    options.petWindow.show();
  }
  options.markStartupReady();
}
