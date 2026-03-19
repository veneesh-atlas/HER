/**
 * TypingIndicator — Gentle pulsing dots.
 * Like watching someone pause before they speak.
 * Cinematic, unhurried, alive.
 */

export default function TypingIndicator() {
  return (
    <div className="animate-fade-in mb-4 flex flex-col items-start sm:mb-5">
      <span className="mb-1 ml-1 text-[9px] font-medium tracking-[0.15em] uppercase text-her-accent/50 sm:text-[10px]">
        her
      </span>
      <div className="flex items-center gap-[5px] rounded-[20px] rounded-bl-lg bg-her-ai-bubble/80 px-5 py-3.5 shadow-[0_1px_4px_rgba(180,140,110,0.06)]">
        <span
          className="h-[4.5px] w-[4.5px] rounded-full bg-her-accent/30"
          style={{ animation: "softPulse 1.8s ease-in-out infinite" }}
        />
        <span
          className="h-[4.5px] w-[4.5px] rounded-full bg-her-accent/30"
          style={{
            animation: "softPulse 1.8s ease-in-out infinite",
            animationDelay: "0.3s",
          }}
        />
        <span
          className="h-[4.5px] w-[4.5px] rounded-full bg-her-accent/30"
          style={{
            animation: "softPulse 1.8s ease-in-out infinite",
            animationDelay: "0.6s",
          }}
        />
      </div>
    </div>
  );
}
