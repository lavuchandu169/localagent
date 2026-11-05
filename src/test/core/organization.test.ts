import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadOrganization, saveOrganization, emptyOrganization, type Organization } from "../../organization.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

async function main() {
  console.log("emptyOrganization:");
  {
    const org = emptyOrganization();
    check("starts with an empty goal", org.goal === "");
    check("starts with no roles", org.roles.length === 0);
    check("starts with no initiatives", org.initiatives.length === 0);
  }

  console.log("\nloadOrganization: a workspace with no organization.json at all (the common case):");
  {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-org-test-"));
    const org = await loadOrganization(root);
    check("returns an empty organization, not an error", org.goal === "" && org.roles.length === 0 && org.initiatives.length === 0);
    await fs.rm(root, { recursive: true, force: true });
  }

  console.log("\nsaveOrganization + loadOrganization: round-trips exactly:");
  {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-org-test-"));
    const org: Organization = {
      goal: "Ship localagent v1.0 and grow real users",
      roles: [
        { id: "r-ceo", title: "CEO", responsibilities: "Sets priorities, reviews progress", reportsTo: null, model: "claude-sonnet-5" },
        { id: "r-cto", title: "CTO", responsibilities: "Architecture, code review", reportsTo: "r-ceo", model: "claude-opus-5" },
        { id: "r-eng-1", title: "Engineer", responsibilities: "Implements features", reportsTo: "r-cto", model: "qwen-coder-7b" },
      ],
      initiatives: [
        { id: "i-1", title: "Add dark-mode toggle", assignedRoleId: "r-eng-1", status: "todo", notes: "" },
        { id: "i-2", title: "Write the Q1 roadmap", assignedRoleId: "r-ceo", status: "in-progress", notes: "Draft started" },
      ],
    };
    const saveResult = await saveOrganization(root, org);
    check("save reports ok", saveResult.ok === true);

    const loaded = await loadOrganization(root);
    check("goal round-trips", loaded.goal === org.goal);
    check("role count round-trips", loaded.roles.length === 3);
    check("every role field round-trips", JSON.stringify(loaded.roles) === JSON.stringify(org.roles));
    check("initiative count round-trips", loaded.initiatives.length === 2);
    check("every initiative field round-trips", JSON.stringify(loaded.initiatives) === JSON.stringify(org.initiatives));

    const raw = await fs.readFile(path.join(root, ".localagent", "organization.json"), "utf8");
    check("the file on disk is valid, parseable JSON", (() => {
      try {
        JSON.parse(raw);
        return true;
      } catch {
        return false;
      }
    })());

    const entries = await fs.readdir(path.join(root, ".localagent"));
    check("no stray temp file left behind after a successful save", !entries.some((e) => e.includes(".tmp")));

    await fs.rm(root, { recursive: true, force: true });
  }

  console.log("\nloadOrganization: malformed JSON on disk degrades to empty, not a throw:");
  {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-org-test-"));
    await fs.mkdir(path.join(root, ".localagent"), { recursive: true });
    await fs.writeFile(path.join(root, ".localagent", "organization.json"), "{ this is not valid json", "utf8");
    const org = await loadOrganization(root);
    check("returns an empty organization rather than throwing", org.goal === "" && org.roles.length === 0 && org.initiatives.length === 0);
    await fs.rm(root, { recursive: true, force: true });
  }

  console.log("\nloadOrganization: valid JSON but the wrong shape degrades to empty, not a throw:");
  {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-org-test-"));
    await fs.mkdir(path.join(root, ".localagent"), { recursive: true });
    await fs.writeFile(path.join(root, ".localagent", "organization.json"), JSON.stringify({ goal: 12345, roles: "not an array" }), "utf8");
    const org = await loadOrganization(root);
    check("returns an empty organization rather than throwing or crashing", org.goal === "" && org.roles.length === 0 && org.initiatives.length === 0);
    await fs.rm(root, { recursive: true, force: true });
  }

  console.log("\nsaveOrganization: creates the .localagent directory if it doesn't exist yet:");
  {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-org-test-"));
    const result = await saveOrganization(root, { goal: "test", roles: [], initiatives: [] });
    check("save succeeds even with no pre-existing .localagent dir", result.ok === true);
    const stat = await fs.stat(path.join(root, ".localagent", "organization.json"));
    check("the file now exists", stat.isFile());
    await fs.rm(root, { recursive: true, force: true });
  }

  console.log("\nsaveOrganization: a genuinely unwritable target reports a clean error, not a throw:");
  {
    // A path through a FILE (not a directory) can never be written into —
    // a reliable, portable way to force a real write failure without
    // relying on filesystem permissions, which behave inconsistently
    // across CI environments and macOS/Linux.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "localagent-org-test-"));
    await fs.writeFile(path.join(root, ".localagent"), "this is a file, not a directory", "utf8");
    const result = await saveOrganization(root, { goal: "test", roles: [], initiatives: [] });
    check("save reports ok: false instead of throwing", result.ok === false);
    check("the error is non-empty", result.ok === false && !!result.error);
    await fs.rm(root, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
