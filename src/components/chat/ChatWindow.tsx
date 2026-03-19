"use client";

import { useEffect, useRef } from "react";

/**
 * ChatWindow — Scrollable conversation container.
 * Messages float near the bottom, creating an atmospheric
 * calm space above. Like a conversation happening in
 * a warm, quiet room with high ceilings.
 */

interface ChatWindowProps {
  children?: React.ReactNode;
  autoScroll?: boolean;
}

export default function ChatWindow({ children, autoScroll = true }: ChatWindowProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!autoScroll || !containerRef.current || !bottomRef.current) return;

    const el = containerRef.current;
    // Only auto-scroll if user is near the bottom (within 150px)
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
    if (isNearBottom) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [children, autoScroll]);

  return (
    <div
      ref={containerRef}
      className="chat-scroll flex min-h-0 flex-1 flex-col overflow-y-auto"
    >
      {/* Push messages toward the bottom — atmospheric empty space above */}
      <div className="flex-1" />

      {/* Centered conversation column */}
      <div className="mx-auto w-full max-w-[640px] px-3 pb-4 pt-4 sm:px-5 sm:pb-5 sm:pt-8 md:px-6">
        {children}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
