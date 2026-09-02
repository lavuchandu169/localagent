import fs from "node:fs/promises";
import path from "node:path";

export interface PickedAttachment {
  name: string;
  kind: "image" | "text";
  mediaType?: string;
  dataBase64?: string;
  content?: string;
  truncated?: boolean;
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_TEXT_BYTES = 200 * 1024; // 200KB
const TRUNCATION_MARKER = "\n…truncated…\n";

interface ImageSignature {
  mediaType: string;
  magic: number[];
}

const IMAGE_SIGNATURES: ImageSignature[] = [
  { mediaType: "image/png", magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mediaType: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
  { mediaType: "image/gif", magic: [0x47, 0x49, 0x46, 0x38] }, // "GIF8"
  { mediaType: "image/webp", magic: [0x52, 0x49, 0x46, 0x46] }, // "RIFF" — confirmed as WebP separately below
];

/** Classifies by real bytes, never by filename extension. A RIFF container (the WebP signature) isn't exclusively WebP — e.g. WAV also starts with "RIFF" — so that one signature gets a second check for the "WEBP" fourCC at byte 8 before it's accepted. */
function detectImageMediaType(buf: Buffer): string | null {
  for (const sig of IMAGE_SIGNATURES) {
    if (buf.length < sig.magic.length) continue;
    if (!sig.magic.every((byte, i) => buf[i] === byte)) continue;
    if (sig.mediaType === "image/webp") {
      if (buf.length < 12 || buf.subarray(8, 12).toString("ascii") !== "WEBP") continue;
    }
    return sig.mediaType;
  }
  return null;
}

/**
 * Reads and classifies one picked file — an image (by magic-number
 * signature) or text (by UTF-8 validity), never by extension. Throws for
 * an oversized image or a file that's neither: the caller (the
 * agent:pick-attachments IPC handler, Task 6) catches per-file so one bad
 * file in a multi-file pick doesn't lose the others.
 */
export async function readAttachment(filePath: string): Promise<PickedAttachment> {
  const name = path.basename(filePath);
  const buf = await fs.readFile(filePath);

  const imageMediaType = detectImageMediaType(buf);
  if (imageMediaType) {
    if (buf.length > MAX_IMAGE_BYTES) {
      throw new Error(`${name}: image is too large (${(buf.length / 1024 / 1024).toFixed(1)}MB, limit is 5MB).`);
    }
    return { name, kind: "image", mediaType: imageMediaType, dataBase64: buf.toString("base64") };
  }

  // Detect binary/unsupported files by two criteria:
  // 1. Literal null bytes (0x00) in the buffer — nearly always binary, even
  //    if the rest decodes as valid UTF-8 (e.g., RIFF headers like WAV).
  // 2. UTF-8 decoding with U+FFFD (replacement character) — indicates
  //    invalid byte sequences. Buffer#toString("utf-8") never throws; it
  //    silently substitutes U+FFFD for invalid sequences. Real text files
  //    have none; binary files are riddled with them.
  if (buf.includes(0)) {
    throw new Error(`${name}: not a recognized image and not valid UTF-8 text.`);
  }
  const text = buf.toString("utf-8");
  if (text.includes("�")) {
    throw new Error(`${name}: not a recognized image and not valid UTF-8 text.`);
  }

  if (buf.length > MAX_TEXT_BYTES) {
    const truncatedText = Buffer.from(buf.subarray(0, MAX_TEXT_BYTES)).toString("utf-8");
    return { name, kind: "text", content: `${truncatedText}${TRUNCATION_MARKER}`, truncated: true };
  }

  return { name, kind: "text", content: text };
}
