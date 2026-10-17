import fs from "node:fs/promises";
import path from "node:path";
import type {
  AgentEvent,
  AgentState,
  AttachedImage,
  AttachedText,
  ChatMessage,
  ChatResponse,
  ModelProvider,
  PermissionDecision,
  PermissionMode,
  PermissionResponse,
  ProposedPlan,
  ToolCall,
} from "./types.js";
import { ProviderChatError } from "./types.js";
import { ToolRegistry } from "./toolRegistry.js";
import { PermissionEngine } from "./permissions.js";
import { extractFilenameCandidates } from "./filenameCandidates.js";
import { discoverBuiltinSkills, discoverUserSkills, matchSkills, MAX_SKILLS_PER_TASK, type SkillMetadata } from "./skillLoader.js";
import { LOAD_SKILL_FALLBACK_MESSAGE } from "./tools/loadSkill.js";
import { groupDiffIntoSegments, applyHunkSelection } from "./diffUtil.js";
import { computeFileDiff } from "./diffCompute.js";
import { createCheckpoint } from "./checkpoints.js";
import { detectVerifyCommand, KNOWN_VERIFY_COMMANDS } from "./verifyCommand.js";
import { isProtectedPath } from "./protected.js";
import { resolveWithinWorkspace } from "./workspacePath.js";
import { applyOldStringReplace } from "./editResolution.js";

export interface AgentSessionOptions {
  workspaceRoot: string;
  /**
   * False when workspaceRoot is only a fallback (sessionRegistry.ts's
   * startSession falls back to os.homedir() when the user never picked a
   * folder) rather than a folder the user actually chose. Undefined/true
   * behaves exactly like every existing caller/test today. When false, any
   * non-READ tool call (edit_file, delete_file, run_command — see the main
   * dispatch loop below) is refused outright instead of being proposed for
   * approval: a real bug report showed the model proposing — and a diff
   * actually rendering for — an edit_file call into the user's home
   * directory after a plain "hello" with no workspace ever selected.
   * Prompt-only guidance can't be relied on alone, since the failure was
   * seen on a small embedded model (see tryParseFallbackToolCall in
   * embeddedLlama.ts) that doesn't reliably follow it.
   */
  hasWorkspace?: boolean;
  model: string;
  provider: ModelProvider;
  tools: ToolRegistry;
  permissionMode: PermissionMode;
  maxTurns?: number;
  systemPrompt?: string;
  /** Seeds the conversation from a prior session's history instead of starting fresh with just the system prompt — used to resume a saved session. */
  initialMessages?: ChatMessage[];
  /** Seeds checkpointHash from a prior session's persisted value — without this, resuming a session after an app restart always starts with no checkpoint (getCheckpointHash() === null), silently making "Revert this task" unavailable with no indication the capability (and the now-or-never window to use it) just disappeared (correctness audit: session High #2). */
  initialCheckpointHash?: string | null;
  /** Called when a tool call needs ASK approval. Return `{ approved: true }` to allow; add `approvedHunkIds` to apply only some of an edit_file diff's hunks. */
  onApprovalNeeded?: (call: ToolCall) => Promise<PermissionResponse>;
  /**
   * When true, every task's very first turn is held for approval before any
   * of it runs — see run()'s interception right after the first provider
   * call. Off by default, so existing sessions are unaffected unless this
   * is explicitly turned on.
   */
  planFirst?: boolean;
  /** Called with the first turn's proposed plan when planFirst is on. Return true to proceed with it exactly as proposed (no re-fetch — the same response is then processed normally); false aborts the task with nothing executed. */
  onPlanApprovalNeeded?: (plan: ProposedPlan) => Promise<boolean>;
  /** A human-readable name for the current provider (e.g. "Claude Sonnet 5"), shown in the status event when a retryable error triggers a fallback switch. Optional — omitting it just makes that status message slightly less specific. */
  providerLabel?: string;
  /**
   * Configured cloud providers to try, in order, if the active one throws a
   * retryable ProviderChatError — built once at session-start time by
   * sessionRegistry.ts's startSession() via providerFallback.ts's
   * resolveFallbackOrder(), never re-resolved mid-task. Consumed
   * front-to-back: each retry shifts the used entry off, so a task that
   * burns through every configured fallback fails cleanly on the last one
   * instead of looping. Undefined/empty behaves exactly like today —
   * unconditional failure on any provider error.
   */
  fallbackProviders?: { provider: ModelProvider; model: string; label: string }[];
  /** Supplies the GitHub push-authentication token accessor to every tool
   * call's ToolContext — see ToolContext.getGithubToken. Only main.ts (via
   * sessionRegistry.ts's startSession) ever sets this; the CLI/demo entry
   * points leave it undefined. */
  getGithubToken?: () => Promise<string | null>;
}

export const DEFAULT_SYSTEM_PROMPT = `You are a careful autonomous coding agent operating on a local repository.
You have tools that read files directly from disk and write real changes to
them. If you need to see a file to answer, call read_file (or list_directory
/ grep to find it first) instead of asking the user for it. Use the exact
filename mentioned in the task, not a placeholder path — if you're not sure
of the exact path, call list_directory first rather than guessing one. If a
tool call fails (e.g. file not found), that's a signal to look again with
list_directory or grep, not to give up and ask the user to supply the path
themselves.

IMPORTANT — creating or changing a file means calling edit_file. It is never
done by describing the change in your reply:
Whenever the task asks you to create, write, build, design, fix, add,
implement, or scaffold anything — a file, a function, a component, a whole
project — the ONLY way to actually do that is to call edit_file, once per
file. Putting the code in your chat reply as a markdown code block instead
does NOT create or change anything; it is invisible to the user's real
files. A reply that describes files instead of writing them has not
completed the task, no matter how complete or correct the code in it looks.
  WRONG: replying with "Here's index.html:" followed by a \`\`\`html code
  block, then stopping — nothing was written, this is not done.
  RIGHT: calling edit_file with path="index.html" and the real file content
  (repeated for every other file the task needs), THEN, once every file is
  actually written, replying in plain text to summarize what you did.
Only put code directly in your plain-text reply when the user is asking a
question about code (e.g. "how would I..." or "explain this function") —
never when they've asked you to create or change something in this
workspace.

Rules:
1. Gather evidence with read-only tools before modifying unfamiliar code, and before answering any question about what a specific file contains, does, or how it could be improved — read it first rather than describing what a typical file like that might contain.
2. Prefer targeted, minimal changes over rewrites.
3. Never claim a command ran or a test passed unless you actually invoked the tool and saw the result.
4. When you believe the task is complete and verified, respond with plain text (no further tool calls) summarizing what changed and how it was verified.
5. If you lack information required to proceed safely, say so instead of guessing.
6. For tasks that require understanding a whole project (summarizing, reviewing, documenting, or answering "what does this codebase do"), use list_directory and grep to build a complete picture and read every file that's actually relevant — don't stop after one or two files just because you have *an* answer, if the task implies covering the whole thing.
7. When asked to create, write, build, design, or scaffold something, materialize it for real via edit_file — one call per file, never all of it crammed into a single call, and never left as code in your reply instead of a real tool call. See the IMPORTANT section above.
8. To delete a file, call delete_file directly — never guess a shell command for it (rm doesn't exist on every platform this runs on). To delete a whole directory and everything inside it, call delete_file with recursive: true; it refuses a directory without that flag.
9. read_file's result always reports totalLines — if the file is bigger than what you were shown (the result says truncated:true), call read_file again with offset/limit to page through the rest before claiming you've seen the whole file.
10. For a small change to a file that already exists, prefer edit_file with old_string/new_string over rewriting the whole file with content — it's faster and can't accidentally drop unrelated parts of the file. old_string must match the file's current text exactly (whitespace included) and be unique; use content instead when creating a new file or changing most of an existing one.
11. A greeting or plain conversation (e.g. "hello", "thanks", "how are you") doesn't mean there's a file by that name, or any file at all, to look for — just reply conversationally. The same goes for a general-knowledge or explanatory question about some topic ("tell me about X", "what do you think of Y", "let's consider Z") that doesn't name or clearly imply a file in this workspace: answer it directly in your reply. Discussing or explaining a topic is never, on its own, a request to create a document, notes, or summary file about it — only create one when the user actually asks you to save, write, or document something. Only treat the task as being about a file when it actually names one or clearly describes one.
12. If every real attempt at something fails (a tool call errors, or there's no tool that can actually do it — e.g. this app has no web-search tool, so don't improvise one via run_command and curl/scraping), say so explicitly rather than quietly falling back to what you already know instead. A from-memory answer is fine to offer, but label it plainly as one (e.g. "I couldn't actually search for this, but from what I already know...") — never present it in a way that could be mistaken for a verified result, even if you never literally claimed the failed attempt succeeded.`;

/**
 * A rough "this task asks for a file to end up different than it is now"
 * signal, used only to gate the corrective nudge below. Originally covered
 * only literal creation verbs (create/build/add/...); a real report showed
 * a modification-phrased task ("change the X route from GET to POST") hit
 * the exact same code-in-prose failure and slipped through uncaught, so
 * this also covers changing/fixing/refactoring existing code — not just
 * building something new.
 *
 * The verb match alone is NOT generous-but-harmless the way it first looked
 * — a live report showed a plain "write me a python code for binary search"
 * (no file named anywhere) matching "write" and getting nudged toward
 * edit_file for a request that was only ever asking for code shown in chat,
 * burning all 3 nudge attempts and then failing the task outright with
 * "nothing was changed" for a question that was answered correctly on the
 * very first turn. Same distinction this app's own system prompt (rule 11)
 * already draws for plain prose vs. a real file request: only treat this as
 * a file task when the task text actually names one or clearly implies one
 * (a dotted filename token, or the word "file"/"files" itself) — a bare
 * request for code/text with no file ever mentioned never belongs here,
 * regardless of which verb it happens to use.
 */
function taskImpliesCreation(task: string): boolean {
  const hasCreationVerb =
    /\b(create|write|rewrite|build|design|scaffold|make|generate|implement|add|change|update|modify|fix|patch|refactor|rename|edit|replace|convert|remove|delete|optimi[sz]e|tweak|clean ?up)\b/i.test(
      task
    );
  if (!hasCreationVerb) return false;
  return /\b[\w-]+\.[a-zA-Z0-9]{1,8}\b/.test(task) || /\bfiles?\b/i.test(task);
}

/** Whether a response's text contains a real fenced code block — the tell-tale sign the model wrote out file content instead of calling edit_file. Checks both fence styles (``` and ~~~); a model doesn't reliably pick one over the other. */
function containsFencedCode(content: string): boolean {
  return (content.match(/```/g)?.length ?? 0) >= 2 || (content.match(/~~~/g)?.length ?? 0) >= 2;
}

/** A single nudge wasn't always enough to get a smaller/more reluctant
 * model to actually call edit_file instead of apologizing in prose again
 * — verified live. Capped at a small fixed number of attempts (not
 * unbounded) so a model that never complies still fails the task instead
 * of burning its whole turn budget on nudges alone; each attempt also
 * consumes one of the existing per-task maxTurns slots regardless. */
const MAX_CORRECTIVE_NUDGE_ATTEMPTS = 3;

/** Escalates in directness with each attempt — a flat, identically-worded
 * repeat didn't read as urgent (or even as a correction at all) to a
 * model that just ignored the first one. */
function correctiveNudgeMessage(attemptNumber: number): string {
  if (attemptNumber === 1) {
    return (
      "You wrote file content in your reply but never called edit_file, so nothing was actually created or changed. " +
      "If you meant to create or modify files, call edit_file now for each one — one call per file, using the real content you just described. " +
      "If you were only explaining and didn't mean to produce real files, say that explicitly instead of including full file contents."
    );
  }
  if (attemptNumber < MAX_CORRECTIVE_NUDGE_ATTEMPTS) {
    return (
      "This is the second time: you still haven't called edit_file, and the file still doesn't exist. " +
      "Stop describing or apologizing — your very next action must be a real edit_file tool call with the content you already wrote out, one call per file."
    );
  }
  return (
    "Final attempt: you have not called edit_file after being asked twice. Call it now, in this reply, with no further explanation first — " +
    "or if you genuinely cannot or will not create the file, say exactly that and nothing else."
  );
}

export class AgentSession {
  private messages: ChatMessage[] = [];
  private permissions: PermissionEngine;
  private turn = 0;
  private state: AgentState = "INITIALIZING";
  private cancelled = false;
  /** Set by stopCurrentTask() — a lighter-weight sibling of `cancelled`: stops only the task in progress (aborting whatever model call is in flight) and winds the turn loop down to its normal terminal "done" event, but the session itself stays alive — a later run() call works normally. `cancelled` is reserved for cancel()'s permanent, whole-session teardown (see sessionRegistry.ts's cancelSession vs its stopTask). Reset at the start of every run() call, same lifetime as the other per-task flags above. */
  private stopRequested = false;
  /** Aborts the in-flight provider call the moment stopCurrentTask() is called — without this, `cancelled`/`stopRequested` are only checked at loop boundaries (top of the while loop, between tool calls), so a model response already streaming would otherwise keep running until it finished on its own. Freshly created at the start of every run() call; a controller from a previous task is never reused. */
  private abortController: AbortController | null = null;
  /** Paths read_file has been attempted on this session, success or not — evidence the model actually looked before writing. */
  private readPaths = new Set<string>();
  /** Skill ids already injected this session — mirrors readPaths' own
   * session-lifetime (not per-task) semantics, so the same skill is never
   * re-injected on a later task in the same session. */
  private loadedSkillIds = new Set<string>();
  /** The most recent task's checkpoint (see createCheckpoint) — one per task, not a deep undo stack. Overwritten the next time a task actually makes its first non-read tool call; a task that never writes anything leaves the previous task's checkpoint as the current "revert" target. A task that DOES attempt one but the attempt fails clears this to null instead of leaving the previous task's hash in place — otherwise "revert this task" would silently discard that earlier task's work too (final-review finding: agent core High #2). */
  private checkpointHash: string | null = null;
  /** Reported once, right after the first successful provider call —
   * never re-checked on later turns. Only the embedded provider sets
   * this (see embeddedLlama.ts's own gpuStatus field, Task 7), but this
   * code is generic: it reports whatever ModelProvider.gpuStatus says,
   * for any provider that has one. */
  private gpuStatusReported = false;
  /** Whether THIS task has already attempted its one checkpoint — reset at the start of every run() call. Attempted, not "succeeded": a non-git workspace or any other createCheckpoint failure still marks this true so every subsequent write this task doesn't retry it. */
  private checkpointAttemptedThisTask = false;
  /** Security audit findings H3 and final-review Critical #2: a
   * PROJECT_SCRIPT command (`npm test`/`pytest`/`cargo test`/`go test` —
   * running a repo's own test-runner script, arbitrary repo-defined code)
   * always evaluates to ASK from permissions.ts's own stateless
   * perspective, in every mode. This is the once-per-task memo that lets
   * it stop asking after the first approval THIS task — shared by BOTH
   * the places a PROJECT_SCRIPT run_command can originate: the model
   * issuing one directly (the main per-call loop below) and auto-verify
   * injecting one after a successful edit (autoVerifyAfterEdit). Fixing
   * only the auto-verify call site (the original H3 fix) left a model
   * calling run_command("npm test") directly completely unguarded — the
   * same hole, reachable a different way. Reset at the start of every
   * run() call, matching checkpointAttemptedThisTask's own once-per-task
   * granularity.
   *
   * Code-review finding: this memo originally keyed off classifyCommand's
   * PROJECT_SCRIPT *category* (plus hasShellMetacharacters/
   * hasEscapingArguments) rather than the exact command text. Those two
   * checks catch shell-metacharacter injection but not flag injection —
   * "npm test --script-shell=./x.sh", "go test -exec=./x", and
   * "pytest -p evilplugin" all classify as PROJECT_SCRIPT with no shell
   * metacharacters and no escaping-argument shape, so approving a bare
   * "npm test" once silently authorized any of those later in the same
   * task, never shown to the user. isApprovedVerifyCommand() below now
   * requires an exact match against KNOWN_VERIFY_COMMANDS — the same
   * fixed, closed set (and the same trust boundary) permissions.ts's own
   * AUTO_SAFE mode already uses — which makes those checks redundant
   * (an exact string match can't contain injected flags or
   * metacharacters) and closes the gap outright rather than attempting to
   * heuristically detect every way a command string could be dangerous. */
  private projectScriptApprovedThisTask = false;

  /** Single source of truth for "is this exactly one of the project's own
   * known verify commands" — shared by both places a PROJECT_SCRIPT
   * run_command can originate (the main per-call loop and
   * autoVerifyAfterEdit), so the two can't independently drift into
   * different safety postures the way they did before this check existed
   * (see projectScriptApprovedThisTask's own doc comment above). */
  private isApprovedVerifyCommand(command: string): boolean {
    return (KNOWN_VERIFY_COMMANDS as readonly string[]).includes(command.trim());
  }
  /**
   * Whether the model's MOST RECENT attempt at a WRITE-permission tool this
   * task was denied or rejected — reset at the start of every run() call,
   * and every time any write attempt happens (set true only if that attempt
   * was denied/rejected; cleared back to false the moment any write actually
   * succeeds). Feeds the corrective-nudge check below: if the model already
   * tried to write and was told no, that's a real policy decision to
   * respect, not the "described code instead of writing it" failure the
   * nudge exists to catch — but that grace must not persist forever. It
   * used to be a plain "has any write ever been attempted this task" flag,
   * which meant a task that wrote file 1 successfully then described files
   * 2 and 3 in prose (never calling edit_file for them) was never nudged
   * for those — the earlier success permanently disarmed the check for the
   * rest of the task. Scoping it to "was the most recent attempt a denial"
   * instead closes that gap while still preserving its original purpose.
   */
  private wroteThisTask = false;
  /** Whether ANY write this task has actually succeeded (unlike wroteThisTask, this never gets cleared once true) — reset at the start of every run() call. Lets the "final" branch tell a genuinely completed task apart from one where the corrective nudge fired and the model still never wrote anything, even after being told to. */
  private anyWriteSucceededThisTask = false;
  /**
   * Whether a write has succeeded since the last auto-verify attempt (or
   * since task start, if none has run yet) — reset at the start of every
   * run() call, set true on every successful WRITE-tool execution, cleared
   * the moment an auto-verify attempt actually runs (see autoVerifyAfterEdit
   * and its call site in the "final" branch below). This makes auto-verify
   * fire once per NEW batch of writes, not just once per task — a model
   * that edits again after a failed verification still gets checked again
   * before it's allowed to claim done a second time, bounded by the
   * existing per-task turn budget either way.
   */
  private writeSucceededSinceLastVerify = false;
  /** How many corrective nudges (see the "final" branch in run()) have fired this task — reset to 0 at the start of every run() call. Capped at MAX_CORRECTIVE_NUDGE_ATTEMPTS so a model that ignores every attempt doesn't loop forever; verified live that a single nudge isn't always enough for a smaller/more reluctant model, which can apologize in prose right back instead of complying the first time but still comply on a later attempt. */
  private correctiveNudgeAttemptsThisTask = 0;
  /** Whether THIS task's first-turn plan has already been proposed — reset at the start of every run() call. Gates only turn 1; once a task's plan has been shown (and approved), later turns in that same task run normally. */
  private planProposedThisTask = false;

  /**
   * The session's real primary — provider/model/label/fallbackProviders as
   * originally configured, captured once here and never touched again. A
   * mid-task fallback switch mutates this.opts directly (see run()'s catch
   * block) so the rest of THAT task keeps using the fallback, but the spec
   * only promises the switch "for the remainder of the task" — restored
   * from these at the top of every run() so a later task in the same
   * session starts back on the real primary, with the full fallback list
   * available again, rather than staying pinned to whatever provider the
   * previous task happened to end on.
   */
  private readonly originalProvider: ModelProvider;
  private readonly originalModel: string;
  private readonly originalProviderLabel: string | undefined;
  private readonly originalFallbackProviders: { provider: ModelProvider; model: string; label: string }[] | undefined;

  constructor(private opts: AgentSessionOptions) {
    this.permissions = new PermissionEngine(opts.permissionMode);
    this.originalProvider = opts.provider;
    this.originalModel = opts.model;
    this.originalProviderLabel = opts.providerLabel;
    this.originalFallbackProviders = opts.fallbackProviders;
    if (opts.initialMessages && opts.initialMessages.length > 0) {
      this.messages = [...opts.initialMessages];
      // Deferred-minor finding M5: without this, a session resumed after
      // an app restart has an empty loadedSkillIds regardless of what
      // its own prior history shows — the first matching task after
      // resume would re-inject a skill already loaded before the
      // restart. Scanning the seeded history for the same synthetic
      // load_skill tool-call shape autoLoadSkills itself produces keeps
      // this in sync with that shape without a separate stored list.
      for (const m of this.messages) {
        if (m.role !== "assistant" || !m.tool_calls) continue;
        for (const call of m.tool_calls) {
          if (call.name === "load_skill" && typeof call.arguments.id === "string") {
            this.loadedSkillIds.add(call.arguments.id);
          }
        }
      }
    } else {
      const basePrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
      const prompt =
        opts.hasWorkspace === false
          ? `${basePrompt}\n\nNo workspace folder is open right now, so this is chat-only: do not call edit_file, delete_file, or run_command — answer in conversation instead. If the user wants file edits or commands run, tell them to choose a workspace first (top of the composer).`
          : basePrompt;
      this.messages.push({ role: "system", content: prompt });
    }
    if (opts.initialCheckpointHash) this.checkpointHash = opts.initialCheckpointHash;
  }

  /** A copy of the current conversation history, safe to persist or inspect without risking mutation of the live session. */
  getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  /**
   * Updates the workspace tools resolve paths against, in place — no
   * provider/model involved, so this is safe to call on a live session
   * between tasks (never call it mid-run() — the effect on a tool call
   * already in flight is undefined).
   */
  setWorkspaceRoot(workspaceRoot: string, hasWorkspace = true): void {
    // Final-review finding I1: renderer.ts's applySessionEdits ("Edit
    // settings…") always passes the CURRENT workspaceRoot through to this
    // call, even when the user only changed mode/planFirst and never
    // touched the workspace field — so this must only clear the
    // checkpoint for an ACTUAL path change, or a plain mode-only edit
    // silently wipes Revert/"View changes" with no workspace switch
    // having happened at all.
    const changed = workspaceRoot !== this.opts.workspaceRoot;
    this.opts.workspaceRoot = workspaceRoot;
    if (!changed) return;
    // Security-review finding: hasWorkspace must only ever be promoted on
    // an ACTUAL path change, gated behind the same `changed` check as the
    // checkpoint/skill resets below — never unconditionally. Per the I1
    // comment above, updateLiveSessionSettings calls this on every
    // settings apply, re-sending the session's CURRENT workspaceRoot even
    // when the user only changed mode/planFirst and never touched the
    // workspace field. Setting hasWorkspace = true unconditionally would
    // let that redundant, unrelated re-send silently promote a session
    // that never had a real workspace (the os.homedir() fallback) into
    // one that does — defeating the whole no-workspace guard with no
    // folder ever actually having been chosen. Gating on `changed` means
    // the only way hasWorkspace flips to true is the one real way a user
    // leaves chat-only mode: actually picking a different folder.
    this.opts.hasWorkspace = hasWorkspace;
    // Correctness audit finding (session Medium #3): a checkpoint hash is
    // a commit inside a SPECIFIC git repo — carrying it over into a
    // different workspace would make a later revert try to check out
    // that hash inside the WRONG repo, which almost always throws
    // (unknown revision / not a git repo at all). The old checkpoint is
    // simply inapplicable here, not something to silently keep offering.
    this.checkpointHash = null;
    // Deferred-minor finding M5: loadedSkillIds tracks what's been
    // injected for THIS workspace's own skills — carrying it across a
    // workspace switch would wrongly suppress a different project's
    // user-authored skill that happens to share an id with one already
    // loaded from the PREVIOUS workspace, even though it's genuinely
    // different content the user has never seen or approved here.
    this.loadedSkillIds.clear();
  }

  /** The workspace a checkpoint hash (see getCheckpointHash) needs to be reverted against — reads the same live opts.workspaceRoot setWorkspaceRoot mutates, so this is never stale even after a mid-session workspace edit. */
  getWorkspaceRoot(): string {
    return this.opts.workspaceRoot;
  }

  /** Updates the permission policy in place — same in-place, between-tasks-only contract as setWorkspaceRoot. */
  setPermissionMode(mode: PermissionMode): void {
    this.permissions = new PermissionEngine(mode);
  }

  /** Updates whether the next task's first turn gets held for approval before executing — same in-place, between-tasks-only contract as setWorkspaceRoot/setPermissionMode. */
  setPlanFirst(planFirst: boolean): void {
    this.opts.planFirst = planFirst;
  }

  /** Reads the live permission mode — same never-stale contract as getWorkspaceRoot, so a caller persisting session state (sessionRegistry.ts) always sees the result of the most recent setPermissionMode, not whatever mode the session started with. */
  getPermissionMode(): PermissionMode {
    return this.permissions.getMode();
  }

  /** Reads the live planFirst setting — same never-stale contract as getPermissionMode. */
  getPlanFirst(): boolean {
    return this.opts.planFirst ?? false;
  }

  cancel() {
    this.cancelled = true;
    this.abortController?.abort();
  }

  /** Stops only the CURRENTLY RUNNING task — see the stopRequested field's own doc comment for how this differs from cancel(). No-op if nothing is running (abortController is null between tasks); the caller (sessionRegistry.ts's stopTask) checks entry.inFlightOperation's kind itself before ever reaching this, but a redundant call here is harmless either way. */
  stopCurrentTask() {
    this.stopRequested = true;
    this.abortController?.abort();
  }

  /**
   * Computes a diff for an edit_file call to attach to its permission.request
   * event, so the UI can show a real diff instead of just a filename before
   * the user decides — computed here (before the tool ever runs), not inside
   * editFileTool itself, since the whole point is showing it BEFORE the write
   * happens. Reads the file fresh from disk rather than relying on an earlier
   * read_file result in the conversation, so the diff reflects the file's
   * actual current state even if it changed since the model last read it.
   * Returns undefined for anything that isn't a well-formed edit_file call
   * (including whenever the tool's own execute() would itself refuse it —
   * e.g. a path escaping the workspace root) — the permission-request event
   * just omits `diff` in that case, same as for every non-edit_file call.
   */
  private async computeEditDiffForCall(call: ToolCall) {
    if (call.name !== "edit_file") return undefined;
    const relPath = call.arguments.path;
    const newContent = call.arguments.content;
    if (typeof relPath !== "string" || typeof newContent !== "string") return undefined;
    // Security audit finding (confirmed, medium): naive-workspace-check.
    // This used to be its own inline path.resolve+startsWith check, which
    // workspacePath.ts's own header comment documents as broken (findings
    // H2/M2: no trailing-separator guard, no symlink resolution) — exactly
    // the pattern editFileTool itself was hardened away from. Reusing
    // resolveWithinWorkspace here means a symlink escaping the workspace
    // is refused before this pre-approval diff ever reads anything,
    // matching editFileTool's own containment check exactly.
    const resolved = await resolveWithinWorkspace(this.opts.workspaceRoot, relPath);
    if (!resolved.ok) return undefined;
    const abs = resolved.abs;
    let oldContent: string | null;
    try {
      oldContent = await fs.readFile(abs, "utf8");
    } catch {
      oldContent = null; // doesn't exist yet — the whole new content shows as added
    }
    return computeFileDiff(oldContent, newContent);
  }

  /**
   * An edit_file call is accepted in two shapes: a full `content` (today's
   * existing behavior, unchanged by this method) or `old_string`/`new_string`
   * (a targeted replace, for changing a small part of a large file without
   * regenerating the whole thing). This resolves the second shape into the
   * first — reading the file's current content and computing the full
   * replacement — so every call downstream (permission evaluation, diff
   * computation, the tool's own execute()) only ever has to understand plain
   * `content`. Any call that isn't edit_file, or that already carries a
   * string `content`, passes through completely unchanged.
   */
  private async resolveEditFileCall(call: ToolCall): Promise<{ ok: true; call: ToolCall } | { ok: false; error: string }> {
    if (call.name !== "edit_file") return { ok: true, call };
    const args = call.arguments as Record<string, unknown>;
    if (typeof args.content === "string") return { ok: true, call };
    if (args.old_string === undefined && args.new_string === undefined) {
      return { ok: true, call }; // neither shape supplied — let editFileTool's own validation report the missing content.
    }
    const relPath = args.path;
    const oldString = args.old_string;
    const newString = args.new_string;
    if (typeof relPath !== "string" || typeof oldString !== "string" || typeof newString !== "string") {
      return { ok: false, error: "edit_file's old_string/new_string mode requires path, old_string, and new_string to all be strings." };
    }
    if (isProtectedPath(relPath)) {
      return { ok: false, error: `Refusing to read protected path: ${relPath}` };
    }
    const resolved = await resolveWithinWorkspace(this.opts.workspaceRoot, relPath);
    if (!resolved.ok) {
      return { ok: false, error: resolved.error };
    }
    let existingContent: string;
    try {
      existingContent = await fs.readFile(resolved.abs, "utf8");
    } catch (err: any) {
      return { ok: false, error: `old_string/new_string edit requires an existing file — could not read ${relPath}: ${err.message}` };
    }
    const result = applyOldStringReplace(existingContent, oldString, newString, args.replace_all === true);
    if (!result.ok) {
      return { ok: false, error: `${relPath}: ${result.error}` };
    }
    return { ok: true, call: { ...call, arguments: { ...call.arguments, content: result.newContent } } };
  }

  getState(): AgentState {
    return this.state;
  }

  /**
   * Runtime-enforced grounding: a task naming a real file gets that file read
   * before the model's first turn, regardless of whether the model would have
   * chosen to call read_file itself. Prompt wording alone proved unreliable at
   * getting small/mid local models to read a named file before answering —
   * this makes it happen rather than asking nicely. A candidate that isn't a
   * real file at that path just fails read_file silently and is skipped.
   */
  private async *autoReadNamedFiles(task: string): AsyncGenerator<AgentEvent> {
    const tool = this.opts.tools.get("read_file");
    if (!tool) return;

    for (const relPath of extractFilenameCandidates(task)) {
      if (this.readPaths.has(relPath)) continue;

      const call: ToolCall = { id: `auto_${relPath}`, name: "read_file", arguments: { path: relPath } };
      const result = await tool.execute(call.arguments, {
        workspaceRoot: this.opts.workspaceRoot,
        log: () => {},
      });
      if (!result.ok) continue;

      this.readPaths.add(relPath);
      yield { type: "permission.request", call, decision: "ALLOW" };
      yield { type: "tool.start", call };
      yield { type: "tool.result", call, result };

      this.messages.push({ role: "assistant", content: "", tool_calls: [call] });
      this.messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: "read_file",
        content: JSON.stringify(result).slice(0, 6000),
      });
    }
  }

  /** Final-review finding I1: the old `.slice(0, 6000)` truncated the
   * JSON.stringify'd RESULT, which could cut mid-string and hand the
   * model invalid JSON while the yielded event still showed the whole
   * body — UI and model disagreeing about what actually loaded. Capping
   * the body itself, before it goes into either the event or the
   * message, keeps both in sync and keeps the JSON always valid. */
  private static readonly MAX_SKILL_BODY_CHARS = 6000;

  /**
   * Mirrors autoReadNamedFiles' own shape and call site: runs once per
   * task, before the model's first turn, so a matching skill's guidance
   * is already in context rather than depending on the model to notice
   * and ask for it. Discovery happens fresh every call (user skills can
   * change between tasks; built-in skills are cached inside
   * discoverBuiltinSkills itself) — see skillLoader.ts.
   *
   * Security-review finding C1: a built-in skill ships with the app and
   * can't be planted by a repo, so it auto-loads with no approval. A
   * user-authored skill lives INSIDE the workspace — a cloned or
   * compromised repo could already contain a `.localagent/skills/`
   * file the human never wrote, crafted with a common trigger word so
   * it fires on an ordinary task and feeds the model attacker-chosen
   * "guidance" that looks exactly as authoritative as a real skill (it
   * can even silently override a built-in skill's id — see the override
   * check below). That's a materially different risk than the model
   * merely reading a file's content: a skill is specifically designed
   * to carry imperative authority over the model's behavior, injected
   * before the model's own first turn, with no selection step the user
   * controls. So a user-sourced skill ASKs — the same onApprovalNeeded
   * gate every other consequential action already goes through — with
   * the skill's full (untruncated) body, its triggers, and whether it
   * overrides a built-in skill, all in the call so the approval UI can
   * actually show what's about to be injected. A rejection is recorded
   * in loadedSkillIds too, so the user is never asked about the same
   * skill twice in one session.
   */
  private async *autoLoadSkills(task: string): AsyncGenerator<AgentEvent> {
    const [builtin, user] = await Promise.all([discoverBuiltinSkills(), discoverUserSkills(this.opts.workspaceRoot)]);
    const builtinIds = new Set(builtin.map((s) => s.id));

    // A user-authored skill overrides a built-in skill sharing its id —
    // lets a project customize a built-in skill's guidance without
    // forking the app. Insert built-in first, then user, so user's
    // Map.set() for the same id wins.
    const byId = new Map<string, SkillMetadata>();
    for (const skill of builtin) byId.set(skill.id, skill);
    for (const skill of user) byId.set(skill.id, skill);

    const matches = matchSkills(task, [...byId.values()], this.loadedSkillIds);
    const toLoad = matches.slice(0, MAX_SKILLS_PER_TASK);
    if (matches.length > MAX_SKILLS_PER_TASK) {
      const skipped = matches.slice(MAX_SKILLS_PER_TASK).map((s) => s.id).join(", ");
      console.warn(`[skills] ${matches.length - MAX_SKILLS_PER_TASK} matched skill(s) skipped this task (cap is ${MAX_SKILLS_PER_TASK}): ${skipped}`);
    }

    for (const skill of toLoad) {
      const isUserSourced = skill.source === "user";
      const call: ToolCall = {
        id: `skill_${skill.id}`,
        name: "load_skill",
        arguments: isUserSourced
          ? {
              id: skill.id,
              name: skill.name,
              description: skill.description,
              triggers: skill.triggers,
              body: skill.body,
              source: skill.source,
              overridesBuiltin: builtinIds.has(skill.id),
            }
          : { id: skill.id },
      };

      const decision: PermissionDecision = isUserSourced ? "ASK" : "ALLOW";
      yield { type: "permission.request", call, decision };
      this.messages.push({ role: "assistant", content: "", tool_calls: [call] });

      if (decision === "ASK") {
        const response = this.opts.onApprovalNeeded ? await this.opts.onApprovalNeeded(call) : { approved: false };
        if (!response.approved) {
          // Recorded immediately — a rejected skill isn't asked about
          // again this session either, and there are no further yields
          // for this skill after this point for a cancellation to land
          // between.
          this.loadedSkillIds.add(skill.id);
          this.messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: "load_skill",
            content: JSON.stringify({ ok: false, error: "User rejected loading this project-authored skill." }),
          });
          continue;
        }
      }

      const truncated = skill.body.length > AgentSession.MAX_SKILL_BODY_CHARS;
      const body = truncated ? skill.body.slice(0, AgentSession.MAX_SKILL_BODY_CHARS) : skill.body;
      if (truncated) {
        console.warn(
          `[skills] "${skill.id}"'s body was truncated to ${AgentSession.MAX_SKILL_BODY_CHARS} characters (was ${skill.body.length}) — the model only sees the truncated version.`
        );
      }
      const result = { ok: true, output: { id: skill.id, name: skill.name, body, source: skill.source, truncated } };

      yield { type: "tool.start", call };
      yield { type: "tool.result", call, result };

      this.messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: "load_skill",
        content: JSON.stringify(result),
      });
      // Deferred-minor finding M6: marked loaded only here, AFTER the
      // skill has actually been shown (both yields fired, message
      // pushed) — not earlier, where a cancellation landing between
      // here and the final yield could mark a skill "loaded" that the
      // model never actually saw, permanently suppressing a real retry.
      this.loadedSkillIds.add(skill.id);
    }
  }

  /**
   * Runtime-enforced verification, same principle as autoReadNamedFiles and
   * the corrective nudge above: don't just trust a "done" claim after a
   * write succeeded — actually run the project's own test command, if one
   * can be detected, and let the model see the real result before the task
   * actually finishes. Same spirit as demo.ts's scripted proof ("verified by
   * rerunning math.test.js... only reports success after seeing a real exit
   * code 0"), generalized to real sessions. Goes through the exact same
   * PermissionEngine check as any model-issued run_command call — this
   * never bypasses PLAN mode, ASK, or DENY.
   *
   * Returns true if a verify command was found and actually run (whether it
   * passed or not) — the caller loops back for one more turn either way, so
   * the model reacts to a real result instead of the task ending on an
   * unverified claim. Returns false if no recognizable verify command
   * exists for this workspace, or no run_command tool is registered — a
   * total no-op in both cases, identical to today's behavior.
   */
  private async *autoVerifyAfterEdit(): AsyncGenerator<AgentEvent, boolean> {
    // Mirrors the main dispatch loop's hasWorkspace guard: this only ever
    // runs after a successful WRITE, which the dispatch loop guard already
    // prevents with no real workspace — kept explicit rather than relying
    // on that invariant alone.
    if (this.opts.hasWorkspace === false) return false;
    const command = await detectVerifyCommand(this.opts.workspaceRoot);
    if (!command) return false;
    const tool = this.opts.tools.get("run_command");
    if (!tool) return false;

    const call: ToolCall = { id: `auto_verify_${this.turn}`, name: "run_command", arguments: { command } };
    let decision = this.permissions.evaluate(call, tool.permission, this.opts.workspaceRoot);
    // Security audit finding H3 / final-review Critical #2: detectVerifyCommand's
    // commands all classify as PROJECT_SCRIPT, which evaluate() always
    // answers ASK for from its own stateless perspective — running them
    // means executing this repo's own test-runner script, arbitrary
    // repo-defined code. This override (shared with the main per-call
    // loop above, for a model-issued run_command of the same kind) is
    // what lets it stop asking after the first approval THIS task.
    // isApprovedVerifyCommand() is always true here in practice (`command`
    // only ever comes from detectVerifyCommand's own KNOWN_VERIFY_COMMANDS
    // set), but checking it anyway keeps this call site symmetric with the
    // main loop's — one shared rule, not an implicit invariant that only
    // holds because of where this value happened to come from.
    if (decision === "ASK" && this.projectScriptApprovedThisTask && this.isApprovedVerifyCommand(command)) decision = "ALLOW";
    yield { type: "permission.request", call, decision };
    this.messages.push({ role: "assistant", content: "", tool_calls: [call] });

    if (decision === "DENY") {
      this.messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.name,
        content: JSON.stringify({ ok: false, error: "Permission denied by policy." }),
      });
      return true;
    }
    if (decision === "ASK") {
      const response = this.opts.onApprovalNeeded ? await this.opts.onApprovalNeeded(call) : { approved: false };
      if (!response.approved) {
        this.messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.name,
          content: JSON.stringify({ ok: false, error: "User rejected this action." }),
        });
        return true;
      }
      this.projectScriptApprovedThisTask = true;
    }

    this.state = "EXECUTING_TOOL";
    yield { type: "tool.start", call };
    const result = await tool.execute(call.arguments, { workspaceRoot: this.opts.workspaceRoot, log: () => {}, getGithubToken: this.opts.getGithubToken });
    yield { type: "tool.result", call, result };
    this.messages.push({
      role: "tool",
      tool_call_id: call.id,
      name: call.name,
      content: JSON.stringify(result).slice(0, 6000),
    });
    return true;
  }

  /** The current revert target, if any — the most recent task that actually wrote/executed something in a git workspace. Read by the caller (sessionRegistry) after each run(), not pushed as its own event stream, since it needs to survive independently of whatever events a specific run() happened to yield. */
  getCheckpointHash(): string | null {
    return this.checkpointHash;
  }

  async *run(
    task: string,
    attachments?: { images?: AttachedImage[]; textAttachments?: AttachedText[] }
  ): AsyncGenerator<AgentEvent> {
    this.messages.push({ role: "user", content: task, ...attachments });
    this.opts.provider = this.originalProvider;
    this.opts.model = this.originalModel;
    this.opts.providerLabel = this.originalProviderLabel;
    this.opts.fallbackProviders = this.originalFallbackProviders ? [...this.originalFallbackProviders] : this.originalFallbackProviders;
    this.state = "THINKING";
    this.checkpointAttemptedThisTask = false;
    this.projectScriptApprovedThisTask = false;
    this.wroteThisTask = false;
    this.anyWriteSucceededThisTask = false;
    this.writeSucceededSinceLastVerify = false;
    this.correctiveNudgeAttemptsThisTask = 0;
    this.planProposedThisTask = false;
    this.stopRequested = false;
    this.abortController = new AbortController();
    yield* this.autoReadNamedFiles(task);
    yield* this.autoLoadSkills(task);
    const maxTurns = this.opts.maxTurns ?? 25;

    while (!this.cancelled && !this.stopRequested) {
      if (this.turn >= maxTurns) {
        this.state = "FAILED";
        yield { type: "error", message: `Stopped: exceeded max turns (${maxTurns}).` };
        yield { type: "done", success: false, summary: "Turn budget exceeded." };
        return;
      }

      yield { type: "status", message: `Turn ${this.turn + 1}: thinking...` };

      let response;
      let streamedAnything = false;
      try {
        if (this.opts.provider.chatStream) {
          let gotDone: ChatResponse | undefined;
          for await (const streamEvent of this.opts.provider.chatStream({
            model: this.opts.model,
            messages: this.messages,
            tools: this.opts.tools.toSchema(),
            signal: this.abortController.signal,
          })) {
            if (streamEvent.type === "done") {
              gotDone = streamEvent.response;
              break;
            }
            if (streamEvent.type === "text") {
              streamedAnything = true;
              yield { type: "text.delta", text: streamEvent.text };
            } else if (streamEvent.type === "tool_call_start") {
              streamedAnything = true;
              yield { type: "tool_call.start", index: streamEvent.index, name: streamEvent.name };
            } else if (streamEvent.type === "tool_call_delta") {
              streamedAnything = true;
              yield { type: "tool_call.delta", index: streamEvent.index, argumentsDelta: streamEvent.argumentsDelta };
            } else if (streamEvent.type === "reset") {
              streamedAnything = true;
              yield { type: "stream.reset" };
            } else if (streamEvent.type === "perf") {
              // Deliberately does NOT set streamedAnything — this is an
              // ambient speed/context readout with no visible partial
              // text/tool-card state of its own, so a provider-fallback
              // retry's stream.reset (which only exists to clear THAT
              // kind of state) has nothing here to clear.
              yield { type: "perf", tokensPerSecond: streamEvent.tokensPerSecond, contextUsedTokens: streamEvent.contextUsedTokens, contextSizeTokens: streamEvent.contextSizeTokens };
            }
          }
          if (!gotDone) throw new Error("Provider's chatStream ended without a final 'done' event.");
          response = gotDone;
        } else {
          response = await this.opts.provider.chat({
            model: this.opts.model,
            messages: this.messages,
            tools: this.opts.tools.toSchema(),
            signal: this.abortController.signal,
          });
        }
      } catch (err: any) {
        // The in-flight call was deliberately aborted by cancel()/
        // stopCurrentTask(), not a real provider failure — fall through to
        // the loop's own exit instead of reporting it as one. Checked
        // before the retryable-fallback branch below: a provider that
        // reports an abort as some generic retryable error must not
        // trigger a fallback retry for a task the user just asked to stop.
        if (this.cancelled || this.stopRequested) break;
        if (err instanceof ProviderChatError && err.retryable && this.opts.fallbackProviders?.length) {
          if (streamedAnything) yield { type: "stream.reset" };
          const next = this.opts.fallbackProviders.shift()!;
          const fromLabel = this.opts.providerLabel ?? "the current provider";
          yield { type: "status", message: `${fromLabel} hit a rate limit — retrying on ${next.label}...` };
          this.opts.provider = next.provider;
          this.opts.model = next.model;
          this.opts.providerLabel = next.label;
          continue;
        }
        this.state = "FAILED";
        yield { type: "error", message: `Model provider error: ${err.message}` };
        yield { type: "done", success: false, summary: "Provider error." };
        return;
      }

      if (!this.gpuStatusReported) {
        this.gpuStatusReported = true;
        const gpuStatus = (this.opts.provider as { gpuStatus?: string }).gpuStatus;
        if (typeof gpuStatus === "string") yield { type: "status", message: gpuStatus };
      }

      // Reported unconditionally whenever the provider's response carries
      // real token counts (only AnthropicProvider does today) — the call
      // already happened and already cost whatever it cost by this point,
      // regardless of whether planFirst is about to gate what happens next
      // or whether this turn is final or a tool_calls turn.
      if (response.usage) {
        yield { type: "usage", model: this.opts.model, inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens };
      }

      // User-reported UX finding: a small GGUF model mis-flagging its own
      // <tool_call> control token streams what looks like prose, which
      // then vanishes (embeddedLlama.ts's stream.reset) the instant a
      // tool card appears in its place — with nothing explaining why.
      // AssistantTurn.recoveredFromTextFallback (set only by
      // embeddedLlama.ts's tryParseFallbackToolCall recovery path) is
      // the one signal that this just happened; surfacing it here means
      // this works for both chat() and chatStream(), since both run
      // through fromLlamaResult.
      if (response.turn.type === "tool_calls" && response.turn.recoveredFromTextFallback) {
        yield { type: "status", message: "Recovered a tool call the model didn't flag correctly — continuing normally." };
      }

      // Holds the task's very first turn for approval before any of it
      // runs — deliberately not a separate "plan-only, don't call tools
      // yet" turn: prompting a model to withhold tool calls proved
      // unreliable elsewhere in this file (see the corrective-nudge
      // comment below), so instead of fighting that, this intercepts
      // whatever the model naturally proposes first — a batch of tool
      // calls, or a direct text answer — and shows exactly that as the
      // plan. Approving falls through to process this SAME response
      // normally (no re-fetch); rejecting ends the task with nothing
      // executed and nothing added to history. Only gates turn 1 — once
      // a task's plan is approved, its later turns are ungated.
      if (this.opts.planFirst && !this.planProposedThisTask) {
        this.planProposedThisTask = true;
        const plan: ProposedPlan =
          response.turn.type === "tool_calls"
            ? { kind: "tool_calls", toolCalls: response.turn.toolCalls, content: response.turn.content }
            : { kind: "text", content: response.turn.content };
        yield { type: "plan.proposed", plan };
        const approved = this.opts.onPlanApprovalNeeded ? await this.opts.onPlanApprovalNeeded(plan) : false;
        if (!approved) {
          // A deliberate user decision, not an error — same "declined,
          // not failed" spirit as a cancelled task, hence this state
          // rather than FAILED (reserved for real errors elsewhere in
          // this loop: max-turns-exceeded, a provider error).
          this.state = "CANCELLED";
          yield { type: "done", success: false, summary: "Plan rejected — nothing was changed." };
          return;
        }
      }

      if (response.turn.type === "final") {
        // Runtime-enforced correction, same principle as autoReadNamedFiles
        // above: prompt wording alone proved unreliable at stopping a small
        // local model from answering a "create/build/design X" task with
        // the code written out in prose instead of real edit_file calls
        // (verified live — the model repeated this exact failure even with
        // an explicit system-prompt rule against it). Retried up to
        // MAX_CORRECTIVE_NUDGE_ATTEMPTS times (not just once — a single
        // nudge verified live as still sometimes ignored by a reluctant
        // model, which then complied on a later attempt), and only when
        // the model never even tried to write — if it tried and got
        // denied, that's a real policy decision to respect, not this
        // failure mode.
        if (
          this.correctiveNudgeAttemptsThisTask < MAX_CORRECTIVE_NUDGE_ATTEMPTS &&
          !this.wroteThisTask &&
          taskImpliesCreation(task) &&
          containsFencedCode(response.turn.content)
        ) {
          this.correctiveNudgeAttemptsThisTask++;
          this.messages.push({ role: "assistant", content: response.turn.content });
          this.messages.push({ role: "user", content: correctiveNudgeMessage(this.correctiveNudgeAttemptsThisTask) });
          yield {
            type: "status",
            message: `Turn produced code without writing it — nudging the model to call edit_file instead (attempt ${this.correctiveNudgeAttemptsThisTask}/${MAX_CORRECTIVE_NUDGE_ATTEMPTS}).`,
          };
          this.turn++;
          this.state = "THINKING";
          continue;
        }

        this.messages.push({ role: "assistant", content: response.turn.content });
        yield { type: "text", text: response.turn.content };

        if (this.writeSucceededSinceLastVerify) {
          this.writeSucceededSinceLastVerify = false;
          const verified = yield* this.autoVerifyAfterEdit();
          if (verified) {
            this.turn++;
            this.state = "THINKING";
            continue;
          }
        }

        this.state = "COMPLETED";
        // A task whose corrective nudge fired at least once (the model was
        // explicitly told to call edit_file instead of describing files)
        // and which STILL never got a single successful write this task
        // didn't actually do what it claimed — verified live: a small model
        // can apologize in prose right back instead of complying, and that
        // used to still report success:true with nothing ever written.
        const nudgeFailedToProduceAWrite = this.correctiveNudgeAttemptsThisTask > 0 && !this.anyWriteSucceededThisTask;
        yield nudgeFailedToProduceAWrite
          ? {
              type: "done",
              success: false,
              summary: "The model described changes but never actually wrote them, even after being asked to. Nothing was changed.",
            }
          : { type: "done", success: true, summary: response.turn.content };
        return;
      }

      // tool_calls branch
      this.messages.push({
        role: "assistant",
        content: response.turn.content ?? "",
        tool_calls: response.turn.toolCalls,
      });
      // Tool-call ids aren't guaranteed unique across turns (the embedded
      // provider mints them as call_0, call_1, ... reset per turn), so the
      // backfill below must only look at replies pushed for *this* turn —
      // scanning the whole history would treat a same-numbered id answered
      // in an earlier turn as already answering this turn's call too.
      const turnRepliesStart = this.messages.length;

      for (const rawCall of response.turn.toolCalls) {
        if (this.cancelled || this.stopRequested) break;
        // An edit_file call carrying old_string/new_string instead of content
        // is resolved to a full content HERE, before permission evaluation or
        // diff computation ever see it — both of those (and the tool's own
        // execute()) only ever need to understand one shape of edit_file call,
        // the existing full-content one. Resolution fails CLOSED: a missing
        // file or an ambiguous/absent old_string match is reported as a tool
        // error with no permission prompt, never silently falls back to some
        // other behavior.
        const resolution = await this.resolveEditFileCall(rawCall);
        if (!resolution.ok) {
          yield { type: "tool.start", call: rawCall };
          const result = { ok: false as const, output: null, error: resolution.error };
          yield { type: "tool.result", call: rawCall, result };
          this.messages.push({
            role: "tool",
            tool_call_id: rawCall.id,
            name: rawCall.name,
            content: JSON.stringify(result),
          });
          continue;
        }
        const call = resolution.call;
        const tool = this.opts.tools.get(call.name);
        if (!tool) {
          // Live-tested regression (see loadSkill.ts's doc comment): a
          // model imitating the auto-injected load_skill pattern it just
          // saw in its OWN history gets a graceful, VISIBLE answer here
          // — unlike a genuine unknown-tool hallucination (silent, no
          // events, below), this case is worth showing: if a model does
          // end up calling it, the user should be able to see that
          // happened and what it got back, not have it vanish into the
          // message history with no trace. load_skill is deliberately
          // never registered in the tool registry, so a model never
          // sees it as an option to choose on a task where no skill
          // matched at all (the actual cause of the regression this
          // replaced).
          if (call.name === "load_skill") {
            const result = { ok: true, output: { message: LOAD_SKILL_FALLBACK_MESSAGE } };
            yield { type: "tool.start", call };
            yield { type: "tool.result", call, result };
            this.messages.push({
              role: "tool",
              tool_call_id: call.id,
              name: call.name,
              content: JSON.stringify(result),
            });
            continue;
          }
          this.messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: call.name,
            content: JSON.stringify({ ok: false, error: `Unknown tool: ${call.name}` }),
          });
          continue;
        }

        // No real workspace was ever chosen (see hasWorkspace's doc comment
        // on AgentSessionOptions) — refuse outright, before any diff is
        // computed or approval is offered. READ tools (read_file,
        // list_directory, grep) still work: they're harmless without a
        // real project root and the demo UI already relies on them
        // (e.g. list_directory) answering fine with no workspace selected.
        if (tool.permission !== "READ" && this.opts.hasWorkspace === false) {
          yield { type: "permission.request", call, decision: "DENY" };
          this.messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: call.name,
            content: JSON.stringify({
              ok: false,
              error: "No workspace is open — choose a folder (top of the composer) before I can edit files or run commands.",
            }),
          });
          continue;
        }

        if (call.name === "read_file" && typeof call.arguments.path === "string") {
          this.readPaths.add(call.arguments.path);
        }
        // One checkpoint per task, taken before the FIRST tool call this
        // task that isn't pure READ — regardless of what decision that call
        // ends up getting (ALLOW/ASK/DENY), same principle as the diff
        // above: capture proactively, before the outcome is known, so it's
        // already in place if the call (or a later one this same task)
        // does end up allowed. A task that only ever reads never takes one.
        if (!this.checkpointAttemptedThisTask && tool.permission !== "READ") {
          this.checkpointAttemptedThisTask = true;
          const hash = await createCheckpoint(this.opts.workspaceRoot);
          if (hash) {
            this.checkpointHash = hash;
            yield { type: "checkpoint.created", checkpointHash: hash };
          } else {
            // Functional-correctness audit finding (agent core High #2):
            // this task is about to write real changes (that's why a
            // checkpoint was attempted at all), but the attempt itself
            // failed — leaving the PREVIOUS task's hash in place would
            // make "revert this task" silently discard that earlier
            // task's work too, with a success message that's factually
            // wrong about what got reverted. Clearing it makes the revert
            // affordance correctly unavailable for this task instead.
            this.checkpointHash = null;
          }
        }

        let decision = this.permissions.evaluate(call, tool.permission, this.opts.workspaceRoot);
        if (
          decision === "ALLOW" &&
          call.name === "edit_file" &&
          typeof call.arguments.path === "string" &&
          !this.readPaths.has(call.arguments.path)
        ) {
          // A model can fabricate a whole-file rewrite instead of grounding in the
          // real content — never let that auto-apply unreviewed, even in modes that
          // otherwise auto-allow writes.
          decision = "ASK";
        }
        // Final review Critical #2: permissions.ts's own evaluate() always
        // returns ASK for a PROJECT_SCRIPT command (running a repo's own
        // test runner) — this is the once-per-task override that lets a
        // MODEL-issued run_command("npm test") stop asking after the
        // first approval this task, same memo autoVerifyAfterEdit shares
        // below. Without this, the model's own direct call was the one
        // path the original H3 fix never covered.
        //
        // Code-review finding (see projectScriptApprovedThisTask's own doc
        // comment): this used to gate on classifyCommand's PROJECT_SCRIPT
        // *category* plus hasShellMetacharacters/hasEscapingArguments —
        // which stops shell-metacharacter injection ("npm test; rm -rf ~")
        // but not flag injection ("npm test --script-shell=./x.sh",
        // "pytest -p evilplugin"), both of which classify as PROJECT_SCRIPT
        // with no metacharacters and no escaping-argument shape. Requiring
        // an exact match against KNOWN_VERIFY_COMMANDS instead closes that
        // gap outright — a flag-injected variant simply isn't an exact
        // match, full stop, regardless of what shape the injection takes.
        if (decision === "ASK" && call.name === "run_command" && this.projectScriptApprovedThisTask && this.isApprovedVerifyCommand(String(call.arguments.command ?? ""))) {
          decision = "ALLOW";
        }
        const diff = await this.computeEditDiffForCall(call);
        yield diff ? { type: "permission.request", call, decision, diff } : { type: "permission.request", call, decision };

        if (decision === "DENY") {
          if (tool.permission === "WRITE") this.wroteThisTask = true;
          this.messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: call.name,
            content: JSON.stringify({ ok: false, error: "Permission denied by policy." }),
          });
          continue;
        }

        let effectiveCall = call;
        if (decision === "ASK") {
          const response = this.opts.onApprovalNeeded ? await this.opts.onApprovalNeeded(call) : { approved: false };
          if (!response.approved) {
            if (tool.permission === "WRITE") this.wroteThisTask = true;
            this.messages.push({
              role: "tool",
              tool_call_id: call.id,
              name: call.name,
              content: JSON.stringify({ ok: false, error: "User rejected this action." }),
            });
            continue;
          }
          // Only an exact KNOWN_VERIFY_COMMANDS match sets the memo —
          // approving a flag-carrying variant once (e.g. "npm test
          // --coverage") does NOT unlock "don't ask again" for anything,
          // the same narrow trust boundary isApprovedVerifyCommand()
          // enforces everywhere else.
          if (call.name === "run_command" && this.isApprovedVerifyCommand(String(call.arguments.command ?? ""))) {
            this.projectScriptApprovedThisTask = true;
          }
          // A genuinely PARTIAL hunk selection rewrites the arguments actually
          // handed to tool.execute below — the model's own turn history (the
          // assistant message with its original tool_calls, already pushed
          // above the per-call loop) is never touched. A full approval (no
          // approvedHunkIds, or one covering every hunk) leaves effectiveCall
          // exactly equal to call — byte-for-byte today's existing behavior.
          if (call.name === "edit_file" && diff && response.approvedHunkIds) {
            const segments = groupDiffIntoSegments(diff);
            const allHunkIds = new Set(segments.filter((s) => s.kind === "hunk").map((s) => (s.kind === "hunk" ? s.id : -1)));
            const approvedSet = new Set(response.approvedHunkIds);
            const isPartial = [...allHunkIds].some((id) => !approvedSet.has(id));
            if (isPartial) {
              // diff is only ever set (see computeEditDiffForCall) once
              // call.arguments.path is already confirmed to be a string, so
              // this branch is structurally unreachable today — it exists so
              // that IF that invariant is ever violated, a partial selection
              // fails CLOSED (denies the call) instead of silently falling
              // through to executing the model's full, unapproved content.
              if (typeof call.arguments.path !== "string") {
                this.messages.push({
                  role: "tool",
                  tool_call_id: call.id,
                  name: call.name,
                  content: JSON.stringify({ ok: false, error: "Could not determine which content to write for a partial approval." }),
                });
                continue;
              }
              const mergedContent = applyHunkSelection(segments, approvedSet);
              effectiveCall = { ...call, arguments: { ...call.arguments, content: mergedContent } };
              yield {
                type: "status",
                message: `Applying ${approvedSet.size} of ${allHunkIds.size} proposed changes to ${call.arguments.path} — the rest were left as-is.`,
              };
            }
          }
        }

        this.state = "EXECUTING_TOOL";
        yield { type: "tool.start", call };
        const result = await tool.execute(effectiveCall.arguments, {
          workspaceRoot: this.opts.workspaceRoot,
          getGithubToken: this.opts.getGithubToken,
          log: (msg) => {
            /* forwarded via tool.result event below */
            void msg;
          },
        });
        yield { type: "tool.result", call, result };
        // A write that actually succeeded clears any earlier denial's grace
        // period — the model has now demonstrably completed a real write
        // this task, so a LATER final turn describing yet more files in
        // prose deserves a fresh nudge, not leftover suppression from an
        // unrelated earlier denial.
        if (tool.permission === "WRITE" && result.ok) {
          this.wroteThisTask = false;
          this.anyWriteSucceededThisTask = true;
          this.writeSucceededSinceLastVerify = true;
        }

        this.messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.name,
          content: JSON.stringify(result).slice(0, 6000),
        });
      }

      // If cancellation broke the loop above before every tool call got a
      // reply, the assistant message already pushed for this turn still
      // references all of response.turn.toolCalls — an unanswered
      // tool_calls entry makes the persisted history invalid for a strict
      // provider (Anthropic rejects tool_use with no matching tool_result)
      // if this session is ever resumed. Backfill a synthetic reply for
      // anything left unanswered, looking only at this turn's own replies.
      const answeredCallIds = new Set(
        this.messages
          .slice(turnRepliesStart)
          .filter((m) => m.role === "tool" && m.tool_call_id)
          .map((m) => m.tool_call_id)
      );
      for (const call of response.turn.toolCalls) {
        if (answeredCallIds.has(call.id)) continue;
        this.messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.name,
          content: JSON.stringify({ ok: false, error: "Cancelled before execution." }),
        });
      }

      this.turn++;
      this.state = "THINKING";
    }

    this.state = "CANCELLED";
    yield { type: "done", success: false, summary: "Cancelled by user." };
  }
}
