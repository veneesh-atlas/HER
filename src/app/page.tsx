import Link from "next/link";

export default function LandingPage() {
  return (
    <div className="animate-page-enter relative flex h-full min-h-full flex-col items-center justify-center overflow-hidden bg-her-bg">
      {/* Near-invisible ambient warmth — felt, not seen */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-[40%] h-[300px] w-[300px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-her-accent opacity-[0.015] blur-[120px] sm:h-[500px] sm:w-[500px] sm:blur-[200px]" />
      </div>

      {/* Content — slightly above true-center for natural gravity */}
      <main className="relative z-10 -mt-10 flex flex-col items-center px-6 text-center sm:-mt-16">
        {/* Breathing presence dot */}
        <div className="animate-breathe mb-6 h-[6px] w-[6px] rounded-full bg-her-accent/50 sm:mb-8 sm:h-[7px] sm:w-[7px]" />

        {/* Title — carries the emotional weight of the page */}
        <h1 className="text-gradient text-[2.5rem] font-extralight tracking-[0.18em] sm:text-[3.5rem] md:text-[6rem] md:tracking-[0.22em]">
          HER
        </h1>

        {/* CTA — a quiet invitation, tightly coupled to the title */}
        <Link
          href="/chat"
          className="group mt-6 inline-flex min-h-[44px] items-center gap-2 rounded-full border border-her-accent/20 bg-her-accent/[0.04] px-6 py-2.5 text-[12px] font-light tracking-[0.08em] text-her-accent/75 transition-all duration-500 ease-out hover:border-her-accent/35 hover:bg-her-accent/[0.08] hover:text-her-accent hover:shadow-[0_2px_16px_rgba(201,110,90,0.06)] active:scale-[0.97] active:bg-her-accent/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-her-accent/20 focus-visible:ring-offset-2 focus-visible:ring-offset-her-bg sm:mt-8 sm:px-8 sm:py-3 sm:text-[13px]"
        >
          say something
          <span className="inline-block text-her-accent/35 transition-all duration-500 ease-out group-hover:translate-x-1 group-hover:text-her-accent/60">
            →
          </span>
        </Link>
      </main>
    </div>
  );
}
