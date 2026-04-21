/**
 * HER — Image Storage Helper
 *
 * Uploads base64 / data-URL images to Supabase Storage and returns a short
 * public HTTPS URL. This keeps the `messages.image_url` column tiny (~80 chars
 * instead of multi-MB) and makes conversation refetches dramatically faster.
 *
 * BUCKET REQUIREMENT
 * ──────────────────
 * In your Supabase dashboard:
 *   1. Storage → New bucket → name: "chat-images"
 *   2. Public bucket: ON (so the <img src="..."> tag can load directly)
 *   3. File size limit: 6 MB (matches /api/vision client limit)
 *   4. Allowed MIME types: image/jpeg, image/png, image/webp
 *
 * RLS policies (Storage → Policies on storage.objects):
 *   - INSERT: authenticated users can upload to their own folder (userId/*)
 *   - SELECT: public (so messages render for anyone with the URL)
 *
 * GRACEFUL FALLBACK
 * ─────────────────
 * If the bucket doesn't exist or upload fails for any reason, we return the
 * original data URL so the message still saves and renders. Old behavior.
 */

import { getSupabaseClient } from "./supabase-client";

const BUCKET = "chat-images";

/** Detect whether a string looks like a base64 data URL */
export function isDataUrl(value: string | null | undefined): boolean {
  return !!value && value.startsWith("data:");
}

/** Decode the base64 portion of a data URL into a Uint8Array + mime type */
function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; mime: string; ext: string } | null {
  const match = dataUrl.match(/^data:(image\/(jpeg|jpg|png|webp));base64,(.+)$/i);
  if (!match) return null;
  const mime = match[1].toLowerCase();
  const ext = match[2].toLowerCase().replace("jpeg", "jpg");
  const b64 = match[3];

  try {
    if (typeof atob === "function") {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return { bytes, mime, ext };
    }
    // Node fallback (server-side, e.g. API routes)
    const buf = Buffer.from(b64, "base64");
    return { bytes: new Uint8Array(buf), mime, ext };
  } catch {
    return null;
  }
}

/**
 * Upload a data URL to Supabase Storage and return a public HTTPS URL.
 *
 * On any failure (bucket missing, network error, invalid format, etc.) returns
 * the original data URL so the caller can still persist something.
 *
 * @param userId  — used as the storage path prefix for organisation/RLS
 * @param dataUrl — the image as a `data:image/...;base64,...` string
 */
export async function uploadDataUrlToStorage(
  userId: string,
  dataUrl: string
): Promise<string> {
  // If it's already an https URL, nothing to do
  if (!isDataUrl(dataUrl)) return dataUrl;

  const client = getSupabaseClient();
  if (!client) return dataUrl;

  const decoded = dataUrlToBytes(dataUrl);
  if (!decoded) return dataUrl;

  const { bytes, mime, ext } = decoded;

  // Path: <userId>/<timestamp>-<random>.<ext>
  // The userId prefix lets Storage RLS scope writes per user.
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
  const path = `${userId}/${filename}`;

  try {
    const { error: uploadError } = await client.storage
      .from(BUCKET)
      .upload(path, bytes, {
        contentType: mime,
        upsert: false,
        cacheControl: "31536000", // 1 year — content-addressed-ish
      });

    if (uploadError) {
      console.warn("[HER Storage] Upload failed:", uploadError.message);
      return dataUrl;
    }

    const { data } = client.storage.from(BUCKET).getPublicUrl(path);
    return data?.publicUrl || dataUrl;
  } catch (err) {
    console.warn("[HER Storage] Upload exception:", err);
    return dataUrl;
  }
}
