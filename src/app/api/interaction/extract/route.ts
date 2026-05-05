/**
 * HER — Interaction Signal Extraction API
 *
 * POST /api/interaction/extract
 *
 * Called by the client after each assistant turn to extract a behavioral
 * signal for that turn and store it. Fire-and-forget — failures never
 * block the chat UI.
 *
 * Body: {
 *   userId: string,
 *   conversationId?: string,
 *   messageId?: string,
 *   recentMessages: { role: "user"|"assistant", content: string }[],
 *   latestUserMessage: string,
 *   latestHerResponse: string
 * }
 *
 * Returns: { stored: boolean, signal?: InteractionSignal }
 */

import { NextRequest, NextResponse } from "next/server";
import { validateApiRequest, checkBodySize } from "@/lib/api-auth";
import {
  extractInteractionSignal,
  saveInteractionSignal,
} from "@/lib/interaction-signals";

export async function POST(req: NextRequest) {
  try {
    const auth = await validateApiRequest(req);
    if (auth.error) return auth.error;

    const sizeError = checkBodySize(req);
    if (sizeError) return sizeError;

    const body = await req.json();
    const {
      userId,
      conversationId,
      messageId,
      recentMessages,
      latestUserMessage,
      latestHerResponse,
    } = body ?? {};

    if (!userId || typeof userId !== "string") {
      return NextResponse.json({ error: "Missing userId" }, { status: 400 });
    }
    if (!Array.isArray(recentMessages)) {
      return NextResponse.json(
        { error: "recentMessages must be an array" },
        { status: 400 }
      );
    }
    if (typeof latestUserMessage !== "string" || typeof latestHerResponse !== "string") {
      return NextResponse.json(
        { error: "latestUserMessage and latestHerResponse must be strings" },
        { status: 400 }
      );
    }

    if (auth.userId !== "guest" && auth.userId !== userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    const signal = await extractInteractionSignal({
      recentMessages,
      latestUserMessage,
      latestHerResponse,
    });

    if (!signal) {
      return NextResponse.json({ stored: false });
    }

    await saveInteractionSignal({
      userId,
      conversationId: conversationId ?? null,
      messageId: messageId ?? null,
      signal,
    });

    return NextResponse.json({ stored: true, signal });
  } catch (err) {
    console.error("[HER Signals API] Error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
