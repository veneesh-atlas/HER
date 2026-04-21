"use client";

import { useEffect, useLayoutEffect, useRef, useCallback } from "react";

/**
 * ChatWindow — Plain scrollable conversation container.
 *
 * History note: an earlier version used `react-virtuoso` for virtualization,
 * which caused persistent scroll-pin races during streaming (every token
 * resized the bottom message; virtuoso ran its own scroll math at the same
 * time as our pin; visible jitter resulted no matter how we coalesced or
 * gated). Pagination already keeps mounted message count bounded (~50-150),
 * MessageBubble is React.memo'd, and modern browsers handle that just fine.
 *
 * Anchor preservation on prepend: when we prepend older messages to the top,
 * the browser does NOT automatically keep the user's view stable — the
 * content above grows and pushes the visible content down. We handle this
 * by snapshotting `scrollHeight` before items change and restoring
 * `scrollTop += delta` after the prepend lands.
 *
 * Streaming pin: we listen to the actual scroll event to maintain
 * `isAtBottomRef`. While true, we keep `scrollTop = scrollHeight` on every
 * `items` change. Because there's no virtualization library running its
 * own scroll math, there's nothing to race with → no jitter.
 */

interface ChatWindowProps<T> {
  /** The full list of items to render (messages). */
  items: T[];
  /** Stable unique key per item. */
  itemKey: (item: T) => string;
  /** Render function for a single item. */
  renderItem: (item: T, index: number) => React.ReactNode;
  /** Fired when the user scrolls to (or near) the top of the list. */
  onScrollNearTop?: () => void;
  /** Optional fixed header (empty state, breathing dot, etc.). */
  header?: React.ReactNode;
  /** Optional fixed footer (typing indicator, error toast). */
  footer?: React.ReactNode;
  /** Increment to force an unconditional scroll-to-bottom (sent message, switched conversation). */
  forceScrollTrigger?: number;
}

/** How close (in px) to the bottom counts as "at bottom" for the streaming pin. */
const AT_BOTTOM_THRESHOLD = 100;
/** How close (in px) to the top fires onScrollNearTop. */
const NEAR_TOP_THRESHOLD = 200;

export default function ChatWindow<T>({
  items,
  itemKey,
  renderItem,
  onScrollNearTop,
  header,
  footer,
  forceScrollTrigger,
}: ChatWindowProps<T>) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  /** Whether the user is currently within AT_BOTTOM_THRESHOLD of the bottom. */
  const isAtBottomRef = useRef(true);
  /** Throttle: don't fire onScrollNearTop more than once per 250ms. */
  const lastTopFireRef = useRef<number>(0);
  /**
   * For prepend anchor preservation. We snapshot scrollHeight BEFORE the
   * commit (in a layout effect that runs on every render) and compare
   * AFTER the commit to figure out how much content grew above the viewport.
   * If items grew but we weren't at the bottom, we restore relative position.
   */
  const prevScrollHeightRef = useRef(0);
  const prevItemCountRef = useRef(items.length);

  /** Scroll to the absolute bottom of the container. */
  const scrollToBottom = useCallback(() => {
    const node = scrollerRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, []);

  // ── Track at-bottom state from real scroll events + fire onScrollNearTop ──
  const handleScroll = useCallback(() => {
    const node = scrollerRef.current;
    if (!node) return;
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    isAtBottomRef.current = distanceFromBottom <= AT_BOTTOM_THRESHOLD;

    if (onScrollNearTop && node.scrollTop <= NEAR_TOP_THRESHOLD) {
      const now = Date.now();
      if (now - lastTopFireRef.current >= 250) {
        lastTopFireRef.current = now;
        onScrollNearTop();
      }
    }
  }, [onScrollNearTop]);

  // ── Force scroll on demand (sent message, switched conversation) ──
  // We schedule the scroll AND set a "settle window" — for the next 600ms,
  // any height growth (images loading, fonts swapping, MessageBubble children
  // mounting late) re-pins us to the bottom. Without the window the conversation
  // could appear to load at the top because scrollHeight at first paint was
  // smaller than after images settled.
  const settleUntilRef = useRef(0);
  useEffect(() => {
    if (!forceScrollTrigger) return;
    settleUntilRef.current = Date.now() + 600;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollToBottom();
        isAtBottomRef.current = true;
      });
    });
  }, [forceScrollTrigger, scrollToBottom]);

  // ── Stay pinned while content settles (images, fonts, late mounts) ──
  // ResizeObserver fires whenever the inner content height changes for any
  // reason — not just React re-renders. We use it to keep the bottom pinned
  // both during streaming (token-by-token growth) and during the post-load
  // settle window when async content (images) inflates the document.
  useEffect(() => {
    const node = scrollerRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (isAtBottomRef.current || Date.now() < settleUntilRef.current) {
        node.scrollTop = node.scrollHeight;
      }
    });
    // Observe the scroller's first child (the actual content wrapper).
    // If we observed `node` itself we'd only see clientHeight changes, not
    // scrollHeight changes.
    Array.from(node.children).forEach((c) => ro.observe(c));
    return () => ro.disconnect();
  }, []);

  /**
   * The big effect: handles BOTH streaming-pin (item content grew while we
   * were at the bottom) AND prepend-anchor (items were added above the
   * viewport while we were scrolled up reading history). Runs synchronously
   * after every items change, before paint, so the user never sees a flash
   * of mis-positioned content.
   */
  useLayoutEffect(() => {
    const node = scrollerRef.current;
    if (!node) return;

    const prevHeight = prevScrollHeightRef.current;
    const newHeight = node.scrollHeight;
    const prevCount = prevItemCountRef.current;
    const newCount = items.length;

    // Was the user at the bottom before this update? Pin them there.
    if (isAtBottomRef.current) {
      node.scrollTop = newHeight;
    } else if (newCount > prevCount && prevHeight > 0 && newHeight > prevHeight) {
      // Items were prepended (older messages loaded). Keep the user's
      // visual position stable by adding the height delta to scrollTop.
      // Heuristic: if message count grew AND total height grew, the new
      // content went somewhere; if we weren't at the bottom, it's almost
      // always a prepend (sends/streams happen at the bottom and would
      // have hit the isAtBottom branch).
      node.scrollTop += newHeight - prevHeight;
    }

    // Snapshot for next render.
    prevScrollHeightRef.current = newHeight;
    prevItemCountRef.current = newCount;
  }, [items]);

  /**
   * Clear text selection when tapping on whitespace / non-text areas.
   * Mirrors the prior behavior so mobile selection still dismisses
   * naturally when the user taps outside selectable text.
   */
  const handleContainerClick = useCallback((e: React.MouseEvent) => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const target = e.target as HTMLElement;
    if (
      target.closest(".msg-text-selectable") ||
      target.closest("button") ||
      target.closest("a") ||
      target.closest("input") ||
      target.closest("textarea")
    ) return;
    sel.removeAllRanges();
  }, []);

  return (
    <div
      ref={scrollerRef}
      onScroll={handleScroll}
      onClick={handleContainerClick}
      className="chat-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
      style={{ overscrollBehaviorY: "contain" }}
    >
      {header ? (
        <div className="mx-auto w-full max-w-[640px] px-3 pt-3 sm:px-5 sm:pt-6 md:px-6">
          {header}
        </div>
      ) : (
        <div className="pt-3 sm:pt-6" />
      )}

      {items.map((item, i) => (
        <div
          key={itemKey(item)}
          className="mx-auto w-full max-w-[640px] px-3 sm:px-5 md:px-6"
        >
          {renderItem(item, i)}
        </div>
      ))}

      {footer ? (
        <div className="mx-auto w-full max-w-[640px] px-3 pb-4 sm:px-5 sm:pb-5 md:px-6">
          {footer}
        </div>
      ) : (
        <div className="pb-4 sm:pb-5" />
      )}
    </div>
  );
}
