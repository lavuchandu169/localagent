import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { readAttachment } from "../electron/attachments.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

async function withTempFile(name: string, data: Buffer | string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-attachments-test-"));
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, data);
  return filePath;
}

console.log("readAttachment:");

{
  // Real PNG magic bytes (the 8-byte PNG signature) padded with arbitrary
  // data — readAttachment only sniffs the signature and then base64-encodes
  // the whole file, so this is a faithful fixture without needing a fully
  // valid, decodable image.
  const pngBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 0xab)]);
  const filePath = await withTempFile("photo.png", pngBytes);
  const result = await readAttachment(filePath);
  check("a PNG is classified as an image", result.kind === "image" && result.mediaType === "image/png");
  check("the image content is base64-encoded losslessly", result.kind === "image" && Buffer.from(result.dataBase64, "base64").equals(pngBytes));
  check("the name is just the basename", result.name === "photo.png");
}

{
  const jpegBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(50, 0x11)]);
  const filePath = await withTempFile("photo.jpg", jpegBytes);
  const result = await readAttachment(filePath);
  check("a JPEG is classified as an image", result.kind === "image" && result.mediaType === "image/jpeg");
}

{
  const gifBytes = Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.alloc(50, 0x22)]);
  const filePath = await withTempFile("anim.gif", gifBytes);
  const result = await readAttachment(filePath);
  check("a GIF is classified as an image", result.kind === "image" && result.mediaType === "image/gif");
}

{
  const webpBytes = Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP", "ascii"), Buffer.alloc(50, 0x33)]);
  const filePath = await withTempFile("sticker.webp", webpBytes);
  const result = await readAttachment(filePath);
  check("a WebP is classified as an image", result.kind === "image" && result.mediaType === "image/webp");
}

{
  // A RIFF container that ISN'T WebP (e.g. a WAV file) must not be
  // misclassified as an image just because it starts with "RIFF".
  const wavBytes = Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.from([0, 0, 0, 0]), Buffer.from("WAVE", "ascii"), Buffer.alloc(50, 0x44)]);
  const filePath = await withTempFile("sound.wav", wavBytes);
  let threw = false;
  try {
    await readAttachment(filePath);
  } catch {
    threw = true;
  }
  check("a non-WebP RIFF file is rejected, not misclassified as an image", threw);
}

{
  const filePath = await withTempFile("notes.txt", "line one\nline two\nline three\n");
  const result = await readAttachment(filePath);
  check("a plain text file is classified as text", result.kind === "text");
  check("its content is read exactly", result.kind === "text" && result.content === "line one\nline two\nline three\n");
  check("a small text file is not marked truncated", result.kind === "text" && !result.truncated);
}

{
  const oversizedText = "x".repeat(200 * 1024 + 500);
  const filePath = await withTempFile("big.log", oversizedText);
  const result = await readAttachment(filePath);
  check("a text file over the 200KB cap is truncated, not rejected", result.kind === "text" && result.truncated === true);
  check("the truncated content ends with the truncation marker", result.kind === "text" && result.content.endsWith("\n…truncated…\n"));
  check("the truncated content is at or under the cap plus the marker's own length", result.kind === "text" && result.content.length <= 200 * 1024 + "\n…truncated…\n".length);
}

{
  // 6MB of PNG-signature-prefixed bytes — over the 5MB image cap.
  const oversizedImage = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(6 * 1024 * 1024, 0x55)]);
  const filePath = await withTempFile("huge.png", oversizedImage);
  let threw = false;
  let message = "";
  try {
    await readAttachment(filePath);
  } catch (err) {
    threw = true;
    message = err instanceof Error ? err.message : String(err);
  }
  check("an oversized image is rejected, not silently truncated", threw);
  check("the rejection message names the file and the limit", message.includes("huge.png") && message.includes("5MB"));
}

{
  // Random binary bytes that are neither a recognized image signature nor
  // valid UTF-8 text (a run of continuation-byte-shaped bytes with no
  // valid lead byte decodes with replacement characters).
  const binaryBytes = Buffer.from([0x80, 0x81, 0x82, 0xff, 0xfe, 0x80, 0x81, 0x82, 0xff, 0xfe]);
  const filePath = await withTempFile("mystery.bin", binaryBytes);
  let threw = false;
  try {
    await readAttachment(filePath);
  } catch {
    threw = true;
  }
  check("a binary file that isn't a recognized image is rejected", threw);
}

{
  // A text-like buffer that IS valid UTF-8 (no U+FFFD replacement characters)
  // but contains a literal null byte among otherwise-printable ASCII content.
  // This is the null-byte rejection criterion in isolation — the test proves
  // the new check catches binary files that happen to decode as otherwise-valid UTF-8.
  const textWithNull = Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x77, 0x6f, 0x72, 0x6c, 0x64]); // "hello\0world"
  const filePath = await withTempFile("null-text.txt", textWithNull);
  let threw = false;
  try {
    await readAttachment(filePath);
  } catch {
    threw = true;
  }
  check("a text-like file with a literal null byte is rejected", threw);
}

{
  // A large (well over the 5MB image cap) file that isn't a recognized
  // image and has a null byte within its first bytes — like a real video
  // container's binary header. Proves readAttachment rejects it via the
  // new stat-based pre-check, WITHOUT ever calling fs.readFile on the
  // whole file: readFile is monkey-patched to record whether it's called
  // at all, which is more reliable than timing.
  const bigBinary = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]), // fake mp4-ish box header, includes null bytes
    Buffer.alloc(8 * 1024 * 1024, 0x41), // padding well past the 5MB cap
  ]);
  const filePath = await withTempFile("huge.mp4", bigBinary);

  let readFileCalled = false;
  const originalReadFile = fs.readFile;
  // @ts-expect-error -- intentionally monkey-patching for this one assertion
  fs.readFile = async (...args: Parameters<typeof fs.readFile>) => {
    readFileCalled = true;
    return originalReadFile(...args);
  };

  let threw = false;
  let message = "";
  try {
    await readAttachment(filePath);
  } catch (err) {
    threw = true;
    message = err instanceof Error ? err.message : String(err);
  } finally {
    fs.readFile = originalReadFile;
  }

  check("a large non-image file with an early null byte is rejected", threw);
  check("the rejection message matches the not-image/not-text style", message.includes("huge.mp4") && message.includes("not a recognized image"));
  check("the rejection happens WITHOUT a full fs.readFile of the file (stat-based pre-check)", !readFileCalled);
}

{
  // A large text-looking file (over the 5MB image cap, no null bytes in its
  // head) must still be ACCEPTED (truncated to the 200KB text cap) — the
  // stat-based pre-check must never reject a large file just because it's
  // large and not an image; only a large file that also looks binary gets
  // pre-rejected. This is the regression guard for that invariant.
  const bigText = "y".repeat(6 * 1024 * 1024);
  const filePath = await withTempFile("huge.log", bigText);
  const result = await readAttachment(filePath);
  check("a large legitimate text file is still accepted, not pre-rejected", result.kind === "text" && result.truncated === true);
  check("its truncated content still ends with the truncation marker", result.kind === "text" && result.content.endsWith("\n…truncated…\n"));
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
