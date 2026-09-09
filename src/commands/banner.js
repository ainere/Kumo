/**
 * banner.js — Command to preview and display the KUMO Cloud Cumulus banner.
 */

import { BANNER_DESIGNS, getBanner, c, separator } from "../utils/ui.js";

export function bannerCommand() {
  console.log(`\n${c.bold}KUMO Cloud Banner${c.reset}\n`);
  console.log(separator(60));
  console.log(getBanner("1.0.0", "cloud"));
  console.log(separator(60) + "\n");
}
