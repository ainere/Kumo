#!/usr/bin/env node

/**
 * bin/orchestrator.js — Executable entrypoint for the Orchestrator CLI.
 */

import { createCli } from "../src/cli.js";

const cli = createCli();
cli.parse(process.argv);
