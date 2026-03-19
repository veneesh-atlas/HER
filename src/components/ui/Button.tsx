import { ButtonHTMLAttributes } from "react";

/**
 * Button — Reusable styled button component
 */

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "ghost";
}

export default function Button({
  children,
  variant = "primary",
  className = "",
  ...props
}: ButtonProps) {
  const base =
    "inline-flex items-center justify-center rounded-full px-6 py-3 text-sm font-medium transition-all duration-300 disabled:opacity-50";

  const variants = {
    primary:
      "border border-her-accent/25 bg-her-accent/8 text-her-accent hover:border-her-accent/40 hover:bg-her-accent/15 hover:text-her-accent-hover hover:shadow-[0_4px_24px_rgba(201,110,90,0.12)]",
    ghost:
      "text-her-text-muted hover:text-her-text hover:bg-her-surface",
  };

  return (
    <button
      className={`${base} ${variants[variant]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
