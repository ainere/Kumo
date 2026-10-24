import { useLayoutEffect, useRef, useState } from "react";
import { providerLabel } from "../lib";
import { interrupt, send, useStore } from "../store";
import { IconArrowUp, IconStop } from "./icons";

export function Composer({ autoFocus = false }: { autoFocus?: boolean }) {
  const busy = useStore((s) => s.busy);
  const settings = useStore((s) => s.session?.settings);
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);

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
            <span className="chip" title="Lead model">
              {providerLabel(settings.orchestratorProvider)} · {settings.orchestratorModel}
            </span>
          )}
          {settings && (
            <span className="chip" title="Safety mode">
              {settings.safetyMode}
            </span>
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

export function EmptyState() {
  return (
    <div className="empty">
      <div className="empty-halo" aria-hidden="true" />
      <h1>what should we build?</h1>
      <Composer autoFocus />
    </div>
  );
}
