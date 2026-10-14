import { Bubble, type BubbleItemType, type BubbleListProps } from "@ant-design/x";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";

const OVERSCAN_ROWS = 6;
const ESTIMATED_ROW_HEIGHT = 160;

const rowListStyles: BubbleListProps["styles"] = {
  root: { minHeight: 0, maxHeight: "none" },
  scroll: { maxHeight: "none", overflowY: "visible" },
};

function VirtualBubbleRow({
  item,
  roles,
}: {
  item: BubbleItemType;
  roles: NonNullable<BubbleListProps["role"]>;
}) {
  const singleItem = useMemo(() => [item], [item]);
  // 保留 Bubble.List 的角色、插槽与状态处理；每行独立撑高，供虚拟器测量。
  return <Bubble.List items={singleItem} role={roles} autoScroll={false} styles={rowListStyles} />;
}

export function VirtualChatMessageList({
  items,
  roles,
  scrollRef,
  nearBottomRef,
  layoutKey,
}: {
  items: BubbleItemType[];
  roles: NonNullable<BubbleListProps["role"]>;
  scrollRef: RefObject<HTMLDivElement | null>;
  nearBottomRef: RefObject<boolean>;
  layoutKey: string | null;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const getScrollElement = useCallback(() => scrollRef.current, [scrollRef]);
  const getItemKey = useCallback((index: number) => items[index]?.key ?? index, [items]);
  const initialOffset = useCallback(() => scrollRef.current?.scrollTop ?? 0, [scrollRef]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement,
    getItemKey,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: OVERSCAN_ROWS,
    scrollMargin,
    initialOffset,
  });
  const totalSize = virtualizer.getTotalSize();
  const virtualRows = virtualizer.getVirtualItems();

  useLayoutEffect(() => {
    const list = listRef.current;
    const scroll = scrollRef.current;
    if (!list || !scroll) return;

    const updateScrollMargin = () => {
      const nextMargin = list.getBoundingClientRect().top
        - scroll.getBoundingClientRect().top
        + scroll.scrollTop;
      setScrollMargin((current) => current === nextMargin ? current : nextMargin);
    };
    updateScrollMargin();
    const observer = new ResizeObserver(updateScrollMargin);
    observer.observe(list);
    observer.observe(scroll);
    window.addEventListener("resize", updateScrollMargin);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateScrollMargin);
    };
  }, [items.length, layoutKey, scrollRef]);

  useLayoutEffect(() => {
    if (!nearBottomRef.current) return;
    const scroll = scrollRef.current;
    // 行高增长可能先触发滚动事件；在布局阶段贴底，避免误判为用户滚离底部。
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }, [items, nearBottomRef, scrollRef, totalSize]);

  return (
    <div ref={listRef} className="cy-message-list__virtual-list">
      <div className="cy-message-list__virtual-spacer" style={{ height: totalSize }}>
        {virtualRows.map((virtualRow) => {
          const item = items[virtualRow.index];
          if (!item) return null;
          return (
            <div
              key={virtualRow.key}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              className="cy-message-list__virtual-row"
              style={{ transform: `translateY(${virtualRow.start - scrollMargin}px)` }}
            >
              <VirtualBubbleRow item={item} roles={roles} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
