import { useState } from "react";
import { basename } from "../lib";
import { newChat, useStore } from "../store";
import { AppearanceMenu } from "./AppearanceMenu";
import { IconPlus, IconSliders } from "./icons";

export function TitleBar() {
  const session = useStore((s) => s.session);
  const chats = useStore((s) => s.chats);
  const busy = useStore((s) => s.busy);
  const [menu, setMenu] = useState(false);
  const chat = session ? chats.find((c) => c.id === session.chatId) : undefined;

  return (
    <header className="titlebar glass" data-part="titlebar">
      <span className="brand">kumo</span>
      <span className="brand-kanji">雲</span>
      {session && (
        <>
          <span className="divider-v" />
          <span className="crumb" title={session.workspace}>
            {basename(session.workspace)}
            {chat ? ` / ${chat.title}` : ""}
          </span>
        </>
      )}
      <span className="spacer" />
      {session && (
        <button className="chip-btn" onClick={() => void newChat()} disabled={busy}>
          <IconPlus /> New chat
        </button>
      )}
      <div className="popover-anchor no-drag">
        <button className="icon-btn" aria-label="Appearance" aria-expanded={menu} onClick={() => setMenu((open) => !open)}>
          <IconSliders />
        </button>
        {menu && <AppearanceMenu onClose={() => setMenu(false)} />}
      </div>
    </header>
  );
}
