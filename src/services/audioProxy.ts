export interface AudioProxyContentTypeResult {
  ok: boolean;
  contentType: string;
}

export function audioProxyContentType(rawContentType: string, firstChunk: Uint8Array): AudioProxyContentTypeResult {
  const contentType = rawContentType || "audio/mpeg";
  const lower = contentType.toLowerCase();
  if (lower.startsWith("audio/")) {
    return { ok: true, contentType };
  }

  if (!lower.startsWith("application/octet-stream")) {
    return { ok: false, contentType };
  }

  const inferred = inferAudioContentType(firstChunk);
  return inferred ? { ok: true, contentType: inferred } : { ok: false, contentType };
}

function inferAudioContentType(bytes: Uint8Array): string {
  if (bytes.length < 4) return "";
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return "audio/mpeg";
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "audio/mpeg";
  if (bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) return "audio/flac";
  if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    return "audio/mp4";
  }
  if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return "audio/ogg";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  ) {
    return "audio/wav";
  }
  return "";
}
