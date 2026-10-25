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
];

const AFTERNOON_PROMPTS = [
  "afternoon! what's next on the agenda?",
  "post-lunch momentum. let's knock something out.",
  "halfway through the day. what should we ship?",
  "afternoon sprint? let's do this.",
  "let's turn that idea into working code.",
  "ready for the afternoon push.",
];

const EVENING_PROMPTS = [
  "wrapping up the day or just getting started?",
  "evening flow state. what are we building?",
  "winding down with some clean code?",
  "let's tie up loose ends and get this shipped.",
  "the evening shift begins. what are we building?",
  "one clean commit to finish the day strong.",
];

const FRIDAY_EVENING_PROMPTS = [
  "friday night deploy? brave. what are we building?",
  "made it to friday evening. what's the plan?",
  "weekend is almost here. let's wrap this up.",
  "friday evening flow state. let's ship something great.",
  "closing out the work week strong. what's next?",
];

const SATURDAY_MORNING_PROMPTS = [
  "saturday morning code session. what are we building?",
  "lazy saturday morning? perfect for hacking on something fun.",
  "weekend coffee brewed. let's dive into some code.",
  "no standups today. what are we building?",
  "saturday morning side-quest time. what are we cooking?",
];

const SATURDAY_DAY_PROMPTS = [
  "saturday side-quest time. what are we cooking?",
  "pet project hours. let's make something cool.",
  "saturday night coding session. what's on your mind?",
  "building for fun on a saturday. the best kind of code.",
  "no deadlines today, just pure code. what's on your mind?",
  "saturday hacking? the best kind. what are we building?",
];

const SUNDAY_DAY_PROMPTS = [
  "sunday dev mode. what are we building today?",
  "quiet sunday, fresh ideas. what's on your mind?",
  "weekend hacking in progress. let's build.",
  "sunday afternoon flow state. what are we crafting?",
  "lazy sunday, productive code.",
];

const SUNDAY_EVENING_PROMPTS = [
  "sunday evening wind-down. getting ready for the week?",
  "tying up weekend side projects before monday.",
  "one last clean commit before the week starts.",
  "sunday night build. let's make it count.",
  "clearing the deck for the week ahead.",
];

const WEEKEND_NIGHT_PROMPTS = [
  "weekend late night coding hits different.",
  "no work tomorrow, so let's keep building.",
  "2 AM on the weekend. pure flow state.",
  "the weekend midnight oil burns brightest.",
  "quiet weekend night. let's build something extraordinary.",
];

export function getWelcomeHeadline(): string {
  const now = new Date();
  const hour = now.getHours();
  const day = now.getDay(); // 0 is Sunday, 5 is Friday, 6 is Saturday

  let pool: string[];

  if (day === 5 && hour >= 17) {
    // Friday evening
    pool = FRIDAY_EVENING_PROMPTS;
  } else if (day === 6) {
    // Saturday
    if (hour >= 0 && hour < 5) pool = WEEKEND_NIGHT_PROMPTS;
    else if (hour >= 5 && hour < 12) pool = SATURDAY_MORNING_PROMPTS;
    else pool = SATURDAY_DAY_PROMPTS;
  } else if (day === 0) {
    // Sunday
    if (hour >= 0 && hour < 5) pool = WEEKEND_NIGHT_PROMPTS;
    else if (hour >= 5 && hour < 17) pool = SUNDAY_DAY_PROMPTS;
    else pool = SUNDAY_EVENING_PROMPTS;
  } else {
    // Weekdays
    if (hour >= 0 && hour < 5) {
      pool = NIGHT_PROMPTS;
    } else if (hour >= 5 && hour < 12) {
      pool = MORNING_PROMPTS;
    } else if (hour >= 12 && hour < 17) {
      pool = AFTERNOON_PROMPTS;
    } else if (hour >= 17 && hour < 24) {
      pool = EVENING_PROMPTS;
    } else {
      pool = PROMPTS;
    }
  }

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
