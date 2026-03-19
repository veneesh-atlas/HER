import type { Metadata } from "next";
import { Inter } from "next/font/google";
import RegisterSW from "@/components/RegisterSW";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "HER — Your AI Companion",
  description:
    "An emotionally intelligent AI companion. Warm, intimate, and always here for you.",
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/icons/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon-192x192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [
      { url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  },
  appleWebApp: {
    capable: true,
    title: "HER",
    statusBarStyle: "default",
  },
  other: {
    "mobile-web-app-capable": "yes",
    "msapplication-TileColor": "#F7F2EA",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
        <meta name="theme-color" content="#F7F2EA" />
      </head>
      <body className={`${inter.variable} font-sans antialiased`}>
        <RegisterSW />
        {children}
      </body>
    </html>
  );
}
