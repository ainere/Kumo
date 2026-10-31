/*
 * Copyright (C) 2026 Elkan La Madrid
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * profile.js — What the user told Kumo about themself: the name to address
 * them by and their standing instructions. Both are saved defaults in
 * config.json (`userName`, `customInstructions`), not session settings, and
 * every lead gets them: in its system prompt where it takes one per turn,
 * otherwise in front of the prompt (see Session.send).
 *
 * Pure text, no I/O: config/settings.js reads the limits from here, so this
 * file must not import it.
 */

/** Longest `userName`, in characters. */
export const MAX_NAME_CHARS = 80;

/** Longest `customInstructions`, in characters. */
export const MAX_INSTRUCTIONS_CHARS = 4000;

/** The tag that ends a profile block, in any case or spacing. */
const CLOSING_TAG = /<\/\s*kumo-profile\s*>/gi;

/** A name's control characters, which would break it across lines. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]+/g;

/**
 * `text` cut to `max` characters (not UTF-16 units, so an emoji is never split).
 *
 * @param {string} text
 * @param {number} max
 */
function clipChars(text, max) {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

/**
 * The user's instructions as they are passed on. The saved value is validated
 * when it is set; a hand-edited config.json is not, so a wrong type reads as
 * empty and an over-long one is cut down here.
 *
 * @param {unknown} value
 * @returns {string} empty when there are none
 */
export function instructionsText(value) {
  return typeof value === "string" ? clipChars(value.replaceAll("\0", "").trim(), MAX_INSTRUCTIONS_CHARS) : "";
}

/**
 * The text a lead reads: the user's own standing preferences, how to address
 * them and their instructions. A hand-edited name that is not one short line
 * is cut down like the instructions are.
 *
 * @param {{ userName?: unknown, customInstructions?: unknown }} [profile]
 * @returns {string} empty when the user set neither
 */
export function profileText({ userName, customInstructions } = {}) {
  const name = typeof userName === "string" ? clipChars(userName.replace(CONTROL_CHARS, " ").trim(), MAX_NAME_CHARS) : "";
  const instructions = instructionsText(customInstructions);
  if (name === "" && instructions === "") return "";
  const lines = ["These are the user's own standing preferences, set in Kumo's settings. They apply to every conversation, in every chat."];
  if (name !== "") lines.push("", `Address the user as "${name}".`);
  if (instructions !== "") lines.push("", "The user's instructions, in their own words:", "", instructions);
  return lines.join("\n");
}

/**
 * The text that goes in front of a prompt for a lead that has no system
 * prompt of its own to put the profile in.
 *
 * @param {string} text from {@link profileText}
 * @returns {string} empty for an empty profile
 */
export function profilePreamble(text) {
  if (typeof text !== "string" || text === "") return "";
  return [
    "<kumo-profile>",
    // The block sits inside a tag: the user's own text must not close it.
    text.replace(CLOSING_TAG, "</ kumo-profile>"),
    "</kumo-profile>",
    "",
    "The user's message:",
  ].join("\n");
}
