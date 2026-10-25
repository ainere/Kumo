/**
 * Settings: a full-height glass surface in place of the sidebar, chat and
 * Workers panel (which stay mounted behind it, so the chat comes back as it
 * was). A nav rail on the left, the tab's page on the right.
 */

import "../../styles/settings.css";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement } from "react";
import { closeSettings, setSettingsTab, useStore } from "../../store";
import type { SettingsTab } from "../../types";
import { IconArrowLeft, IconContrast, IconCube, IconPulse, IconSliders, IconUser, IconUsers } from "../icons";
import { AccountsTab } from "./AccountsTab";
import { AppearanceTab } from "./AppearanceTab";
import { hasOpenDialog, SettingsActionContext } from "./controls";
import { DoctorTab } from "./DoctorTab";
import { GeneralTab } from "./GeneralTab";
import { ModelsTab } from "./ModelsTab";
import { RolesTab } from "./RolesTab";

type TabDef = { id: SettingsTab; label: string; Icon: () => ReactElement; Page: () => ReactElement };

export const SETTINGS_TABS: readonly TabDef[] = [
  { id: "accounts", label: "Accounts", Icon: IconUser, Page: AccountsTab },
  { id: "models", label: "Models", Icon: IconCube, Page: ModelsTab },
  { id: "roles", label: "Roles", Icon: IconUsers, Page: RolesTab },
  { id: "appearance", label: "Appearance", Icon: IconContrast, Page: AppearanceTab },
  { id: "general", label: "General", Icon: IconSliders, Page: GeneralTab },
  { id: "doctor", label: "Doctor", Icon: IconPulse, Page: DoctorTab },
];

export const settingsTabLabel = (tab: SettingsTab): string => SETTINGS_TABS.find((t) => t.id === tab)?.label ?? "";

export function SettingsView() {
  const tab = useStore((s) => s.settingsTab);
  const inChat = useStore((s) => s.phase === "ready");
  const attention = useStore((s) => (s.approvals.length > 0 ? "approval" : s.busy ? "busy" : null));
  const idBase = useId();
  const tabRefs = useRef(new Map<SettingsTab, HTMLButtonElement>());
  const content = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const active = SETTINGS_TABS.find((t) => t.id === tab) ?? SETTINGS_TABS[0];
  const ids = { tab: (id: SettingsTab) => `${idBase}-tab-${id}`, panel: `${idBase}-panel` };
  // The top bar's slot for the page's actions (PageHeader portals them in).
  const [actionSlot, setActionSlot] = useState<HTMLDivElement | null>(null);

  // Keyboard users land in Settings: the chat behind it is inert.
  useEffect(() => {
    tabRefs.current.get(tab)?.focus({ preventScroll: true });
    // Only when Settings opens.
  }, []);

  // Esc goes back to the chat, unless a dialog in Settings has it.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || hasOpenDialog()) return;
      e.preventDefault();
      closeSettings();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Page headers leave room for the top bar, whose width changes with each tab's actions.
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const measure = () => surface.current?.style.setProperty("--settings-bar-w", `${Math.ceil(el.getBoundingClientRect().width)}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Each tab starts at its top.
  useLayoutEffect(() => {
    if (!content.current) return;
    content.current.scrollTop = 0;
    content.current.removeAttribute("data-scrolled");
  }, [tab]);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const at = SETTINGS_TABS.findIndex((t) => t.id === tab);
    const n = SETTINGS_TABS.length;
    const next =
      e.key === "ArrowDown" ? (at + 1) % n
      : e.key === "ArrowUp" ? (at - 1 + n) % n
      : e.key === "Home" ? 0
      : e.key === "End" ? n - 1
      : -1;
    if (next === -1) return;
    e.preventDefault();
    const id = SETTINGS_TABS[next].id;
    setSettingsTab(id);
    tabRefs.current.get(id)?.focus();
  };

  return (
    <SettingsActionContext.Provider value={actionSlot}>
      <section ref={surface} className="settings glass" data-part="settings" aria-label="Settings">
        <div ref={bar} className="settings-top-bar">
          <div ref={setActionSlot} className="settings-top-actions" data-part="settings-actions" />
          <button
            type="button"
            className="btn settings-close-btn"
            data-part="settings-back"
            data-attention={attention ?? undefined}
            data-tooltip="Back to chat (Esc)"
            data-tooltip-pos="left"
            aria-label={attention === "approval" ? "Back to chat (approval waiting)" : attention === "busy" ? "Back to chat (working)" : "Back to chat"}
            onClick={closeSettings}
          >
            <IconArrowLeft />
            <span>{inChat ? "Back to chat" : "Back"}</span>
            {attention && (
              <>
                <span className="back-dot" aria-hidden="true" />
                <span className="sr-only">{attention === "approval" ? "(approval waiting)" : "(working)"}</span>
              </>
            )}
          </button>
        </div>
        <div className="settings-rail">
        <div className="sidebar-section settings-rail-label" aria-hidden="true">
          Settings
        </div>
        <div
          className="settings-rail-tabs"
          role="tablist"
          aria-orientation="vertical"
          aria-label="Settings"
          style={{ "--at": SETTINGS_TABS.indexOf(active) } as CSSProperties}
        >
          {SETTINGS_TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              ref={(el) => {
                if (el) tabRefs.current.set(id, el);
                else tabRefs.current.delete(id);
              }}
              type="button"
              role="tab"
              className="settings-tab"
              id={ids.tab(id)}
              aria-selected={id === active.id}
              aria-controls={ids.panel}
              tabIndex={id === active.id ? 0 : -1}
              data-part="settings-tab"
              data-tab={id}
              onClick={() => setSettingsTab(id)}
              onKeyDown={onKeyDown}
            >
              <Icon />
              <span className="settings-tab-label">{label}</span>
            </button>
          ))}
        </div>
      </div>
      <div
        className="settings-content"
        ref={content}
        role="tabpanel"
        id={ids.panel}
        aria-labelledby={ids.tab(active.id)}
        tabIndex={-1}
        // Scrolled: the page fades out under the top bar's buttons instead of running into them.
        onScroll={(e) => e.currentTarget.toggleAttribute("data-scrolled", e.currentTarget.scrollTop > 4)}
      >
        <div className="settings-page" key={active.id} data-part={`settings-${active.id}`}>
          <active.Page />
        </div>
      </div>
    </section>
  </SettingsActionContext.Provider>
  );
}
