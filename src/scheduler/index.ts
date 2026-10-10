// STUB — stream C (publish/ops) owns this module. Signatures are frozen (contracts-v1).

/** Create slots for the next `days` days for every enabled product. Returns number created. */
export async function planSlots(days = 1): Promise<number> {
  throw new Error(`planSlots not implemented yet (${days})`);
}

/** One scheduler pass: generate posts for due slots, publish approved posts whose time has come. */
export async function tick(): Promise<void> {
  throw new Error("tick not implemented yet");
}

/** Long-running daemon: tick every 5 minutes, plan daily. */
export async function runDaemon(): Promise<void> {
  throw new Error("runDaemon not implemented yet");
}
