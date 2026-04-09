/**
 * HER — API Route Authentication
 *
 * Shared auth validation for all API routes.
 * Verifies the Supabase JWT from the Authorization header.
 *
 * Usage in any route:
 *   const auth = await validateApiRequest(req);
 *   if (auth.error) return auth.error;
 *   // auth.userId is available
 *
 * Guest mode:
 *   When Supabase isn't configured, all requests pass through
 *   with userId = "guest" (dev/local mode).
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { isSupabaseConfigured } from "./supabase-client";

// ── Types ──────────────────────────────────────────────────

interface AuthSuccess {
  userId: string;
  error: null;
}

interface AuthFailure {
  userId: null;
  error: NextResponse;
}

type AuthResult = AuthSuccess | AuthFailure;

// ── Constants ──────────────────────────────────────────────

/** Max request body size: 12 MB (covers base64 images + message content) */
export const MAX_BODY_SIZE = 12 * 1024 * 1024;

/** Max single message content length: 10,000 characters */
export const MAX_MESSAGE_LENGTH = 10_000;

/** Max messages array length in a single request */
export const MAX_MESSAGES_COUNT = 60;

// ── Auth Validation ────────────────────────────────────────

/**
 * Validate an API request's authentication.
 *
 * Extracts the Bearer token from the Authorization header,
 * verifies it with Supabase, and returns the authenticated user ID.
 *
 * Returns { userId, error: null } on success.
 * Returns { userId: null, error: NextResponse } on failure — return it directly.
 */
export async function validateApiRequest(req: NextRequest): Promise<AuthResult> {
  // If Supabase isn't configured (local dev without auth), allow all requests
  if (!isSupabaseConfigured()) {
    return { userId: "guest", error: null };
  }

  const authHeader = req.headers.get("authorization");

  // No auth header = guest mode — allow the request but with limited identity.
  // Guest users get a device-based UUID from the client side (supabase-persistence.ts).
  // This keeps the app fully usable without sign-in while still protecting
  // authenticated users' data via token verification below.
  if (!authHeader?.startsWith("Bearer ")) {
    return { userId: "guest", error: null };
  }

  const token = authHeader.slice(7); // Remove "Bearer "

  try {
    // Create a one-off server client to verify the token
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        auth: { persistSession: false, autoRefreshToken: false },
      }
    );

    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data.user) {
      return {
        userId: null,
        error: NextResponse.json(
          { error: "Invalid or expired session" },
          { status: 401 }
        ),
      };
    }

    return { userId: data.user.id, error: null };
  } catch {
    return {
      userId: null,
      error: NextResponse.json(
        { error: "Authentication failed" },
        { status: 401 }
      ),
    };
  }
}

// ── Input Validation Helpers ───────────────────────────────

/**
 * Enforce content-length limit on the raw request.
 * Returns an error response if the body is too large, null if OK.
 */
export function checkBodySize(req: NextRequest): NextResponse | null {
  const contentLength = req.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
    return NextResponse.json(
      { error: "Request too large" },
      { status: 413 }
    );
  }
  return null;
}

/**
 * Truncate a message content string to the max allowed length.
 * Returns the original string if under the limit.
 */
export function sanitizeMessageContent(content: string): string {
  if (typeof content !== "string") return "";
  return content.length > MAX_MESSAGE_LENGTH
    ? content.slice(0, MAX_MESSAGE_LENGTH)
    : content;
}
