/**
 * graph.js — CLI command to inspect Graphify knowledge graph freshness and lifecycle.
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { c, badge, separator } from "../utils/ui.js";

/**
 * Inspect graphify-out/ freshness in the target workspace.
 */
export function inspectGraph(targetDir) {
  const graphDir = path.join(targetDir, "graphify-out");
  const graphJson = path.join(graphDir, "graph.json");
  const reportMd = path.join(graphDir, "GRAPH_REPORT.md");

  if (!fs.existsSync(graphJson)) {
    return {
      exists: false,
      graphDir,
      graphJson,
      reportMd,
      stale: false,
      reason: "No graphify-out/graph.json found in workspace.",
    };
  }

  const stat = fs.statSync(graphJson);
  const graphMtime = stat.mtime;

  let nodeCount = 0;
  let edgeCount = 0;
  try {
    const data = JSON.parse(fs.readFileSync(graphJson, "utf-8"));
    if (data && Array.isArray(data.nodes)) nodeCount = data.nodes.length;
    if (data && Array.isArray(data.edges)) edgeCount = data.edges.length;
  } catch {
    /* ignore json parse errors */
  }

  // Check git commit timestamp if workspace is a git repo
  let latestCommit = null;
  let isStale = false;
  try {
    const gitOut = execSync("git log -1 --format=%ct|%h|%s", {
      cwd: targetDir,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    }).trim();

    if (gitOut) {
      const [timestampSec, hash, subject] = gitOut.split("|");
      const commitDate = new Date(parseInt(timestampSec, 10) * 1000);
      latestCommit = {
        hash,
        subject,
        date: commitDate,
      };

      // If latest commit is newer than graph.json by more than 60 seconds
      if (commitDate.getTime() - graphMtime.getTime() > 60000) {
        isStale = true;
      }
    }
  } catch {
    /* not a git repository or git command unavailable */
  }

  return {
    exists: true,
    graphDir,
    graphJson,
    reportMd,
    graphMtime,
    nodeCount,
    edgeCount,
    latestCommit,
    stale: isStale,
  };
}

export async function graphCommand(opts = {}) {
  const targetDir = path.resolve(opts.dir || process.cwd());

  console.log(`\n${c.bold}Graphify Knowledge Graph Status${c.reset}`);
  console.log(separator(50));
  console.log(`  ${c.dim}Workspace:${c.reset} ${targetDir}\n`);

  const info = inspectGraph(targetDir);

  // --refresh: print regeneration instructions and exit
  if (opts.refresh) {
    console.log(`  ${c.cyan}To regenerate the Graphify knowledge graph:${c.reset}`);
    console.log(`    Run ${c.bold}graphify${c.reset} in the workspace directory if installed.`);
    console.log(`    This will rebuild ${c.dim}graphify-out/graph.json${c.reset} and ${c.dim}GRAPH_REPORT.md${c.reset}.\n`);
    return info;
  }

  if (opts.json) {
    console.log(JSON.stringify(info, null, 2));
    return info;
  }

  if (!info.exists) {
    console.log(`  ${badge.warn} ${c.yellow}No Graphify knowledge graph found in this workspace.${c.reset}`);
    console.log(`  ${c.dim}Expected: ${info.graphJson}${c.reset}\n`);
    console.log(`  ${c.cyan}To generate a knowledge graph:${c.reset}`);
    console.log(`    Run ${c.bold}graphify${c.reset} in this directory if the toolchain is installed.\n`);
    // --check: exit 1 if no graph exists
    if (opts.check) process.exitCode = 1;
    return info;
  }

  const dateStr = info.graphMtime.toLocaleString();
  console.log(`  ${badge.ok} Graph file found: ${c.dim}${info.graphJson}${c.reset}`);
  console.log(`  ${c.dim}Last Generated:${c.reset} ${dateStr}`);
  if (info.nodeCount || info.edgeCount) {
    console.log(`  ${c.dim}Elements:${c.reset}       ${info.nodeCount} nodes, ${info.edgeCount} edges`);
  }

  if (info.stale && info.latestCommit) {
    console.log(`\n  ${badge.warn} ${c.yellow}Graph is STALE compared to latest commit (${info.latestCommit.hash}):${c.reset}`);
    console.log(`    Commit Date: ${info.latestCommit.date.toLocaleString()}`);
    console.log(`    Message:     ${info.latestCommit.subject}`);
    console.log(`  ${c.dim}Warning: Active symbols or call paths may have changed. Verify against source code.${c.reset}\n`);
    // --check: exit 1 if stale
    if (opts.check) process.exitCode = 1;
  } else if (info.latestCommit) {
    console.log(`  ${badge.ok} ${c.green}Graph is FRESH (newer than commit ${info.latestCommit.hash}).${c.reset}\n`);
  } else {
    console.log(`  ${badge.info} Graph timestamp: ${dateStr}\n`);
  }

  return info;
}
