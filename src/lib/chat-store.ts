import { Message, ChatSession } from "./types";

// ── Constants ──────────────────────────────────────────────

export const STORAGE_KEY = "her-chat-session";
const STORAGE_VERSION = 1;

// ── Helpers ────────────────────────────────────────────────

/**
 * Generate a simple unique ID
 */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ── Validation ─────────────────────────────────────────────

/**
 * Checks whether a stored value looks like a valid ChatSession.
 * Protects against corrupted or outdated data shapes.
 */
function isValidSession(data: unknown): data is ChatSession & { _v?: number } {
  if (!data || typeof data !== "object") return false;

  const obj = data as Record<string, unknown>;
  if (typeof obj.id !== "string") return false;
  if (!Array.isArray(obj.messages)) return false;
  if (typeof obj.createdAt !== "number") return false;
  if (typeof obj.updatedAt !== "number") return false;

  // Validate every message has the right shape
  for (const msg of obj.messages) {
    if (!msg || typeof msg !== "object") return false;
    const m = msg as Record<string, unknown>;
    if (typeof m.id !== "string") return false;
    if (m.role !== "user" && m.role !== "assistant") return false;
    if (typeof m.content !== "string") return false;
    if (typeof m.timestamp !== "number") return false;
  }

  return true;
}

// ── Load / Save / Clear ────────────────────────────────────

/**
 * Load the current chat session from localStorage.
 * Returns null if nothing is stored, data is corrupted,
 * or we're running on the server (SSR).
 */
export function loadSession(): ChatSession | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed: unknown = JSON.parse(raw);

    if (!isValidSession(parsed)) {
      console.warn("[HER store] Invalid session data — clearing.");
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }

    return parsed as ChatSession;
  } catch {
    // JSON.parse failed or localStorage threw — wipe it
    console.warn("[HER store] Corrupted session data — clearing.");
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* noop */ }
    return null;
  }
}

/**
 * Save the full message array to localStorage.
 * Wraps messages in a ChatSession envelope so the shape
 * is always consistent and swappable to a DB later.
 */
export function saveMessages(messages: Message[]): void {
  if (typeof window === "undefined") return;

  try {
    // Load existing session to preserve the session id + createdAt
    const existing = loadSession();
    const now = Date.now();

    const session: ChatSession & { _v: number } = {
      id: existing?.id ?? generateId(),
      messages,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      _v: STORAGE_VERSION,
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch (error) {
    console.error("[HER store] Failed to save:", error);
  }
}

/**
 * Save a chat session to localStorage (legacy — kept for compat)
 */
export function saveSession(session: ChatSession): void {
  if (typeof window === "undefined") return;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...session, _v: STORAGE_VERSION }));
  } catch (error) {
    console.error("[HER store] Failed to save:", error);
  }
}

/**
 * Create a new empty chat session
 */
export function createSession(): ChatSession {
  const now = Date.now();
  return {
    id: generateId(),
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Add a message to the session and persist
 */
export function addMessage(
  session: ChatSession,
  role: Message["role"],
  content: string
): ChatSession {
  const message: Message = {
    id: generateId(),
    role,
    content,
    timestamp: Date.now(),
  };

  const updated: ChatSession = {
    ...session,
    messages: [...session.messages, message],
    updatedAt: Date.now(),
  };

  saveSession(updated);
  return updated;
}

/**
 * Clear the current session from localStorage
 */
export function clearSession(): void {
  if (typeof window === "undefined") return;

  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* noop */ }
}
