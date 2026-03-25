"use client";

import { SessionProvider } from "next-auth/react";
import { SWRConfig } from "swr";
import { ThemeProvider } from "@/components/theme-provider";
import type { ThemeId } from "@/lib/theme";
import { Toaster } from "@/components/ui/sonner";
import { SyntaxHighlightTheme } from "@/components/syntax-highlight-theme";

async function swrFetcher<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  return res.json();
}

export function Providers({
  children,
  initialTheme,
}: {
  children: React.ReactNode;
  initialTheme: ThemeId;
}) {
  return (
    <SWRConfig value={{ fetcher: swrFetcher, revalidateOnFocus: true, dedupingInterval: 2000 }}>
      <SessionProvider>
        <ThemeProvider initialTheme={initialTheme}>
          {children}
          <SyntaxHighlightTheme />
          <Toaster />
        </ThemeProvider>
      </SessionProvider>
    </SWRConfig>
  );
}
