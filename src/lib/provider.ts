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

// ── OpenAI Provider (future) ───────────────────────────────

// async function openaiProvider(messages: ModelMessage[]): Promise<string> {
//   // TODO: Implement OpenAI provider
//   // Uses messages directly as [{ role, content }]
//   throw new Error("OpenAI provider not implemented yet");
// }

// ── Anthropic Provider (future) ────────────────────────────

// async function anthropicProvider(messages: ModelMessage[]): Promise<string> {
//   // TODO: Implement Anthropic provider
//   // System prompt goes in a separate `system` field
//   throw new Error("Anthropic provider not implemented yet");
// }

// ── Provider Registry ──────────────────────────────────────

const providers: Record<string, ProviderFn> = {
  gemini: geminiProvider,
  // openai: openaiProvider,
  // anthropic: anthropicProvider,
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
