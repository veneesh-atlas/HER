import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/imagine
 *
 * Generates an image from a text prompt using NVIDIA Stable Diffusion 3 Medium.
 * Returns { image: "data:image/jpeg;base64,..." } on success.
 *
 * The frontend detects image-intent keywords and routes here instead of /api/chat.
 */

const NVIDIA_SD3_URL =
  "https://ai.api.nvidia.com/v1/genai/stabilityai/stable-diffusion-3-medium";

export async function POST(req: NextRequest) {
  try {
    const { prompt } = (await req.json()) as { prompt?: string };

    if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
      return NextResponse.json(
        { error: "A prompt is required to imagine something." },
        { status: 400 }
      );
    }

    const apiKey = process.env.NVIDIA_IMAGE_API_KEY;
    if (!apiKey || apiKey === "your_image_key_here") {
      return NextResponse.json(
        { error: "Missing NVIDIA_IMAGE_API_KEY" },
        { status: 500 }
      );
    }

    console.log(`[HER Imagine] Generating image for: "${prompt.slice(0, 80)}…"`);

    const res = await fetch(NVIDIA_SD3_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      body: JSON.stringify({
        prompt: prompt.trim(),
        cfg_scale: 5,
        aspect_ratio: "1:1",
        seed: 0,
        steps: 40,
        negative_prompt: "",
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.error("[HER Imagine] NVIDIA error:", res.status, errBody);

      if (res.status === 429) {
        return NextResponse.json(
          {
            error:
              "i need a moment before i can paint again… try in about 30 seconds 💛",
          },
          { status: 429 }
        );
      }

      return NextResponse.json(
        { error: "i couldn't paint that just now… try again in a moment." },
        { status: 502 }
      );
    }

    const data = await res.json();

    // NVIDIA SD3 returns { image: "<base64>", ... } or { artifacts: [{ base64 }] }
    let base64Image: string | null = null;

    if (data?.image) {
      base64Image = data.image;
    } else if (data?.artifacts?.[0]?.base64) {
      base64Image = data.artifacts[0].base64;
    }

    if (!base64Image) {
      console.error("[HER Imagine] Unexpected response shape:", JSON.stringify(data).slice(0, 200));
      return NextResponse.json(
        { error: "i imagined it but couldn't capture it… try again?" },
        { status: 502 }
      );
    }

    // Return as data URL
    const dataUrl = `data:image/jpeg;base64,${base64Image}`;

    console.log("[HER Imagine] Image generated successfully");

    return NextResponse.json({ image: dataUrl });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[HER Imagine] Error:", msg);

    return NextResponse.json(
      { error: "i couldn't paint that just now… try again in a moment." },
      { status: 502 }
    );
  }
}
