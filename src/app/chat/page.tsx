"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Message } from "@/lib/types";
import { HER_GREETING, randomGreeting } from "@/lib/prompts";
import { generateId, loadSession, saveMessages, clearSession } from "@/lib/chat-store";
import {
  initPersistence,
  getEffectiveUserId,
  getOrCreateConversation,
  saveMessageToSupabase,
  touchConversation,
  clearActiveConversationId,
  setActiveConversationId,
  getActiveConversationId,
  listUserConversations,
  getConversationMessages,
  updateConversationTitle,
  deleteConversation,
  createConversation,
  type ConversationSummary,
  type DbMessage,
} from "@/lib/supabase-persistence";
import { useAuth } from "@/components/AuthProvider";
import ChatHeader from "@/components/chat/ChatHeader";
import ChatWindow from "@/components/chat/ChatWindow";
import MessageBubble from "@/components/chat/MessageBubble";
import ChatInput from "@/components/chat/ChatInput";
import TypingIndicator from "@/components/chat/TypingIndicator";
import HistoryDrawer from "@/components/chat/HistoryDrawer";
import EmptyState from "@/components/chat/EmptyState";

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

/** Convert a Supabase DB message to the UI Message shape */
function dbMessageToUiMessage(dbMsg: DbMessage): Message {
  return {
    id: dbMsg.id,
    role: dbMsg.role,
    content: dbMsg.content,
    timestamp: new Date(dbMsg.created_at).getTime(),
    ...(dbMsg.image_url ? { image: dbMsg.image_url } : {}),
  };
}

// ── Image-intent detection ──

const IMAGE_PATTERNS = [
  /\b(generate|create|make|paint|draw|sketch|design)\b.{0,20}\b(image|picture|photo|illustration|art|painting|portrait|drawing)\b/i,
  /\b(imagine|visualize|picture)\b.{0,30}\b(of|for|with|a|an|the|me)\b/i,
  /\b(show me|can you draw|can you paint|can you create|can you make)\b/i,
  /\bdraw\s+(me\s+)?a\b/i,
  /\bpaint\s+(me\s+)?a\b/i,
  /\bsketch\s+(me\s+)?a\b/i,
];

/** Detect if a user message is asking for image generation */
function isImageRequest(text: string): boolean {
  return IMAGE_PATTERNS.some((pattern) => pattern.test(text));
}

/** Strip the intent keywords from the prompt to get a cleaner image description */
function extractImagePrompt(text: string): string {
  let prompt = text
    .replace(/\b(please|can you|could you|would you|i'd like you to|i want you to)\b/gi, "")
    .replace(/\b(generate|create|make|draw|sketch|design|paint|imagine|visualize|picture|show me)\b/gi, "")
    .replace(/\b(an? |the |me |of |for )\b/gi, " ")
    .replace(/\b(image|picture|photo|illustration|art|painting|portrait|drawing)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  // If stripping removed everything meaningful, use the original text
  if (prompt.length < 5) prompt = text.trim();

  return prompt;
}

export default function ChatPage() {
  const { user, isAuthenticated, loading: authLoading } = useAuth();

  // ── Core chat state ──
  const [messages, setMessages] = useState<Message[]>([createGreeting()]);
  const [isTyping, setIsTyping] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // ── History state (authenticated users only) ──
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [activeConvoId, setActiveConvoId] = useState<string | null>(null);
  const [loadingConvo, setLoadingConvo] = useState(false);

  // Prevent double-sends
  const sendingRef = useRef(false);

  // ── Empty state / suggestion chip prefill ──
  const [prefillText, setPrefillText] = useState<string | null>(null);

  // Session key — increments on session switch to trigger fade animation
  const [sessionKey, setSessionKey] = useState(0);

  // Scroll trigger — increments during streaming to keep auto-scroll working
  const [scrollTrigger, setScrollTrigger] = useState(0);

  // ── Restore from localStorage (client-only, after hydration) ──
  useEffect(() => {
    const saved = loadSession();
    if (saved && saved.messages.length > 0) {
      setMessages(saved.messages);
    } else {
      setMessages([createGreeting(randomGreeting())]);
    }
    setHydrated(true);

    // Restore active conversation ID from localStorage
    const storedConvoId = getActiveConversationId();
    if (storedConvoId) setActiveConvoId(storedConvoId);

    // Initialize Supabase persistence (device profile) — fire-and-forget
    initPersistence().catch(() => {});
  }, []);

  // ── Load conversation history when auth resolves ──
  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated || !user?.id) return;

    let cancelled = false;
    setHistoryLoading(true);

    listUserConversations(user.id).then((convos) => {
      if (!cancelled) {
        setConversations(convos);
        setHistoryLoading(false);

        // If we have a stored active convo ID and it's in the list, load it
        const storedId = getActiveConversationId();
        if (storedId && convos.some((c) => c.id === storedId)) {
          loadConversationMessages(storedId);
        }
      }
    });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, isAuthenticated, user?.id]);

  // ── Persist whenever messages change (skip the first server render) ──
  useEffect(() => {
    if (!hydrated) return;
    saveMessages(messages);
  }, [messages, hydrated]);

  // ── Load messages for a specific conversation ──
  const loadConversationMessages = useCallback(async (conversationId: string) => {
    setLoadingConvo(true);
    const dbMessages = await getConversationMessages(conversationId);

    if (dbMessages.length > 0) {
      const uiMessages: Message[] = dbMessages.map(dbMessageToUiMessage);
      setMessages(uiMessages);
    } else {
      // Conversation exists but has no messages — show greeting
      setMessages([createGreeting(randomGreeting())]);
    }

    setActiveConvoId(conversationId);
    setActiveConversationId(conversationId);
    setLoadingConvo(false);
    setSessionKey((k) => k + 1);
    setError(null);
  }, []);

  // ── Select a conversation from history ──
  const handleSelectConversation = useCallback(
    (conversationId: string) => {
      // Guard: skip if already loading or selecting the same conversation
      if (loadingConvo || conversationId === activeConvoId) return;
      loadConversationMessages(conversationId);
    },
    [loadConversationMessages, loadingConvo, activeConvoId]
  );

  // ── Refresh the conversation list (e.g. after a new message) ──
  const refreshConversations = useCallback(async () => {
    if (!isAuthenticated || !user?.id) return;
    const convos = await listUserConversations(user.id);
    setConversations(convos);
  }, [isAuthenticated, user?.id]);

  // ── Send a message (with streaming response) ──
  const handleSend = useCallback(async (content: string, image?: string) => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setError(null);

    // Add user message
    const userMessage: Message = {
      id: generateId(),
      role: "user",
      content: content || (image ? "(shared a photo)" : ""),
      timestamp: Date.now(),
      ...(image ? { image } : {}),
    };

    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setIsTyping(true);

    // ── Persist user message to Supabase (fire-and-forget) ──
    const userId = await getEffectiveUserId();
    let convoId = activeConvoId;

    // If no active conversation, create one
    if (!convoId) {
      convoId = await getOrCreateConversation(userId, userMessage.content).catch(() => null);
      if (convoId) {
        setActiveConvoId(convoId);
        setActiveConversationId(convoId);
      }
    } else {
      // ── Smart session title: update title from first real user message ──
      const userMsgCount = updatedMessages.filter((m) => m.role === "user").length;
      if (userMsgCount === 1) {
        const raw = userMessage.content.trim();
        if (raw && raw !== "(shared a photo)") {
          const title = raw.length > 50 ? raw.slice(0, 50).trimEnd() + "\u2026" : raw;
          updateConversationTitle(convoId, title).then((ok) => {
            if (ok) {
              setConversations((prev) =>
                prev.map((c) => (c.id === convoId ? { ...c, title } : c))
              );
            }
          }).catch(() => {});
        }
      }
    }

    if (convoId) {
      saveMessageToSupabase({
        conversationId: convoId,
        userId,
        role: "user",
        content: userMessage.content,
        imageUrl: image || undefined,
      }).catch(() => {});
    }

    // Create a stable ID for the streaming assistant message
    const herMessageId = generateId();

    // ── Vision analysis branch (user uploaded an image) ──
    if (image) {
      const visionPrompt = content || "Describe this image in detail.";
      console.log(`[HER] Vision request — prompt: "${visionPrompt.slice(0, 60)}"`);

      try {
        // Show placeholder while vision model analyzes
        setIsTyping(false);
        setIsStreaming(true);

        const herPlaceholder: Message = {
          id: herMessageId,
          role: "assistant",
          content: "let me look closely…",
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, herPlaceholder]);
        setScrollTrigger((n) => n + 1);

        const res = await fetch("/api/vision", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image, prompt: visionPrompt }),
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({ error: "Failed to analyze image" }));
          throw new Error(errData.error || "i couldn't read that image just now… try another one.");
        }

        const data = await res.json();

        if (!data.message) {
          throw new Error("i looked closely but couldn't put it into words… try again?");
        }

        // ── Vision complete — finalize ──
        setMessages((prev) =>
          prev.map((m) =>
            m.id === herMessageId
              ? { ...m, content: data.message, timestamp: Date.now() }
              : m
          )
        );
        setScrollTrigger((n) => n + 1);

        // ── Persist assistant vision response to Supabase ──
        if (convoId) {
          saveMessageToSupabase({
            conversationId: convoId,
            userId,
            role: "assistant",
            content: data.message,
          }).catch(() => {});
          touchConversation(convoId).catch(() => {});
          refreshConversations().catch(() => {});
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "something went wrong";
        setError(msg);
        setMessages((prev) => prev.filter((m) => m.id !== herMessageId));
        setIsTyping(false);
      } finally {
        setIsStreaming(false);
        sendingRef.current = false;
      }
      return; // Exit early — vision path complete
    }

    // ── Image generation branch ──
    if (isImageRequest(content)) {
      const imagePrompt = extractImagePrompt(content);
      console.log(`[HER] Image request detected — prompt: "${imagePrompt}"`);

      try {
        // Transition: show typing then show placeholder with imageLoading
        setIsTyping(false);
        setIsStreaming(true);

        const herPlaceholder: Message = {
          id: herMessageId,
          role: "assistant",
          content: "imagining something beautiful…",
          timestamp: Date.now(),
          imageLoading: true,
        };
        setMessages((prev) => [...prev, herPlaceholder]);
        setScrollTrigger((n) => n + 1);

        const res = await fetch("/api/imagine", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: imagePrompt }),
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({ error: "Failed to generate image" }));
          throw new Error(errData.error || "i couldn't paint that just now… try again in a moment.");
        }

        const data = await res.json();

        if (!data.image) {
          throw new Error("i imagined it but couldn't capture it… try again?");
        }

        // ── Image generated — finalize ──
        const captionText = `here's what i imagined ✨`;

        setMessages((prev) =>
          prev.map((m) =>
            m.id === herMessageId
              ? { ...m, content: captionText, image: data.image, imageLoading: false, timestamp: Date.now() }
              : m
          )
        );
        setScrollTrigger((n) => n + 1);

        // ── Persist assistant image message to Supabase ──
        if (convoId) {
          saveMessageToSupabase({
            conversationId: convoId,
            userId,
            role: "assistant",
            content: captionText,
            imageUrl: data.image,
          }).catch(() => {});
          touchConversation(convoId).catch(() => {});
          refreshConversations().catch(() => {});
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "something went wrong";
        setError(msg);
        setMessages((prev) => prev.filter((m) => m.id !== herMessageId));
        setIsTyping(false);
      } finally {
        setIsStreaming(false);
        sendingRef.current = false;
      }
      return; // Exit early — image path complete
    }

    // ── Text streaming branch (existing) ──

    try {
      const res = await fetch("/api/chat?stream=true", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: updatedMessages }),
      });

      if (!res.ok || !res.body) {
        // Non-streaming error (e.g. 400, 429, 502)
        const errorText = await res.text();
        throw new Error(errorText || "Failed to get a response");
      }

      // ── Transition from typing indicator to streaming text ──
      setIsTyping(false);
      setIsStreaming(true);

      // Insert empty placeholder assistant message
      const herPlaceholder: Message = {
        id: herMessageId,
        role: "assistant",
        content: "",
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, herPlaceholder]);

      // ── Read the stream chunk by chunk ──
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        fullText += chunk;

        // Update the assistant message in-place
        const textSoFar = fullText;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === herMessageId ? { ...m, content: textSoFar } : m
          )
        );
        // Trigger scroll to keep up with growing text
        setScrollTrigger((n) => n + 1);
      }

      // ── Stream complete — finalize ──
      if (!fullText) {
        throw new Error("i got a little lost in my thoughts... can you try again?");
      }

      // Ensure final state is clean
      setMessages((prev) =>
        prev.map((m) =>
          m.id === herMessageId
            ? { ...m, content: fullText, timestamp: Date.now() }
            : m
        )
      );

      // ── Persist FINAL assistant message to Supabase (fire-and-forget) ──
      if (convoId) {
        saveMessageToSupabase({
          conversationId: convoId,
          userId,
          role: "assistant",
          content: fullText,
        }).catch(() => {});
        touchConversation(convoId).catch(() => {});

        // Refresh conversation list for authenticated users
        refreshConversations().catch(() => {});
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "something went wrong";
      setError(msg);

      // Remove the empty/partial placeholder if stream failed
      setMessages((prev) => prev.filter((m) => m.id !== herMessageId));
      setIsTyping(false);
    } finally {
      setIsStreaming(false);
      sendingRef.current = false;
    }
  }, [messages, activeConvoId, refreshConversations]);

  // ── New chat / start over ──
  const handleClear = useCallback(() => {
    clearSession();
    clearActiveConversationId();
    setActiveConvoId(null);
    setMessages([createGreeting(randomGreeting())]);
    setError(null);
    setSessionKey((k) => k + 1);
  }, []);

  // ── Rename a conversation ──
  const handleRenameConversation = useCallback(
    async (conversationId: string, title: string): Promise<boolean> => {
      const success = await updateConversationTitle(conversationId, title);
      if (success) {
        // Optimistically update the local list
        setConversations((prev) =>
          prev.map((c) => (c.id === conversationId ? { ...c, title } : c))
        );
      }
      return success;
    },
    []
  );

  // ── Delete a conversation ──
  const handleDeleteConversation = useCallback(
    async (conversationId: string): Promise<boolean> => {
      const success = await deleteConversation(conversationId);
      if (success) {
        // Remove from local list
        setConversations((prev) => prev.filter((c) => c.id !== conversationId));

        // If we just deleted the active conversation, reset to a fresh chat
        if (conversationId === activeConvoId) {
          clearSession();
          clearActiveConversationId();
          setActiveConvoId(null);
          setMessages([createGreeting(randomGreeting())]);
          setError(null);
        }
      }
      return success;
    },
    [activeConvoId]
  );

  const dismissError = useCallback(() => setError(null), []);

  return (
    <div className="animate-page-enter flex h-full flex-col overflow-hidden bg-her-bg">
      <ChatHeader
        onClear={handleClear}
        onHistoryOpen={() => setHistoryOpen(true)}
      />

      {/* History drawer */}
      <HistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        conversations={conversations}
        activeConversationId={activeConvoId}
        onSelectConversation={handleSelectConversation}
        onNewChat={handleClear}
        onRenameConversation={handleRenameConversation}
        onDeleteConversation={handleDeleteConversation}
        isAuthenticated={isAuthenticated}
        loading={historyLoading}
      />

      {/* Loading overlay for conversation switch */}
      {loadingConvo && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-her-bg/60 backdrop-blur-[1px]">
          <div className="flex items-center gap-1.5">
            <div className="animate-soft-pulse h-[5px] w-[5px] rounded-full bg-her-accent/40" />
            <div
              className="animate-soft-pulse h-[5px] w-[5px] rounded-full bg-her-accent/40"
              style={{ animationDelay: "0.3s" }}
            />
            <div
              className="animate-soft-pulse h-[5px] w-[5px] rounded-full bg-her-accent/40"
              style={{ animationDelay: "0.6s" }}
            />
          </div>
        </div>
      )}

      <ChatWindow scrollTrigger={scrollTrigger}>
        <div key={sessionKey} className="animate-session-fade">
          {/* Empty state — shown when conversation only has the greeting */}
          {!isTyping && messages.length === 1 && messages[0].id === "greeting" && (
            <EmptyState onSuggestion={setPrefillText} />
          )}

          {/* Messages */}
          {messages.map((msg, i) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              index={i}
              showTimestamp={!isStreaming && (i === 0 || i === messages.length - 1)}
              isStreaming={isStreaming && i === messages.length - 1 && msg.role === "assistant"}
            />
          ))}
        </div>

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

      <ChatInput
        onSend={handleSend}
        disabled={isTyping || isStreaming}
        prefillText={prefillText ?? undefined}
        onPrefillConsumed={() => setPrefillText(null)}
      />
    </div>
  );
}
