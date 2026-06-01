import type { MemoryStore } from "../storage/memoryStore.js";
import type { DecisionTrace } from "./radioBrainTypes.js";

export class DecisionTraceStore {
  constructor(private readonly store: MemoryStore) {}

  save(trace: DecisionTrace): void {
    this.store.saveDecisionTrace(trace);
  }

  latestForSession(uid: string | null, sessionId: number | null): DecisionTrace | null {
    return this.store.getLatestDecisionTrace(uid, sessionId);
  }
}
