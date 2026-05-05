/**
 * HER — Interaction Signal Retrieval API (Step EXP+1)
 *
 * GET /api/interaction?userId=xxx&conversationId=optional&limit=optional
 *
 * Returns a compact, behavioral-only context block for injection into the
 * system prompt. Empty/null when there is nothing useful to say.
 *
 * Returns: { interactionContext: string | null }
 */

import { NextRequest, NextResponse } from "next/server";
import { validateApiRequest } from "@/lib/api-auth";
import {
  getRecentInteractionSignals,
  formatSignalsForPrompt,
} from "@/lib/interaction-signals";

export async function GET(req: NextRequest) {
  try {
    const auth = await validateApiRequest(req);
    if (auth.error) return auth.error;

    const userId = req.nextUrl.searchParams.get("userId");
    const conversationId = req.nextUrl.searchParams.get("conversationId");
    const limitParam = req.nextUrl.searchParams.get("limit");

    if (!userId) {
      return NextResponse.json({ error: "Missing userId" }, { status: 400 });
    }

    if (auth.userId !== "guest" && auth.userId !== userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    const limit = limitParam ? Math.max(1, Math.min(20, parseInt(limitParam, 10) || 6)) : 6;

    const signals = await getRecentInteractionSignals({
      userId,
      conversationId: conversationId || null,
      limit,
    });

    const interactionContext = formatSignalsForPrompt(signals);

    return NextResponse.json({ interactionContext });
  } catch (err) {
    console.error("[HER Signals API] GET error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
