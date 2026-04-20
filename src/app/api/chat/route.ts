import { NextRequest, NextResponse } from "next/server";
import { ChatRequest, ChatResponse } from "@/lib/types";
import { buildPayload } from "@/lib/conversation";
import { generateReply, generateStreamReply } from "@/lib/provider";
import { validateApiRequest, checkBodySize, MAX_MESSAGES_COUNT, MAX_MESSAGE_LENGTH } from "@/lib/api-auth";

/**
 * POST /api/chat
 *
 * Receives conversation messages from the client,
 * builds the full model payload (system prompt + history),
 * calls the configured AI provider, and returns HER's reply.
 *
 * Supports two modes:
 *   - Default: returns { message: string } JSON
 *   - Streaming (?stream=true): returns a text/plain ReadableStream
 *
 * Provider logic is fully isolated in lib/provider.ts.
 */

// ── Error classification helper ──

function classifyError(errorMessage: string): { userError: string; status: number } {
  const isConfigError =
    errorMessage.includes("not configured") ||
    errorMessage.includes("Unknown provider");

  const isRateLimit =
    errorMessage.includes("429") ||
    errorMessage.includes("quota") ||
    errorMessage.includes("Too Many Requests");

  if (isConfigError) {
    return { userError: errorMessage, status: 500 };
  } else if (isRateLimit) {
    return {
      userError: "okay hold on, too many messages at once — try again in like 30 seconds.",
      status: 429,
    };
  } else {
    return {
      userError: "wait something broke on my end — try that again?",
      status: 502,
    };
  }
}

export async function POST(req: NextRequest) {
  try {
    // ── Auth check ──
    const auth = await validateApiRequest(req);
    if (auth.error) return auth.error;

    // ── Body size check ──
    const sizeError = checkBodySize(req);
    if (sizeError) return sizeError;

    const body: ChatRequest = await req.json();
    const wantsStream = req.nextUrl.searchParams.get("stream") === "true";

    // Validate request
    if (!body.messages || !Array.isArray(body.messages)) {
      if (wantsStream) {
        return new Response("Invalid request: messages array required", { status: 400 });
      }
      return NextResponse.json(
        { message: "", error: "Invalid request: messages array required" } as ChatResponse,
        { status: 400 }
      );
    }

    if (body.messages.length === 0) {
      if (wantsStream) {
        return new Response("No messages provided", { status: 400 });
      }
      return NextResponse.json(
        { message: "", error: "No messages provided" } as ChatResponse,
        { status: 400 }
      );
    }

    // Enforce limits: max message count + truncate long content
    if (body.messages.length > MAX_MESSAGES_COUNT) {
      body.messages = body.messages.slice(-MAX_MESSAGES_COUNT);
    }
    for (const msg of body.messages) {
      if (msg.content && msg.content.length > MAX_MESSAGE_LENGTH) {
        msg.content = msg.content.slice(0, MAX_MESSAGE_LENGTH);
      }
    }

    // Build the full model payload
    const payload = buildPayload(body.messages, {
      mode: body.mode || "default",
      continuityContext: body.continuityContext,
      rapportLevel: body.rapportLevel,
      memoryContext: body.memoryContext,
      responseModeInstruction: body.responseModeInstruction,
      antiRepetitionInstruction: body.antiRepetitionInstruction,
      userTimezone: body.userTimezone,
    });

    console.log(
      `[HER API] ${body.messages.length} messages → ${payload.length} payload items (mode: ${body.mode || "default"}, rapport: ${body.rapportLevel ?? 0}, memory: ${body.memoryContext ? "yes" : "no"}, adaptiveMode: ${body.responseModeInstruction ? "yes" : "no"}, tz: ${body.userTimezone || "unknown"}, stream: ${wantsStream})`
    );

    // ── Streaming path ──
    if (wantsStream) {
      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          let chunksEmitted = 0;
          try {
            for await (const chunk of generateStreamReply(payload)) {
              controller.enqueue(encoder.encode(chunk));
              chunksEmitted++;
            }
            controller.close();
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Stream failed";
            console.error("[HER API] Stream error:", msg);
            // If no chunks were emitted, close cleanly so the client gets a proper error
            // If chunks were already sent, error the stream to signal failure
            if (chunksEmitted === 0) {
              controller.close();
            } else {
              controller.error(err);
            }
          }
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-cache",
          "Transfer-Encoding": "chunked",
        },
      });
    }

    // ── Non-streaming path (backward compatible) ──
    const reply = await generateReply(payload);

    return NextResponse.json({
      message: reply,
    } as ChatResponse);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Something went wrong";

    console.error("[HER API] Error:", errorMessage);

    const { userError, status } = classifyError(errorMessage);

    // For stream requests, return plain text error
    const wantsStream = req.nextUrl.searchParams.get("stream") === "true";
    if (wantsStream) {
      return new Response(userError, { status });
    }

    return NextResponse.json(
      { message: "", error: userError } as ChatResponse,
      { status }
    );
  }
}
