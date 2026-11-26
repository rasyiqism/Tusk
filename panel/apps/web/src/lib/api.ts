import { treaty } from "@elysiajs/eden";
import type { App } from "@panel/api";

export const api = treaty<App>(
  typeof window !== "undefined" ? window.location.origin : "http://localhost:3000",
  {
    fetch: {
      credentials: "include",
    },
  }
);
