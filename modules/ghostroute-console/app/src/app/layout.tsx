import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GhostRoute Console",
  description: "Read-only GhostRoute observability console",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
