// ── App Message (used in UI & localStorage) ───────────────

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  /** Base64 data URL — attached photo (user) or generated image (assistant) */
  image?: string;
  /** True while an image is being generated for this message */
  imageLoading?: boolean;
}

// ── Model Message (sent to the LLM API) ────────────────────

export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ── Conversation Modes ─────────────────────────────────────

export type ConversationMode =
  | "default"     // Natural companion conversation
  | "comfort"     // Gentle, emotionally supportive
  | "playful"     // Light, teasing, fun energy
  | "deep"        // Philosophical, reflective, meaningful
  | "curious";    // Asking questions, exploring ideas

// ── Conversation Config ────────────────────────────────────

export interface ConversationConfig {
  mode: ConversationMode;
  /** Optional memory context to inject (future use) */
  memoryContext?: string;
  /** Max conversation messages to include in payload */
  maxMessages?: number;
}

// ── Session ────────────────────────────────────────────────

export interface ChatSession {
  id: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

// ── API Types ──────────────────────────────────────────────

export interface ChatRequest {
  messages: Message[];
  mode?: ConversationMode;
}

export interface ChatResponse {
  message: string;
  error?: string;
}
