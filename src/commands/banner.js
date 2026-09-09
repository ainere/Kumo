/**
 * banner.js — Command to preview, list, and switch KUMO banner styles.
 */

import { loadConfig, setConfigValue } from "../config/settings.js";
import { BANNER_DESIGNS, getBanner, c, badge, separator } from "../utils/ui.js";

export function bannerCommand(targetStyle) {
  const config = loadConfig();
  const currentStyle = config.bannerStyle || "cloud";

  // If style name is provided, switch to it
  if (targetStyle && targetStyle !== "list" && targetStyle !== "show") {
    const key = targetStyle.toLowerCase();
    if (!BANNER_DESIGNS[key]) {
      console.error(`${badge.fail} Unknown banner style '${targetStyle}'.`);
      console.log(`Available styles: ${Object.keys(BANNER_DESIGNS).join(", ")}`);
      process.exit(1);
    }

    setConfigValue("bannerStyle", key);
    console.log(`\n${badge.ok} Switched banner style to: ${c.bold}${key}${c.reset} (${BANNER_DESIGNS[key].name})\n`);
    console.log(getBanner("1.0.0", key));
    console.log("");
    return;
  }

  // Otherwise, showcase all available styles with preview
  console.log(`\n${c.bold}KUMO Cloud Banner Showcase & Selection${c.reset}`);
  console.log(`${c.dim}Current active style:${c.reset} ${c.brightGreen}${currentStyle}${c.reset}\n`);

  for (const [key, design] of Object.entries(BANNER_DESIGNS)) {
    const isCurrent = key === currentStyle;
    const marker = isCurrent ? `${c.brightGreen}[ACTIVE] ` : "         ";
    console.log(separator(60));
    console.log(`${marker}${c.bold}${c.brightCyan}${key}${c.reset} — ${design.name}`);
    console.log(`         ${c.dim}${design.description}${c.reset}\n`);
    console.log(design.render("1.0.0"));
    console.log("");
  }

  console.log(separator(60));
  console.log(`\n${c.bold}To select a design:${c.reset}`);
  console.log(`  ${c.dim}kumo banner <style-name>${c.reset}    (e.g., kumo banner cloud, kumo banner cloud-cumulus, kumo banner cloud-kanji)\n`);
}
