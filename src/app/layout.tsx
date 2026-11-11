import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "Bharani", description: "Production ledger for shared-brand food collectives" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
