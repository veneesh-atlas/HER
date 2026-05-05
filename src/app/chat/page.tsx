"use client";

import { useState, useCallback, useRef, useEffect, useMemo, type Dispatch, type SetStateAction } from "react";
import { Message } from "@/lib/types";
import { generateId, loadSession, saveMessages, clearSession } from "@/lib/chat-store";
import { createSurfaceCopyBundle, GREETING_POOL, type SurfaceCopyBundle } from "@/lib/surface-copy";
import { buildContinuity, buildContinuityBlock } from "@/lib/continuity";
import { analyzeInteractionPattern, saveInteractionPattern } from "@/lib/interaction-patterns";
import { selectResponseMode } from "@/lib/response-mode";
import { checkRepetition } from "@/lib/anti-repetition-runtime";
import { humanDelay, authFetch } from "@/lib/utils";
import {
  initPersistence,
  getEffectiveUserId,
  getOrCreateConversation,
  saveMessageToSupabase,
  saveReactionToSupabase,
  touchConversation,
  clearActiveConversationId,
  setActiveConversationId,
  getActiveConversationId,
  listUserConversations,
  getConversationMessages,
  getOlderMessages,
  countConversationMessages,
  MESSAGES_PAGE_SIZE,
  updateConversationTitle,
  deleteConversation,
  getUserRapportStats,
  type ConversationSummary,
  type DbMessage,
} from "@/lib/supabase-persistence";
import { computeRapportLevel, type RapportLevel } from "@/lib/rapport";
import { detectUserTimezone } from "@/lib/notification-settings";
import { uploadDataUrlToStorage, isDataUrl } from "@/lib/image-storage";
import { routeImageType, type ImageType } from "@/lib/image-router";
import { markConversationSeen, getUnreadConversationIds } from "@/lib/conversation-seen";
import { debug } from "@/lib/debug";
import { useAuth } from "@/components/AuthProvider";
import ChatHeader from "@/components/chat/ChatHeader";
import ChatWindow from "@/components/chat/ChatWindow";
import MessageBubble from "@/components/chat/MessageBubble";
import ChatInput from "@/components/chat/ChatInput";
import TypingIndicator from "@/components/chat/TypingIndicator";
import HistoryDrawer from "@/components/chat/HistoryDrawer";
import EmptyState from "@/components/chat/EmptyState";
import ImageStudio from "@/components/chat/ImageStudio";
import ModeSelector from "@/components/chat/ModeSelector";
import AuthModal from "@/components/AuthModal";
import type { ImageStudioMode, ConversationMode } from "@/lib/types";

/**
 * HER opens every conversation with a greeting.
 * Uses a stable timestamp (0) to avoid SSR/client hydration mismatch.
 */
function createGreeting(content: string): Message {
  return {
    id: "greeting",
    role: "assistant",
    content,
    timestamp: 0,
  };
}

/**
 * Reactions are stored as Record<string, string[]> but historical rows may
 * contain malformed values (e.g. cron-job notification markers stored as
 * objects). Strip anything that isn't a valid emoji → string[] entry so the
 * renderer can never crash on bad shape.
 */
function sanitizeReactions(
  raw: unknown,
): Record<string, string[]> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.startsWith("_")) continue; // sentinel keys like _notification
    if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
      out[key] = value as string[];
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Convert a Supabase DB message to the UI Message shape */
function dbMessageToUiMessage(dbMsg: DbMessage): Message {
  const cleanReactions = sanitizeReactions(dbMsg.reactions);
  return {
    id: dbMsg.id,
    role: dbMsg.role,
    content: dbMsg.content.replace(/\s*\[user reacted to this: [^\]]*\]/g, ""),
    timestamp: new Date(dbMsg.created_at).getTime(),
    ...(dbMsg.image_url ? { image: dbMsg.image_url } : {}),
    ...(dbMsg.reply_to_id && dbMsg.reply_to_content && dbMsg.reply_to_role
      ? { replyTo: { id: dbMsg.reply_to_id, content: dbMsg.reply_to_content, role: dbMsg.reply_to_role } }
      : {}),
    ...(cleanReactions ? { reactions: cleanReactions } : {}),
  };
}

// ── Image-intent detection ──

const IMAGE_PATTERNS = [
  /\b(generate|create|make|paint|draw|sketch|design)\b.{0,20}\b(image|picture|photo|illustration|art|painting|portrait|drawing)\b/i,
  /\b(imagine|visualize)\b.{0,30}\b(of|for|with|a|an|the|me)\b/i,
  /\b(can you draw|can you paint|can you create|can you make)\b.{0,20}\b(image|picture|photo|illustration|art|painting|portrait|drawing|a|an|the|me)\b/i,
  /\bdraw\s+(me\s+)?a\b(?!\s+(bath|blank|conclusion|line|comparison|parallel|breath|crowd|salary|paycheck))/i,
  /\bpaint\s+(me\s+)?a\b/i,
  /\bsketch\s+(me\s+)?a\b/i,
];

/** Phrases that look like image requests but aren't */
const IMAGE_NEGATIVE_PATTERNS = [
  /\bdraw\s+(a\s+)?bath\b/i,
  /\bdraw\s+(a\s+)?(blank|conclusion|line|comparison|parallel|breath)\b/i,
  /\bpicture\s+(this|that|it)\b/i,
  /\bcan\s+you\s+picture\b/i,
  /\bshow\s+me\s+(how|what|where|why|when|around|the\s+way)\b/i,
  /\bbig\s+picture\b/i,
  /\bget\s+the\s+picture\b/i,
  /\bpaint\s+(a\s+)?picture\s+of\s+(what|how|the\s+situation)\b/i,
  /\bdraw\s+(a\s+)?line\b/i,
  /\bcreate\s+(a\s+)?(plan|list|schedule|account|profile|password|playlist)\b/i,
  /\bmake\s+(a\s+)?(plan|list|decision|choice|call|point|deal|joke|move|mess|mistake|change|difference)\b/i,
  /\bdesign\s+(a\s+)?(plan|system|strategy|approach|workflow|process)\b/i,
];

/** Detect if a user message is asking for image generation */
function isImageRequest(text: string): boolean {
  // Check negative patterns first — bail out if it's a common phrase
  if (IMAGE_NEGATIVE_PATTERNS.some((pattern) => pattern.test(text))) return false;
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

/**
 * Lightweight client-side image-type heuristic for explicit requests.
 * Mirrors the LLM classifier's categories so the explicit path can route
 * through the same `routeImageType()` source of truth.
 *
 * - self_portrait: "of yourself", "of you", "selfie", "how you look"
 * - creative:     "art", "painting", "sketch", "illustration", "fantasy"
 * - casual:       "casual", everyday objects (default for short prompts)
 * - realistic_scene: everything else (landscapes, scenes)
 */
function detectExplicitImageType(originalText: string): ImageType {
  const t = originalText.toLowerCase();

  // Self-portrait: explicit reference to HER herself
  if (
    /\b(of\s+)?yourself\b/.test(t) ||
    /\bselfie\b/.test(t) ||
    /\b(picture|photo|image|portrait)\s+of\s+you\b/.test(t) ||
    /\bhow\s+(you|do\s+you)\s+look\b/.test(t) ||
    /\byour\s+(face|appearance|outfit)\b/.test(t)
  ) {
    return "self_portrait";
  }

  // Creative / artistic
  if (/\b(painting|sketch|illustration|artwork|fantasy|abstract|surreal|anime|cartoon)\b/.test(t)) {
    return "creative";
  }

  // Default: realistic scene (matches router fallback)
  return "realistic_scene";
}

// ── Static microcopy pools (module-level — never recreated) ──
const LOCAL_VISION = ["okay let me see…", "looking…"];
const LOCAL_IMAGE_CAPTIONS = ["here you go", "okay how's this"];
const LOCAL_IMAGE_FAIL = [
  "that didn't work — try again?",
  "image generation broke — give it another shot?",
];
const LOCAL_VISION_FAIL = [
  "couldn't read that image — try another one?",
  "got nothing from that — try again?",
];

function pickRandom(pool: string[]): string {
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Fire-and-forget: persist assistant message + touch conversation + refresh list.
 * Extracted to avoid repeating the same 3-call pattern in every send branch.
 *
 * If imageUrl is a base64 data URL, it's uploaded to Supabase Storage first
 * so the messages table only stores a short HTTPS URL, not the full blob.
 */
async function persistAssistantMessage(
  convoId: string | null,
  userId: string,
  content: string,
  clientMessageId: string,
  imageUrl: string | undefined,
  refreshConversations: () => Promise<void>,
): Promise<void> {
  if (!convoId) return;

  // Upload to Storage if it's a base64 data URL — falls back to dataUrl on failure.
  let finalUrl = imageUrl;
  if (imageUrl && isDataUrl(imageUrl)) {
    finalUrl = await uploadDataUrlToStorage(userId, imageUrl);
  }

  saveMessageToSupabase({
    conversationId: convoId,
    userId,
    role: "assistant",
    content,
    imageUrl: finalUrl,
    clientMessageId,
  }).catch(() => {});
  touchConversation(convoId).catch(() => {});
  refreshConversations().catch(() => {});
}

/**
 * Smart session title: update conversation title from the first real user message.
 * Extracted to avoid duplicating the same logic in handleSend and handleStudioGenerate.
 */
async function maybeUpdateTitle(
  convoId: string,
  updatedMessages: Message[],
  userContent: string,
  setConversations: Dispatch<SetStateAction<ConversationSummary[]>>,
): Promise<void> {
  const userMsgCount = updatedMessages.filter((m) => m.role === "user").length;
  if (userMsgCount !== 1) return;
  const raw = userContent.trim();
  if (!raw || raw === "(shared a photo)") return;
  const title = raw.length > 50 ? raw.slice(0, 50).trimEnd() + "\u2026" : raw;
  const ok = await updateConversationTitle(convoId, title).catch(() => false);
  if (ok) {
    setConversations((prev) =>
      prev.map((c) => (c.id === convoId ? { ...c, title } : c))
    );
  }
}

/**
 * HER auto-react: After responding, HER may spontaneously react to the user's
 * most recent message with an emoji. Fires ~30% of the time to keep it natural.
 *
 * Uses a dedicated lightweight endpoint (/api/chat/react) with minimal tokens.
 */
async function maybeHerReact(
  recentUserMessage: Message,
  herReplyText: string,
  handleReaction: (messageId: string, emoji: string, reactor: "user" | "her") => void,
  accessToken?: string | null,
): Promise<void> {
  // Roll the dice — only ~30% of the time
  if (Math.random() > 0.3) return;

  // Don't react to very short messages (greetings, "ok", etc.)
  if (recentUserMessage.content.trim().length < 8) return;

  try {
    const res = await authFetch("/api/chat/react", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userMessage: recentUserMessage.content,
        herReply: herReplyText,
      }),
    }, accessToken);

    if (!res.ok) return;

    const { emoji } = await res.json();
    if (emoji) {
      // Small delay so the reaction appears after the message, feeling natural
      await new Promise((r) => setTimeout(r, 800 + Math.random() * 1200));
      handleReaction(recentUserMessage.id, emoji, "her");
    }
  } catch {
    // Silently fail — reactions are non-critical
  }
}

/**
 * Implicit image generation via /api/imagine/auto.
 *
 * Fires in the background after a normal text reply completes. The server
 * pipeline:
 *   1. Classifies intent (skips silently if no visual intent detected)
 *   2. Routes to the best image model
 *   3. Generates + verifies + retries once
 *   4. Generates a contextual delivery caption
 *
 * When an image is ready, we append a NEW HER message with the caption + image
 * to the chat. This keeps the conversation flowing naturally — HER appears to
 * follow up with the image when she's ready, rather than blocking the chat.
 */
async function maybeAutoGenerateImage(
  contextMessages: Message[],
  userId: string,
  convoId: string | null,
  accessToken: string | null,
  setMessages: Dispatch<SetStateAction<Message[]>>,
  setForceScrollTrigger: Dispatch<SetStateAction<number>>,
  refreshConversations: () => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  // Snapshot the conversation we belong to. If the user switches chats or
  // starts a new one before the image arrives, we drop the result rather
  // than appending a phantom selfie to the wrong conversation.
  const startingConvoId = convoId;
  const stillOnSameConversation = () =>
    getActiveConversationId() === startingConvoId;

  try {
    if (signal?.aborted) return;

    // Skip if the regex fast-path already handled this turn (explicit image request).
    const lastUser = [...contextMessages].reverse().find((m) => m.role === "user");
    if (!lastUser || isImageRequest(lastUser.content)) return;

    // Build a compact history payload for the classifier
    const payload = {
      userId,
      messages: contextMessages
        .filter((m) => m.id !== "greeting")
        .slice(-8)
        .map((m) => ({ role: m.role, content: m.content })),
    };

    const res = await authFetch("/api/imagine/auto", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    }, accessToken);

    if (!res.ok) return;
    if (signal?.aborted || !stillOnSameConversation()) return;

    const data = (await res.json()) as {
      generated: boolean;
      image?: string;
      caption?: string;
    };

    if (!data.generated || !data.image) return;
    if (signal?.aborted || !stillOnSameConversation()) return;

    const captionText = data.caption ?? "here you go 😊";
    const newMessageId = generateId();

    const newMessage: Message = {
      id: newMessageId,
      role: "assistant",
      content: captionText,
      timestamp: Date.now(),
      image: data.image,
    };

    setMessages((prev) => [...prev, newMessage]);
    setForceScrollTrigger((n) => n + 1);

    // Persist to Supabase (handles Storage upload internally)
    if (startingConvoId) {
      let finalUrl = data.image;
      if (isDataUrl(finalUrl)) {
        finalUrl = await uploadDataUrlToStorage(userId, finalUrl);
      }
      // Re-check after the (potentially slow) upload — don't write to a
      // conversation the user has since left. The UI message stays;
      // persistence just becomes best-effort.
      if (!stillOnSameConversation()) return;
      saveMessageToSupabase({
        conversationId: startingConvoId,
        userId,
        role: "assistant",
        content: captionText,
        imageUrl: finalUrl,
        clientMessageId: newMessageId,
      }).catch(() => {});
      touchConversation(startingConvoId).catch(() => {});
      refreshConversations().catch(() => {});
    }
  } catch {
    // Non-critical — silently ignore failures so they never disrupt the chat.
  }
}

export default function ChatPage() {
  const { user, session, isAuthenticated, loading: authLoading } = useAuth();

  // Ref-stable access token for module-level helpers (maybeHerReact, etc.)
  const accessTokenRef = useRef<string | null>(null);
  accessTokenRef.current = session?.access_token ?? null;

  // ── Surface copy bundle (session-stable, regenerates on New Chat) ──
  const [surfaceCopy, setSurfaceCopy] = useState<SurfaceCopyBundle>(() => createSurfaceCopyBundle());

  // ── Core chat state ──
  // Initial greeting uses the first pool item for SSR stability — overwritten by hydration useEffect
  const [messages, setMessages] = useState<Message[]>(() => [createGreeting(GREETING_POOL[0])]);
  const [isTyping, setIsTyping] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // ── History state (authenticated users only) ──
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [activeConvoId, setActiveConvoId] = useState<string | null>(null);
  const [loadingConvo, setLoadingConvo] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  // Prevent double-sends
  const sendingRef = useRef(false);

  // Abort controller — cancel in-flight requests on conversation switch or unmount
  const abortRef = useRef<AbortController | null>(null);
  // Separate controller for the background auto-image pipeline. We don't want
  // a normal stream-abort to kill an in-flight image, but switching
  // conversations / starting a new chat / unmounting must cancel it so the
  // result never lands in the wrong conversation.
  const autoImageAbortRef = useRef<AbortController | null>(null);
  // Same idea for the explicit /api/imagine path — we fire-and-forget so the
  // user can keep chatting while HER "draws".
  const explicitImageAbortRef = useRef<AbortController | null>(null);

  // ── Empty state / suggestion chip prefill ──
  const [prefillText, setPrefillText] = useState<string | null>(null);

  // Session key — increments on session switch to trigger fade animation
  const [sessionKey, setSessionKey] = useState(0);

  // Force-scroll trigger — unconditional scroll on new messages (user send, HER reply).
  // Streaming auto-scroll is handled internally by ChatWindow via virtuoso's
  // followOutput, so we no longer fire a per-token scroll signal from here.
  const [forceScrollTrigger, setForceScrollTrigger] = useState(0);

  // ── Image Studio state ──
  const [studioOpen, setStudioOpen] = useState(false);
  const [lastRevisedPrompt, setLastRevisedPrompt] = useState<string | null>(null);
  const [studioError, setStudioError] = useState<string | null>(null);

  // ── Ref for studio prefill (reuse prompt / edit source) ──
  const [studioPrefill, setStudioPrefill] = useState<{
    prompt?: string;
    mode?: "create" | "edit";
    sourceImage?: string;
  } | null>(null);
  const [studioKey, setStudioKey] = useState(0);

  // ── Conversation mode ──
  const [conversationMode, setConversationMode] = useState<ConversationMode>("default");

  // ── Retry state — stores the last failed user message for retry ──
  const [retryContent, setRetryContent] = useState<{ content: string; image?: string } | null>(null);

  // ── Reply/quote state — the message being replied to ──
  const [replyingTo, setReplyingTo] = useState<Message["replyTo"] | null>(null);

  // ── Rapport system — progressive bonding ──
  const [rapportLevel, setRapportLevel] = useState<RapportLevel>(0);
  const rapportStatsRef = useRef({ totalConversations: 0, totalUserMessages: 0 });

  // ── Cross-conversation memory ──
  const [memoryContext, setMemoryContext] = useState<string | null>(null);
  /** Compact behavioral-only context (Step EXP+1) — never contains emotion labels. */
  const [interactionContext, setInteractionContext] = useState<string | null>(null);

  /**
   * Fire-and-forget: extract memories from a set of messages and refresh context.
   * Uses a ref-stable function so it can be called from any callback without
   * stale closures or declaration-order issues.
   */
  const extractMemoryRef = useRef<(msgs: Message[]) => void>(() => {});
  extractMemoryRef.current = (msgs: Message[]) => {
    const userMsgs = msgs.filter((m) => m.role === "user");
    if (userMsgs.length < 3) return;

    // Build recent context for ranked memory retrieval
    const recentCtxForMemory = msgs.slice(-4).map((m) => m.content).join(" ").slice(0, 300);

    getEffectiveUserId().then((userId) => {
      const payload = msgs
        .filter((m) => m.id !== "greeting")
        .map((m) => ({ role: m.role, content: m.content }));

      authFetch("/api/memory/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, messages: payload }),
      }, accessTokenRef.current)
        .then((res) => res.json())
        .then((data) => {
          if (data.extracted > 0) {
            debug(`[HER] Extracted ${data.extracted} memories`);
            // Refresh memory context with ranking based on recent conversation
            const ctxParam = recentCtxForMemory ? `&context=${encodeURIComponent(recentCtxForMemory)}` : "";
            authFetch(`/api/memory?userId=${encodeURIComponent(userId)}${ctxParam}`, {}, accessTokenRef.current)
              .then((r) => r.json())
              .then((d) => { if (d.memoryContext) setMemoryContext(d.memoryContext); })
              .catch(() => {});
          }
        })
        .catch(() => {});
    }).catch(() => {});
  };

  /**
   * Ref-stable wrapper for handleReaction so module-level helpers
   * (maybeHerReact) can call it without stale closures.
   */
  const handleReactionRef = useRef<(messageId: string, emoji: string, reactor: "user" | "her") => void>(() => {});

  // Fetch rapport stats once on mount (fire-and-forget)
  useEffect(() => {
    getEffectiveUserId().then((userId) =>
      getUserRapportStats(userId).then((stats) => {
        rapportStatsRef.current = stats;
        const currentUserMsgs = messages.filter((m) => m.role === "user").length;
        const level = computeRapportLevel({
          ...stats,
          currentMessageCount: currentUserMsgs,
        });
        setRapportLevel(level);

        // If rapport > 0, regenerate surface copy with appropriate greetings
        // (only if still on the initial greeting — don't disrupt ongoing chat)
        if (level > 0 && messages.length === 1 && messages[0].id === "greeting") {
          const freshCopy = createSurfaceCopyBundle(level);
          setSurfaceCopy(freshCopy);
          setMessages([createGreeting(freshCopy.greeting)]);
        }
      })
    ).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch cross-conversation memory on mount (+ auto-backfill if needed)
  useEffect(() => {
    getEffectiveUserId().then((userId) => {
      authFetch(`/api/memory?userId=${encodeURIComponent(userId)}`, {}, accessTokenRef.current)
        .then((res) => res.json())
        .then((data) => {
          if (data.memoryContext) {
            setMemoryContext(data.memoryContext);
            debug("[HER] Memory loaded");
          } else if (rapportStatsRef.current.totalConversations >= 2) {
            // User has past conversations but no memories — run backfill once
            debug("[HER] No memories found — running backfill");
            authFetch("/api/memory/backfill", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ userId }),
            }, accessTokenRef.current)
              .then((r) => r.json())
              .then((result) => {
                debug("[HER] Backfill complete", result?.extracted ?? 0);
                if (result.extracted > 0) {
                  // Re-fetch memory context now that backfill is done
                  authFetch(`/api/memory?userId=${encodeURIComponent(userId)}`, {}, accessTokenRef.current)
                    .then((r2) => r2.json())
                    .then((d) => { if (d.memoryContext) setMemoryContext(d.memoryContext); })
                    .catch(() => {});
                }
              })
              .catch(() => {});
          }
        })
        .catch(() => {});
    }).catch(() => {});
  }, []);

  // Step EXP+1: load the current interaction texture (behavioral signals only).
  // Re-runs when the active conversation changes so per-convo signals win.
  useEffect(() => {
    getEffectiveUserId().then((userId) => {
      const url = `/api/interaction?userId=${encodeURIComponent(userId)}`
        + (activeConvoId ? `&conversationId=${encodeURIComponent(activeConvoId)}` : "");
      authFetch(url, {}, accessTokenRef.current)
        .then((res) => res.json())
        .then((data) => {
          if (typeof data?.interactionContext === "string" || data?.interactionContext === null) {
            setInteractionContext(data.interactionContext);
          }
        })
        .catch(() => {});
    }).catch(() => {});
  }, [activeConvoId]);

  useEffect(() => {
    const saved = loadSession();
    if (saved && saved.messages.length > 0) {
      setMessages(saved.messages);
    } else {
      setMessages([createGreeting(surfaceCopy.greeting)]);
    }
    setHydrated(true);

    // Restore active conversation ID from localStorage
    const storedConvoId = getActiveConversationId();
    if (storedConvoId) setActiveConvoId(storedConvoId);

    // Initialize Supabase persistence (device profile) — fire-and-forget
    initPersistence().catch(() => {});
    // Mount-only: greeting is read once at hydrate; rapport-driven copy
    // refresh is handled by the rapport effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

        // Priority for which conversation to open:
        //   1. ?c=<id> URL param (set when user taps a notification)
        //   2. Last active conversation from localStorage
        let targetId: string | null = null;
        if (typeof window !== "undefined") {
          const params = new URLSearchParams(window.location.search);
          const fromUrl = params.get("c");
          if (fromUrl && convos.some((c) => c.id === fromUrl)) {
            targetId = fromUrl;
            // Clean the URL so refreshing doesn't re-open it
            const cleanUrl = window.location.pathname;
            window.history.replaceState({}, "", cleanUrl);
          }
        }
        if (!targetId) {
          const storedId = getActiveConversationId();
          if (storedId && convos.some((c) => c.id === storedId)) {
            targetId = storedId;
          }
        }
        if (targetId) loadConversationMessages(targetId);
      }
    });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, isAuthenticated, user?.id]);

  // ── Persist whenever messages change (skip the first server render) ──
  // Filter out in-flight placeholders (imageLoading) so they never leak to storage
  // Debounced by default (300ms) — immediate on final states
  useEffect(() => {
    if (!hydrated) return;
    const persistable = messages.filter((m) => !m.imageLoading);
    saveMessages(persistable, !isStreaming);
  }, [messages, hydrated, isStreaming]);

  // Stable ref for current messages — avoids stale closures without adding `messages` to deps
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Stable ref for surfaceCopy greeting — used by loadConversationMessages without adding to deps
  const surfaceCopyRef = useRef(surfaceCopy);
  surfaceCopyRef.current = surfaceCopy;

  // ── Abort cleanup on unmount — cancel any in-flight requests when navigating away ──
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
      autoImageAbortRef.current?.abort();
      autoImageAbortRef.current = null;
      explicitImageAbortRef.current?.abort();
      explicitImageAbortRef.current = null;
    };
  }, []);

  // ── Load messages for a specific conversation ──
  const loadConversationMessages = useCallback(async (conversationId: string) => {
    // Extract memories from the conversation we're leaving (fire-and-forget)
    extractMemoryRef.current(messagesRef.current);

    // Cancel any in-flight request from the previous conversation
    abortRef.current?.abort();
    abortRef.current = null;
    // Also kill any background auto-image — it belongs to the previous convo.
    autoImageAbortRef.current?.abort();
    autoImageAbortRef.current = null;
    explicitImageAbortRef.current?.abort();
    explicitImageAbortRef.current = null;

    setLoadingConvo(true);
    sendingRef.current = false;

    // Fetch latest page + total count in parallel for fast initial render
    const [dbMessages, total] = await Promise.all([
      getConversationMessages(conversationId),
      countConversationMessages(conversationId),
    ]);

    if (dbMessages.length > 0) {
      const uiMessages: Message[] = dbMessages.map(dbMessageToUiMessage);
      setMessages(uiMessages);
      setHasMoreMessages(total > dbMessages.length);
    } else {
      // Conversation exists but has no messages — show greeting
      setMessages([createGreeting(surfaceCopyRef.current.greeting)]);
      setHasMoreMessages(false);
    }

    setActiveConvoId(conversationId);
    setActiveConversationId(conversationId);
    // Mark this conversation as seen so the unread dot disappears.
    markConversationSeen(conversationId);
    setLoadingConvo(false);
    setIsTyping(false);
    setIsStreaming(false);
    setStudioOpen(false);
    setLastRevisedPrompt(null);
    setStudioError(null);
    setRetryContent(null);
    setReplyingTo(null);
    sendingRef.current = false;
    setSessionKey((k) => k + 1);
    setForceScrollTrigger((n) => n + 1);
    setError(null);
  }, []); // no deps — reads messages via messagesRef to avoid stale closures

  // Stable ref for loadConversationMessages so listeners (SW messages, etc.)
  // can call the latest version without rebinding.
  const loadConvoRef = useRef(loadConversationMessages);
  loadConvoRef.current = loadConversationMessages;

  // ── Listen for SW notification taps while the app is already open ──
  // The SW posts { type: "her:open-conversation", conversationId } so we
  // can switch in-place instead of doing a full navigation.
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    const onMessage = (e: MessageEvent) => {
      const data = e.data;
      if (!data || data.type !== "her:open-conversation") return;
      const id = data.conversationId;
      if (typeof id !== "string") return;
      // Refresh the conversation list first so the freshly-arrived message is visible
      // in the drawer, then jump to the right conversation.
      loadConvoRef.current(id);
    };

    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
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

  // ── Unread set: conversations with last_message_at newer than last seen ──
  // Recomputed when the list refreshes or the active conversation changes
  // (so the dot disappears the moment you open a conversation).
  const unreadIds = useMemo(
    () => getUnreadConversationIds(conversations, activeConvoId),
    [conversations, activeConvoId]
  );

  // ── Background poll: refresh the conversation list while the app is open ──
  // Catches notifications that arrived in other conversations (or while the
  // app was hidden) so the unread dot lights up without a manual refresh.
  useEffect(() => {
    if (!isAuthenticated || !user?.id) return;
    const tick = () => { refreshConversations().catch(() => {}); };
    // Poll every 60s while visible; immediately on visibilitychange to visible.
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") tick();
    }, 60_000);
    const onVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") tick();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible);
    }
    return () => {
      clearInterval(interval);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible);
      }
    };
  }, [isAuthenticated, user?.id, refreshConversations]);

  // ── Load older messages (pagination) ──
  const handleLoadOlder = useCallback(async () => {
    if (!activeConvoId || loadingOlder || !hasMoreMessages) return;
    const current = messagesRef.current;
    // Find the oldest non-greeting timestamp
    const oldest = current.find((m) => m.id !== "greeting");
    if (!oldest) return;

    setLoadingOlder(true);
    try {
      const older = await getOlderMessages(
        activeConvoId,
        new Date(oldest.timestamp).toISOString()
      );
      if (older.length > 0) {
        const olderUi: Message[] = older.map(dbMessageToUiMessage);
        // Dedupe against current — Supabase boundary semantics may include
        // a row already in our array; duplicates would render as duplicate keys.
        const existingIds = new Set(current.map((m) => m.id));
        const fresh = olderUi.filter((m) => !existingIds.has(m.id));
        if (fresh.length > 0) {
          setMessages([...fresh, ...current]);
          // ChatWindow's layout effect snapshots scrollHeight before/after
          // and adjusts scrollTop to keep the user's view anchored — no
          // index bookkeeping needed up here.
        }
        // If we got fewer than a full page, we've hit the start
        if (older.length < MESSAGES_PAGE_SIZE) setHasMoreMessages(false);
      } else {
        setHasMoreMessages(false);
      }
    } catch (err) {
      // Never let a fetch failure crash the React tree — that's what was
      // producing the "this page couldn't load" error on mobile.
      console.warn("[HER] Load older messages failed:", err);
      setError("couldn't load older messages — try scrolling again in a sec");
    } finally {
      setLoadingOlder(false);
    }
  }, [activeConvoId, loadingOlder, hasMoreMessages]);

  // Pool that depends on session surface copy — memoized
  const LOCAL_IMAGE = useMemo(
    () => [surfaceCopy.imageGeneratingLabel, "working on it…"],
    [surfaceCopy.imageGeneratingLabel]
  );

  // ── Send a message (with streaming response) ──
  const handleSend = useCallback(async (content: string, image?: string) => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setError(null);
    setRetryContent(null);

    // Cancel any previous in-flight request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Add user message
    const userMessage: Message = {
      id: generateId(),
      role: "user",
      content: content || (image ? "(shared a photo)" : ""),
      timestamp: Date.now(),
      ...(image ? { image } : {}),
      ...(replyingTo ? { replyTo: { ...replyingTo } } : {}),
    };

    // Clear the reply state immediately so it doesn't linger
    const currentReply = replyingTo;
    setReplyingTo(null);

    // Use functional updater to avoid stale closure over `messages`
    let updatedMessages: Message[] = [];
    setMessages((prev) => {
      updatedMessages = [...prev, userMessage];
      return updatedMessages;
    });
    setIsTyping(true);
    // Force-scroll to show the user's new message immediately
    setForceScrollTrigger((n) => n + 1);

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
      maybeUpdateTitle(convoId, updatedMessages, userMessage.content, setConversations);
    }

    if (convoId) {
      // Upload user-attached image to Storage first so the messages row stays small.
      // Falls back to original data URL if storage isn't configured.
      let userImageUrl: string | undefined = image || undefined;
      if (userImageUrl && isDataUrl(userImageUrl)) {
        userImageUrl = await uploadDataUrlToStorage(userId, userImageUrl);
      }

      saveMessageToSupabase({
        conversationId: convoId,
        userId,
        role: "user",
        content: userMessage.content,
        imageUrl: userImageUrl,
        clientMessageId: userMessage.id,
        ...(currentReply ? {
          replyToId: currentReply.id,
          replyToContent: currentReply.content,
          replyToRole: currentReply.role,
        } : {}),
      }).catch(() => {});
    }

    // Create a stable ID for the streaming assistant message
    const herMessageId = generateId();

    // ── Vision analysis branch (user uploaded an image) ──
    if (image) {
      const visionPrompt = content || "Describe this image in detail.";

      try {
        // Show placeholder while vision model analyzes
        setIsTyping(false);
        setIsStreaming(true);

        const herPlaceholder: Message = {
          id: herMessageId,
          role: "assistant",
          content: pickRandom(LOCAL_VISION),
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, herPlaceholder]);
        setForceScrollTrigger((n) => n + 1);

        await humanDelay();

        const res = await authFetch("/api/vision", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image, prompt: visionPrompt }),
          signal: controller.signal,
        }, accessTokenRef.current);

        if (!res.ok) {
          const errData = await res.json().catch(() => ({ error: "Failed to analyze image" }));
          throw new Error(errData.error || pickRandom(LOCAL_VISION_FAIL));
        }

        const data = await res.json();

        if (!data.message) {
          throw new Error(pickRandom(LOCAL_VISION_FAIL));
        }

        // ── Vision complete — finalize ──
        setMessages((prev) =>
          prev.map((m) =>
            m.id === herMessageId
              ? { ...m, content: data.message, timestamp: Date.now() }
              : m
          )
        );
        setForceScrollTrigger((n) => n + 1);

        // ── Persist assistant vision response to Supabase ──
        persistAssistantMessage(convoId, userId, data.message, herMessageId, undefined, refreshConversations);
      } catch (err) {
        // Silently ignore aborted requests (user switched conversation)
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        const msg = err instanceof Error ? err.message : "something went wrong";
        setError(msg);
        setMessages((prev) => prev.filter((m) => m.id !== herMessageId));
      } finally {
        setIsTyping(false);
        setIsStreaming(false);
        sendingRef.current = false;
        if (abortRef.current === controller) abortRef.current = null;
      }
      return; // Exit early — vision path complete
    }

    // ── Image generation branch (fire-and-forget) ──
    // We deliberately don't block the chat UI on image generation. Instead:
    //   1. Drop a placeholder message with `imageLoading: true`
    //   2. Free sendingRef / isStreaming / isTyping IMMEDIATELY so the user
    //      can keep chatting with HER while she "draws"
    //   3. Run the fetch in the background; when it resolves, patch the
    //      placeholder in place (or remove it on failure)
    //   4. Convo-switch / unmount aborts via explicitImageAbortRef so the
    //      result never lands in the wrong conversation
    if (isImageRequest(content)) {
      const imagePrompt = extractImagePrompt(content);
      // Route through the same `routeImageType()` the auto pipeline uses,
      // so model selection (incl. self-portrait → Kontext + reference) lives
      // in one place. The server fills in the reference image when it sees
      // mode: "edit" without an uploaded `image`.
      const explicitType = detectExplicitImageType(content);
      const route = routeImageType(explicitType);

      // Transition typing → placeholder
      setIsTyping(false);

      const herPlaceholder: Message = {
        id: herMessageId,
        role: "assistant",
        content: pickRandom(LOCAL_IMAGE),
        timestamp: Date.now(),
        imageLoading: true,
      };
      setMessages((prev) => [...prev, herPlaceholder]);
      setForceScrollTrigger((n) => n + 1);

      // Free the input lock immediately — image generation runs in background.
      // The text-stream abortRef is also released since this turn isn't
      // owning the streaming slot anymore.
      sendingRef.current = false;
      setIsStreaming(false);
      if (abortRef.current === controller) abortRef.current = null;

      // Background image generation with its own abort controller.
      // Convo-switch / unmount cancels via explicitImageAbortRef.
      explicitImageAbortRef.current?.abort();
      const imgController = new AbortController();
      explicitImageAbortRef.current = imgController;
      const startingConvoId = convoId;
      const stillOnSameConversation = () =>
        getActiveConversationId() === startingConvoId;

      (async () => {
        try {
          await humanDelay();
          if (imgController.signal.aborted) return;

          const res = await authFetch("/api/imagine", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              prompt: imagePrompt,
              modelId: route.modelId,
              mode: route.mode,
              aspect_ratio: route.overrides.aspect_ratio,
              steps: route.overrides.steps,
              cfg_scale: route.overrides.cfg_scale,
            }),
            signal: imgController.signal,
          }, accessTokenRef.current);

          if (imgController.signal.aborted || !stillOnSameConversation()) return;

          if (!res.ok) {
            const errData = await res.json().catch(() => ({ error: "Failed to generate image" }));
            throw new Error(errData.error || pickRandom(LOCAL_IMAGE_FAIL));
          }

          const data = await res.json();
          if (!data.image) throw new Error(pickRandom(LOCAL_IMAGE_FAIL));

          if (imgController.signal.aborted || !stillOnSameConversation()) return;

          // Patch the placeholder in place
          const captionText = pickRandom(LOCAL_IMAGE_CAPTIONS);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === herMessageId
                ? { ...m, content: captionText, image: data.image, imageLoading: false, timestamp: Date.now() }
                : m
            )
          );
          setForceScrollTrigger((n) => n + 1);

          persistAssistantMessage(startingConvoId, userId, captionText, herMessageId, data.image, refreshConversations);
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") return;
          if (!stillOnSameConversation()) return;
          const msg = err instanceof Error ? err.message : "something went wrong";
          setError(msg);
          // Drop the placeholder so the failed turn doesn't linger
          setMessages((prev) => prev.filter((m) => m.id !== herMessageId));
        } finally {
          if (explicitImageAbortRef.current === imgController) {
            explicitImageAbortRef.current = null;
          }
        }
      })();

      return; // Exit early — image path scheduled
    }

    // ── Text streaming branch (existing) ──

    // Compute conversation continuity for anti-repetition
    const continuity = buildContinuity(updatedMessages);
    const continuityContext = buildContinuityBlock(continuity) ?? undefined;

    // Update rapport level with current message count
    const currentUserMsgs = updatedMessages.filter((m) => m.role === "user").length;
    const currentRapport = computeRapportLevel({
      ...rapportStatsRef.current,
      currentMessageCount: currentUserMsgs,
    });
    setRapportLevel(currentRapport);

    // ── Inject reply context into messages for the LLM ──
    // If the latest user message is a reply, prepend the quoted text so HER knows the context.
    const apiMessages = updatedMessages.map((m) => {
      // Strip any legacy reaction annotations from message content
      const cleanContent = m.content.replace(/\s*\[user reacted to this: [^\]]*\]/g, "");
      const cleaned = { ...m, content: cleanContent };
      if (cleaned.replyTo && cleaned.role === "user") {
        const quotedLabel = cleaned.replyTo.role === "user" ? "the user" : "HER";
        const quotedSnippet = cleaned.replyTo.content.length > 120
          ? cleaned.replyTo.content.slice(0, 120).trimEnd() + "…"
          : cleaned.replyTo.content;
        return {
          ...cleaned,
          content: `[replying to ${quotedLabel}: "${quotedSnippet}"]\n${cleaned.content}`,
        };
      }
      return cleaned;
    });

    // ── Build a compact reaction summary for the last few messages ──
    // Passed as part of the request context, NOT baked into message content.
    // This prevents the LLM from echoing "[user reacted to this: ❤️]" in its replies.
    const recentReactions: string[] = [];
    const recentSlice = updatedMessages.slice(-10);
    for (const m of recentSlice) {
      if (!m.reactions) continue;
      const userEmojis = Object.entries(m.reactions)
        .filter(([, reactors]) => reactors.includes("user"))
        .map(([emoji]) => emoji);
      if (userEmojis.length > 0) {
        const label = m.role === "assistant" ? "your message" : "their own message";
        const snippet = m.content.length > 30 ? m.content.slice(0, 30).trimEnd() + "…" : m.content;
        recentReactions.push(`they reacted ${userEmojis.join("")} to ${label}: "${snippet}"`);
      }
    }
    const reactionContext = recentReactions.length > 0
      ? `Recent emoji reactions: ${recentReactions.join("; ")}`
      : undefined;

    // ── Step 21: Adaptive Intelligence Layer (auth users only) ──
    let responseModeInstruction: string | undefined;
    let antiRepetitionInstruction: string | undefined;

    if (isAuthenticated) {
      // Part A: Analyze interaction patterns
      const patterns = analyzeInteractionPattern(updatedMessages);

      // Part B: Select response mode based on patterns + continuity
      const continuityState = buildContinuity(updatedMessages);
      const timeSinceLast = updatedMessages.length >= 2
        ? Date.now() - updatedMessages[updatedMessages.length - 2].timestamp
        : 0;
      const modeResult = selectResponseMode({
        continuity: continuityState,
        patterns,
        timeSinceLastMessage: timeSinceLast,
        isAuthenticated: true,
      });
      if (modeResult.instruction) {
        responseModeInstruction = modeResult.instruction;
      }

      // Part C: Anti-repetition runtime check
      const recentAssistant = updatedMessages
        .filter((m) => m.role === "assistant" && m.id !== "greeting")
        .slice(-8)
        .map((m) => m.content);
      const repetitionCheck = checkRepetition(recentAssistant);
      if (repetitionCheck.variationInstruction) {
        antiRepetitionInstruction = repetitionCheck.variationInstruction;
      }

      // Part A (persist): save patterns every 10 messages (fire-and-forget)
      const totalMsgs = updatedMessages.filter((m) => m.role === "user").length;
      if (totalMsgs > 0 && totalMsgs % 10 === 0) {
        getEffectiveUserId().then((uid) =>
          saveInteractionPattern(uid, patterns).catch(() => {})
        ).catch(() => {});
      }
    }

    try {
      const res = await authFetch("/api/chat?stream=true", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: apiMessages,
          mode: conversationMode,
          rapportLevel: currentRapport,
          memoryContext: memoryContext ?? undefined,
          continuityContext: [continuityContext, reactionContext, interactionContext].filter(Boolean).join("\n") || undefined,
          responseModeInstruction,
          antiRepetitionInstruction,
          userTimezone: detectUserTimezone(),
        }),
        signal: controller.signal,
      }, accessTokenRef.current);

      if (!res.ok || !res.body) {
        // Non-streaming error (e.g. 400, 429, 502)
        const errorText = await res.text().catch(() => "");
        throw new Error(errorText || "Failed to get a response");
      }

      // ── Transition from typing indicator to streaming text ──
      setIsTyping(false);
      setIsStreaming(true);

      // Insert placeholder — starts empty (triggers "thinking…" in MessageBubble)
      const herPlaceholder: Message = {
        id: herMessageId,
        role: "assistant",
        content: "",
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, herPlaceholder]);
      setForceScrollTrigger((n) => n + 1);

      await humanDelay();

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
        // Streaming auto-scroll is owned by virtuoso's followOutput now —
        // no manual scroll signal needed per token.
      }

      // ── Stream complete — finalize ──
      if (!fullText) {
        throw new Error("wait something broke on my end — try that again?");
      }

      // Ensure final state is clean
      setMessages((prev) =>
        prev.map((m) =>
          m.id === herMessageId
            ? { ...m, content: fullText, timestamp: Date.now() }
            : m
        )
      );

      // Clear retry state on success
      setRetryContent(null);

      // ── Persist FINAL assistant message to Supabase (fire-and-forget) ──
      persistAssistantMessage(convoId, userId, fullText, herMessageId, undefined, refreshConversations);

      // ── HER auto-react: maybe react to the user's message with an emoji ──
      maybeHerReact(userMessage, fullText, handleReactionRef.current, accessTokenRef.current);

      // ── Temporal intent detection (fire-and-forget, auth users only) ──
      // Detects future events/tasks in the user's message and schedules follow-ups
      // Also handles: predictive follow-ups, continuity learning, event resolution
      // Guests get zero background cost — no scheduling, no LLM calls
      if (isAuthenticated && accessTokenRef.current) {
        // Build a brief recent context for predictive follow-up detection
        const recentCtx = updatedMessages
          .slice(-6)
          .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
          .join("\n");

        authFetch("/api/temporal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: userMessage.content,
            conversationId: convoId,
            recentContext: recentCtx,
            userTimezone: detectUserTimezone(),
            agentReply: fullText,
          }),
        }, accessTokenRef.current).catch(() => {});
      }

      // ── Periodic memory extraction (every ~10 user messages) ──
      const totalUserMsgs = updatedMessages.filter((m) => m.role === "user").length;
      if (totalUserMsgs > 0 && totalUserMsgs % 5 === 0) {
        extractMemoryRef.current(updatedMessages);
      }

      // ── Step EXP+1: extract a behavioral interaction signal for this turn ──
      // Fire-and-forget. NEVER stores emotions — only observable patterns.
      // Refreshes the in-memory interactionContext so the next reply has it.
      //
      // EXP+2 cost controls:
      //   - sample every 2nd user turn (not every turn)
      //   - skip when the user message is trivially short (<10 chars) — no signal there
      const userMsgCount = updatedMessages.filter((m) => m.role === "user").length;
      const userMsgLong = userMessage.content.trim().length >= 10;
      const shouldExtractSignal =
        isAuthenticated &&
        accessTokenRef.current &&
        userMsgLong &&
        userMsgCount % 2 === 0;
      if (shouldExtractSignal) {
        const recentForSignal = updatedMessages
          .slice(-10)
          .map((m) => ({ role: m.role, content: m.content }));
        authFetch("/api/interaction/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId,
            conversationId: convoId,
            messageId: herMessageId,
            recentMessages: recentForSignal,
            latestUserMessage: userMessage.content,
            latestHerResponse: fullText,
          }),
        }, accessTokenRef.current)
          .then((r) => r.json())
          .then((data) => {
            if (data?.stored) {
              const url = `/api/interaction?userId=${encodeURIComponent(userId)}`
                + (convoId ? `&conversationId=${encodeURIComponent(convoId)}` : "");
              authFetch(url, {}, accessTokenRef.current)
                .then((r) => r.json())
                .then((d) => {
                  if (typeof d?.interactionContext === "string" || d?.interactionContext === null) {
                    setInteractionContext(d.interactionContext);
                  }
                })
                .catch(() => {});
            }
          })
          .catch(() => {});
      }

      // ── Memory feedback loop (Step 19 Part G, auth users only) ──
      // Detects corrections, reinforcements, and emotional shifts in memories
      if (isAuthenticated && accessTokenRef.current) {
        authFetch("/api/memory/feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userMessage: userMessage.content,
            assistantMessage: fullText,
          }),
        }, accessTokenRef.current).catch(() => {});
      }

      // ── Implicit image generation (auto pipeline) ──
      // Fire in background, in parallel with the rest of the response cycle.
      // If the classifier says yes, an image arrives later as a NEW HER message
      // with a contextual delivery caption — never interrupting the active flow.
      // Cancel any previous auto-image first — we only ever care about the
      // most recent turn's pending image.
      autoImageAbortRef.current?.abort();
      const autoImageController = new AbortController();
      autoImageAbortRef.current = autoImageController;
      maybeAutoGenerateImage(
        updatedMessages,
        userId,
        convoId,
        accessTokenRef.current,
        setMessages,
        setForceScrollTrigger,
        refreshConversations,
        autoImageController.signal,
      ).finally(() => {
        if (autoImageAbortRef.current === autoImageController) {
          autoImageAbortRef.current = null;
        }
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }
      const msg = err instanceof Error ? err.message : "something went wrong";
      setError(msg);

      // Store retry info so user can try again
      setRetryContent({ content: userMessage.content, image: image ?? undefined });

      // Remove the empty/partial placeholder if stream failed
      setMessages((prev) => prev.filter((m) => m.id !== herMessageId));
    } finally {
      setIsTyping(false);
      setIsStreaming(false);
      sendingRef.current = false;
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [activeConvoId, refreshConversations, conversationMode, memoryContext, interactionContext, replyingTo, LOCAL_IMAGE, isAuthenticated]);

  const handleRetry = useCallback(() => {
    if (!retryContent || sendingRef.current) return;
    const { content, image } = retryContent;
    setError(null);
    setRetryContent(null);
    // Remove the last user message (we'll re-send it)
    setMessages((prev) => {
      const lastUserIdx = [...prev].reverse().findIndex((m) => m.role === "user");
      if (lastUserIdx === -1) return prev;
      const idx = prev.length - 1 - lastUserIdx;
      return [...prev.slice(0, idx), ...prev.slice(idx + 1)];
    });
    // Re-send on next microtask so setMessages has flushed
    queueMicrotask(() => handleSend(content, image));
  }, [retryContent, handleSend]);

  // ── Reply handler — sets the quote context for the next message ──
  const handleReply = useCallback((msg: Message) => {
    setReplyingTo({
      id: msg.id,
      content: msg.content,
      role: msg.role,
    });
  }, []);

  const cancelReply = useCallback(() => {
    setReplyingTo(null);
  }, []);

  // ── Reaction handler — toggle emoji on a message ──
  const handleReaction = useCallback((messageId: string, emoji: string, reactor: "user" | "her") => {
    setMessages((prev) => {
      const updated = prev.map((m) => {
        if (m.id !== messageId) return m;
        const reactions = { ...(m.reactions || {}) };
        const reactors = reactions[emoji] ? [...reactions[emoji]] : [];
        const idx = reactors.indexOf(reactor);
        if (idx >= 0) {
          // Toggle off
          reactors.splice(idx, 1);
          if (reactors.length === 0) {
            delete reactions[emoji];
          } else {
            reactions[emoji] = reactors;
          }
        } else {
          // Toggle on
          reactions[emoji] = [...reactors, reactor];
        }
        return { ...m, reactions: Object.keys(reactions).length > 0 ? reactions : undefined };
      });

      // Persist to Supabase (fire-and-forget)
      const msg = updated.find((m) => m.id === messageId);
      if (msg) {
        saveReactionToSupabase(messageId, msg.reactions || {}).catch(() => {});
      }

      return updated;
    });
  }, []);

  // Keep the ref in sync so module-level helpers can call it
  handleReactionRef.current = handleReaction;

  // ── Friendly error mapper for Image Studio ──
  function mapStudioError(raw: string): string {
    const lower = raw.toLowerCase();
    if (lower.includes("api key") || lower.includes("envkey") || lower.includes("configure") || lower.includes("missing") || lower.includes("unauthorized")) {
      return "she can't create right now — the image service key isn't working.";
    }
    if (lower.includes("rate limit") || lower.includes("429") || lower.includes("too many")) {
      return "too many requests — give it about 30 seconds and try again.";
    }
    if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("gateway") || lower.includes("abort")) {
      return "that took too long. try again in a moment.";
    }
    if (lower.includes("(422)") || lower.includes("rejected the request") || lower.includes("payload")) {
      return "those settings didn't quite work. try adjusting the prompt or switching to Recommended.";
    }
    if (lower.includes("unavailable") || lower.includes("overload") || lower.includes("503") || lower.includes("502") || lower.includes("unsupported model") || lower.includes("not be supported")) {
      return "the image service is taking a break. try once more, or switch to Recommended for the most reliable results.";
    }
    if (lower.includes("unexpected response")) {
      return "the image came back in a format she didn't recognize. try once more, or Recommended tends to be the most reliable.";
    }
    if (lower.includes("image") && (lower.includes("invalid") || lower.includes("read") || lower.includes("decode") || lower.includes("unsupported"))) {
      return "she couldn't read that image clearly. try a different one.";
    }
    // Fallback — include a hint of the real error for debugging
    console.warn("[HER Studio] Unmapped error:", raw);
    return "something went wrong. try once more, or switch to Recommended for the most reliable results.";
  }

  // ── Image Studio generation handler ──
  const handleStudioGenerate = useCallback(async (request: {
    prompt: string;
    modelId: string;
    mode: ImageStudioMode;
    aspect_ratio?: string;
    steps?: number;
    cfg_scale?: number;
    negative_prompt?: string;
    seed?: number;
    image?: string;
  }) => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setError(null);
    setStudioError(null);
    setStudioOpen(false);
    setLastRevisedPrompt(null);

    // Cancel any previous in-flight request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Add user message (shows what the user asked for)
    const userContent = request.mode === "edit"
      ? `✏️ ${request.prompt}`
      : `🎨 ${request.prompt}`;

    const userMessage: Message = {
      id: generateId(),
      role: "user",
      content: userContent,
      timestamp: Date.now(),
      ...(request.mode === "edit" && request.image ? { image: request.image } : {}),
    };

    let updatedMessages: Message[] = [];
    setMessages((prev) => {
      updatedMessages = [...prev, userMessage];
      return updatedMessages;
    });
    setIsTyping(true);

    // ── Persist user message to Supabase ──
    const userId = await getEffectiveUserId();
    let convoId = activeConvoId;

    if (!convoId) {
      convoId = await getOrCreateConversation(userId, userMessage.content).catch(() => null);
      if (convoId) {
        setActiveConvoId(convoId);
        setActiveConversationId(convoId);
      }
    } else {
      maybeUpdateTitle(convoId, updatedMessages, userMessage.content, setConversations);
    }

    if (convoId) {
      saveMessageToSupabase({
        conversationId: convoId,
        userId,
        role: "user",
        content: userMessage.content,
        imageUrl: request.mode === "edit" ? request.image : undefined,
        clientMessageId: userMessage.id,
      }).catch(() => {});
    }

    const herMessageId = generateId();

    try {
      setIsTyping(false);
      setIsStreaming(true);

      const herPlaceholder: Message = {
        id: herMessageId,
        role: "assistant",
        content: pickRandom(LOCAL_IMAGE),
        timestamp: Date.now(),
        imageLoading: true,
      };
      setMessages((prev) => [...prev, herPlaceholder]);
      setForceScrollTrigger((n) => n + 1);

      await humanDelay();

      const res = await authFetch("/api/imagine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: request.prompt,
          modelId: request.modelId,
          mode: request.mode,
          aspect_ratio: request.aspect_ratio,
          steps: request.steps,
          cfg_scale: request.cfg_scale,
          negative_prompt: request.negative_prompt,
          seed: request.seed,
          image: request.image,
        }),
        signal: controller.signal,
      }, accessTokenRef.current);

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: "Failed to generate image" }));
        throw new Error(errData.error || pickRandom(LOCAL_IMAGE_FAIL));
      }

      const data = await res.json();
      if (!data.image) {
        throw new Error(pickRandom(LOCAL_IMAGE_FAIL));
      }

      // Store the optimized prompt if the server returned one
      // (visible next time the user opens the studio — no auto-reopen)
      if (data.revisedPrompt) {
        setLastRevisedPrompt(data.revisedPrompt);
      }

      const captionText = request.mode === "edit"
        ? pickRandom(["here's the edit", "done", "how's this"])
        : pickRandom(LOCAL_IMAGE_CAPTIONS);

      setMessages((prev) =>
        prev.map((m) =>
          m.id === herMessageId
            ? { ...m, content: captionText, image: data.image, imageLoading: false, timestamp: Date.now() }
            : m
        )
      );
      setForceScrollTrigger((n) => n + 1);

      persistAssistantMessage(convoId, userId, captionText, herMessageId, data.image, refreshConversations);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      const raw = err instanceof Error ? err.message : "something went wrong";
      const friendly = mapStudioError(raw);
      console.warn(`[HER Studio] Generation error (model: ${request.modelId}, mode: ${request.mode}):`, raw);
      setStudioError(friendly);
      setStudioOpen(true); // Re-open studio to show the inline error
      setMessages((prev) => prev.filter((m) => m.id !== herMessageId));
    } finally {
      setIsTyping(false);
      setIsStreaming(false);
      sendingRef.current = false;
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [activeConvoId, refreshConversations, LOCAL_IMAGE]);

  // ── New chat / start over ──
  const handleClear = useCallback(() => {
    // Extract memories from the conversation we're leaving (fire-and-forget)
    extractMemoryRef.current(messagesRef.current);

    abortRef.current?.abort();
    abortRef.current = null;
    autoImageAbortRef.current?.abort();
    autoImageAbortRef.current = null;
    explicitImageAbortRef.current?.abort();
    explicitImageAbortRef.current = null;
    clearSession();
    clearActiveConversationId();
    setActiveConvoId(null);

    // Generate fresh surface copy for the new session
    const freshCopy = createSurfaceCopyBundle(rapportLevel);
    setSurfaceCopy(freshCopy);
    setMessages([createGreeting(freshCopy.greeting)]);

    // Reset pagination — a fresh chat has no older history to load.
    setHasMoreMessages(false);
    setLoadingOlder(false);

    setError(null);
    setIsTyping(false);
    setIsStreaming(false);
    setStudioOpen(false);
    setLastRevisedPrompt(null);
    setStudioError(null);
    setRetryContent(null);
    setReplyingTo(null);
    setConversationMode("default");
    sendingRef.current = false;
    setSessionKey((k) => k + 1);
  }, [rapportLevel]);

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
          const freshCopy = createSurfaceCopyBundle(rapportLevel);
          setSurfaceCopy(freshCopy);
          setMessages([createGreeting(freshCopy.greeting)]);
          setError(null);
        }
      }
      return success;
    },
    [activeConvoId, rapportLevel]
  );

  const dismissError = useCallback(() => setError(null), []);

  // ── Image action handlers (15J) ──

  const handleImageDownload = useCallback((imageUrl: string) => {
    try {
      const link = document.createElement("a");
      link.href = imageUrl;
      link.download = `her-image-${Date.now()}.png`;
      link.click();
    } catch {
      console.warn("[HER] Download failed");
    }
  }, []);

  const handleCopyPrompt = useCallback((prompt: string) => {
    navigator.clipboard?.writeText(prompt).catch(() => {});
  }, []);

  const handleReusePrompt = useCallback((prompt: string) => {
    setStudioPrefill({ prompt, mode: "create" });
    setStudioError(null);
    setStudioKey((k) => k + 1);
    setStudioOpen(true);
  }, []);

  const handleUseAsEditSource = useCallback((imageUrl: string) => {
    setStudioPrefill({ mode: "edit", sourceImage: imageUrl });
    setStudioError(null);
    setStudioKey((k) => k + 1);
    setStudioOpen(true);
  }, []);

  // ── Stable callback refs for JSX (avoid inline arrow re-creation) ──
  const openHistory = useCallback(() => setHistoryOpen(true), []);
  const closeHistory = useCallback(() => setHistoryOpen(false), []);
  const openAuth = useCallback(() => setAuthOpen(true), []);
  const closeAuth = useCallback(() => setAuthOpen(false), []);
  const closeStudio = useCallback(() => setStudioOpen(false), []);
  const toggleStudio = useCallback(() => setStudioOpen((v) => !v), []);
  const consumePrefill = useCallback(() => setPrefillText(null), []);
  const clearStudioError = useCallback(() => setStudioError(null), []);

  return (
    <div className="animate-page-enter flex h-full flex-col overflow-hidden bg-her-bg">
      <ChatHeader
        onClear={handleClear}
        onHistoryOpen={openHistory}
        onSignInClick={openAuth}
        accessToken={accessTokenRef.current}
      />

      {/* Conversation mode selector — auto-hides after a few seconds */}
      <ModeSelector
        mode={conversationMode}
        onChange={setConversationMode}
        disabled={isTyping || isStreaming}
      />

      {/* History drawer */}
      <HistoryDrawer
        open={historyOpen}
        onClose={closeHistory}
        conversations={conversations}
        activeConversationId={activeConvoId}
        onSelectConversation={handleSelectConversation}
        onNewChat={handleClear}
        onRenameConversation={handleRenameConversation}
        onDeleteConversation={handleDeleteConversation}
        isAuthenticated={isAuthenticated}
        loading={historyLoading}
        unreadIds={unreadIds}
        accessToken={accessTokenRef.current}
      />

      {/* Sign-in modal — opened from header for guests */}
      <AuthModal open={authOpen} onClose={closeAuth} />

      {/* Loading overlay for conversation switch */}
      {loadingConvo && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-her-bg/70 backdrop-blur-[2px]" role="status" aria-live="polite">
          <div className="flex flex-col items-center gap-3">
            <div className="animate-presence-breathe h-2 w-2 rounded-full bg-her-accent/40" />
            <span className="sr-only">Loading conversation</span>
          </div>
        </div>
      )}

      <ChatWindow<Message>
        key={sessionKey}
        items={messages}
        itemKey={(m) => m.id}
        forceScrollTrigger={forceScrollTrigger}
        anchorToBottom={
          // Let EmptyState breathe: only anchor to the bottom once a real
          // conversation has started. The greeting-only state renders its
          // own centered UI and shouldn't be shoved against the input.
          !(messages.length === 1 && messages[0].id === "greeting")
        }
        onScrollNearTop={hasMoreMessages && !loadingOlder ? handleLoadOlder : undefined}
        renderItem={(msg, i) => {
          const isGeneratedImage = !!msg.image && msg.role === "assistant" && !msg.imageLoading;

          // For generated images, find the preceding user prompt for copy/reuse
          let msgImageActions:
            | {
                onDownload?: (imageUrl: string) => void;
                onCopyPrompt?: () => void;
                onReusePrompt?: () => void;
                onUseAsEditSource?: (imageUrl: string) => void;
              }
            | undefined;
          if (isGeneratedImage) {
            // Walk backwards to find the user message that triggered this generation
            let userPrompt = "";
            for (let j = i - 1; j >= 0; j--) {
              if (messages[j].role === "user") {
                userPrompt = messages[j].content.replace(/^[🎨✏️]\s*/, "").trim();
                break;
              }
            }
            msgImageActions = {
              onDownload: handleImageDownload,
              onCopyPrompt: userPrompt ? () => handleCopyPrompt(userPrompt) : undefined,
              onReusePrompt: userPrompt ? () => handleReusePrompt(userPrompt) : undefined,
              onUseAsEditSource: handleUseAsEditSource,
            };
          }

          return (
            <MessageBubble
              message={msg}
              index={i}
              showTimestamp={!isStreaming && (i === 0 || i === messages.length - 1)}
              isStreaming={isStreaming && i === messages.length - 1 && msg.role === "assistant"}
              imageActions={msgImageActions}
              thinkingLabel={surfaceCopy.thinkingLabel}
              onReply={handleReply}
              onReaction={handleReaction}
            />
          );
        }}
        header={
          <>
            {/* Subtle loading indicator while older messages stream in */}
            {loadingOlder && (
              <div className="flex justify-center py-3" aria-live="polite">
                <div className="animate-presence-breathe h-1.5 w-1.5 rounded-full bg-her-accent/35" />
                <span className="sr-only">Loading older messages</span>
              </div>
            )}

            {/* Empty state — shown when conversation only has the greeting */}
            {!isTyping && messages.length === 1 && messages[0].id === "greeting" && (
              <EmptyState
                onSuggestion={setPrefillText}
                suggestions={surfaceCopy.starterPrompts}
                openingLine={surfaceCopy.openingLine}
                openingSubtext={surfaceCopy.openingSubtext}
              />
            )}
          </>
        }
        footer={
          <>
            {/* Typing indicator */}
            {isTyping && <TypingIndicator label={surfaceCopy.thinkingLabel} />}

            {/* Error toast */}
            {error && (
              <div role="alert" aria-live="assertive" className="animate-fade-in mb-5 flex flex-col items-center gap-2 px-3 sm:px-0">
                <button
                  onClick={dismissError}
                  aria-label="Dismiss error"
                  className="min-h-[44px] rounded-[18px] bg-her-accent/[0.05] px-5 py-3 text-[12px] leading-[1.5] text-her-accent/70 shadow-[0_1px_4px_rgba(180,140,110,0.04)] transition-colors duration-300 hover:bg-her-accent/[0.09] sm:px-6 sm:text-[13px]"
                >
                  {error}
                  <span className="ml-2.5 text-her-accent/25">✕</span>
                </button>
                {retryContent && (
                  <button
                    onClick={handleRetry}
                    aria-label="Retry sending message"
                    className="rounded-full border border-her-accent/15 px-4 py-1.5 text-[11px] tracking-[0.04em] text-her-accent/55 transition-all duration-200 hover:bg-her-accent/[0.06] hover:text-her-accent/75 active:scale-[0.96]"
                  >
                    try again
                  </button>
                )}
              </div>
            )}
          </>
        }
      />

      {/* Image Studio — slides in above the composer */}
      {studioOpen && (
        <div className="shrink-0 border-t border-her-border/10 bg-her-bg/95 pb-2 pt-3">
          <ImageStudio
            key={studioKey}
            onGenerate={handleStudioGenerate}
            disabled={isTyping || isStreaming}
            onClose={closeStudio}
            lastRevisedPrompt={lastRevisedPrompt}
            studioError={studioError}
            initialPrefill={studioPrefill}
            generatingLabel={surfaceCopy.imageGeneratingLabel}
            editingLabel={surfaceCopy.imageEditingLabel}
            promptPlaceholder={surfaceCopy.studioPlaceholder}
            onRetry={clearStudioError}
            onSwitchRecommended={clearStudioError}
          />
        </div>
      )}

      <ChatInput
        onSend={handleSend}
        disabled={isTyping || isStreaming}
        prefillText={prefillText ?? undefined}
        onPrefillConsumed={consumePrefill}
        onToggleStudio={toggleStudio}
        studioOpen={studioOpen}
        replyingTo={replyingTo}
        onCancelReply={cancelReply}
      />
    </div>
  );
}
