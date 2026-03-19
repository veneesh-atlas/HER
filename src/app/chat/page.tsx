"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Message, ChatResponse } from "@/lib/types";
import { HER_GREETING, randomGreeting } from "@/lib/prompts";
import { generateId, loadSession, saveMessages, clearSession } from "@/lib/chat-store";
import ChatHeader from "@/components/chat/ChatHeader";
import ChatWindow from "@/components/chat/ChatWindow";
import MessageBubble from "@/components/chat/MessageBubble";
import ChatInput from "@/components/chat/ChatInput";
import TypingIndicator from "@/components/chat/TypingIndicator";

/**
 * HER opens every conversation with a greeting.
 * Uses a stable timestamp (0) to avoid SSR/client hydration mismatch.
 * Accepts optional content — defaults to HER_GREETING (deterministic for SSR).
 */
function createGreeting(content: string = HER_GREETING): Message {
  return {
    id: "greeting",
    role: "assistant",
    content,
    timestamp: 0,
  };
}

export default function ChatPage() {
  // Start with just the greeting — hydration-safe default.
  // Real history is loaded in useEffect (client-only).
  const [messages, setMessages] = useState<Message[]>([createGreeting()]);
  const [isTyping, setIsTyping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // Prevent double-sends
  const sendingRef = useRef(false);

  // ── Restore from localStorage (client-only, after hydration) ──
  useEffect(() => {
    const saved = loadSession();
    if (saved && saved.messages.length > 0) {
      setMessages(saved.messages);
    } else {
      // No saved session — pick a random greeting (client-only, avoids hydration mismatch)
      setMessages([createGreeting(randomGreeting())]);
    }
    setHydrated(true);
  }, []);

  // ── Persist whenever messages change (skip the first server render) ──
  useEffect(() => {
    if (!hydrated) return;
    saveMessages(messages);
  }, [messages, hydrated]);

  // ── Send a message ──
  const handleSend = useCallback(async (content: string) => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setError(null);

    // Add user message
    const userMessage: Message = {
      id: generateId(),
      role: "user",
      content,
      timestamp: Date.now(),
    };

    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setIsTyping(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: updatedMessages }),
      });

      const data: ChatResponse = await res.json();

      if (!res.ok || data.error) {
        throw new Error(data.error || "Failed to get a response");
      }

      const herMessage: Message = {
        id: generateId(),
        role: "assistant",
        content: data.message,
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, herMessage]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "something went wrong";
      setError(msg);
    } finally {
      setIsTyping(false);
      sendingRef.current = false;
    }
  }, [messages]);

  // ── Clear conversation ──
  const handleClear = useCallback(() => {
    clearSession();
    setMessages([createGreeting(randomGreeting())]);
    setError(null);
  }, []);

  const dismissError = useCallback(() => setError(null), []);

  return (
    <div className="animate-page-enter flex h-full flex-col overflow-hidden bg-her-bg">
      <ChatHeader onClear={handleClear} />

      <ChatWindow>
        {/* Messages */}
        {messages.map((msg, i) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            index={i}
            showTimestamp={i === 0 || i === messages.length - 1}
          />
        ))}

        {/* Typing indicator */}
        {isTyping && <TypingIndicator />}

        {/* Error toast */}
        {error && (
          <div className="animate-fade-in mb-4 flex justify-center px-3 sm:px-0">
            <button
              onClick={dismissError}
              className="min-h-[44px] rounded-full bg-her-accent/[0.06] px-4 py-2.5 text-[12px] text-her-accent/80 transition-colors duration-300 hover:bg-her-accent/[0.12] sm:px-5 sm:text-[13px]"
            >
              {error}
              <span className="ml-2 text-her-accent/30">✕</span>
            </button>
          </div>
        )}
      </ChatWindow>

      <ChatInput onSend={handleSend} disabled={isTyping} />
    </div>
  );
}
