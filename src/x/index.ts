// X through the product's logged-in browser profile (data/sessions/<slug>/). Stub: stream X implements it.
import type { XAccount } from "../core/types.ts";

/**
 * Open a visible browser at x.com/login on the product's profile, wait for the user to log in (up to ~10 min),
 * read the profile, save the x_accounts row (and avatar into products/<slug>/assets/), close the window.
 */
export async function connectX(_slug: string): Promise<XAccount> {
  throw new Error("connectX not implemented");
}

/** Delete the product's browser profile and x_accounts row. */
export async function disconnectX(_slug: string): Promise<void> {
  throw new Error("disconnectX not implemented");
}

/** Read fresh metrics for published posts of the last `days` days. Returns how many posts were updated. */
export async function collectMetrics(_days = 7): Promise<number> {
  throw new Error("collectMetrics not implemented");
}
