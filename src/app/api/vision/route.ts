import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/vision
 *
 * Analyzes an uploaded image using NVIDIA NIM Gemma 3 27B (Vision).
 * Accepts { image: "data:image/...;base64,...", prompt?: string }
 * Returns  { message: string }
 *
 * Uses multimodal chat/completions format with image_url content part.
 */

const NVIDIA_VISION_URL =
  "https://integrate.api.nvidia.com/v1/chat/completions";
const NVIDIA_VISION_MODEL = "google/gemma-3-27b-it";

const DEFAULT_PROMPT = "Describe this image in detail.";

/** Max base64 payload size we'll accept (~6 MB raw → ~8 MB base64) */
const MAX_PAYLOAD_SIZE = 10 * 1024 * 1024;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { image, prompt } = body as { image?: string; prompt?: string };

    // ── Validate image ──
    if (!image || typeof image !== "string") {
      return NextResponse.json(
        { error: "An image is required for vision analysis." },
        { status: 400 }
      );
    }

    if (!image.startsWith("data:image/")) {
      return NextResponse.json(
        { error: "Image must be a base64 data URL (data:image/...)." },
        { status: 400 }
      );
    }

    if (image.length > MAX_PAYLOAD_SIZE) {
      return NextResponse.json(
        { error: "that image is a bit too large for me to study… try a smaller one?" },
        { status: 413 }
      );
    }

    // ── Validate API key ──
    const apiKey = process.env.NVIDIA_VISION_API_KEY;
    if (!apiKey || apiKey === "your_vision_key_here") {
      return NextResponse.json(
        { error: "Missing NVIDIA_VISION_API_KEY" },
        { status: 500 }
      );
    }

    const userPrompt = (prompt && prompt.trim()) || DEFAULT_PROMPT;

    console.log(
      `[HER Vision] Analyzing image (${Math.round(image.length / 1024)}KB) — prompt: "${userPrompt.slice(0, 60)}…"`
    );

    // ── Build multimodal payload (OpenAI-compatible format) ──
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: userPrompt },
          {
            type: "image_url",
            image_url: {
              url: image,
            },
          },
        ],
      },
    ];

    const res = await fetch(NVIDIA_VISION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: NVIDIA_VISION_MODEL,
        messages,
        max_tokens: 512,
        temperature: 0.2,
        top_p: 0.7,
        stream: false,
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.error("[HER Vision] NVIDIA error:", res.status, errBody);

      if (res.status === 429) {
        return NextResponse.json(
          {
            error:
              "i need a moment to rest my eyes… try again in about 30 seconds 💛",
          },
          { status: 429 }
        );
      }

      if (res.status === 413 || res.status === 400) {
        return NextResponse.json(
          {
            error:
              "that image was a bit much for me… try a smaller or simpler one?",
          },
          { status: 400 }
        );
      }

      return NextResponse.json(
        { error: "i couldn't read that image just now… try another one." },
        { status: 502 }
      );
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;

    if (!text) {
      console.error(
        "[HER Vision] Unexpected response shape:",
        JSON.stringify(data).slice(0, 300)
      );
      return NextResponse.json(
        { error: "i looked closely but couldn't put it into words… try again?" },
        { status: 502 }
      );
    }

    console.log("[HER Vision] Analysis complete");

    return NextResponse.json({ message: text.trim() });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[HER Vision] Error:", msg);

    return NextResponse.json(
      { error: "i couldn't read that image just now… try another one." },
      { status: 502 }
    );
  }
}
