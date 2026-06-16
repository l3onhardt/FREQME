import type { StationContract } from "../radio/radioBrainTypes.js";
import type { AgentSessionContract } from "./contractController.js";

export function agentContractForGovernor(
  contract: StationContract | null,
  session: { uid: string | null; sessionId: number | null },
): AgentSessionContract | null {
  if (!contract) return null;
  const stationBrief = contract.mainDirection || contract.rawUserText;
  return {
    id: contract.id,
    uid: session.uid,
    sessionId: session.sessionId,
    rawUserText: contract.rawUserText || stationBrief,
    stationBrief,
    positiveAnchors: unique([...contract.positiveSeeds]),
    disallowed: unique([...contract.disallowed, ...contract.negativeConstraints]),
    allowedAdjacent: unique([...contract.allowedAdjacent, ...contract.softBridge]),
    bridgeBudget: Math.max(0, contract.driftBudget - contract.bridgeCount),
    returnRequirement: `Return to ${stationBrief} after any adjacent step.`,
    sourceEventId: contract.id,
    status: "active",
    createdAt: contract.createdAt,
    updatedAt: contract.updatedAt,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
