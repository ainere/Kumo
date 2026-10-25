/**
 * Asks before a chat continues on another lead provider: the engine replays
 * the earlier turns into the new model's context, which costs tokens.
 * Shown whenever the store has a pending `providerSwitch`.
 */

import { useRef, useState } from "react";
import { providerLabel } from "../lib";
import { answerProviderSwitch, useStore } from "../store";
import { Modal } from "./settings/controls";

export function ProviderSwitchModal() {
  const pending = useStore((s) => s.providerSwitch);
  if (!pending) return null;
  // A new question starts with the box unticked.
  return <ProviderSwitchDialog key={`${pending.provider}\n${pending.model}`} provider={pending.provider} model={pending.model} />;
}

function ProviderSwitchDialog({ provider, model }: { provider: string; model: string }) {
  const [dontAsk, setDontAsk] = useState(false);
  const proceed = useRef<HTMLButtonElement>(null);
  const name = providerLabel(provider) || provider;

  return (
    <Modal
      title={`Continue with ${name}?`}
      description={model ? `${name} · ${model}` : undefined}
      part="provider-switch"
      initialFocus={proceed}
      onClose={() => answerProviderSwitch(false, false)}
      onKeyDown={(e) => {
        // Enter continues, except on a button, which does its own thing.
        if (e.key === "Enter" && !e.nativeEvent.isComposing && !(e.target instanceof HTMLButtonElement)) {
          e.preventDefault();
          answerProviderSwitch(true, dontAsk);
        }
      }}
      actions={
        <>
          <button type="button" className="btn" onClick={() => answerProviderSwitch(false, false)}>
            Cancel
          </button>
          <button ref={proceed} type="button" className="btn primary" onClick={() => answerProviderSwitch(true, dontAsk)}>
            Continue
          </button>
        </>
      }
    >
      <p>
        This chat's earlier turns, and what its workers produced, go into {name}'s context first. That uses tokens, and leaves less room for new work in
        this chat.
      </p>
      <label className="check">
        <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
        Don't ask again
      </label>
    </Modal>
  );
}
