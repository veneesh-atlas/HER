import Link from "next/link";

export default function LandingPage() {
  return (
    <div className="animate-page-enter relative flex h-full min-h-full flex-col items-center justify-center overflow-hidden bg-her-bg">
      {/* Near-invisible ambient warmth — felt, not seen */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-[40%] h-[300px] w-[300px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-her-accent opacity-[0.015] blur-[120px] sm:h-[500px] sm:w-[500px] sm:blur-[200px]" />
      </div>

      {/* Content — slightly above true-center for natural gravity */}
      <main className="relative z-10 -mt-8 flex flex-col items-center px-6 pb-16 text-center sm:-mt-14 sm:pb-20">
        {/* Breathing presence dot */}
        <div className="animate-breathe mb-7 h-[7px] w-[7px] rounded-full bg-her-accent/45 shadow-[0_0_16px_3px_rgba(201,110,90,0.08)] sm:mb-9 sm:h-2 sm:w-2" />

        {/* Title — carries the emotional weight of the page */}
        <h1 className="text-gradient text-[2.5rem] font-extralight tracking-[0.18em] sm:text-[3.5rem] md:text-[6rem] md:tracking-[0.22em]">
          HER
        </h1>

        {/* CTA — a quiet invitation, tightly coupled to the title */}
        <Link
          href="/chat"
          className="group mt-7 inline-flex min-h-[44px] items-center gap-2.5 rounded-full border border-her-accent/25 bg-her-accent/[0.05] px-7 py-3 text-[12px] font-light tracking-[0.1em] text-her-accent/70 transition-all duration-500 ease-out hover:border-her-accent/40 hover:bg-her-accent/[0.09] hover:text-her-accent hover:shadow-[0_2px_20px_rgba(201,110,90,0.08)] active:scale-[0.97] active:bg-her-accent/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-her-accent/20 focus-visible:ring-offset-2 focus-visible:ring-offset-her-bg sm:mt-9 sm:px-9 sm:py-3.5 sm:text-[13px]"
        >
          say something
          <span className="inline-block text-her-accent/40 transition-all duration-500 ease-out group-hover:translate-x-1 group-hover:text-her-accent/65">
            →
          </span>
        </Link>
      </main>
    </div>
  );
}
