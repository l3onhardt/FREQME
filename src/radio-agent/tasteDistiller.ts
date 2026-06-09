import type { RadioAgentEvent, RadioAgentMemory, RadioLibraryPlaylist, RadioLibraryTrack } from "./types.js";

export interface TasteDistillationArgs {
  uid: string;
  libraryTracks: RadioLibraryTrack[];
  playlists: RadioLibraryPlaylist[];
  recentEvents: RadioAgentEvent[];
  existingMemories?: RadioAgentMemory[];
}

export interface TasteEvidenceItem {
  key: string;
  kind: "taste_fact" | "taste_hypothesis" | "session_evidence";
  value: string;
  confidence: number;
  evidenceCount: number;
  evidenceRefs: string[];
}

export interface TasteDistillationResult {
  uid: string;
  facts: TasteEvidenceItem[];
  hypotheses: TasteEvidenceItem[];
  sessionEvidence: TasteEvidenceItem[];
}

const STOP_PLAYLIST_TOKENS = new Set([
  "music",
  "playlist",
  "songs",
  "song",
  "my",
  "liked",
  "favorite",
  "favorites",
  "collection",
]);

export function distillTasteFacts(args: TasteDistillationArgs): TasteDistillationResult {
  const facts: TasteEvidenceItem[] = [];
  const hypotheses: TasteEvidenceItem[] = [];
  const sessionEvidence: TasteEvidenceItem[] = [];
  const existingMemories = args.existingMemories || [];

  for (const memory of existingMemories) {
    if (memory.kind !== "taste_fact" && memory.kind !== "taste_hypothesis") continue;
    upsertEvidence(memory.kind === "taste_fact" ? facts : hypotheses, {
      key: memory.key,
      kind: memory.kind,
      value: memory.value,
      confidence: memory.confidence,
      evidenceCount: memory.evidenceCount,
      evidenceRefs: memory.evidenceRefs,
    });
  }

  for (const [artist, tracks] of groupedBy(args.libraryTracks, (track) => track.artist).entries()) {
    if (tracks.length < 2 || !artist) continue;
    upsertEvidence(facts, {
      key: `artist:${artist}`,
      kind: "taste_fact",
      value: `Listener has repeated library evidence for ${artist}.`,
      confidence: Math.min(0.95, 0.6 + tracks.length * 0.08),
      evidenceCount: tracks.length,
      evidenceRefs: tracks.map((track) => `track:${track.songId}`).slice(0, 12),
    });
  }

  for (const [album, tracks] of groupedBy(args.libraryTracks, (track) => track.album).entries()) {
    if (tracks.length < 2 || !album) continue;
    upsertEvidence(facts, {
      key: `album:${album}`,
      kind: "taste_fact",
      value: `Listener has multiple saved tracks from ${album}.`,
      confidence: Math.min(0.9, 0.55 + tracks.length * 0.07),
      evidenceCount: tracks.length,
      evidenceRefs: tracks.map((track) => `track:${track.songId}`).slice(0, 12),
    });
  }

  for (const item of playlistThemeHypotheses(args.playlists)) {
    upsertEvidence(hypotheses, item);
  }

  for (const item of completedListeningHypotheses(args.recentEvents, existingMemories)) {
    upsertEvidence(hypotheses, item);
  }

  for (const item of explicitPositiveArtistHypotheses(args.recentEvents)) {
    upsertEvidence(hypotheses, item);
  }

  for (const item of durablePositiveArtistFacts(args.recentEvents, existingMemories)) {
    upsertEvidence(facts, item);
  }

  for (const event of args.recentEvents) {
    if (event.type === "track_skipped") {
      const trackId = extractTrackId(event.payload.track);
      if (!trackId) continue;
      sessionEvidence.push({
        key: `skip:${trackId}`,
        kind: "session_evidence",
        value: `Skipped track ${trackId}; treat as session evidence until repeated or explicitly confirmed.`,
        confidence: 0.45,
        evidenceCount: 1,
        evidenceRefs: event.id ? [`event:${event.id}`] : [`event:${event.createdAt}`],
      });
    }

    if (event.type === "user_text") {
      const text = stringValue(event.payload.text);
      if (!text || !looksLikePreferenceText(text)) continue;
      sessionEvidence.push({
        key: "explicit:user_text",
        kind: "session_evidence",
        value: text,
        confidence: 0.82,
        evidenceCount: 1,
        evidenceRefs: event.id ? [`event:${event.id}`] : [`event:${event.createdAt}`],
      });
    }
  }

  return {
    uid: args.uid,
    facts: facts.sort(compareEvidence),
    hypotheses: hypotheses.sort(compareEvidence),
    sessionEvidence: sessionEvidence.sort(compareEvidence),
  };
}

function playlistThemeHypotheses(playlists: RadioLibraryPlaylist[]): TasteEvidenceItem[] {
  const tokenCounts = new Map<string, { count: number; refs: string[] }>();
  for (const playlist of playlists) {
    const tokens = tokenizePlaylistName(playlist.name);
    for (const token of new Set(tokens)) {
      const current = tokenCounts.get(token) || { count: 0, refs: [] };
      current.count += 1;
      current.refs.push(`playlist:${playlist.playlistId}`);
      tokenCounts.set(token, current);
    }
  }

  const result: TasteEvidenceItem[] = [];
  for (const [token, evidence] of tokenCounts.entries()) {
    if (evidence.count < 2) continue;
    result.push({
      key: `theme:${token}`,
      kind: "taste_hypothesis",
      value: `Playlist titles repeatedly mention ${token}; possible listening context or taste theme.`,
      confidence: Math.min(0.75, 0.45 + evidence.count * 0.08),
      evidenceCount: evidence.count,
      evidenceRefs: evidence.refs.slice(0, 12),
    });
  }

  const phrase = repeatedPhrase(playlists.map((playlist) => playlist.name));
  if (phrase) {
    result.push({
      key: `theme:${phrase.replace(/\s+/g, "-")}`,
      kind: "taste_hypothesis",
      value: `Playlist titles repeatedly suggest ${phrase}; keep this as a hypothesis until behavior confirms it.`,
      confidence: 0.58,
      evidenceCount: playlists.filter((playlist) => playlist.name.toLowerCase().includes(phrase)).length,
      evidenceRefs: playlists
        .filter((playlist) => playlist.name.toLowerCase().includes(phrase))
        .map((playlist) => `playlist:${playlist.playlistId}`)
        .slice(0, 12),
    });
  }

  return result;
}

function completedListeningHypotheses(events: RadioAgentEvent[], existingMemories: RadioAgentMemory[] = []): TasteEvidenceItem[] {
  const artistEvidence = completedArtistEvidence(events, existingMemories);

  const result: TasteEvidenceItem[] = [];
  for (const [artist, evidence] of artistEvidence.entries()) {
    if (evidence.count < 2) continue;
    result.push({
      key: `session_artist:${artist}`,
      kind: "taste_hypothesis",
      value: `Recent completed listening repeatedly returned to ${artist}; treat this as a session preference signal until it repeats across sessions.`,
      confidence: Math.min(0.78, 0.46 + evidence.count * 0.09),
      evidenceCount: evidence.count,
      evidenceRefs: evidence.refs.slice(0, 12),
    });
  }
  return result;
}

function explicitPositiveArtistHypotheses(events: RadioAgentEvent[]): TasteEvidenceItem[] {
  const result: TasteEvidenceItem[] = [];
  for (const event of events) {
    if (event.type !== "user_text") continue;
    const text = stringValue(event.payload.text);
    const artist = explicitPositiveArtistFromText(text);
    if (!artist) continue;
    result.push({
      key: `session_artist:${artist}`,
      kind: "taste_hypothesis",
      value: `Listener explicitly asked for more ${artist}; treat this as a session preference signal until playback confirms it.`,
      confidence: 0.64,
      evidenceCount: 1,
      evidenceRefs: event.id ? [`event:${event.id}`] : [`event:${event.createdAt}`],
    });
  }
  return result;
}

function durablePositiveArtistFacts(events: RadioAgentEvent[], existingMemories: RadioAgentMemory[]): TasteEvidenceItem[] {
  const artistEvidence = completedArtistEvidence(events, existingMemories);
  const positiveEvidence = positiveExplicitArtistEvidence(events, Array.from(artistEvidence.keys()));
  const result: TasteEvidenceItem[] = [];

  for (const [artist, evidence] of artistEvidence.entries()) {
    const positive = positiveEvidence.get(artist);
    if (!positive || evidence.count < 2) continue;
    result.push({
      key: `artist:${artist}`,
      kind: "taste_fact",
      value: `Listener explicitly asked for more ${artist} and completed repeated ${artist} listening; use ${artist} as a durable preference anchor.`,
      confidence: Math.min(0.94, 0.68 + evidence.count * 0.06 + positive.count * 0.08),
      evidenceCount: evidence.count + positive.count,
      evidenceRefs: uniqueStrings([...evidence.refs, ...positive.refs]).slice(0, 12),
    });
  }

  return result;
}

function completedArtistEvidence(
  events: RadioAgentEvent[],
  existingMemories: RadioAgentMemory[] = [],
): Map<string, { count: number; refs: string[] }> {
  const artistEvidence = new Map<string, { count: number; refs: string[] }>();

  for (const memory of existingMemories) {
    const artist = artistFromSessionMemory(memory);
    if (!artist) continue;
    const current = artistEvidence.get(artist) || { count: 0, refs: [] };
    current.count += Math.max(1, memory.evidenceCount || 1);
    current.refs.push(...memory.evidenceRefs);
    artistEvidence.set(artist, current);
  }

  for (const event of events) {
    if (event.type !== "track_completed") continue;
    const track = extractTrack(event.payload.track) || extractTrack(event.payload.currentTrack);
    if (!track || !track.artist) continue;
    const current = artistEvidence.get(track.artist) || { count: 0, refs: [] };
    current.count += 1;
    current.refs.push(event.id ? `event:${event.id}` : `event:${event.createdAt}`);
    artistEvidence.set(track.artist, current);
  }

  return artistEvidence;
}

function artistFromSessionMemory(memory: RadioAgentMemory): string {
  if (memory.kind !== "taste_hypothesis" || !memory.key.startsWith("session_artist:")) return "";
  return memory.key.split(":").slice(1).join(":").trim();
}

function positiveExplicitArtistEvidence(
  events: RadioAgentEvent[],
  candidateArtists: string[],
): Map<string, { count: number; refs: string[] }> {
  const result = new Map<string, { count: number; refs: string[] }>();
  const uniqueArtists = uniqueStrings(candidateArtists);
  for (const event of events) {
    if (event.type !== "user_text") continue;
    const text = stringValue(event.payload.text);
    if (!text) continue;
    for (const artist of uniqueArtists) {
      if (!textNamesPositiveArtist(text, artist)) continue;
      const current = result.get(artist) || { count: 0, refs: [] };
      current.count += 1;
      current.refs.push(event.id ? `event:${event.id}` : `event:${event.createdAt}`);
      result.set(artist, current);
    }
  }
  return result;
}

function textNamesPositiveArtist(text: string, artist: string): boolean {
  const normalizedText = text.toLowerCase();
  const normalizedArtist = artist.toLowerCase();
  const index = normalizedText.indexOf(normalizedArtist);
  if (index < 0) return false;

  const local = normalizedText.slice(Math.max(0, index - 32), index + normalizedArtist.length + 32);
  const before = normalizedText.slice(Math.max(0, index - 24), index);
  if (/\b(less|avoid|skip|not|no|don't|dont|dislike)\b|不要|别|不想/u.test(before)) return false;
  return /\b(more|play|want|like|love|prefer|again)\b|想听|喜欢|多来|来点/u.test(local);
}

function explicitPositiveArtistFromText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (/\b(less|avoid|skip|not|no|don't|dont|dislike)\b/i.test(normalized.slice(0, 32))) return "";
  if (/不要|别|不想|少来/u.test(normalized.slice(0, 8))) return "";

  const patterns = [
    /\b(?:play|queue|put on|give me|want|need|like|love|prefer)\s+(?:some\s+|more\s+|tracks?\s+by\s+|songs?\s+by\s+)?([A-Z][A-Za-z0-9 .+'&-]{1,48}?)(?:\s+(?:lately|tonight|today|please|pls|now|next|tracks?|songs?|music|radio|vibes?))?(?:[.!?]|$)/i,
    /\bmore\s+of\s+([A-Z][A-Za-z0-9 .+'&-]{1,48}?)(?:\s+(?:lately|tonight|today|please|pls|now|next|tracks?|songs?|music|radio|vibes?))?(?:[.!?]|$)/i,
    /\bmore\s+([A-Z][A-Za-z0-9 .+'&-]{1,48}?)(?:\s+(?:lately|tonight|today|please|pls|now|next|tracks?|songs?|music|radio|vibes?))?(?:[.!?]|$)/i,
    /(?:多来点|来点|想听更多|想听点|喜欢|更喜欢)\s*([A-Z][A-Za-z0-9 .+'&-]{1,48})(?:[。！？.!?]|$)/u,
  ];

  const match = patterns.map((pattern) => normalized.match(pattern)).find((candidate) => candidate?.[1]);
  const artist = cleanArtistCandidate(match?.[1] ?? "");
  if (!artist) return "";
  if (isGenericArtistCandidate(artist)) return "";
  return artist;
}

function cleanArtistCandidate(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s+(?:lately|tonight|today|please|pls|now|next|tracks?|songs?|music|radio|vibes?)$/i, "")
    .replace(/[.,!?。！？]+$/u, "")
    .trim();
}

function isGenericArtistCandidate(artist: string): boolean {
  if (!artist) return false;
  return /\b(classical|edm|rnb|r&b|jazz|ambient|pop|rock|hip hop|soul|music|songs?|tracks?)\b/i.test(artist);
}

function upsertEvidence(items: TasteEvidenceItem[], item: TasteEvidenceItem): void {
  const index = items.findIndex((existing) => existing.key === item.key && existing.kind === item.kind);
  if (index < 0) {
    items.push({ ...item, evidenceRefs: uniqueStrings(item.evidenceRefs).slice(0, 12) });
    return;
  }

  const existing = items[index];
  items[index] = {
    ...item,
    confidence: Math.max(existing.confidence, item.confidence),
    evidenceCount: Math.max(existing.evidenceCount, item.evidenceCount),
    evidenceRefs: uniqueStrings([...existing.evidenceRefs, ...item.evidenceRefs]).slice(0, 12),
  };
}

function uniqueStrings(items: string[]): string[] {
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean)));
}

function groupedBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item).trim();
    if (!key) continue;
    const bucket = result.get(key) || [];
    bucket.push(item);
    result.set(key, bucket);
  }
  return result;
}

function tokenizePlaylistName(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOP_PLAYLIST_TOKENS.has(token));
}

function repeatedPhrase(names: string[]): string {
  const lowered = names.map((name) => name.toLowerCase());
  if (lowered.filter((name) => name.includes("late night")).length >= 1 && lowered.some((name) => name.includes("night"))) {
    return "late night";
  }
  return "";
}

function extractTrackId(track: unknown): string {
  if (!isRecord(track)) return "";
  return stringValue(track.id || track.songId);
}

function extractTrack(value: unknown): { id: string; name: string; artist: string } | null {
  if (!isRecord(value)) return null;
  return {
    id: stringValue(value.id || value.songId),
    name: stringValue(value.name || value.songName),
    artist: stringValue(value.artist),
  };
}

function looksLikePreferenceText(text: string): boolean {
  return /不要|别|不想|更|喜欢|想听|prefer|avoid|less|more/i.test(text);
}

function stringValue(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareEvidence(a: TasteEvidenceItem, b: TasteEvidenceItem): number {
  return b.confidence - a.confidence || b.evidenceCount - a.evidenceCount || a.key.localeCompare(b.key);
}
