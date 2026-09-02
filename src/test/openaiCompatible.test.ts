import { buildChatBody } from "../providers/openaiCompatible.js";
import type { ChatMessage } from "../types.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("buildChatBody:");

{
  const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
  const body: any = buildChatBody({ model: "qwen2.5-coder:latest", messages });
  check("a plain message with no attachments keeps plain string content", body.messages[0].content === "hi");
}

{
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: "what's this",
      images: [{ name: "a.png", mediaType: "image/png", dataBase64: "ZmFrZQ==" }],
    },
  ];
  const body: any = buildChatBody({ model: "some-vision-model", messages });
  const parts = body.messages[0].content;
  check("a message with an image becomes a content-part array", Array.isArray(parts));
  check("the text part comes first", parts[0].type === "text" && parts[0].text === "what's this");
  check(
    "the image becomes an image_url part with a data URI",
    JSON.stringify(parts[1]) === JSON.stringify({ type: "image_url", image_url: { url: "data:image/png;base64,ZmFrZQ==" } })
  );
}

{
  const messages: ChatMessage[] = [
    { role: "user", content: "", images: [{ name: "a.png", mediaType: "image/png", dataBase64: "AAAA" }] },
  ];
  const body: any = buildChatBody({ model: "m", messages });
  const parts = body.messages[0].content;
  check("an attachment-only message has no leading empty text part", parts.length === 1 && parts[0].type === "image_url");
}

{
  const messages: ChatMessage[] = [
    { role: "user", content: "summarize", textAttachments: [{ name: "notes.txt", content: "key point: X" }] },
  ];
  const body: any = buildChatBody({ model: "m", messages });
  check(
    "a text attachment folds into the message's plain string content (no attachment array needed for text)",
    body.messages[0].content === "summarize\n\n--- Attached file: notes.txt ---\nkey point: X\n---"
  );
}

{
  // Existing behavior this task must not disturb: tool_calls / tool_call_id
  // / name still map through exactly as before.
  const messages: ChatMessage[] = [
    { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "read_file", arguments: { path: "a.js" } }] },
    { role: "tool", tool_call_id: "c1", name: "read_file", content: "file contents" },
  ];
  const body: any = buildChatBody({ model: "m", messages });
  check(
    "assistant tool_calls still map to the OpenAI function-call shape",
    JSON.stringify(body.messages[0].tool_calls) === JSON.stringify([{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.js"}' } }])
  );
  check("tool_call_id and name still pass through on a tool message", body.messages[1].tool_call_id === "c1" && body.messages[1].name === "read_file");
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
