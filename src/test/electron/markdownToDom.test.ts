import { JSDOM } from "jsdom";
import { renderMarkdown } from "../../electron/renderer/markdownToDom.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
(globalThis as any).document = dom.window.document;

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

function render(text: string, opts?: { onLinkClick?: (url: string) => void; writeToClipboard?: (text: string) => Promise<void> }) {
  const container = document.createElement("div");
  const frag = renderMarkdown(text, {
    onLinkClick: opts?.onLinkClick ?? (() => {}),
    writeToClipboard: opts?.writeToClipboard,
  });
  container.appendChild(frag);
  return container;
}

console.log("renderMarkdown — headings:");
for (let level = 1; level <= 6; level++) {
  const hashes = "#".repeat(level);
  const container = render(`${hashes} Heading text`);
  const el = container.querySelector(`h${level}`);
  check(`a level-${level} heading (${hashes}) becomes a real <h${level}> element`, el !== null && el.textContent === "Heading text");
}
{
  const container = render("####### too many hashes");
  check("7 hashes is not a valid heading level — falls back to a plain paragraph", container.querySelector("h1, h2, h3, h4, h5, h6") === null);
}

console.log("\nrenderMarkdown — inline formatting:");
{
  const container = render("some **bold** text");
  const strong = container.querySelector("strong");
  check("**bold** becomes a real <strong> element", strong !== null && strong.textContent === "bold");
  check("surrounding plain text is preserved", container.textContent === "some bold text");
}
{
  const container = render("some *italic* text");
  const em = container.querySelector("em");
  check("*italic* becomes a real <em> element", em !== null && em.textContent === "italic");
}
{
  const container = render("some `inline code` text");
  const code = container.querySelector("code");
  check("`inline code` becomes a real <code> element", code !== null && code.textContent === "inline code");
}
{
  const container = render("a **bold `nested` word**");
  check(
    "inline formatting doesn't nest — bold's content is taken as plain literal text, not re-parsed (deliberate v1 simplicity)",
    container.querySelector("strong")?.textContent === "bold `nested` word" && container.querySelector("code") === null
  );
}

console.log("\nrenderMarkdown — links:");
{
  let clickedUrl: string | undefined;
  const container = render("see [the docs](https://example.com/docs) for more", {
    onLinkClick: (url) => {
      clickedUrl = url;
    },
  });
  const a = container.querySelector("a");
  check("[text](url) becomes a real <a> element with the right text", a !== null && a.textContent === "the docs");
  check("the <a> carries the real href (so hovering/right-click still shows the real URL)", a?.getAttribute("href") === "https://example.com/docs");

  const event = new dom.window.MouseEvent("click", { bubbles: true, cancelable: true });
  let defaultPrevented = false;
  a?.addEventListener("click", () => {
    defaultPrevented = event.defaultPrevented;
  });
  a?.dispatchEvent(event);
  check("clicking it calls onLinkClick with the real URL instead of letting the window navigate", clickedUrl === "https://example.com/docs");
  check("the click's default action (real in-window navigation) is prevented", defaultPrevented);
}
{
  const container = render("see [click me](javascript:evil) for more");
  check("a javascript: scheme link never becomes a real <a> element", container.querySelector("a") === null);
  check("its text is still shown, just as plain literal text", container.textContent === "see click me for more");
}
{
  const container = render("[local file](file:///etc/passwd)");
  check("a file: scheme link never becomes a real <a> element", container.querySelector("a") === null);
}
{
  const container = render("[bad](not a url)");
  check("a target that doesn't even parse as a URL never becomes a real <a> element", container.querySelector("a") === null);
}
{
  const container = render("[secure](HTTPS://Example.com)");
  check("scheme matching is case-insensitive — HTTPS still becomes a real link", container.querySelector("a") !== null);
}

console.log("\nrenderMarkdown — lists:");
{
  const container = render("- first\n- second\n- third");
  const ul = container.querySelector("ul");
  const items = ul ? [...ul.querySelectorAll("li")].map((li) => li.textContent) : [];
  check("consecutive '- ' lines become one real <ul> with one <li> each, in order", JSON.stringify(items) === JSON.stringify(["first", "second", "third"]));
}
{
  const container = render("* first\n* second");
  const items = [...container.querySelectorAll("ul li")].map((li) => li.textContent);
  check("'* ' bullets work exactly like '- ' bullets", JSON.stringify(items) === JSON.stringify(["first", "second"]));
}
{
  const container = render("1. first\n2. second\n3. third");
  const ol = container.querySelector("ol");
  const items = ol ? [...ol.querySelectorAll("li")].map((li) => li.textContent) : [];
  check("consecutive numbered lines become one real <ol> with one <li> each, in order", JSON.stringify(items) === JSON.stringify(["first", "second", "third"]));
}

console.log("\nrenderMarkdown — fenced code blocks:");
{
  const container = render("```python\nprint('**not bold**')\n```");
  const code = container.querySelector("pre code");
  check("a fenced code block becomes a real <pre><code> element", code !== null);
  check(
    "content inside a code fence is NEVER inline-parsed — markdown-looking text stays completely literal",
    code?.textContent === "print('**not bold**')"
  );
  check("the code fence's language is captured and shown", container.textContent?.includes("python") === true);
  check("a copy button is present for the code block", container.querySelector("button") !== null);
}
{
  const container = render("```\nno language here\n```");
  check("a fenced code block with no language still renders the code", container.querySelector("pre code")?.textContent === "no language here");
}
{
  const container = render("```js\nunterminated fence with no closing backticks");
  check("an unterminated code fence doesn't throw — still renders what it can as code", container.querySelector("pre code") !== null);
}

console.log("\nrenderMarkdown — copy button:");
{
  let copiedText: string | undefined;
  const container = render("```\nconst x = 1;\n```", {
    writeToClipboard: async (text) => {
      copiedText = text;
    },
  });
  const button = container.querySelector("button")!;
  button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await Promise.resolve(); // let the async writeToClipboard settle
  await Promise.resolve();
  check("clicking the copy button copies the code block's exact raw text", copiedText === "const x = 1;");
  check("the button's label confirms the copy happened", button.textContent === "Copied!");
}

console.log("\nrenderMarkdown — paragraphs and mixed content:");
{
  const container = render("first paragraph\n\nsecond paragraph");
  const paragraphs = container.querySelectorAll("p");
  check("a blank line separates two real, distinct <p> elements", paragraphs.length === 2 && paragraphs[0]?.textContent === "first paragraph" && paragraphs[1]?.textContent === "second paragraph");
}
{
  const container = render("# Title\n\nSome intro text.\n\n- a\n- b\n\n```\ncode here\n```");
  const children = [...container.children].map((el) => el.tagName.toLowerCase());
  check(
    "a mixed document (heading, paragraph, list, code) renders each block in the right order",
    JSON.stringify(children) === JSON.stringify(["h1", "p", "ul", "div"])
  );
}

console.log("\nrenderMarkdown — tables:");
{
  const container = render("| a | b |\n| - | - |\n| 1 | 2 |");
  const table = container.querySelector("table");
  check("a GFM-style pipe table becomes a real <table> element", table !== null);
  const headerCells = table ? [...table.querySelectorAll("thead th")].map((el) => el.textContent) : [];
  check("the header row's cells are real <th> elements with the right text, in order", JSON.stringify(headerCells) === JSON.stringify(["a", "b"]));
  const bodyRows = table ? [...table.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent)) : [];
  check("the body row's cells are real <td> elements with the right text, in order", JSON.stringify(bodyRows) === JSON.stringify([["1", "2"]]));
}
{
  // A live-reported regression: before table support existed, a model's
  // own markdown table got silently squashed into one unreadable line by
  // the paragraph-joining logic — worse than not supporting tables at
  // all. Multiple body rows must each stay a distinct real <tr>.
  const container = render(
    "Here's a comparison:\n| Algorithm | Best | Worst |\n|---|---|---|\n| Bubble Sort | O(n) | O(n^2) |\n| Merge Sort | O(n log n) | O(n log n) |"
  );
  const table = container.querySelector("table");
  check("a table preceded by an intro paragraph still becomes a real <table>, not one squashed line", table !== null);
  check("the intro text stays a separate paragraph, not joined into the table", container.querySelector("p")?.textContent === "Here's a comparison:");
  const bodyRows = table ? [...table.querySelectorAll("tbody tr")] : [];
  check("each data row is its own real <tr>, not joined into a single line", bodyRows.length === 2);
}
{
  // Column alignment markers (:--- left, ---: right, :---: center) — GFM's
  // own syntax for this, applied as a real text-align style per column.
  const container = render("| Name | Qty | Price |\n|:---|---|---:|\n| Widget | 3 | $5 |");
  const cells = [...container.querySelectorAll<HTMLElement>("thead th")];
  check("a left-aligned column (':---') carries left text-align", cells[0]?.style.textAlign === "left");
  check("a column with no alignment marker ('---') has none set", cells[1]?.style.textAlign === "");
  check("a right-aligned column ('---:') carries right text-align", cells[2]?.style.textAlign === "right");
  const bodyCells = [...container.querySelectorAll<HTMLElement>("tbody td")];
  check("the body row's own cells carry the same column alignment as the header", bodyCells[0]?.style.textAlign === "left" && bodyCells[2]?.style.textAlign === "right");
}
{
  // Inline formatting must still work inside table cells, same as any
  // other block — reuses renderInline rather than a separate code path.
  const container = render("| Name | Link |\n|---|---|\n| **Bold** | [docs](https://example.com) |");
  check("bold text inside a table cell becomes a real <strong> element", container.querySelector("tbody td strong")?.textContent === "Bold");
  const link = container.querySelector("tbody td a");
  check("a link inside a table cell becomes a real, safe <a> element", link !== null && link.getAttribute("href") === "https://example.com");
}
{
  // Outer pipes are optional in GFM — a table with no leading/trailing "|"
  // on each row must still be recognized and parsed the same way.
  const container = render("a | b\n---|---\n1 | 2");
  const table = container.querySelector("table");
  check("a table without outer pipes on its rows is still recognized", table !== null);
  check(
    "its cells are parsed the same as the piped form",
    [...(table?.querySelectorAll("thead th") ?? [])].map((el) => el.textContent).join(",") === "a,b"
  );
}

console.log("\nrenderMarkdown — graceful fallback and edge cases:");
{
  const container = render("");
  check("empty input never throws and produces no visible block elements", container.children.length === 0);
}
{
  // No delimiter row (just a line with "|" in it, and an ordinary next
  // line) — this is NOT a table, just a paragraph that happens to
  // contain a "|" character; must never be misdetected as one.
  const container = render("a | b\njust a normal next line, not a delimiter row");
  check("a lone line with a pipe but no delimiter row underneath is never misdetected as a table", container.querySelector("table") === null);
  check("it's still shown as plain readable text, not silently dropped", container.textContent?.includes("a | b") === true);
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
