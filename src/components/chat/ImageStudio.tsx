"use client";

import { useState, useCallback, useRef, useEffect, ChangeEvent } from "react";
import {
  ASPECT_RATIOS,
  getImageModel,
  getModelsByMode,
  DEFAULT_CREATE_MODEL_ID,
  DEFAULT_EDIT_MODEL_ID,
  type ImageModelMode,
  type ModelQuality,
} from "@/lib/image-models";
import type { ImageStudioMode } from "@/lib/types";

// ── Constants ──────────────────────────────────────────────

const MAX_IMAGE_SIZE = 4 * 1024 * 1024; // 4 MB
const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const RECENT_PROMPTS_KEY = "her.image.recentPrompts";
const MAX_RECENT = 5;

// ── Types ──────────────────────────────────────────────────

interface ImageStudioProps {
  /** Called when user submits a generation/edit request */
  onGenerate: (request: {
    prompt: string;
    modelId: string;
    mode: ImageStudioMode;
    aspect_ratio?: string;
    steps?: number;
    cfg_scale?: number;
    negative_prompt?: string;
    seed?: number;
    image?: string;
  }) => void;
  disabled?: boolean;
  /** Called to close the studio */
  onClose: () => void;
  /** The last optimized/enhanced prompt returned by the server (undefined = none yet) */
  lastRevisedPrompt?: string | null;
  /** Friendly error message from the last generation attempt */
  studioError?: string | null;
  /** Optional initial values when opening studio via reuse/edit source actions */
  initialPrefill?: {
    prompt?: string;
    mode?: ImageStudioMode;
    sourceImage?: string;
  } | null;
  /** Dynamic label for the "generating" button state */
  generatingLabel?: string;
  /** Dynamic label for the "editing" button state */
  editingLabel?: string;
  /** Dynamic placeholder for the prompt textarea */
  promptPlaceholder?: string;
  /** Called when user clicks 'try again' after a failure */
  onRetry?: () => void;
  /** Called when user clicks 'use recommended' after a failure on a non-default model */
  onSwitchRecommended?: () => void;
}

// ── Helpers ────────────────────────────────────────────────

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

/** Load recent prompts from localStorage */
function loadRecentPrompts(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_PROMPTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p: unknown) => typeof p === "string" && (p as string).trim().length > 0).slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

/** Save a prompt to recent history (deduped, most-recent-first, max 5) */
function saveRecentPrompt(prompt: string): void {
  const trimmed = prompt.trim();
  if (!trimmed) return;
  try {
    const current = loadRecentPrompts();
    const filtered = current.filter((p) => p.toLowerCase() !== trimmed.toLowerCase());
    const updated = [trimmed, ...filtered].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_PROMPTS_KEY, JSON.stringify(updated));
  } catch {
    // localStorage unavailable — silently ignore
  }
}

/** Short prompt detection for helper text (≤2 words and non-empty) */
function isVeryShortPrompt(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  const words = trimmed.split(/\s+/).filter(Boolean);
  return words.length <= 2 || trimmed.length < 12;
}

/** Chevron icon used by disclosure sections */
function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={`h-2.5 w-2.5 transition-transform duration-200 ${open ? "rotate-90" : ""}`}
    >
      <path fillRule="evenodd" d="M6.22 4.22a.75.75 0 011.06 0l3.25 3.25a.75.75 0 010 1.06l-3.25 3.25a.75.75 0 01-1.06-1.06L8.94 8 6.22 5.28a.75.75 0 010-1.06z" clipRule="evenodd" />
    </svg>
  );
}

// ── Trust Layer Helpers ─────────────────────────────────────

/** Map internal quality tag → user-facing trust label */
const QUALITY_LABELS: Record<ModelQuality, string> = {
  stable: "Recommended",
  fast: "Fast",
  experimental: "Creative",
  specialized: "Edit Focused",
};

/** Per-model soft guidance copy (keyed by model ID for precision) */
const MODEL_GUIDANCE: Record<string, string> = {
  "flux-1-dev": "Most reliable for everyday creations.",
  "flux-2-klein-4b": "Fast and lightweight — great for quick ideas.",
  "flux-1-kontext-dev": "Built for image edits and transformations.",
};

/** Per-model soft retry hint (only shown for less-reliable models) */
const MODEL_HINT: Record<string, string> = {
  "flux-2-klein-4b": "If a generation stalls, try once more or switch to Recommended.",
  "flux-1-kontext-dev": "Best with clear, full-size images. Try again if it doesn't respond the first time.",
};

// ── Component ──────────────────────────────────────────────

export default function ImageStudio({ onGenerate, disabled = false, onClose, lastRevisedPrompt, studioError, initialPrefill, generatingLabel, editingLabel, promptPlaceholder, onRetry, onSwitchRecommended }: ImageStudioProps) {
  // ── State ──
  const [mode, setMode] = useState<ImageModelMode>(initialPrefill?.mode || "create");
  const [revisedOpen, setRevisedOpen] = useState(false);
  const [modelId, setModelId] = useState(
    initialPrefill?.mode === "edit" ? DEFAULT_EDIT_MODEL_ID : DEFAULT_CREATE_MODEL_ID
  );
  const [prompt, setPrompt] = useState(initialPrefill?.prompt || "");
  const [aspectRatio, setAspectRatio] = useState<string>(
    initialPrefill?.mode === "edit" ? "match_input_image" : "1:1"
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [sourceImage, setSourceImage] = useState<string | null>(initialPrefill?.sourceImage || null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [recentPrompts, setRecentPrompts] = useState<string[]>([]);
  const [showValidation, setShowValidation] = useState(false);

  // Advanced controls — undefined means "use model default"
  const [steps, setSteps] = useState<number | undefined>(undefined);
  const [cfgScale, setCfgScale] = useState<number | undefined>(undefined);
  const [negativePrompt, setNegativePrompt] = useState("");
  const [seed, setSeed] = useState<number | undefined>(undefined);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const model = getImageModel(modelId);
  const createModels = getModelsByMode("create");
  const editModels = getModelsByMode("edit");

  // Auto-dismiss image error
  useEffect(() => {
    if (!imageError) return;
    const t = setTimeout(() => setImageError(null), 3000);
    return () => clearTimeout(t);
  }, [imageError]);

  // Load recent prompts on mount
  useEffect(() => {
    setRecentPrompts(loadRecentPrompts());
  }, []);

  // Focus prompt on open
  useEffect(() => {
    promptRef.current?.focus();
  }, []);

  // Clear validation when user starts typing or adds image
  useEffect(() => {
    if (showValidation) setShowValidation(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt, sourceImage]);

  // When switching modes, update model to appropriate default
  const handleModeChange = useCallback((newMode: ImageModelMode) => {
    setMode(newMode);
    if (newMode === "create") {
      setModelId(DEFAULT_CREATE_MODEL_ID);
      setSourceImage(null);
      setAspectRatio("1:1");
    } else {
      setModelId(DEFAULT_EDIT_MODEL_ID);
      setAspectRatio("match_input_image");
    }
    // Reset advanced controls to defaults
    setSteps(undefined);
    setCfgScale(undefined);
    setNegativePrompt("");
    setSeed(undefined);
  }, []);

  // When switching model within same mode, normalize advanced controls to new model's constraints
  const handleModelChange = useCallback((newId: string) => {
    const newModel = getImageModel(newId);
    setModelId(newId);

    // Clamp steps into new model's valid range (or reset if unsupported)
    if (newModel?.capabilities.steps && newModel.ranges.steps) {
      setSteps((prev) => {
        if (prev === undefined) return undefined; // user hadn't customized → keep default
        return Math.max(newModel.ranges.steps!.min, Math.min(newModel.ranges.steps!.max, prev));
      });
    } else {
      setSteps(undefined);
    }

    // Clear cfg_scale if new model doesn't support it, otherwise keep user's value
    if (!newModel?.capabilities.cfg_scale) {
      setCfgScale(undefined);
    }

    // Clear negative prompt if unsupported
    if (!newModel?.capabilities.negative_prompt) {
      setNegativePrompt("");
    }

    // Keep seed as-is (all current models support it)
    // Reset aspect ratio to model default
    if (newModel) {
      setAspectRatio(newModel.defaults.aspect_ratio as string || "1:1");
    }
  }, []);

  const handleFileSelect = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!file) return;

    if (!ACCEPTED_TYPES.includes(file.type)) {
      setImageError("only photos please — jpg, png, or webp");
      return;
    }
    if (file.size > MAX_IMAGE_SIZE) {
      setImageError("that photo is too large — under 4 MB works best");
      return;
    }

    try {
      const dataUrl = await readFileAsDataURL(file);
      setSourceImage(dataUrl);
      setImageError(null);
    } catch {
      setImageError("couldn't read that photo — try another?");
    }
  }, []);

  const handleSubmit = useCallback(() => {
    // Duplicate submission guard — disabled prop prevents while in-flight
    if (disabled) return;

    // Validate and show friendly inline messages
    if (!prompt.trim()) {
      setShowValidation(true);
      return;
    }
    if (mode === "edit" && !sourceImage) {
      setShowValidation(true);
      return;
    }

    // Save to recent prompts
    saveRecentPrompt(prompt.trim());
    setRecentPrompts(loadRecentPrompts());

    onGenerate({
      prompt: prompt.trim(),
      modelId,
      mode,
      aspect_ratio: aspectRatio,
      steps,
      cfg_scale: cfgScale,
      negative_prompt: model?.capabilities.negative_prompt ? negativePrompt : undefined,
      seed,
      image: mode === "edit" ? sourceImage || undefined : undefined,
    });
  }, [prompt, disabled, mode, sourceImage, modelId, aspectRatio, steps, cfgScale, negativePrompt, seed, model, onGenerate]);

  const canSubmit = prompt.trim().length > 0 && !disabled && (mode === "create" || !!sourceImage);

  // Inline validation message
  const validationMessage = showValidation
    ? !prompt.trim()
      ? "tell her what to create."
      : mode === "edit" && !sourceImage
        ? "she needs an image to refine."
        : null
    : null;

  // Short prompt helper (only when non-empty and very short)
  const showShortHelper = !showValidation && isVeryShortPrompt(prompt);

  // ── Render ──
  return (
    <div className="animate-fade-in mx-auto w-full max-w-[640px] px-3 sm:px-5 md:px-6">
      <div className="rounded-[20px] border border-her-border/25 bg-her-surface/50 p-4 shadow-[0_2px_16px_rgba(180,140,110,0.06)] sm:rounded-[24px] sm:p-5">

        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-6 w-6 items-center justify-center rounded-full bg-her-accent/10">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5 text-her-accent/70">
                <path fillRule="evenodd" d="M1 5.25A2.25 2.25 0 013.25 3h13.5A2.25 2.25 0 0119 5.25v9.5A2.25 2.25 0 0116.75 17H3.25A2.25 2.25 0 011 14.75v-9.5zm1.5 5.81v3.69c0 .414.336.75.75.75h13.5a.75.75 0 00.75-.75v-2.69l-2.22-2.219a.75.75 0 00-1.06 0l-1.91 1.909-4.22-4.22a.75.75 0 00-1.06 0L2.5 11.06zm6.5-3.81a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z" clipRule="evenodd" />
              </svg>
            </div>
            <span className="text-[12px] font-medium tracking-[0.08em] uppercase text-her-text-muted/50">
              image studio
            </span>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-full text-her-text-muted/30 transition-colors duration-200 hover:bg-her-surface hover:text-her-text-muted/50"
            aria-label="Close image studio"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5">
              <path d="M5.28 4.22a.75.75 0 00-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 101.06 1.06L8 9.06l2.72 2.72a.75.75 0 101.06-1.06L9.06 8l2.72-2.72a.75.75 0 00-1.06-1.06L8 6.94 5.28 4.22z" />
            </svg>
          </button>
        </div>

        {/* Mode toggle: Create / Edit */}
        <div className="mb-4 flex gap-1 rounded-full border border-her-border/20 bg-her-bg/60 p-0.5">
          <button
            onClick={() => handleModeChange("create")}
            className={`flex-1 rounded-full px-3 py-1.5 text-[11px] font-medium tracking-[0.04em] transition-all duration-200 sm:text-[12px] ${
              mode === "create"
                ? "bg-white/80 text-her-text shadow-[0_1px_3px_rgba(180,140,110,0.08)]"
                : "text-her-text-muted/40 hover:text-her-text-muted/60"
            }`}
          >
            Create
          </button>
          <button
            onClick={() => handleModeChange("edit")}
            className={`flex-1 rounded-full px-3 py-1.5 text-[11px] font-medium tracking-[0.04em] transition-all duration-200 sm:text-[12px] ${
              mode === "edit"
                ? "bg-white/80 text-her-text shadow-[0_1px_3px_rgba(180,140,110,0.08)]"
                : "text-her-text-muted/40 hover:text-her-text-muted/60"
            }`}
          >
            Edit
          </button>
        </div>

        {/* Edit mode: Image upload area */}
        {mode === "edit" && (
          <div className="mb-3.5">
            {sourceImage ? (
              <div className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element -- base64 data URL, no remote optimization possible */}
                <img
                  src={sourceImage}
                  alt="Source image"
                  className="h-[120px] w-full rounded-[14px] border border-her-border/15 object-cover sm:h-[140px]"
                />
                <button
                  onClick={() => setSourceImage(null)}
                  className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-her-text/50 text-white shadow-sm transition-all hover:bg-her-text/70"
                  aria-label="Remove image"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3">
                    <path d="M5.28 4.22a.75.75 0 00-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 101.06 1.06L8 9.06l2.72 2.72a.75.75 0 101.06-1.06L9.06 8l2.72-2.72a.75.75 0 00-1.06-1.06L8 6.94 5.28 4.22z" />
                  </svg>
                </button>
              </div>
            ) : (
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={disabled}
                className="flex w-full items-center justify-center gap-2 rounded-[14px] border border-dashed border-her-border/30 bg-her-bg/40 py-8 text-[12px] text-her-text-muted/35 transition-all duration-200 hover:border-her-accent/20 hover:bg-her-accent/[0.02] hover:text-her-text-muted/50 sm:py-10"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                  <path d="M9.25 13.25a.75.75 0 001.5 0V4.636l2.955 3.129a.75.75 0 001.09-1.03l-4.25-4.5a.75.75 0 00-1.09 0l-4.25 4.5a.75.75 0 101.09 1.03L9.25 4.636v8.614z" />
                  <path d="M3.5 12.75a.75.75 0 00-1.5 0v2.5A2.75 2.75 0 004.75 18h10.5A2.75 2.75 0 0018 15.25v-2.5a.75.75 0 00-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5z" />
                </svg>
                upload a photo to edit
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={handleFileSelect}
              className="hidden"
            />
            {imageError && (
              <p className="mt-1.5 text-[11px] text-her-accent/70">{imageError}</p>
            )}
          </div>
        )}

        {/* Prompt */}
        <textarea
          ref={promptRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={mode === "edit" ? "describe the edit…" : (promptPlaceholder || "describe what to create…")}
          disabled={disabled}
          rows={2}
          className="w-full resize-none rounded-[14px] border border-her-border/25 bg-her-bg/60 px-3.5 py-2.5 text-[13px] leading-[1.6] text-her-text placeholder:text-her-text-muted/28 focus:border-her-accent/20 focus:outline-none focus:ring-1 focus:ring-her-accent/10 disabled:opacity-30 sm:text-[14px]"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
        />

        {/* Inline helpers — validation, short prompt note */}
        <div className="mb-3 min-h-[18px]">
          {validationMessage && (
            <p className="mt-1 text-[11px] text-her-accent/60 italic">{validationMessage}</p>
          )}
          {showShortHelper && (
            <p className="mt-1 text-[10.5px] text-her-text-muted/28 italic">
              short prompts are gently expanded before creation.
            </p>
          )}
        </div>

        {/* Recent prompts — compact chips */}
        {recentPrompts.length > 0 && (
          <div className="mb-3">
            <span className="mb-1.5 block text-[10px] font-medium tracking-[0.08em] uppercase text-her-text-muted/25">
              Recent
            </span>
            <div className="flex flex-wrap gap-1">
              {recentPrompts.map((rp, i) => (
                <button
                  key={i}
                  onClick={() => {
                    setPrompt(rp);
                    promptRef.current?.focus();
                  }}
                  className="max-w-[200px] truncate rounded-full border border-her-border/12 bg-her-bg/40 px-2.5 py-1 text-[10px] text-her-text-muted/40 transition-all duration-150 hover:border-her-accent/15 hover:text-her-text-muted/55 sm:text-[10.5px]"
                  title={rp}
                >
                  {rp}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Her Interpretation — shown only when enhancement produced a meaningfully different result */}
        {lastRevisedPrompt && (
          <div className="mb-3">
            <button
              onClick={() => setRevisedOpen((v) => !v)}
              className="flex items-center gap-1.5 text-[10px] tracking-[0.06em] uppercase text-her-text-muted/30 transition-colors duration-200 hover:text-her-text-muted/45"
            >
              <ChevronIcon open={revisedOpen} />
              Her Interpretation
            </button>
            {revisedOpen && (
              <div className="animate-fade-in mt-1.5 rounded-[12px] border border-her-border/10 bg-her-bg/30 px-3.5 py-2.5">
                <p className="whitespace-pre-wrap text-[11.5px] leading-[1.55] text-her-text-muted/55 sm:text-[12px]">
                  {lastRevisedPrompt}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Model selector */}
        <div className="mb-3">
          <div className="flex flex-wrap gap-1.5">
            {(mode === "create" ? createModels : editModels).map((m) => {
              const badge = QUALITY_LABELS[m.quality] || "";
              const isDefault = m.id === DEFAULT_CREATE_MODEL_ID;
              return (
                <button
                  key={m.id}
                  onClick={() => handleModelChange(m.id)}
                  className={`rounded-full px-3 py-1.5 text-[10.5px] tracking-[0.02em] transition-all duration-200 sm:text-[11px] ${
                    modelId === m.id
                      ? "border border-her-accent/25 bg-her-accent/[0.07] text-her-accent shadow-[0_1px_3px_rgba(201,110,90,0.06)]"
                      : "border border-her-border/15 bg-her-bg/40 text-her-text-muted/40 hover:border-her-accent/15 hover:text-her-text-muted/55"
                  }`}
                >
                  {m.label}
                  {isDefault && mode === "create" && (
                    <span className={`ml-1 text-[9px] tracking-[0.03em] ${
                      modelId === m.id ? "text-her-accent/45" : "text-her-text-muted/25"
                    }`}>
                      ✦
                    </span>
                  )}
                  <span className={`ml-1 ${modelId === m.id ? "text-her-accent/45" : "text-her-text-muted/25"}`}>
                    · {badge}
                  </span>
                </button>
              );
            })}
          </div>
          {/* Per-model guidance copy */}
          {model && (
            <div className="mt-1.5 min-h-[16px]">
              <p className="text-[10px] leading-[1.5] text-her-text-muted/30 italic">
                {MODEL_GUIDANCE[model.id] || model.description}
              </p>
              {MODEL_HINT[model.id] && (
                <p className="mt-0.5 text-[9.5px] leading-[1.4] text-her-text-muted/22 italic">
                  {MODEL_HINT[model.id]}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Aspect ratio selector (always visible) */}
        <div className="mb-3">
          <span className="mb-1.5 block text-[10px] font-medium tracking-[0.08em] uppercase text-her-text-muted/30">
            Ratio
          </span>
          <div className="flex flex-wrap gap-1">
            {mode === "edit" && (
              <button
                onClick={() => setAspectRatio("match_input_image")}
                className={`rounded-full px-2.5 py-1 text-[10px] transition-all duration-200 sm:text-[10.5px] ${
                  aspectRatio === "match_input_image"
                    ? "border border-her-accent/20 bg-her-accent/[0.06] text-her-accent"
                    : "border border-her-border/15 text-her-text-muted/35 hover:border-her-accent/15 hover:text-her-text-muted/50"
                }`}
              >
                Match
              </button>
            )}
            {ASPECT_RATIOS.map((r) => (
              <button
                key={r}
                onClick={() => setAspectRatio(r)}
                className={`rounded-full px-2.5 py-1 text-[10px] transition-all duration-200 sm:text-[10.5px] ${
                  aspectRatio === r
                    ? "border border-her-accent/20 bg-her-accent/[0.06] text-her-accent"
                    : "border border-her-border/15 text-her-text-muted/35 hover:border-her-accent/15 hover:text-her-text-muted/50"
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        {/* Advanced toggle */}
        <button
          onClick={() => setAdvancedOpen(!advancedOpen)}
          className="mb-2 flex items-center gap-1.5 text-[10px] tracking-[0.06em] uppercase text-her-text-muted/25 transition-colors duration-200 hover:text-her-text-muted/40"
        >
          <ChevronIcon open={advancedOpen} />
          Advanced
        </button>

        {/* Advanced controls — capability-aware */}
        {advancedOpen && model && (
          <div className="animate-fade-in mb-3 space-y-3 rounded-[12px] border border-her-border/10 bg-her-bg/30 px-3.5 py-3">
            {/* Capability-aware hint */}
            <p className="text-[9.5px] leading-[1.4] text-her-text-muted/22 italic -mb-1">
              Controls adjust to what each model supports.
            </p>

            {/* Steps */}
            {model.capabilities.steps && model.ranges.steps && (
              <div>
                <label className="mb-1 flex items-center justify-between">
                  <span className="text-[10px] tracking-[0.04em] text-her-text-muted/35">Steps</span>
                  <span className="text-[10px] tabular-nums text-her-text-muted/30">
                    {steps ?? model.defaults.steps as number}
                  </span>
                </label>
                <input
                  type="range"
                  min={model.ranges.steps.min}
                  max={model.ranges.steps.max}
                  value={steps ?? model.defaults.steps as number}
                  onChange={(e) => setSteps(Number(e.target.value))}
                  className="studio-range w-full"
                />
              </div>
            )}

            {/* CFG Scale */}
            {model.capabilities.cfg_scale && model.ranges.cfg_scale && (
              <div>
                <label className="mb-1 flex items-center justify-between">
                  <span className="text-[10px] tracking-[0.04em] text-her-text-muted/35">Guidance</span>
                  <span className="text-[10px] tabular-nums text-her-text-muted/30">
                    {(cfgScale ?? model.defaults.cfg_scale as number).toFixed(1)}
                  </span>
                </label>
                <input
                  type="range"
                  min={model.ranges.cfg_scale.min}
                  max={model.ranges.cfg_scale.max}
                  step={0.5}
                  value={cfgScale ?? model.defaults.cfg_scale as number}
                  onChange={(e) => setCfgScale(Number(e.target.value))}
                  className="studio-range w-full"
                />
              </div>
            )}

            {/* Negative prompt */}
            {model.capabilities.negative_prompt && (
              <div>
                <label className="mb-1 block text-[10px] tracking-[0.04em] text-her-text-muted/35">
                  Avoid
                </label>
                <input
                  type="text"
                  value={negativePrompt}
                  onChange={(e) => setNegativePrompt(e.target.value)}
                  placeholder="things to avoid…"
                  className="w-full rounded-[10px] border border-her-border/15 bg-white/40 px-3 py-1.5 text-[12px] text-her-text placeholder:text-her-text-muted/20 focus:border-her-accent/15 focus:outline-none sm:text-[12.5px]"
                />
              </div>
            )}

            {/* Seed */}
            {model.capabilities.seed && (
              <div>
                <label className="mb-1 flex items-center justify-between">
                  <span className="text-[10px] tracking-[0.04em] text-her-text-muted/35">Seed</span>
                  <button
                    onClick={() => setSeed(Math.floor(Math.random() * 2147483647))}
                    className="text-[9px] tracking-[0.04em] text-her-accent/40 transition-colors hover:text-her-accent/60"
                  >
                    randomize
                  </button>
                </label>
                <input
                  type="number"
                  value={seed ?? 0}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    setSeed(Number.isFinite(v) ? Math.max(0, v) : 0);
                  }}
                  min={0}
                  className="w-full rounded-[10px] border border-her-border/15 bg-white/40 px-3 py-1.5 text-[12px] tabular-nums text-her-text placeholder:text-her-text-muted/20 focus:border-her-accent/15 focus:outline-none sm:text-[12.5px]"
                />
              </div>
            )}
          </div>
        )}

        {/* Studio error — friendly inline message + recovery actions */}
        {studioError && (
          <div className="animate-fade-in mb-3 rounded-[12px] border border-her-accent/10 bg-her-accent/[0.03] px-3.5 py-2.5">
            <p className="text-[11.5px] leading-[1.5] text-her-accent/60 italic sm:text-[12px]">
              {studioError}
            </p>
            {/* Recovery actions */}
            <div className="mt-2 flex items-center gap-3">
              {onRetry && (
                <button
                  onClick={() => { onRetry(); handleSubmit(); }}
                  disabled={disabled || !canSubmit}
                  className="text-[10.5px] font-medium tracking-[0.02em] text-her-accent/50 transition-colors duration-200 hover:text-her-accent/70 disabled:opacity-30 disabled:cursor-not-allowed sm:text-[11px]"
                >
                  try again
                </button>
              )}
              {onSwitchRecommended && mode === "create" && modelId !== DEFAULT_CREATE_MODEL_ID && (
                <button
                  onClick={() => {
                    handleModelChange(DEFAULT_CREATE_MODEL_ID);
                    onSwitchRecommended();
                  }}
                  disabled={disabled}
                  className="text-[10.5px] tracking-[0.02em] text-her-text-muted/35 transition-colors duration-200 hover:text-her-text-muted/50 disabled:opacity-30 disabled:cursor-not-allowed sm:text-[11px]"
                >
                  use Recommended instead
                </button>
              )}
            </div>
          </div>
        )}

        {/* Primary action button */}
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className={`w-full rounded-full py-2.5 text-[12px] font-medium tracking-[0.04em] transition-all duration-300 sm:text-[13px] ${
            canSubmit
              ? "bg-her-accent text-white shadow-[0_2px_12px_rgba(201,110,90,0.18)] hover:bg-her-accent-hover hover:shadow-[0_3px_18px_rgba(201,110,90,0.24)] active:scale-[0.98]"
              : "bg-her-surface/60 text-her-text-muted/20 cursor-not-allowed"
          }`}
        >
          {disabled
            ? mode === "edit"
              ? (editingLabel || "she's refining…")
              : (generatingLabel || "she's imagining…")
            : mode === "edit"
            ? "transform"
            : "create with her"
          }
        </button>
      </div>
    </div>
  );
}
