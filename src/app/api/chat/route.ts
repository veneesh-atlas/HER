import { NextRequest, NextResponse } from "next/server";
import { ChatRequest, ChatResponse } from "@/lib/types";
import { buildPayload } from "@/lib/conversation";
import { generateReply } from "@/lib/provider";

/**
 * POST /api/chat
 *
 * Receives conversation messages from the client,
 * builds the full model payload (system prompt + history),
 * calls the configured AI provider, and returns HER's reply.
 *
 * The client sends:   { messages: Message[], mode?: ConversationMode }
 * The server returns: { message: string } or { message: "", error: string }
 *
 * Provider logic is fully isolated in lib/provider.ts.
 * The frontend never knows which model is being used.
 */
export async function POST(req: NextRequest) {
  try {
    const body: ChatRequest = await req.json();

    // Validate request
    if (!body.messages || !Array.isArray(body.messages)) {
      return NextResponse.json(
        { message: "", error: "Invalid request: messages array required" } as ChatResponse,
        { status: 400 }
      );
    }

    if (body.messages.length === 0) {
      return NextResponse.json(
        { message: "", error: "No messages provided" } as ChatResponse,
        { status: 400 }
      );
    }

    // Build the full model payload (system prompt + mode + memory + history)
    const payload = buildPayload(body.messages, {
      mode: body.mode || "default",
    });

    console.log(
      `[HER API] ${body.messages.length} messages → ${payload.length} payload items (mode: ${body.mode || "default"})`
    );

    // Call the AI provider
    const reply = await generateReply(payload);

    return NextResponse.json({
      message: reply,
    } as ChatResponse);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Something went wrong";

    console.error("[HER API] Error:", errorMessage);

    // Distinguish between config errors, rate limits, and runtime errors
    const isConfigError =
      errorMessage.includes("not configured") ||
      errorMessage.includes("Unknown provider");

    const isRateLimit =
      errorMessage.includes("429") ||
      errorMessage.includes("quota") ||
      errorMessage.includes("Too Many Requests");

    let userError: string;
    let status: number;

    if (isConfigError) {
      userError = errorMessage;
      status = 500;
    } else if (isRateLimit) {
      userError = "i need a moment to catch my breath... try again in about 30 seconds 💛";
      status = 429;
    } else {
      userError = "i got a little lost in my thoughts... can you try again?";
      status = 502;
    }

    return NextResponse.json(
      { message: "", error: userError } as ChatResponse,
      { status }
    );
  }
}
