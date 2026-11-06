/**
 * The composer's `/` commands: typed shortcuts for what the app already does
 * (Settings, the Workbench tabs, chats, the lead's model, effort and safety
 * mode). A command is one word at the very start of the box; anything else
 * that begins with a slash, a path say, is an ordinary message.
 */

import {
  getState,
  interrupt,
  invoke,
  loadCatalog,
  newChat,
  newSession,
  openCompare,
  openNewWindow,
  openSettings,
  pickAndOpenFolder,
  refreshQuotas,
  renameChat,
  setWorkbenchTab,
  toast,
  toastFailure,
  toggleSplit,
  updateSettings,
} from "./store";
import { SAFETY_MODE_OPTIONS } from "./lib";
import { effortLabel, effortsOf, findModel, pickEffort } from "./components/settings/ModelPicker";
import type { WorkbenchTab } from "./types";

/** One pick after a command: a model, an effort level, a safety mode. */
export interface SlashChoice {
  id: string;
  label: string;
  hint?: string;
  /** Shown whatever was typed after the command, as the way out of a short list. */
  always?: boolean;
  run: () => void;
}

export interface SlashCommand {
  name: string;
  aliases?: readonly string[];
  description: string;
  /** Free text the command takes after its name, as shown to the user: "<title>". */
  usage?: string;
  /** The picks that may follow it; null while they're still loading. */
  choices?: () => SlashChoice[] | null;
  /** Why it can't run right now, or null when it can. */
  unavailable?: () => string | null;
  run: (arg: string, composer: { setText: (text: string) => void }) => void;
}

/** What the box holds, read as a command. */
export type SlashState =
  | { kind: "commands"; items: SlashCommand[] }
  | { kind: "choices"; command: SlashCommand; items: SlashChoice[] | null; arg: string }
  | { kind: "text"; command: SlashCommand; arg: string };

const needsProject = () => (getState().session ? null : "Open a project first.");
const notWhileWorking = () => (getState().busy ? "Wait for the lead to finish, or stop it first." : needsProject());

const slug = (text: string) => text.trim().toLowerCase().replace(/[\s_]+/g, "-");

const openTab = (name: string, tab: WorkbenchTab, description: string): SlashCommand => ({
  name,
  description,
  unavailable: needsProject,
  run: () => setWorkbenchTab(tab),
});

/** Models the lead can run on, from the catalog; null until it has loaded (the composer asks for it). */
function leadModels(): SlashChoice[] | null {
  const { catalog, session } = getState();
  if (!catalog) return null;
  const current = session?.settings.orchestratorModel;
  const choices: SlashChoice[] = [];
  for (const provider of catalog) {
    if (!provider.available || !provider.canLead) continue;
    for (const model of provider.models) {
      choices.push({
        id: `${provider.provider}:${model.id}`,
        label: model.name,
        hint: model.id === current ? `${provider.name} · current` : provider.name,
        run: () => {
          const effort = pickEffort(model, session?.settings.reasoningEffort);
          void updateSettings({
            orchestratorProvider: provider.provider,
            orchestratorModel: model.id,
            ...(effort ? { reasoningEffort: effort } : {}),
          });
        },
      });
    }
  }
  choices.push({ id: "settings", label: "All models in Settings…", always: true, run: () => openSettings("models") });
  return choices;
}

/** The effort levels the lead's model takes. */
function leadEfforts(): SlashChoice[] | null {
  const { catalog, session } = getState();
  if (!catalog) return null;
  const settings = session?.settings;
  if (!settings) return [];
  const model = findModel(catalog, settings.orchestratorProvider, settings.orchestratorModel);
  const fit = pickEffort(model, settings.reasoningEffort);
  return effortsOf(model).map((effort) => ({
    id: effort,
    label: effortLabel(settings.orchestratorProvider, effort),
    hint: effort === fit ? "current" : undefined,
    run: () => void updateSettings({ reasoningEffort: effort }),
  }));
}

function safetyModes(): SlashChoice[] {
  const current = getState().session?.settings.safetyMode;
  return SAFETY_MODE_OPTIONS.map((mode) => ({
    id: mode.id,
    label: mode.label,
    hint: mode.id === current ? "current" : undefined,
    run: () => void updateSettings({ safetyMode: mode.id }),
  }));
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: "new",
    aliases: ["clear"],
    description: "Start a new chat in this project",
    unavailable: notWhileWorking,
    run: () => void newChat(),
  },
  {
    name: "session",
    description: "Open another session in a tab",
    unavailable: needsProject,
    run: () => void newSession(),
  },
  {
    name: "split",
    description: "Show two sessions side by side, or one again",
    unavailable: needsProject,
    run: () => toggleSplit(),
  },
  {
    name: "model",
    description: "Switch the lead's model",
    usage: "<model>",
    choices: leadModels,
    unavailable: needsProject,
    run: () => openSettings("models"),
  },
  {
    name: "effort",
    description: "Set the lead's reasoning effort",
    usage: "<level>",
    choices: leadEfforts,
    unavailable: () => {
      const { catalog, session } = getState();
      if (!session) return "Open a project first.";
      const model = catalog && findModel(catalog, session.settings.orchestratorProvider, session.settings.orchestratorModel);
      return catalog && effortsOf(model ?? null).length === 0 ? "This model picks its own reasoning effort." : null;
    },
    run: () => openSettings("models"),
  },
  {
    name: "mode",
    aliases: ["safety"],
    description: "Set the safety mode",
    usage: "<mode>",
    choices: safetyModes,
    unavailable: needsProject,
    run: () => openSettings("general"),
  },
  { name: "role", aliases: ["roles"], description: "Choose a model for each worker role", run: () => openSettings("roles") },
  { name: "settings", description: "Open Settings", run: () => openSettings() },
  { name: "doctor", description: "Run the health checks", run: () => openSettings("doctor") },
  { name: "usage", aliases: ["quota", "status"], description: "Refresh the usage bars", run: () => void refreshQuotas() },
  openTab("workers", "workers", "Show the Workers tab"),
  openTab("files", "files", "Show the project's files"),
  openTab("diff", "diff", "Show changes, approvals and rewind"),
  openTab("terminal", "terminal", "Show the terminal"),
  openTab("browser", "browser", "Show the browser"),
  openTab("plan", "plan", "Show the chat's plan"),
  {
    name: "compare",
    description: "Give two models the same brief",
    unavailable: notWhileWorking,
    run: () => openCompare(),
  },
  {
    name: "rename",
    description: "Rename this chat",
    usage: "<title>",
    unavailable: needsProject,
    run: (arg) => {
      const session = getState().session;
      const title = arg.trim();
      if (!session?.chatId || !title) return;
      void renameChat(session.workspace, session.chatId, title);
    },
  },
  {
    name: "export",
    description: "Export this chat to Markdown",
    unavailable: needsProject,
    run: () => {
      const session = getState().session;
      if (!session) return;
      void invoke<{ path: string }>("session.exportMarkdown", { sessionId: session.id })
        .then((res) => toast("notice", `Exported to ${res.path}`))
        .catch((err) => toastFailure(err));
    },
  },
  { name: "open", aliases: ["cd"], description: "Open a project folder", run: () => void pickAndOpenFolder() },
  { name: "window", description: "Open another window", run: () => openNewWindow() },
  {
    name: "stop",
    description: "Stop the lead",
    unavailable: () => (getState().busy ? null : "Nothing is running."),
    run: () => void interrupt(),
  },
  { name: "help", description: "List these commands", run: (_arg, composer) => composer.setText("/") },
];

const named = (word: string) =>
  SLASH_COMMANDS.find((c) => c.name === word || c.aliases?.includes(word)) ?? null;

/** The picks matching what was typed after the command. */
export function filterChoices(choices: SlashChoice[], arg: string): SlashChoice[] {
  const q = slug(arg);
  if (!q) return choices;
  return choices.filter((c) => c.always || [c.label, c.id, c.hint ?? ""].some((field) => slug(field).includes(q)));
}

/** Read the box as a command, or null when it isn't one and should be sent as it stands. */
export function parseSlash(text: string): SlashState | null {
  if (!text.startsWith("/") || text.includes("\n")) return null;
  const typing = /^\/([^\s/]*)$/.exec(text);
  if (typing) {
    const q = typing[1].toLowerCase();
    const starts = SLASH_COMMANDS.filter((c) => c.name.startsWith(q) || c.aliases?.some((a) => a.startsWith(q)));
    const items = starts.length > 0 ? starts : SLASH_COMMANDS.filter((c) => c.name.includes(q));
    // An exact name comes first, so Enter on "/new" runs /new and not whatever sorts before it.
    items.sort((a, b) => Number(b.name === q) - Number(a.name === q));
    return items.length > 0 ? { kind: "commands", items } : null;
  }
  const withArg = /^\/(\S+)\s(.*)$/.exec(text);
  if (!withArg) return null;
  const command = named(withArg[1].toLowerCase());
  if (!command) return null;
  const arg = withArg[2];
  if (command.choices) {
    const all = command.choices();
    return { kind: "choices", command, items: all && filterChoices(all, arg), arg };
  }
  if (command.usage) return { kind: "text", command, arg };
  return null;
}

/**
 * Run a command that was typed out in full and sent: "/new", "/mode autopilot",
 * "/rename Fix login". "ran" when it did, "refused" when it couldn't and said
 * why (the text stays for editing), null when the text isn't one, so it goes
 * to the lead.
 */
export function runTypedSlash(text: string, composer: { setText: (text: string) => void }): "ran" | "refused" | null {
  if (text.includes("\n")) return null;
  const match = /^\/(\S+)(?:\s+(.*))?$/.exec(text.trim());
  if (!match) return null;
  const command = named(match[1].toLowerCase());
  if (!command) return null;
  const arg = (match[2] ?? "").trim();
  if (arg && !command.usage) return null;
  const refuse = (why: string) => {
    toast("notice", `/${command.name}: ${why}`);
    return "refused" as const;
  };
  const reason = command.unavailable?.();
  if (reason) return refuse(reason);
  if (command.choices) {
    // With nothing after it, a pick-list command goes to the page where the same choice lives.
    if (!arg) {
      command.run("", composer);
      return "ran";
    }
    const all = command.choices();
    if (all === null) {
      void loadCatalog();
      return refuse("the model list is still loading. Try again in a moment.");
    }
    const q = slug(arg);
    const exact = all.filter((c) => !c.always && [c.label, c.id].some((field) => slug(field) === q));
    const found = exact.length === 1 ? exact : filterChoices(all, arg).filter((c) => !c.always);
    if (found.length === 0) return refuse(`nothing matches "${arg}".`);
    if (found.length > 1) return refuse(`"${arg}" matches ${found.length}. Say a little more.`);
    found[0].run();
    return "ran";
  }
  if (command.usage && !arg) return refuse(command.usage);
  command.run(arg, composer);
  return "ran";
}
