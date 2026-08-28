export {};

declare global {
  interface Window {
    cyrene: {
      minimize: () => void;
      hide: () => void;
      quit: () => void;
      setInteractive: (interactive: boolean) => Promise<void>;
      moveBy: (dx: number, dy: number) => void;
      moveTo: (x: number, y: number) => void;
      setDragging: (isDragging: boolean) => void;
      captureFrame: () => Promise<string | null>;
      getCursorPosition: () => Promise<{ x: number; y: number } | null>;
      getIdleState: () => Promise<{ systemIdleSeconds: number; screenNoChangeCount: number | null }>;
      onPetZoom: (callback: (zoom: number) => void) => () => void;
      onPetVisibilityChanged: (callback: (visible: boolean) => void) => () => void;
      onPetIdleMotionsChanged: (callback: (enabled: boolean) => void) => () => void;
    };
    holoCubicRenderer?: {
      ready: () => void;
      onInput: (callback: (payload: import("../../shared/holocubic-types").HoloCubicInputEvent) => void) => () => void;
    };
  }
}
