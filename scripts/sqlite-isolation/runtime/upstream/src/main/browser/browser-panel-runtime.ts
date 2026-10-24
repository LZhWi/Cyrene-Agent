import type { BrowserPanelController } from "./browser-panel-controller";

let currentController: BrowserPanelController | null = null;

export function setBrowserPanelController(controller: BrowserPanelController | null): void {
  currentController = controller;
}

export function getBrowserPanelController(): BrowserPanelController | null {
  return currentController;
}
