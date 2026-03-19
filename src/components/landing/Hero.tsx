/**
 * Hero — Landing page hero section
 * Will be expanded with more visual flair later.
 */
export default function Hero() {
  return (
    <section className="flex flex-col items-center gap-4 text-center">
      <div className="animate-breathe h-3 w-3 rounded-full bg-her-accent" />
      <h1 className="text-gradient text-5xl font-light tracking-tight sm:text-7xl">
        HER
      </h1>
      <p className="max-w-md text-lg text-her-text-muted">
        an ai companion that feels different.
      </p>
    </section>
  );
}
