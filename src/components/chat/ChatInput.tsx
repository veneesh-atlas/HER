"use client";

import { useEffect, useRef, useState, KeyboardEvent } from "react";

/**
 * ChatInput — Premium warm conversational composer.
 * Pill-shaped, luxurious feel. Like whispering into warm space.
 * Supports Enter to send, Shift+Enter for newline.
 */

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
}

export default function ChatInput({ onSend, disabled = false }: ChatInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-focus on mount + re-focus when HER finishes replying
  useEffect(() => {
    if (!disabled) {
      textareaRef.current?.focus();
    }
  }, [disabled]);

  const handleSend = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");

    // Reset textarea height and re-focus
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.focus();
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = () => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      const clamped = Math.min(el.scrollHeight, 120);
      el.style.height = clamped + "px";
      // Allow scrolling when content exceeds max, but scrollbar stays hidden via CSS
      el.style.overflowY = el.scrollHeight > 120 ? "auto" : "hidden";
    }
  };

  const canSend = value.trim().length > 0 && !disabled;

  return (
    <div className="shrink-0 bg-gradient-to-t from-her-bg via-her-bg to-her-bg/80 pb-3 pt-2 sm:pb-5 sm:pt-3">
      <div className="mx-auto flex max-w-2xl items-end gap-2 px-3 pb-[env(safe-area-inset-bottom)] sm:gap-3 sm:px-5 md:px-6">
        {/* Textarea — pill-shaped, warm */}
        <div className="relative flex-1">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            placeholder="say something..."
            disabled={disabled}
            rows={1}
            className="composer-textarea focus-warm max-h-[120px] min-h-[44px] w-full resize-none overflow-hidden rounded-[22px] border border-her-border/30 bg-her-composer px-4 py-3 text-[14px] leading-relaxed text-her-text shadow-[inset_0_1px_2px_rgba(180,140,110,0.04)] transition-all duration-300 ease-out disabled:opacity-30 sm:min-h-[48px] sm:rounded-[24px] sm:px-5 sm:py-[13px] sm:text-[14.5px]"
          />
        </div>

        {/* Send button — circular, warm, tactile */}
        <button
          type="button"
          onClick={handleSend}
          disabled={!canSend}
          aria-label="Send message"
          className={`flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-full transition-all duration-300 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-her-accent/25 focus-visible:ring-offset-2 focus-visible:ring-offset-her-bg sm:h-[48px] sm:w-[48px] ${
            canSend
              ? "bg-her-accent text-white shadow-[0_2px_12px_rgba(201,110,90,0.18)] hover:bg-her-accent-hover hover:shadow-[0_3px_16px_rgba(201,110,90,0.24)] hover:scale-[1.03] active:scale-[0.96] active:shadow-[0_1px_6px_rgba(201,110,90,0.15)]"
              : "bg-her-surface/50 text-her-text-muted/15 cursor-default"
          }`}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className={`h-[18px] w-[18px] transition-all duration-300 ${canSend ? "-translate-x-[0.5px] translate-y-[0.5px]" : "opacity-60"}`}
          >
            <path d="M3.105 2.289a.75.75 0 00-.826.95l1.414 4.925A1.5 1.5 0 005.135 9.25h6.115a.75.75 0 010 1.5H5.135a1.5 1.5 0 00-1.442 1.086l-1.414 4.926a.75.75 0 00.826.95 28.896 28.896 0 0015.293-7.154.75.75 0 000-1.115A28.897 28.897 0 003.105 2.289z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
