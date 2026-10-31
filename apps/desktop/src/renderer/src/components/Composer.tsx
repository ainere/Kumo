import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getSafetyModeOption, modelDisplayName, SAFETY_MODE_OPTIONS } from "../lib";
import { interrupt, openSettings, send, updateSettings, useStore } from "../store";
import { IconArrowUp, IconCheck, IconStop, SafetyIcon } from "./icons";

export function Composer({ autoFocus = false }: { autoFocus?: boolean }) {
  const busy = useStore((s) => s.busy);
  const settings = useStore((s) => s.session?.settings);
  const [text, setText] = useState("");
  const [safetyMenuOpen, setSafetyMenuOpen] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const safetyMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!safetyMenuOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (safetyMenuRef.current && !safetyMenuRef.current.contains(e.target as Node)) {
        setSafetyMenuOpen(false);
      }
    };
    // Esc closes the menu and goes no further.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      setSafetyMenuOpen(false);
      safetyMenuRef.current?.querySelector<HTMLButtonElement>(".safety-btn")?.focus();
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [safetyMenuOpen]);

  // Settings covers the chat: a menu left open would still be open when it comes back.
  const view = useStore((s) => s.view);
  useEffect(() => {
    if (view === "settings") setSafetyMenuOpen(false);
  }, [view]);

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(240, el.scrollHeight)}px`;
  }, [text]);

  const submit = () => {
    const prompt = text.trim();
    if (!prompt || busy) return;
    setText("");
    void send(prompt);
  };

  const activeSafety = getSafetyModeOption(settings?.safetyMode);

  return (
    <div className="composer-wrap">
      <form
        className="composer glass-strong"
        data-part="composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="sr-only" htmlFor="prompt">
          Message
        </label>
        <textarea
          id="prompt"
          ref={input}
          rows={1}
          value={text}
          autoFocus={autoFocus}
          placeholder={busy ? "Working… press Esc to stop" : "Ask kumo to build, fix or explain something"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape" && busy) {
              e.preventDefault();
              void interrupt();
            }
          }}
        />
        <div className="composer-row">
          {settings && (
            <button
              type="button"
              className="composer-btn lead-btn"
              aria-label={`Lead model: ${modelDisplayName(settings.orchestratorModel)}`}
              onClick={() => openSettings("models")}
            >
              Lead: {modelDisplayName(settings.orchestratorModel)}
            </button>
          )}
          {settings && (
            <div className="safety-dropdown-wrap" ref={safetyMenuRef}>
              <button
                type="button"
                className="composer-btn safety-btn"
                aria-label={`Safety mode: ${activeSafety.label}`}
                aria-haspopup="menu"
                aria-expanded={safetyMenuOpen}
                onClick={() => setSafetyMenuOpen((o) => !o)}
              >
                <SafetyIcon type={activeSafety.iconType} className="safety-btn-icon" />
                <span>{activeSafety.shortLabel}</span>
              </button>
              {safetyMenuOpen && (
                <div className="safety-menu" role="menu" aria-label="Permission safety modes">
                  {SAFETY_MODE_OPTIONS.map((opt) => {
                    const isSelected = opt.id === activeSafety.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        className="safety-menu-item"
                        data-active={isSelected}
                        role="menuitemradio"
                        aria-checked={isSelected}
                        onClick={() => {
                          setSafetyMenuOpen(false);
                          void updateSettings({ safetyMode: opt.id });
                        }}
                      >
                        <span className="safety-menu-icon">
                          <SafetyIcon type={opt.iconType} />
                        </span>
                        <span className="safety-menu-content">
                          <span className="safety-menu-title">{opt.label}</span>
                          <span className="safety-menu-desc">{opt.desc}</span>
                        </span>
                        {isSelected && (
                          <span className="safety-menu-check">
                            <IconCheck />
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          <span className="spacer" />
          <span className="hints">↵ send · ⇧↵ newline</span>
          {busy ? (
            <button type="button" className="send-btn" aria-label="Stop" onClick={() => void interrupt()}>
              <IconStop />
            </button>
          ) : (
            <button type="submit" className="send-btn" aria-label="Send" disabled={!text.trim()}>
              <IconArrowUp />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

const PROMPTS = [
  "what should we build?",
  "hey! what are you up to?",
  "ready when you are.",
  "let's ship something great.",
  "what are we tackling today?",
  "what's on your mind?",
  "got a bug to squash or a feature to craft?",
  "tell me what needs doing, and we'll handle the rest.",
  "what are we cooking up today?",
  "blank canvas. let's make something clean.",
  "have an idea? let's flesh it out.",
  "ready to code. lead the way.",
  "what's the mission today?",
  "give me a puzzle to solve.",
  "refactor? new feature? complete rewrite? your call.",
  "what are we breaking (and fixing) today?",
  "got a repo in mind? let's dive in.",
  "another day, another commit.",
  "point me at the mess. i won't judge.",
  "git status: clean. let's ruin that.",
  "what are we over-engineering today?",
  "tell me what to build. i'll bring the workers.",
  "deleting code is my favorite feature. what are we trimming?",
  "works on my machine. let's make it work on yours.",
  "got a gnarly stack trace? drop it in.",
  "let's turn caffeine into pull requests.",
  "no ticket required. what are we building?",
  "ready to turn 'TODO' into 'done'.",
  "orchestrator warm, workers caffeinated. what's the play?",
  "ship fast, revert faster. (kidding. mostly.)",
  "which file hurt you today?",
  "let's write code future-you won't git blame us for.",
  "you bring the architecture, we'll bring the keystrokes.",
  "summon the cloud. what are we shipping?",
  "zero meetings, 100% throughput. where do we start?",
  "legacy code whisperer reporting for duty.",
  "new feature or revenge refactor?",
  "talk nerdy to me. what's the spec?",
  "let's make the compiler happy.",
  "another day in the mines of node_modules. lead on.",
  "less bikeshedding, more shipping. what's first?",
  "point me at a bug and watch it evaporate.",
];

const NIGHT_PROMPTS = [
  "burning the midnight oil?",
  "busy night?",
  "still up coding?",
  "let's finish this up so you can get some sleep.",
  "the night is quiet. what are we building?",
  "coding in the dark hits different. what are we working on?",
  "remember to hydrate. what should we build?",
  "just one more commit before bed?",
  "late night brilliance in progress?",
  "the rest of the world is asleep. let's build.",
  "2 AM ideas are either genius or insane. let's find out.",
  "quiet hours, loud ideas.",
  "sleep is just a garbage collection pause anyway.",
  "nothing good happens after 2 AM—except this commit.",
  "the bugs come out at night. good thing we're still awake.",
  "commit messages get weird after midnight. i'll write the clean ones.",
  "powered by spite and cold brew. what's broken?",
  "if we fix it before sunrise, did the bug ever really exist?",
  "3 AM debugging: where 'temporary fix' becomes permanent architecture.",
  "your circadian rhythm called. it left a stack trace.",
  "too wired to sleep, too tired to write boilerplate. hand it over.",
  "dark mode wasn't a preference, it's the actual time of day.",
  "chasing that one last failing test before bed?",
  "the servers are quiet and the linter is unforgiving. let's go.",
];

const MORNING_PROMPTS = [
  "good morning. what should we build?",
  "coffee brewed? let's get to work.",
  "fresh day, fresh code.",
  "morning! what are we building today?",
  "early bird gets the cleanest diff. what's the plan?",
  "start with the hard part or ease into it?",
  "new day, zero merge conflicts (hopefully).",
  "let's get some green checkmarks this morning.",
  "rise and grind. what are we shipping?",
  "caffeine compiling… ready when you are.",
  "before the slack notifications find you—what are we shipping?",
  "fresh branch, fresh mindset, zero tech debt (for the next five minutes).",
  "let's ship something before the morning standup even starts.",
  "good morning. git pull and pray?",
  "brain at 100% context window. give me the hard problem.",
  "first sip of coffee, first green build.",
  "let's knock out today's deliverables before lunch.",
  "woke up and chose clean architecture.",
  "the CI pipeline is wide awake. what are we feeding it?",
];

const MONDAY_MORNING_PROMPTS = [
  "monday again. let's ease in with a small diff (or rewrite everything).",
  "surviving monday, one function at a time.",
  "remembering what we were doing on friday… loading context.",
  "new week, new sprint, same questionable TODOs.",
  "monday morning. coffee first, git blame second.",
  "let's make monday regret showing up.",
];

const AFTERNOON_PROMPTS = [
  "afternoon! what's next on the agenda?",
  "post-lunch momentum. let's knock something out.",
  "halfway through the day. what should we ship?",
  "afternoon sprint? let's do this.",
  "let's turn that idea into working code.",
  "ready for the afternoon push.",
  "post-lunch food coma? delegate the heavy lifting to me.",
  "2 PM slump vs. second cup of coffee. let's keep moving.",
  "afternoon focus window unlocked. what's the priority?",
  "too late for morning plans, too early to call it a day. let's ship.",
  "cruising through the afternoon backlog. what's next?",
  "let's clear out those PR review comments.",
  "peak afternoon velocity. point me at the next task.",
  "dodging afternoon meetings to write actual code? respect.",
];

const EVENING_PROMPTS = [
  "wrapping up the day or just getting started?",
  "evening flow state. what are we building?",
  "winding down with some clean code?",
  "let's tie up loose ends and get this shipped.",
  "the evening shift begins. what are we building?",
  "one clean commit to finish the day strong.",
  "office hours are over; real coding hours have begun.",
  "slack is finally quiet. time to actually get things done.",
  "evening session: fixing today's work or starting tomorrow's?",
  "golden hour for deep work. what are we building?",
  "nobody left to interrupt your flow state. let's cook.",
  "leaving the repo cleaner than we found it this morning.",
  "nightfall, zero pings, pure throughput.",
];

const FRIDAY_EVENING_PROMPTS = [
  "friday night deploy? brave. what are we building?",
  "made it to friday evening. what's the plan?",
  "weekend is almost here. let's wrap this up.",
  "friday evening flow state. let's ship something great.",
  "closing out the work week strong. what's next?",
  "read-only friday? never heard of her. what are we shipping?",
  "deploying on friday evening—living dangerously, i see.",
  "one tiny hotfix before the weekend. what could possibly go wrong?",
  "friday night: either wrapping up a deadline or starting a wild side project.",
  "pager on mute? let's build something fun.",
  "trading happy hour for hacker hour. what's on the menu?",
  "closing 47 browser tabs starts with shipping this last commit.",
];

const SATURDAY_MORNING_PROMPTS = [
  "saturday morning code session. what are we building?",
  "lazy saturday morning? perfect for hacking on something fun.",
  "weekend coffee brewed. let's dive into some code.",
  "no standups today. what are we building?",
  "saturday morning side-quest time. what are we cooking?",
  "no jira, no PMs, no sprints—just vibes and code.",
  "saturday morning cartoons? nah, saturday morning compilers.",
  "starting a new side project we'll definitely finish this time?",
  "weekend mode: where we write the code we actually want to write.",
];

const SATURDAY_DAY_PROMPTS = [
  "saturday side-quest time. what are we cooking?",
  "pet project hours. let's make something cool.",
  "saturday night coding session. what's on your mind?",
  "building for fun on a saturday. the best kind of code.",
  "no deadlines today, just pure code. what's on your mind?",
  "saturday hacking? the best kind. what are we building?",
  "saturday afternoon rabbit hole—how deep are we going?",
  "over-engineering a personal project on a saturday? count me in.",
  "saturday night in the terminal. honestly, elite plans.",
  "zero enterprise constraints today. let's get weird with it.",
];

const SUNDAY_DAY_PROMPTS = [
  "sunday dev mode. what are we building today?",
  "quiet sunday, fresh ideas. what's on your mind?",
  "weekend hacking in progress. let's build.",
  "sunday afternoon flow state. what are we crafting?",
  "lazy sunday, productive code.",
  "easy like sunday morning—until the type checker complains.",
  "rainy sunday energy. let's build something cozy.",
  "pre-empting monday's problems so tomorrow-you can coast.",
];

const SUNDAY_EVENING_PROMPTS = [
  "sunday evening wind-down. getting ready for the week?",
  "tying up weekend side projects before monday.",
  "one last clean commit before the week starts.",
  "sunday night build. let's make it count.",
  "clearing the deck for the week ahead.",
  "sunday scaries? nothing a clean build can't cure.",
  "sunday night polish: making monday's demo look effortless.",
  "stashing the weekend experiments before monday morning hits.",
  "sneaking in one more feature before the work week starts.",
];

const WEEKEND_NIGHT_PROMPTS = [
  "weekend late night coding hits different.",
  "no work tomorrow, so let's keep building.",
  "2 AM on the weekend. pure flow state.",
  "the weekend midnight oil burns brightest.",
  "quiet weekend night. let's build something extraordinary.",
  "it's the weekend, time doesn't exist, and neither do deadlines.",
  "3 AM on a weekend: peak side-project velocity.",
  "sleep in tomorrow, ship tonight.",
  "certified weekend night owl. what are we inventing?",
  "when the weekend side-quest turns into a full-blown startup at 2 AM.",
];

export function getWelcomeHeadline(now = new Date()): string {
  const hour = now.getHours();
  const day = now.getDay(); // 0 is Sunday, 1 is Monday, 5 is Friday, 6 is Saturday

  let timePool: string[];

  if (day === 5 && hour >= 17) {
    // Friday evening
    timePool = FRIDAY_EVENING_PROMPTS;
  } else if (day === 6) {
    // Saturday
    if (hour >= 0 && hour < 5) timePool = WEEKEND_NIGHT_PROMPTS;
    else if (hour >= 5 && hour < 12) timePool = SATURDAY_MORNING_PROMPTS;
    else timePool = SATURDAY_DAY_PROMPTS;
  } else if (day === 0) {
    // Sunday
    if (hour >= 0 && hour < 5) timePool = WEEKEND_NIGHT_PROMPTS;
    else if (hour >= 5 && hour < 17) timePool = SUNDAY_DAY_PROMPTS;
    else timePool = SUNDAY_EVENING_PROMPTS;
  } else {
    // Weekdays
    if (hour >= 0 && hour < 5) {
      timePool = NIGHT_PROMPTS;
    } else if (hour >= 5 && hour < 12) {
      timePool = day === 1 ? [...MONDAY_MORNING_PROMPTS, ...MORNING_PROMPTS] : MORNING_PROMPTS;
    } else if (hour >= 12 && hour < 17) {
      timePool = AFTERNOON_PROMPTS;
    } else {
      timePool = EVENING_PROMPTS;
    }
  }

  // Blend time-specific prompts (~65%) with the general prompt pool (~35%) so both rotate naturally.
  const pool = Math.random() < 0.35 ? PROMPTS : timePool;
  const idx = Math.floor(Math.random() * pool.length);
  return pool[idx];
}

export function EmptyState() {
  const [headline] = useState(() => getWelcomeHeadline());
  return (
    <div className="empty">
      <div className="empty-halo" aria-hidden="true" />
      <h1>{headline}</h1>
      <Composer autoFocus />
    </div>
  );
}
