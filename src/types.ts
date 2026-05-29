export type GeoPermission = "granted" | "denied" | "unavailable";

export interface GeoContext {
  lat?: number;
  lon?: number;
  accuracyM?: number;
  permission: GeoPermission;
}

export interface UserSettings {
  voicePreset: string;
  displayName: string;
  musicNotes: string;
  currentMode: string;
  timezoneName?: string;
  locale?: string;
  regionHint?: string;
  localTimeBlock?: string;
  geo?: GeoContext;
  listeningIntent?: ListeningIntent;
}

export interface Track {
  id: string;
  name: string;
  artist: string;
  album?: string;
  aliases?: string[];
  source?: string;
  language?: string;
  selectionReason?: SelectionReason;
  raw?: Record<string, unknown>;
}

export interface SelectionReason {
  type: string;
  text: string;
  understoodIntent?: string;
  verificationNote?: string;
}

export type MusicTaskType =
  | "specific_track"
  | "artist_direction"
  | "artist_work_direction"
  | "scene_genre_direction"
  | "continuation"
  | "negative_feedback"
  | "unclear";

export interface MusicEntity {
  role: "artist" | "performer" | "composer" | "arranger" | "producer" | "work" | "genre" | "scene" | "music_entity";
  name: string;
}

export interface MusicTask {
  type: MusicTaskType;
  primaryEntities: MusicEntity[];
  workHint: string;
  styleHint: string;
  negativeConstraints: string[];
  searchGoals: string[];
  mustNotSearchLiteralUserSentence: boolean;
}

export type DJAction =
  | "play_now"
  | "set_direction_and_play"
  | "revise_mode_and_play"
  | "soft_confirm_and_play"
  | "ask_clarifying_question"
  | "negative_feedback"
  | "continue_current_mode";

export interface QueuePolicy {
  durationTracks: number;
  continueDirection: boolean;
  avoidRepetition: boolean;
}

export interface DJDecision {
  action: DJAction;
  understoodIntent: string;
  musicTask: MusicTask;
  queuePolicy: QueuePolicy;
  uncertainty: {
    level: "low" | "medium" | "high";
    reason: string;
    shouldAskUser: boolean;
  };
  djResponse: {
    speakNow: string;
    tone: string;
  };
  memoryUpdate: {
    sessionPreference: string[];
    possibleLongTermPreference: string[];
    negativeConstraints: string[];
  };
  rawText: string;
}

export interface SearchVerification {
  status: "verified" | "not_found" | "error";
  selectedSong?: Track;
  url?: string;
  verification: {
    confidence?: number;
    matchedEntities?: string[];
    versionNote?: string;
    risk?: string;
  };
  fallbackCandidates: Track[];
  recoveryOptions: Array<{ type: string; task: string; reason: string }>;
  failureReason?: string;
  usedQuery?: string;
  diagnostics?: {
    searchedQueries?: string[];
    rejectedQueries?: string[];
    generatedQueries?: string[];
    candidateIds?: string[];
    attemptedSongIds?: string[];
    queryResults?: Array<{
      query: string;
      results: Array<{
        id: string;
        name: string;
        artist: string;
        album?: string;
        accepted: boolean;
        reason?: string;
      }>;
    }>;
    verifier?: {
      chosenId?: string;
      confidence?: number;
      matchedEntities?: string[];
      risk?: string;
    };
    audioAttempts?: Array<{
      songId: string;
      name?: string;
      artist?: string;
      sourceQuery?: string;
      ok: boolean;
      reason?: string;
      resolvedSongId?: string;
    }>;
  };
}

export interface ListeningIntent {
  label: string;
  rawText: string;
  expiresAfterTracks: number;
  constraints: string[];
  seedTask?: MusicTask;
}

export interface TasteProfile {
  uid: string;
  musicDna: {
    genres: Record<string, number>;
    languageBias: Record<string, number>;
    energyLevel: string;
    vocalPreference: string;
  };
  personality: {
    traits: string[];
    emotionalResonance: string;
  };
  radioInsights: {
    tasteSummary: string;
    comfortZone: string[];
    discoveryDirection: string[];
    emotionalHooks: string[];
    djTalkingPoints: string[];
  };
  anchorTracks: Track[];
  recentTracks: Track[];
  likedTrackIds: string[];
  learned: {
    avoidedLanguages: string[];
    avoidedStyles: string[];
    skippedTrackIds: string[];
    negativeFeedbackCount: number;
  };
  updatedAt: string;
}

export interface MemoryPack {
  userProfileDigest: string;
  sessionWorkingMemory: Record<string, unknown>;
  recentTurns: Array<Record<string, unknown>>;
  retrievedMemories: Array<Record<string, unknown>>;
  playbackContext: Record<string, unknown>;
  userSettings: Partial<UserSettings>;
  hardConstraints: string[];
}

export interface SessionRecord {
  id: number;
  uid: string;
}
