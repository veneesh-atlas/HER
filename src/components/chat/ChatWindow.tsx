"use client";

import { useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { Virtuoso } from "react-virtuoso";

/**
 * ChatWindow — Virtualized scrollable conversation container.
 *
 * Why virtualization: long conversations (hundreds of messages) used to
 * crash mobile WebView with "this page couldn't load" because every
 * MessageBubble carried touch listeners, refs, and gesture state.
 * react-virtuoso renders only the ~20 messages visible in the viewport
 * (plus a small overscan), so memory stays constant no matter how far
 * back the user scrolls.
 *
 * Anchor preservation on prepend: we use Virtuoso's `firstItemIndex`
 * trick — start with a large constant base, decrement by the number of
 * messages prepended each time. Virtuoso uses this signal to keep the
 * user's scroll position stable when older content lands above.
 */

interface ChatWindowProps<T> {
  /** The full list of items to render (messages). */
  items: T[];
  /** Stable unique key per item. */
  itemKey: (item: T) => string;
  /** Render function for a single item. */
  renderItem: (item: T, index: number) => React.ReactNode;
  /**
   * `firstItemIndex` for Virtuoso's anchor preservation when prepending
   * older messages. Parent should track a `prependedCount` and pass
   * `INITIAL_TOP_INDEX - prependedCount`.
   * Defaults to INITIAL_TOP_INDEX (no prepend yet).
   */
  firstItemIndex?: number;
  /** Fired when the user scrolls to (or near) the top of the list. */
  onScrollNearTop?: () => void;
  /** Optional fixed header (empty state, breathing dot, etc.). */
  header?: React.ReactNode;
  /** Optional fixed footer (typing indicator, error toast). */
  footer?: React.ReactNode;
  /** Increment to force an unconditional scroll-to-bottom (sent message, switched conversation). */
  forceScrollTrigger?: number;
}

/**
 * Large base for `firstItemIndex` — Virtuoso requires this for anchor
 * preservation on prepend. Parent decrements from this value by the
 * number of older messages prepended via "load older".
 */
export const INITIAL_TOP_INDEX = 1_000_000;

export default function ChatWindow<T>({
  items,
  itemKey,
  renderItem,
  firstItemIndex = INITIAL_TOP_INDEX,
  onScrollNearTop,
  header,
  footer,
  forceScrollTrigger,
}: ChatWindowProps<T>) {
  /**
   * The actual DOM element virtuoso uses as its scroll container. We grab
   * this via the `scrollerRef` prop and scroll it directly with scrollTop
   * instead of using virtuoso's scrollToIndex API. Index-based scrolling
   * was unreliable while messages were growing mid-stream because virtuoso's
   * internal item-height cache lagged the DOM by one resize.
   */
  const scrollerRef = useRef<HTMLElement | Window | null>(null);
  /**
   * Whether the user is currently within `atBottomThreshold` of the bottom.
   * Updated by virtuoso's atBottomStateChange. Gates our streaming pin so
   * a user who has scrolled up to read is never yanked back.
   */
  const atBottomRef = useRef(true);
  /** Throttle: don't fire onScrollNearTop more than once per 250ms. */
  const lastTopFireRef = useRef<number>(0);
  /**
   * Pending rAF id for streaming auto-scroll. We coalesce rapid token
   * updates into a single scroll-to-bottom per animation frame so we don't
   * fight virtuoso's own internal scroll adjustments, which used to produce
   * a visible up/down jitter while a message was streaming.
   */
  const pendingScrollRafRef = useRef<number | null>(null);

  /**
   * Scroll the underlying DOM container to the bottom — but only if we're
   * not already there (within 2px). Skipping the no-op write avoids the
   * jitter that came from racing with virtuoso's internal layout writes.
   */
  const scrollToBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (!el || el === window) return;
    const node = el as HTMLElement;
    const target = node.scrollHeight - node.clientHeight;
    if (target - node.scrollTop > 2) {
      node.scrollTop = target;
    }
  }, []);

  // ── Force scroll on demand (sent message, switched conversation) ──
  useEffect(() => {
    if (!forceScrollTrigger) return;
    // Two rAFs so React commit + browser layout both finish before we measure.
    requestAnimationFrame(() => {
      requestAnimationFrame(scrollToBottom);
    });
  }, [forceScrollTrigger, scrollToBottom]);

  // ── Streaming auto-scroll ──
  // Coalesces rapid `items` changes (one per streaming token) into a single
  // scroll-to-bottom per animation frame. Without this, our scrollTop write
  // raced with virtuoso's own internal scroll adjustments token-for-token,
  // producing visible jitter (looked like the page was "trying to scroll up
  // and down simultaneously" while HER was typing).
  // Gated on atBottomRef (updated by virtuoso with atBottomThreshold=200)
  // so the pin never overrides a user who scrolled up to read.
  useLayoutEffect(() => {
    if (!atBottomRef.current) return;
    if (pendingScrollRafRef.current !== null) return; // one pending scroll is enough
    pendingScrollRafRef.current = requestAnimationFrame(() => {
      pendingScrollRafRef.current = null;
      scrollToBottom();
    });
  }, [items, scrollToBottom]);

  // Cancel any pending scroll on unmount.
  useEffect(() => {
    return () => {
      if (pendingScrollRafRef.current !== null) {
        cancelAnimationFrame(pendingScrollRafRef.current);
        pendingScrollRafRef.current = null;
      }
    };
  }, []);

  // ── Top-reached handler with light throttle ──
  // Parent already guards re-entry via its own `loadingOlder` flag, so this
  // throttle is just to coalesce rapid scroll wheel events — not to gate
  // load attempts. 250ms keeps subsequent scroll-to-top flicks responsive.
  const handleStartReached = useCallback(() => {
    if (!onScrollNearTop) return;
    const now = Date.now();
    if (now - lastTopFireRef.current < 250) return;
    lastTopFireRef.current = now;
    onScrollNearTop();
  }, [onScrollNearTop]);

  // ── Track near-bottom state for the streaming pin above ──
  const handleAtBottomChange = useCallback((bottom: boolean) => {
    atBottomRef.current = bottom;
  }, []);

  /**
   * Clear text selection when tapping on whitespace / non-text areas.
   * Mirrors the prior ChatWindow behavior so mobile selection still
   * dismisses naturally when the user taps outside selectable text.
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

  /**
   * Centered conversation column wrapper applied to every item.
   * Matches the prior `mx-auto w-full max-w-[640px] px-3 …` styling
   * so message bubbles keep their reading-friendly column width.
   */
  const renderItemWrapped = useCallback(
    (_index: number, item: T) => (
      <div
        key={itemKey(item)}
        className="mx-auto w-full max-w-[640px] px-3 sm:px-5 md:px-6"
      >
        {renderItem(item, _index - firstItemIndex)}
      </div>
    ),
    [itemKey, renderItem, firstItemIndex]
  );

  // Header and footer are also constrained to the same column.
  const HeaderComp = useCallback(
    () =>
      header ? (
        <div className="mx-auto w-full max-w-[640px] px-3 pt-3 sm:px-5 sm:pt-6 md:px-6">
          {header}
        </div>
      ) : (
        <div className="pt-3 sm:pt-6" />
      ),
    [header]
  );

  const FooterComp = useCallback(
    () =>
      footer ? (
        <div className="mx-auto w-full max-w-[640px] px-3 pb-4 sm:px-5 sm:pb-5 md:px-6">
          {footer}
        </div>
      ) : (
        <div className="pb-4 sm:pb-5" />
      ),
    [footer]
  );

  return (
    <div
      className="chat-scroll flex min-h-0 flex-1 flex-col"
      onClick={handleContainerClick}
    >
      <Virtuoso
        scrollerRef={(el) => { scrollerRef.current = el; }}
        data={items}
        firstItemIndex={firstItemIndex}
        initialTopMostItemIndex={Math.max(items.length - 1, 0)}
        atBottomStateChange={handleAtBottomChange}
        atBottomThreshold={200}
        startReached={handleStartReached}
        itemContent={renderItemWrapped}
        components={{ Header: HeaderComp, Footer: FooterComp }}
        increaseViewportBy={{ top: 600, bottom: 400 }}
        style={{ height: "100%" }}
      />
    </div>
  );
}
