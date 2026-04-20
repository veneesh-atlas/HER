// ── App Message (used in UI & localStorage) ───────────────

/** Lightweight reference to a quoted/replied-to message */
export interface ReplyRef {
  id: string;
  content: string;
  role: "user" | "assistant";
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  /** Base64 data URL — attached photo (user) or generated image (assistant) */
  image?: string;
  /** True while an image is being generated for this message */
  imageLoading?: boolean;
  /** If this message is a reply, a lightweight reference to the quoted message */
  replyTo?: ReplyRef;
  /** Emoji reactions — maps emoji to array of who reacted ("user" | "her") */
  reactions?: Record<string, string[]>;
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
  /** Compact continuity context for anti-repetition */
  continuityContext?: string;
  /** Rapport level (0–4) for progressive bonding */
  rapportLevel?: number;
  /** Adaptive response mode instruction (Step 21) */
  responseModeInstruction?: string;
  /** Anti-repetition variation instruction (Step 21) */
  antiRepetitionInstruction?: string;
  /** IANA timezone name from the user's browser (e.g. "Asia/Kolkata") */
  userTimezone?: string;
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
  /** Rapport level (0–4) for progressive bonding */
  rapportLevel?: number;
  /** Cross-conversation memory context (fetched client-side) */
  memoryContext?: string;
  /** Compact continuity context for anti-repetition (computed client-side) */
  continuityContext?: string;
  /** Adaptive response mode instruction (Step 21) */
  responseModeInstruction?: string;
  /** Anti-repetition variation instruction (Step 21) */
  antiRepetitionInstruction?: string;
  /** IANA timezone name from the user's browser */
  userTimezone?: string;
}

export interface ChatResponse {
  message: string;
  error?: string;
}

// ── Image Generation Types ────────────────────────────────

export type ImageStudioMode = "create" | "edit";

export interface ImageGenerationRequest {
  prompt: string;
  /** Model ID from the image-models registry */
  modelId?: string;
  /** "create" or "edit" */
  mode?: ImageStudioMode;
  /** Aspect ratio — mapped to w/h or sent natively depending on model */
  aspect_ratio?: string;
  /** Generation steps */
  steps?: number;
  /** Classifier-free guidance scale */
  cfg_scale?: number;
  /** Negative prompt (only for models that support it) */
  negative_prompt?: string;
  /** Random seed */
  seed?: number;
  /** Base64 data URL of source image (required for edit mode) */
  image?: string;
}

export interface ImageGenerationResponse {
  image: string;
  error?: string;
  /** The enhanced prompt actually sent to the model (absent if unchanged) */
  revisedPrompt?: string;
}

/** State for the Image Studio advanced controls */
export interface ImageStudioState {
  mode: ImageStudioMode;
  modelId: string;
  prompt: string;
  aspect_ratio: string;
  steps?: number;
  cfg_scale?: number;
  negative_prompt?: string;
  seed?: number;
  /** Source image for edit mode (base64 data URL) */
  sourceImage?: string;
  /** Whether the advanced panel is expanded */
  advancedOpen: boolean;
}
