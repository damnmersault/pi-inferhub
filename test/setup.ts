import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests must never read the developer's real config: a
// ~/.pi/agent/pi-inferhub.json with publishUpstream:true would silently change
// what the default config loader returns and break otherwise-correct
// assertions. Point PI_AGENT_DIR at a throwaway dir for the whole suite.
process.env.PI_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-inferhub-test-agent-"));
