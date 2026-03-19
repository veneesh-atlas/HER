"use client";

import { useState, useCallback, useEffect } from "react";
import Link from "next/link";

/**
 * ChatHeader — Refined, cinematic header.
 * The breathing dot feels alive. The typography is airy.
 * A gentle "start over" lives quietly on the right.
 */

interface ChatHeaderProps {
  onClear?: () => void;
}

export default function ChatHeader({ onClear }: ChatHeaderProps) {
  const [confirming, setConfirming] = useState(false);

  // Auto-dismiss the confirm state after 3 seconds
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(timer);
  }, [confirming]);

  const handleClearClick = useCallback(() => {
    if (confirming) {
      onClear?.();
      setConfirming(false);
    } else {
      setConfirming(true);
    }
  }, [confirming, onClear]);

  return (
    <header className="relative flex shrink-0 items-center justify-between px-4 py-3 sm:px-5 sm:py-4 md:px-6 md:py-5">
      {/* Back link */}
      <Link
        href="/"
        className="flex min-h-[44px] min-w-[44px] items-center gap-1.5 text-[11px] tracking-[0.1em] text-her-text-muted/40 transition-colors duration-300 hover:text-her-text-muted/70 active:text-her-text-muted/50 focus-visible:outline-none focus-visible:text-her-text-muted/70"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-3 w-3"
        >
          <path
            fillRule="evenodd"
            d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z"
            clipRule="evenodd"
          />
        </svg>
        back
      </Link>

      {/* Center branding — alive, breathing */}
      <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-2">
        <div className="animate-breathe h-[6px] w-[6px] rounded-full bg-her-accent/80 sm:h-[7px] sm:w-[7px]" />
        <span className="text-[12px] font-light tracking-[0.2em] text-her-text-muted/60 sm:text-[13px] sm:tracking-[0.25em]">
          HER
        </span>
      </div>

      {/* Clear / start over */}
      {onClear ? (
        <button
          onClick={handleClearClick}
          className={`
            min-h-[44px] rounded-full px-3 py-1 text-[10px] tracking-[0.1em]
            transition-all duration-300 ease-out active:scale-[0.96]
            ${confirming
              ? "bg-her-accent/10 text-her-accent"
              : "text-her-text-muted/30 hover:text-her-text-muted/55"
            }
          `}
        >
          {confirming ? "sure?" : "start over"}
        </button>
      ) : (
        <div className="w-16" />
      )}
    </header>
  );
}
