/**
 * banner.js — Command to preview and display the KUMO Cloud Cumulus banner.
 */

import { getBanner, c, separator } from "../utils/ui.js";
import { VERSION } from "../version.js";

export function bannerCommand() {
  console.log(`\n${c.bold}KUMO Cloud Banner${c.reset}\n`);
  console.log(separator(60));
  console.log(getBanner(VERSION, "cloud"));
  console.log(separator(60) + "\n");
}
