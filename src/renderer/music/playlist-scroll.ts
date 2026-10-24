/** 仅把纵向为主的滚轮转为歌单横向滚动；触控板横向手势保留原生行为。 */
export function wheelToHorizontalScroll(
  el: { scrollLeft: number; scrollWidth: number; clientWidth: number },
  deltaX: number,
  deltaY: number,
): number | null {
  if (el.scrollWidth <= el.clientWidth) return null;
  if (Math.abs(deltaY) <= Math.abs(deltaX)) return null;
  const max = el.scrollWidth - el.clientWidth;
  const next = Math.min(max, Math.max(0, el.scrollLeft + deltaY));
  return next === el.scrollLeft ? null : next;
}
