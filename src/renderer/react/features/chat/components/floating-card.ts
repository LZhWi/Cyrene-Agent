import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

export interface FloatingCardPosition { x: number; y: number }

export function clampFloatingCardPosition(
  position: FloatingCardPosition,
  card: { width: number; minVisibleHeight: number; minTop?: number },
  viewport: { width: number; height: number },
): FloatingCardPosition {
  const minTop = Math.min(Math.max(0, card.minTop ?? 0), Math.max(0, viewport.height - card.minVisibleHeight));
  return {
    x: Math.min(Math.max(0, position.x), Math.max(0, viewport.width - card.width)),
    y: Math.min(Math.max(minTop, position.y), Math.max(minTop, viewport.height - card.minVisibleHeight)),
  };
}

export function useFloatingCard(options: { width: number; top?: number; right?: number }) {
  const { width, top = 80, right = 24 } = options;
  const [collapsed, setCollapsed] = useState(false);
  const [position, setPosition] = useState<FloatingCardPosition>({
    x: typeof window !== "undefined" ? window.innerWidth - width - right : 0,
    y: top,
  });
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    initialX: number;
    initialY: number;
  } | null>(null);

  useEffect(() => {
    // These cards are position: fixed, so use the titlebar's viewport bottom,
    // not its height or the workspace's local coordinates.
    const titlebar = document.querySelector<HTMLElement>(".cy-workspace-titlebar");
    const clamp = (position: FloatingCardPosition) => clampFloatingCardPosition(position, {
      width, minVisibleHeight: 48, minTop: titlebar?.getBoundingClientRect().bottom ?? 0,
    }, { width: window.innerWidth, height: window.innerHeight });
    const updateBounds = () => setPosition((current) => clamp(current));
    updateBounds();
    const observer = titlebar ? new ResizeObserver(updateBounds) : null;
    if (titlebar) observer?.observe(titlebar);
    window.addEventListener("resize", updateBounds);
    const handleMove = (event: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) setIsDragging(true);
      setPosition(clamp({
        x: drag.initialX + dx,
        y: drag.initialY + dy,
      }));
    };
    const handleUp = () => {
      dragRef.current = null;
      window.setTimeout(() => setIsDragging(false), 0);
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateBounds);
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [width]);

  return {
    collapsed,
    position,
    toggle: () => setCollapsed((current) => !current),
    onHeaderMouseDown(event: ReactMouseEvent) {
      if ((event.target as HTMLElement).closest("[data-floating-toggle]")) return;
      dragRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        initialX: position.x,
        initialY: position.y,
      };
    },
    onHeaderClick() {
      if (!isDragging) setCollapsed((current) => !current);
    },
  };
}
