import { Message } from "@/lib/types";
import { isTouchDevice } from "@/lib/utils";
import { memo, useState, useRef, useCallback, type TouchEvent as ReactTouchEvent } from "react";

/**
 * MessageBubble — A single message in the conversation.
 * User messages: warm terracotta tint, aligned right.
 * HER messages: creamy neutral, aligned left with subtle label.
 * Feels like handwritten notes exchanged between two people.
 *
 * Reply gesture:
 *  • Mobile — swipe right on any message (WhatsApp-style)
 *  • Desktop — hover to reveal a "reply" button below the bubble
 */

/** Swipe threshold in px — past this triggers reply */
const SWIPE_THRESHOLD = 60;
/** Max visual slide distance */
const SWIPE_MAX = 80;

interface MessageBubbleProps {
  message: Message;
  showTimestamp?: boolean;
  index?: number;
  /** True when this message is actively being streamed */
  isStreaming?: boolean;
  /** Image action callbacks — only for messages with generated images */
  imageActions?: {
    onDownload?: (imageUrl: string) => void;
    onCopyPrompt?: () => void;
    onReusePrompt?: () => void;
    onUseAsEditSource?: (imageUrl: string) => void;
  };
  /** Dynamic thinking state label from surface copy bundle */
  thinkingLabel?: string;
  /** Called when user wants to reply to this message */
  onReply?: (message: Message) => void;
  /** Called when user reacts to a message with an emoji */
  onReaction?: (messageId: string, emoji: string, reactor: "user" | "her") => void;
}

/** Truncate text for quote preview */
function truncateQuote(text: string, max = 80): string {
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + "…";
}

/** Curated emoji set — small, expressive, fits the vibe */
const REACTION_EMOJIS = ["❤️", "😂", "😮", "😢", "🔥", "👏"];

/** Long-press duration in ms to trigger emoji tray on mobile */
const LONG_PRESS_MS = 400;

function MessageBubbleInner({ message, showTimestamp = false, index = 0, isStreaming = false, imageActions, thinkingLabel, onReply, onReaction }: MessageBubbleProps) {
  const isUser = message.role === "user";
  const hasImage = !!message.image;
  const hasText = message.content.length > 0 && message.content !== "(shared a photo)";
  const isShort = !hasImage && message.content.length <= 40;
  const isLong = !hasImage && message.content.length > 600;
  const isEmptyStreaming = isStreaming && !hasImage;
  const isThinkingState = isEmptyStreaming && message.content.length <= 40;
  const isImageLoading = !!message.imageLoading;
  const isGeneratedImage = hasImage && !isUser;
  const showActions = isGeneratedImage && !isImageLoading && imageActions;
  const hasReplyTo = !!message.replyTo;
  const canReply = !!onReply && !isStreaming && !isThinkingState && !isImageLoading;
  const canReact = !!onReaction && !isStreaming && !isThinkingState && !isImageLoading;

  const [copied, setCopied] = useState(false);
  const [showReplyBtn, setShowReplyBtn] = useState(false);
  const [showEmojiTray, setShowEmojiTray] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const emojiHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);

  // Close emoji tray if streaming starts (prevents ghost tray during rapid state changes)
  if (isStreaming && showEmojiTray) {
    setShowEmojiTray(false);
  }

  // ── Swipe-to-reply state (touch only) ──
  const [swipeX, setSwipeX] = useState(0);
  const [isSwiping, setIsSwiping] = useState(false);
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const swipeLockedRef = useRef<"horizontal" | "vertical" | null>(null);
  const swipeTriggeredRef = useRef(false);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const emojiInputRef = useRef<HTMLInputElement>(null);

  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  /** Show reply button + emoji tray on hover (desktop only), auto-hide after 3s */
  const revealReply = useCallback(() => {
    if (isTouchDevice()) return;
    if (canReply) {
      setShowReplyBtn(true);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setShowReplyBtn(false), 3000);
    }
    if (canReact) {
      setShowEmojiTray(true);
      if (emojiHideTimer.current) clearTimeout(emojiHideTimer.current);
      emojiHideTimer.current = setTimeout(() => setShowEmojiTray(false), 3000);
    }
  }, [canReply, canReact]);

  /** Hide desktop tray on mouse leave */
  const hideDesktopActions = useCallback(() => {
    if (isTouchDevice()) return;
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setShowReplyBtn(false), 600);
    if (emojiHideTimer.current) clearTimeout(emojiHideTimer.current);
    emojiHideTimer.current = setTimeout(() => setShowEmojiTray(false), 600);
  }, []);

  /** Handle an emoji tap — toggle reaction and close tray */
  const handleEmojiPick = useCallback((emoji: string) => {
    if (!onReaction) return;
    onReaction(message.id, emoji, "user");
    setShowEmojiTray(false);
    // Light haptic on mobile
    if (isTouchDevice() && navigator.vibrate) navigator.vibrate(8);
  }, [onReaction, message.id]);

  /** Open the native emoji keyboard via hidden input */
  const openCustomEmoji = useCallback(() => {
    emojiInputRef.current?.focus();
  }, []);

  /** Handle custom emoji typed/picked from native keyboard */
  const handleCustomEmojiInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (!val) return;
    // Extract the first emoji (grapheme cluster) from whatever was typed
    const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(val)];
    const firstChar = segments[0]?.segment;
    if (firstChar) {
      // Check it's actually an emoji (not a regular letter/number)
      const emojiRegex = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/u;
      if (emojiRegex.test(firstChar)) {
        handleEmojiPick(firstChar);
      }
    }
    // Always clear the input
    e.target.value = "";
    emojiInputRef.current?.blur();
  }, [handleEmojiPick]);

  /** Scroll to the quoted message */
  const scrollToQuoted = useCallback(() => {
    if (!message.replyTo) return;
    const el = document.getElementById(`msg-${message.replyTo.id}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("reply-highlight");
      setTimeout(() => el.classList.remove("reply-highlight"), 1200);
    }
  }, [message.replyTo]);

  // ── Touch handlers for swipe-to-reply ──

  const handleTouchStart = useCallback((e: ReactTouchEvent) => {
    const touch = e.touches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now() };
    swipeLockedRef.current = null;
    swipeTriggeredRef.current = false;
    longPressFired.current = false;

    // Don't start long-press emoji timer if the user is touching selectable text.
    // This lets the native text selection / copy menu work normally.
    const target = e.target as HTMLElement;
    const isTextContent = target.closest(".msg-text-selectable") !== null;

    // Start long-press timer for emoji tray (mobile) — but only on non-text areas
    if (canReact && !isTextContent) {
      if (longPressTimer.current) clearTimeout(longPressTimer.current);
      longPressTimer.current = setTimeout(() => {
        longPressFired.current = true;
        setShowEmojiTray(true);
        // Haptic feedback
        if (navigator.vibrate) navigator.vibrate(15);
      }, LONG_PRESS_MS);
    }
  }, [canReact]);

  const handleTouchMove = useCallback((e: ReactTouchEvent) => {
    if (!touchStartRef.current) return;
    const touch = e.touches[0];
    const dx = touch.clientX - touchStartRef.current.x;
    const dy = touch.clientY - touchStartRef.current.y;

    // Cancel long-press if finger moved significantly
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
      if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
    }

    // If long-press already fired (emoji tray open), don't do swipe
    if (longPressFired.current) return;
    if (!canReply) return;

    // Determine direction lock on first significant movement
    if (!swipeLockedRef.current) {
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);
      if (absDx < 8 && absDy < 8) return; // still in dead zone
      swipeLockedRef.current = absDx > absDy ? "horizontal" : "vertical";
    }

    // If scrolling vertically, bail out
    if (swipeLockedRef.current === "vertical") return;

    // Only allow swipe right (positive dx)
    if (dx <= 0) {
      setSwipeX(0);
      setIsSwiping(false);
      return;
    }

    // Clamp and apply rubber-band feel past max
    const clamped = dx > SWIPE_MAX
      ? SWIPE_MAX + (dx - SWIPE_MAX) * 0.2
      : dx;

    setSwipeX(clamped);
    setIsSwiping(true);

    // Haptic-like: mark as triggered when crossing threshold
    if (dx >= SWIPE_THRESHOLD && !swipeTriggeredRef.current) {
      swipeTriggeredRef.current = true;
      // Light vibration on supported devices
      if (navigator.vibrate) navigator.vibrate(10);
    }
    if (dx < SWIPE_THRESHOLD) {
      swipeTriggeredRef.current = false;
    }
  }, [canReply]);

  const handleTouchEnd = useCallback(() => {
    // Cancel long-press timer
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }

    if (!touchStartRef.current) return;

    // If long-press opened the emoji tray, don't do swipe action
    if (longPressFired.current) {
      touchStartRef.current = null;
      return;
    }

    // If we crossed the threshold, fire reply
    if (swipeTriggeredRef.current && onReply) {
      onReply(message);
    }

    // Animate back to 0
    setIsSwiping(false);
    setSwipeX(0);
    touchStartRef.current = null;
    swipeLockedRef.current = null;
    swipeTriggeredRef.current = false;
  }, [onReply, message]);

  /** Reply icon opacity — fades in as you swipe, full at threshold */
  const replyIconOpacity = Math.min(swipeX / SWIPE_THRESHOLD, 1);
  /** Reply icon scale — grows as you approach threshold */
  const replyIconScale = 0.5 + Math.min(swipeX / SWIPE_THRESHOLD, 1) * 0.5;

  return (
    <div
      id={`msg-${message.id}`}
      className={`group/msg relative mb-5 flex flex-col sm:mb-6 ${
        isUser ? "animate-message-in items-end" : "animate-assistant-in items-start"
      }`}
      style={{ animationDelay: `${Math.min(index * 30, 150)}ms`, animationFillMode: "backwards" }}
      onMouseEnter={revealReply}
      onMouseLeave={hideDesktopActions}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Swipe reply icon — peeks from left edge during swipe gesture */}
      {isSwiping && swipeX > 5 && (
        <div
          className="pointer-events-none absolute left-0 top-1/2 z-10 flex -translate-y-1/2 items-center justify-center"
          style={{
            opacity: replyIconOpacity,
            transform: `translateY(-50%) scale(${replyIconScale})`,
          }}
        >
          <div className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors duration-100 ${
            swipeTriggeredRef.current ? "bg-her-accent/20 text-her-accent/70" : "bg-her-surface/80 text-her-text-muted/40"
          }`}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4 -scale-x-100">
              <path d="M1.75 1.002a.75.75 0 1 0 0 1.5h6.5a3.75 3.75 0 0 1 0 7.5h-3.44l1.72-1.72a.75.75 0 0 0-1.06-1.06l-3 3a.75.75 0 0 0 0 1.06l3 3a.75.75 0 1 0 1.06-1.06l-1.72-1.72h3.44a5.25 5.25 0 0 0 0-10.5h-6.5Z" />
            </svg>
          </div>
        </div>
      )}

      {/* Swipeable content wrapper */}
      <div
        ref={bubbleRef}
        className="flex w-full flex-col"
        style={{
          transform: swipeX > 0 ? `translateX(${swipeX}px)` : undefined,
          transition: isSwiping ? "none" : "transform 0.3s cubic-bezier(0.2, 0, 0, 1)",
          ...(isUser ? { alignItems: "flex-end" } : { alignItems: "flex-start" }),
        }}
      >
      {/* Sender label — only for HER */}
      {!isUser && (
        <span className="mb-1.5 ml-0.5 text-[9px] font-medium tracking-[0.18em] uppercase text-her-accent/40 sm:text-[10px]">
          her
        </span>
      )}

      {/* Bubble */}
      <div
        className={`message-content rounded-[20px] sm:rounded-[22px] ${
          isImageLoading && !hasImage
            ? "max-w-[80%] overflow-hidden p-1.5 sm:max-w-[70%] sm:p-2 md:max-w-[55%]"
            : hasImage && !hasText
            ? "max-w-[75%] overflow-hidden p-1.5 sm:max-w-[65%] sm:p-2 md:max-w-[50%]"
            : hasImage && hasText
            ? "max-w-[85%] overflow-hidden p-1.5 sm:max-w-[80%] sm:p-2 md:max-w-[70%]"
            : isShort
            ? "max-w-[75%] px-[18px] py-[11px] sm:max-w-[65%] sm:px-5 sm:py-3 md:max-w-[50%]"
            : isLong
            ? "max-w-[88%] px-[18px] py-[14px] sm:max-w-[82%] sm:px-5 sm:py-4 md:max-w-[75%]"
            : "max-w-[85%] px-[18px] py-[13px] sm:max-w-[80%] sm:px-5 sm:py-[15px] md:max-w-[70%]"
        } ${
          isUser
            ? "rounded-br-md bg-her-user-bubble/75 text-her-text shadow-[0_1px_6px_rgba(180,140,110,0.06)]"
            : "rounded-bl-md bg-her-ai-bubble/80 text-her-text shadow-[0_1px_6px_rgba(180,140,110,0.05),0_0_0_0.5px_rgba(221,208,194,0.15)]"
        }`}
      >
        {/* Reply quote preview — shown when this message replies to another */}
        {hasReplyTo && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); scrollToQuoted(); }}
            aria-label={`View original message from ${message.replyTo!.role === "user" ? "you" : "her"}`}
            className={`mb-1.5 flex w-full cursor-pointer items-start gap-2 rounded-[12px] px-3 py-2 text-left transition-colors duration-200 ${
              isUser
                ? "bg-her-text/[0.04] hover:bg-her-text/[0.07]"
                : "bg-her-surface/40 hover:bg-her-surface/60"
            }`}
          >
            <div className={`mt-0.5 h-full w-[2.5px] shrink-0 self-stretch rounded-full ${
              message.replyTo!.role === "user" ? "bg-her-accent/40" : "bg-her-text-muted/25"
            }`} />
            <div className="min-w-0 flex-1">
              <span className="block text-[10px] font-medium tracking-[0.06em] text-her-text-muted/45">
                {message.replyTo!.role === "user" ? "you" : "her"}
              </span>
              <span className="block truncate text-[11px] leading-[1.45] text-her-text-muted/55 sm:text-[12px]">
                {truncateQuote(message.replyTo!.content)}
              </span>
            </div>
          </button>
        )}

        {/* Image loading placeholder — soft frame with presence */}
        {isImageLoading && !hasImage && (
          <div
            className="relative flex w-full items-center justify-center overflow-hidden rounded-[16px] bg-her-surface/60 sm:rounded-[18px]"
            style={{ aspectRatio: "4 / 3", maxHeight: "320px" }}
            role="status"
            aria-label="Generating image"
          >
            {/* Subtle shimmer overlay */}
            <div className="animate-image-shimmer absolute inset-0" />
            {/* Centered presence indicator */}
            <div className="relative z-10 flex flex-col items-center gap-3">
              <div className="animate-presence-breathe h-[7px] w-[7px] rounded-full bg-her-accent/45" />
              {hasText && (
                <span className="text-[11px] tracking-[0.04em] text-her-text-muted/30 italic">
                  {message.content}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Image — user-attached or AI-generated */}
        {hasImage && (
          <img
            src={message.image}
            alt={isGeneratedImage ? "Generated image" : "Shared photo"}
            className={`w-full object-cover ${
              isGeneratedImage
                ? "animate-image-reveal rounded-[16px] shadow-[0_2px_20px_rgba(180,140,110,0.14)] sm:rounded-[18px]"
                : "rounded-[14px] sm:rounded-[16px]"
            } ${hasText ? "mb-2.5" : ""}`}
            style={{ maxHeight: isGeneratedImage ? "400px" : "300px" }}
          />
        )}

        {/* Streaming presence — shown during thinking/placeholder states */}
        {isThinkingState && (
          <div className="flex items-center gap-3 px-0.5 py-1">
            <div className="animate-presence-breathe h-[6px] w-[6px] rounded-full bg-her-accent/45" />
            <span className="text-[12px] tracking-[0.03em] text-her-text-muted/32 italic">
              {hasText ? message.content : (thinkingLabel || "thinking…")}
            </span>
          </div>
        )}

        {/* Text */}
        {hasText && !isThinkingState && !isImageLoading && (
          <div className={`msg-text-selectable text-[13.5px] leading-[1.7] tracking-[0.005em] sm:text-[14.5px] sm:leading-[1.75] ${hasImage ? "px-3.5 pb-3 pt-1.5 sm:px-4" : ""}`}>
            {message.content.split("\n").map((line, i) => (
              <span key={i}>
                {i > 0 && <br />}
                {line}
              </span>
            ))}
            {isStreaming && <span className="animate-stream-cursor" />}
          </div>
        )}

        {/* Image actions — download, copy prompt, reuse, edit source */}
        {showActions && (
          <div className="flex flex-wrap gap-1 px-3 pb-2.5 pt-1">
            {/* Download */}
            {imageActions.onDownload && (
              <button
                onClick={() => imageActions.onDownload!(message.image!)}
                aria-label="Save image"
                className="min-h-[44px] min-w-[44px] rounded-full border border-her-border/12 bg-her-bg/50 px-2.5 py-1 text-[10px] text-her-text-muted/35 transition-all duration-150 hover:border-her-accent/15 hover:text-her-text-muted/55"
              >
                ↓ save
              </button>
            )}
            {/* Copy prompt */}
            {imageActions.onCopyPrompt && (
              <button
                onClick={() => {
                  imageActions.onCopyPrompt!();
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
                aria-label={copied ? "Prompt copied" : "Copy image prompt"}
                className="min-h-[44px] min-w-[44px] rounded-full border border-her-border/12 bg-her-bg/50 px-2.5 py-1 text-[10px] text-her-text-muted/35 transition-all duration-150 hover:border-her-accent/15 hover:text-her-text-muted/55"
              >
                {copied ? "✓ copied" : "copy prompt"}
              </button>
            )}
            {/* Reuse prompt */}
            {imageActions.onReusePrompt && (
              <button
                onClick={() => imageActions.onReusePrompt!()}
                aria-label="Reuse this prompt in Image Studio"
                className="min-h-[44px] min-w-[44px] rounded-full border border-her-border/12 bg-her-bg/50 px-2.5 py-1 text-[10px] text-her-text-muted/35 transition-all duration-150 hover:border-her-accent/15 hover:text-her-text-muted/55"
              >
                reuse
              </button>
            )}
            {/* Use as edit source */}
            {imageActions.onUseAsEditSource && (
              <button
                onClick={() => imageActions.onUseAsEditSource!(message.image!)}
                aria-label="Edit this image"
                className="min-h-[44px] min-w-[44px] rounded-full border border-her-border/12 bg-her-bg/50 px-2.5 py-1 text-[10px] text-her-text-muted/35 transition-all duration-150 hover:border-her-accent/15 hover:text-her-text-muted/55"
              >
                edit this
              </button>
            )}
          </div>
        )}
      </div>

      {/* Reaction pills — displayed below the bubble */}
      {message.reactions && Object.keys(message.reactions).length > 0 && (
        <div className={`mt-1 flex flex-wrap gap-1 ${isUser ? "justify-end mr-1.5" : "justify-start ml-1.5"}`}>
          {Object.entries(message.reactions).map(([emoji, reactors]) => (
            <button
              key={emoji}
              type="button"
              onClick={(e) => { e.stopPropagation(); handleEmojiPick(emoji); }}
              className={`flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[12px] transition-all duration-150 active:scale-[0.92] ${
                reactors.includes("user")
                  ? "border-her-accent/20 bg-her-accent/[0.07] shadow-[0_0_0_0.5px_rgba(201,110,90,0.1)]"
                  : "border-her-border/12 bg-her-bg/60"
              }`}
            >
              <span>{emoji}</span>
              {reactors.length > 1 && (
                <span className="text-[9px] text-her-text-muted/40">{reactors.length}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Emoji tray — mobile: floating above bubble on long-press, desktop: inline on hover */}
      {showEmojiTray && (
        <>
          {/* Invisible backdrop to close tray on tap-away (mobile) */}
          <div
            className="fixed inset-0 z-40 sm:hidden"
            onClick={() => setShowEmojiTray(false)}
            onTouchEnd={() => setShowEmojiTray(false)}
            aria-hidden="true"
          />
          <div
            role="group"
            aria-label="Emoji reactions"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setShowEmojiTray(false);
              }
            }}
            className={`animate-emoji-tray z-50 flex items-center gap-0.5 rounded-full border border-her-border/15 bg-white/95 px-1.5 py-1 shadow-[0_4px_20px_rgba(0,0,0,0.08),0_0_0_0.5px_rgba(0,0,0,0.04)] backdrop-blur-sm dark:bg-her-bg/95 ${
              isUser
                ? "absolute -top-11 right-0 sm:static sm:mt-1 sm:self-end sm:mr-1"
                : "absolute -top-11 left-0 sm:static sm:mt-1 sm:self-start sm:ml-1"
            }`}
          >
            {REACTION_EMOJIS.map((emoji) => {
              const isActive = message.reactions?.[emoji]?.includes("user");
              return (
                <button
                  key={emoji}
                  type="button"
                  onClick={(e) => { e.stopPropagation(); handleEmojiPick(emoji); }}
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-[17px] transition-all duration-150 active:scale-[0.85] sm:h-7 sm:w-7 sm:text-[15px] ${
                    isActive
                      ? "bg-her-accent/[0.10] scale-110"
                      : "hover:bg-her-surface/60"
                  }`}
                  aria-label={`React with ${emoji}`}
                >
                  {emoji}
                </button>
              );
            })}
            {/* "+" button — opens native emoji keyboard */}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); openCustomEmoji(); }}
              className="flex h-8 w-8 items-center justify-center rounded-full text-her-text-muted/30 transition-all duration-150 hover:bg-her-surface/60 hover:text-her-text-muted/50 active:scale-[0.85] sm:h-7 sm:w-7"
              aria-label="Pick another emoji"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4 sm:h-3.5 sm:w-3.5">
                <path d="M8.75 3.75a.75.75 0 0 0-1.5 0v3.5h-3.5a.75.75 0 0 0 0 1.5h3.5v3.5a.75.75 0 0 0 1.5 0v-3.5h3.5a.75.75 0 0 0 0-1.5h-3.5v-3.5Z" />
              </svg>
            </button>
            {/* Hidden input to trigger native emoji keyboard */}
            <input
              ref={emojiInputRef}
              type="text"
              inputMode="text"
              autoComplete="off"
              className="absolute h-0 w-0 opacity-0"
              onChange={handleCustomEmojiInput}
              onBlur={() => { if (emojiInputRef.current) emojiInputRef.current.value = ""; }}
              tabIndex={-1}
            />
          </div>
        </>
      )}

      {/* Desktop action row — reply button + emoji hint, appears on hover */}
      {canReply && showReplyBtn && !showEmojiTray && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onReply!(message); setShowReplyBtn(false); }}
          className={`animate-fade-in mt-1 hidden items-center gap-1 rounded-full px-2.5 py-1 text-[10px] tracking-[0.03em] text-her-text-muted/35 transition-all duration-200 hover:bg-her-surface/60 hover:text-her-text-muted/55 active:scale-[0.94] sm:flex ${
            isUser ? "self-end mr-1" : "self-start ml-1"
          }`}
          aria-label="Reply to this message"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3 -scale-x-100">
            <path d="M1.75 1.002a.75.75 0 1 0 0 1.5h6.5a3.75 3.75 0 0 1 0 7.5h-3.44l1.72-1.72a.75.75 0 0 0-1.06-1.06l-3 3a.75.75 0 0 0 0 1.06l3 3a.75.75 0 1 0 1.06-1.06l-1.72-1.72h3.44a5.25 5.25 0 0 0 0-10.5h-6.5Z" />
          </svg>
          reply
        </button>
      )}

      {/* Timestamp — only show for real timestamps (not the initial greeting) */}
      {showTimestamp && message.timestamp > 0 && (
        <span className={`mt-1.5 text-[10px] tracking-wide text-her-text-muted/30 ${
          isUser ? "mr-1.5" : "ml-1.5"
        }`}>
          {time}
        </span>
      )}
      </div>{/* end swipeable wrapper */}
    </div>
  );
}

const MessageBubble = memo(MessageBubbleInner);
export default MessageBubble;
