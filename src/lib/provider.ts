/**
 * HER — AI Provider Abstraction
 *
 * This file isolates all LLM provider logic. The API route calls
 * a single function: generateReply(). The provider handles the rest.
 *
 * To switch providers:
 *   1. Set HER_PROVIDER in .env.local
 *   2. Add the provider's API key
 *   3. Implement the provider function below
 *
 * The frontend never knows or cares which provider is being used.
 */

import { ModelMessage } from "./types";
import { GoogleGenerativeAI } from "@google/generative-ai";

// ── Provider Interface ─────────────────────────────────────

type ProviderFn = (messages: ModelMessage[]) => Promise<string>;

// ── Gemini Provider ────────────────────────────────────────

async function geminiProvider(messages: ModelMessage[]): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "your_gemini_api_key_here") {
    throw new Error(
      "GEMINI_API_KEY is not configured. Add it to your .env.local file."
    );
  }

  const genAI = new GoogleGenerativeAI(apiKey);

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
  });

  // Gemini uses a different format:
  // - System instruction is separate
  // - History is an array of { role: "user" | "model", parts: [{ text }] }
  // - The last user message is sent via sendMessage()

  // Extract system prompt (first message with role "system")
  const systemMessage = messages.find((m) => m.role === "system");

  // Get only user/assistant messages (skip system)
  const conversationMessages = messages.filter((m) => m.role !== "system");

  // Gemini REQUIRES history to start with a "user" message.
  // HER's greeting (role: "assistant") comes first in our messages,
  // so we must strip any leading assistant messages.
  const trimmed: ModelMessage[] = [];
  let foundUser = false;
  for (const msg of conversationMessages) {
    if (!foundUser && msg.role === "assistant") {
      continue; // skip leading assistant messages
    }
    foundUser = true;
    trimmed.push(msg);
  }

  if (trimmed.length === 0) {
    throw new Error("No user messages to send");
  }

  // The last message is what we send via sendMessage()
  const lastMessage = trimmed[trimmed.length - 1];

  // Everything before the last message becomes "history"
  const history = trimmed.slice(0, -1).map((msg) => ({
    role: msg.role === "assistant" ? ("model" as const) : ("user" as const),
    parts: [{ text: msg.content }],
  }));

  console.log(
    `[Gemini] ${conversationMessages.length} msgs → ${trimmed.length} after trim → ${history.length} history + 1 send`
  );

  // Start chat with system instruction and history
  const chat = model.startChat({
    history,
    ...(systemMessage
      ? { systemInstruction: { role: "user" as const, parts: [{ text: systemMessage.content }] } }
      : {}),
  });

  const result = await chat.sendMessage(lastMessage.content);
  const response = result.response;
  const text = response.text();

  if (!text) {
    throw new Error("Gemini returned an empty response");
  }

  return text;
}

// ── Gemini Streaming Provider ──────────────────────────────

async function* geminiStreamProvider(
  messages: ModelMessage[]
): AsyncGenerator<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "your_gemini_api_key_here") {
    throw new Error(
      "GEMINI_API_KEY is not configured. Add it to your .env.local file."
    );
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const systemMessage = messages.find((m) => m.role === "system");
  const conversationMessages = messages.filter((m) => m.role !== "system");

  const trimmed: ModelMessage[] = [];
  let foundUser = false;
  for (const msg of conversationMessages) {
    if (!foundUser && msg.role === "assistant") continue;
    foundUser = true;
    trimmed.push(msg);
  }

  if (trimmed.length === 0) {
    throw new Error("No user messages to send");
  }

  const lastMessage = trimmed[trimmed.length - 1];
  const history = trimmed.slice(0, -1).map((msg) => ({
    role: msg.role === "assistant" ? ("model" as const) : ("user" as const),
    parts: [{ text: msg.content }],
  }));

  const chat = model.startChat({
    history,
    ...(systemMessage
      ? { systemInstruction: { role: "user" as const, parts: [{ text: systemMessage.content }] } }
      : {}),
  });

  const result = await chat.sendMessageStream(lastMessage.content);

  for await (const chunk of result.stream) {
    const text = chunk.text();
    if (text) yield text;
  }
}

// ── NVIDIA NIM Provider (Mistral Large 3) ──────────────────

const NVIDIA_API_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const NVIDIA_MODEL = "mistralai/mistral-large-3-675b-instruct-2512";

/** Convert ModelMessage[] to OpenAI-compatible messages for NVIDIA */
function toNvidiaMessages(
  messages: ModelMessage[]
): { role: string; content: string }[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
}

function getNvidiaChatApiKey(): string {
  const key = process.env.NVIDIA_CHAT_API_KEY;
  if (!key || key === "your_chat_key_here") {
    throw new Error(
      "Missing NVIDIA_CHAT_API_KEY. Add it to your .env.local file."
    );
  }
  return key;
}

async function nvidiaProvider(messages: ModelMessage[]): Promise<string> {
  const apiKey = getNvidiaChatApiKey();

  const res = await fetch(NVIDIA_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: NVIDIA_MODEL,
      messages: toNvidiaMessages(messages),
      max_tokens: 2048,
      temperature: 0.7,
      top_p: 0.95,
      frequency_penalty: 0,
      presence_penalty: 0,
      stream: false,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    console.error("[NVIDIA] Non-200 response:", res.status, errBody);
    if (res.status === 429) throw new Error("429 Too Many Requests");
    throw new Error(`NVIDIA API error (${res.status})`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;

  if (!text) {
    throw new Error("NVIDIA returned an empty response");
  }

  return text;
}

async function* nvidiaStreamProvider(
  messages: ModelMessage[]
): AsyncGenerator<string> {
  const apiKey = getNvidiaChatApiKey();

  const res = await fetch(NVIDIA_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: NVIDIA_MODEL,
      messages: toNvidiaMessages(messages),
      max_tokens: 2048,
      temperature: 0.7,
      top_p: 0.95,
      frequency_penalty: 0,
      presence_penalty: 0,
      stream: true,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    console.error("[NVIDIA] Stream non-200 response:", res.status, errBody);
    if (res.status === 429) throw new Error("429 Too Many Requests");
    throw new Error(`NVIDIA API error (${res.status})`);
  }

  if (!res.body) {
    throw new Error("NVIDIA returned no response body");
  }

  // Parse SSE stream from NVIDIA
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Process complete SSE lines
    const lines = buffer.split("\n");
    // Keep the last (possibly incomplete) line in the buffer
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;

      const data = trimmed.slice(6); // Remove "data: " prefix
      if (data === "[DONE]") continue;

      try {
        const parsed = JSON.parse(data);
        const delta = parsed?.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // Skip malformed JSON chunks
      }
    }
  }

  // Process any remaining buffer
  if (buffer.trim()) {
    const trimmed = buffer.trim();
    if (trimmed.startsWith("data: ")) {
      const data = trimmed.slice(6);
      if (data !== "[DONE]") {
        try {
          const parsed = JSON.parse(data);
          const delta = parsed?.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          // Skip
        }
      }
    }
  }
}

// ── OpenAI Provider (future) ───────────────────────────────

// async function openaiProvider(messages: ModelMessage[]): Promise<string> {
//   // TODO: Implement OpenAI provider
//   throw new Error("OpenAI provider not implemented yet");
// }

// ── Provider Registry ──────────────────────────────────────

type StreamProviderFn = (messages: ModelMessage[]) => AsyncGenerator<string>;

const providers: Record<string, ProviderFn> = {
  gemini: geminiProvider,
  nvidia: nvidiaProvider,
};

const streamProviders: Record<string, StreamProviderFn> = {
  gemini: geminiStreamProvider,
  nvidia: nvidiaStreamProvider,
};

// ── Main Entry Point ───────────────────────────────────────

/**
 * Generate HER's reply using the configured provider.
 *
 * This is the ONLY function the API route needs to call.
 * The provider, model, and conversion logic are all handled here.
 *
 * @param messages - The full message payload (system + conversation)
 * @returns HER's response text
 */
export async function generateReply(messages: ModelMessage[]): Promise<string> {
  const providerName = process.env.HER_PROVIDER || "gemini";
  const provider = providers[providerName];

  if (!provider) {
    throw new Error(
      `Unknown provider "${providerName}". Available: ${Object.keys(providers).join(", ")}`
    );
  }

  return provider(messages);
}

/**
 * Generate HER's reply as a stream of text chunks.
 * Falls back to non-streaming generateReply if no stream provider exists.
 */
export async function* generateStreamReply(
  messages: ModelMessage[]
): AsyncGenerator<string> {
  const providerName = process.env.HER_PROVIDER || "gemini";
  const streamProvider = streamProviders[providerName];

  if (streamProvider) {
    yield* streamProvider(messages);
  } else {
    // Fallback: return the full reply as a single chunk
    const full = await generateReply(messages);
    yield full;
  }
}
