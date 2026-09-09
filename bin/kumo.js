#!/usr/bin/env node

/**
 * bin/kumo.js — Executable entrypoint for Kumo CLI (雲).
 */

import { createCli } from "../src/cli.js";

const cli = createCli();
cli.parse(process.argv);
