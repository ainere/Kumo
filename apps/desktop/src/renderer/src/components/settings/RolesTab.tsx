/**
 * Settings › Roles: the model each built-in worker role runs on, and custom
 * roles: worker tools of the user's own, with their own instructions.
 */

import { useEffect, useId, useRef, useState } from "react";
import { getState, loadCatalog, loadGlobalConfig, updateSettings, useStore } from "../../store";
import { IconPlus, IconTrash } from "../icons";
import { Badge, Callout, Modal, Note, PageHeader, Row, Section, Segmented } from "./controls";
import { findModel, ModelPicker, pickEffort, type ModelTarget } from "./ModelPicker";

interface BuiltinRoleDef {
  id: "scout" | "builder" | "tester" | "researcher" | "reviewer" | "designer";
  title: string;
  tool: string;
  access: "read" | "write";
  summary: string;
}

const BUILTIN_ROLES: readonly BuiltinRoleDef[] = [
  { id: "scout", title: "Scout", tool: "worker_explore", access: "read", summary: "Finds files, symbols, call paths and dependencies without changing anything." },
  { id: "builder", title: "Builder", tool: "worker_implement", access: "write", summary: "Implements bounded coding tasks against clear acceptance criteria." },
  { id: "tester", title: "Tester", tool: "worker_test", access: "write", summary: "Writes and runs tests with the project's own commands and reports exact results." },
  { id: "researcher", title: "Researcher", tool: "worker_research", access: "read", summary: "Looks up documentation, API specifications and version-specific behavior." },
  { id: "reviewer", title: "Reviewer", tool: "worker_review", access: "read", summary: "Reviews changes for correctness, security and regressions." },
  { id: "designer", title: "Designer", tool: "worker_design", access: "write", summary: "Visual and interaction design, and the design-facing code that realizes it." },
];

/** The engine's rules for a custom role (src/config/roles.js), checked here first so the form can say what's wrong. */
const ROLE_ID_PATTERN = /^[a-z][a-z0-9-]{0,29}[a-z0-9]$/;
const RESERVED_IDS = new Set([
  ...BUILTIN_ROLES.map((r) => r.id),
  ...BUILTIN_ROLES.map((r) => r.tool.slice("worker_".length)),
  "lead",
  "orchestrator",
  "worker",
  "custom",
  "default",
  "task",
  "all",
  "other",
  "constructor",
  "prototype",
  "tostring",
  "valueof",
]);
const MAX_CUSTOM_ROLES = 16;
const MAX_NAME = 60;
const MAX_DESCRIPTION = 400;

/** "Docs Specialist" → "docs-specialist". */
const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "")
    .slice(0, 31)
    .replace(/-+$/, "");

const AccessBadge = ({ access }: { access: "read" | "write" }) => <Badge>{access === "write" ? "Can edit" : "Read-only"}</Badge>;

type CustomRole = {
  id: string;
  name: string;
  description: string;
  prompt: string;
  access: "read" | "write";
  provider?: string;
  model?: string;
  effort?: string;
};

type Roles = NonNullable<ReturnType<typeof getState>["globalConfig"]>["settings"]["roles"];

const storeRoles = (): Roles => {
  const s = getState();
  return s.session?.settings.roles ?? s.globalConfig?.settings.roles ?? { custom: [] };
};

/**
 * Role changes go to the engine one at a time, each built on the one before:
 * the engine replaces the whole roles object, and the store hears about a
 * change only after the orchestrator reconnects, so two quick edits built on
 * the store would undo each other. `sent` is the last value sent until the
 * store catches up.
 */
let sent: Roles | null = null;
let chain: Promise<unknown> = Promise.resolve();

function writeRoles(change: (roles: Roles) => Roles, show: (roles: Roles | null) => void): Promise<boolean> {
  const step = chain.then(async () => {
    const next = change(sent ?? storeRoles());
    sent = next;
    show(next);
    const ok = await updateSettings({ roles: next });
    if (!ok) {
      sent = null;
      show(null);
    }
    return ok;
  });
  chain = step.catch(() => undefined);
  return step;
}

export function RolesTab() {
  const catalog = useStore((s) => s.catalog);
  const session = useStore((s) => s.session);
  const globalConfig = useStore((s) => s.globalConfig);
  const catalogError = useStore((s) => s.loadErrors.catalog);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
  // What was sent and not yet heard back, shown in place of the store's roles.
  const [pending, setPending] = useState<Roles | null>(null);

  useEffect(() => {
    if (!catalog) void loadCatalog();
    if (!globalConfig) void loadGlobalConfig();
  }, [catalog, globalConfig]);

  const saved = session?.settings.roles ?? globalConfig?.settings.roles;

  // The store caught up: what it has now is the truth.
  useEffect(() => {
    sent = null;
    setPending(null);
  }, [saved]);

  const roles = pending ?? saved ?? { custom: [] };
  const customRoles = roles.custom || [];

  const defaultWorker = {
    provider: session?.settings.workerProvider ?? globalConfig?.settings.workerProvider ?? "codex",
    model: session?.settings.workerModel ?? globalConfig?.settings.workerModel ?? "gpt-5-codex",
    effort: session?.settings.workerEffort ?? globalConfig?.settings.workerEffort ?? "medium",
  };

  const assign = (target: ModelTarget) => {
    const effort = pickEffort(findModel(catalog, target.provider, target.model));
    return { provider: target.provider, model: target.model, ...(effort ? { effort } : {}) };
  };

  const setBuiltin = (roleId: BuiltinRoleDef["id"], target: ModelTarget | null) =>
    writeRoles((r) => {
      const next = { ...r };
      if (target) next[roleId] = assign(target);
      else delete next[roleId];
      return next;
    }, setPending);

  const setCustom = (customId: string, target: ModelTarget | null) =>
    writeRoles(
      (r) => ({
        ...r,
        custom: (r.custom || []).map((c) => {
          if (c.id !== customId) return c;
          const { provider: _p, model: _m, effort: _e, ...rest } = c;
          return target ? { ...rest, ...assign(target) } : rest;
        }),
      }),
      setPending
    );

  const remove = (customId: string) => writeRoles((r) => ({ ...r, custom: (r.custom || []).filter((c) => c.id !== customId) }), setPending);

  const add = (role: CustomRole) => writeRoles((r) => ({ ...r, custom: [...(r.custom || []), role] }), setPending);

  const full = customRoles.length >= MAX_CUSTOM_ROLES;

  return (
    <>
      <PageHeader
        title="Roles"
        description="The model each worker role runs on. A role left on Default worker runs on the shared worker from Models."
      />

      {catalog === null && catalogError && (
        <Callout
          tone="fail"
          part="catalog-error"
          action={
            <button type="button" className="btn sm" onClick={() => void loadCatalog(true)}>
              Try again
            </button>
          }
        >
          Couldn't list the models, so the pickers can't open: {catalogError}
        </Callout>
      )}

      <Section label="Built-in roles" hint="The lead hands work to these as worker tools.">
        {BUILTIN_ROLES.map((role) => {
          const a = roles[role.id];
          return (
            <Row
              key={role.id}
              part="role-row"
              label={
                <>
                  {role.title}
                  <AccessBadge access={role.access} />
                  <span className="settings-row-aside">{role.tool}</span>
                </>
              }
              hint={role.summary}
            >
              <ModelPicker
                catalog={catalog}
                value={a ? { provider: a.provider, model: a.model, effort: a.effort } : null}
                need={role.access}
                defaultWorker={defaultWorker}
                onChange={(next) => void setBuiltin(role.id, next)}
              />
            </Row>
          );
        })}
      </Section>

      <Section
        label="Custom roles"
        hint="A worker tool of your own: its instructions, what it may touch, and its model."
        part="custom-roles"
        actions={
          <button
            type="button"
            className="btn sm"
            data-part="custom-role-add"
            disabled={full}
            title={full ? `Kumo takes up to ${MAX_CUSTOM_ROLES} custom roles` : undefined}
            onClick={() => setAdding(true)}
          >
            <IconPlus />
            New role
          </button>
        }
      >
        {customRoles.length === 0 ? (
          <Note>No custom roles yet. A documentation writer or a security auditor, say, each with a model that suits it.</Note>
        ) : (
          customRoles.map((role) => (
            <Row
              key={role.id}
              part="custom-role-row"
              label={
                <>
                  {role.name}
                  <AccessBadge access={role.access} />
                  <span className="settings-row-aside">worker_{role.id}</span>
                </>
              }
              hint={role.description}
            >
              <ModelPicker
                catalog={catalog}
                value={role.provider && role.model ? { provider: role.provider, model: role.model, effort: role.effort } : null}
                need={role.access}
                defaultWorker={defaultWorker}
                onChange={(next) => void setCustom(role.id, next)}
              />
              <button
                type="button"
                className="btn sm icon danger"
                aria-label={`Delete ${role.name}`}
                data-tooltip="Delete"
                data-tooltip-pos="top"
                onClick={() => setRemoving({ id: role.id, name: role.name })}
              >
                <IconTrash />
              </button>
            </Row>
          ))
        )}
      </Section>

      {adding && (
        <NewRoleDialog
          takenIds={customRoles.map((c) => c.id)}
          defaultWorker={defaultWorker}
          onClose={() => setAdding(false)}
          onSave={async (role) => {
            const ok = await add(role);
            if (ok) setAdding(false);
            return ok;
          }}
        />
      )}

      {removing && <DeleteRoleDialog role={removing} onClose={() => setRemoving(null)} onConfirm={() => remove(removing.id)} />}
    </>
  );
}

function DeleteRoleDialog({ role, onClose, onConfirm }: { role: { id: string; name: string }; onClose: () => void; onConfirm: () => Promise<boolean> }) {
  const [busy, setBusy] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Modal
      title={`Delete ${role.name}?`}
      part="delete-role-dialog"
      initialFocus={cancel}
      onClose={() => {
        if (!busy) onClose();
      }}
      actions={
        <>
          <button ref={cancel} type="button" className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              if (await onConfirm()) onClose();
              else setBusy(false);
            }}
          >
            {busy ? "Deleting…" : "Delete role"}
          </button>
        </>
      }
    >
      <p>
        The lead loses the <code className="acct-code">worker_{role.id}</code> tool, and the role's instructions are gone. Chats that used it keep their
        history.
      </p>
    </Modal>
  );
}

function NewRoleDialog({
  takenIds,
  defaultWorker,
  onClose,
  onSave,
}: {
  takenIds: string[];
  defaultWorker: { provider: string; model: string; effort?: string };
  onClose: () => void;
  onSave: (role: CustomRole) => Promise<boolean>;
}) {
  const catalog = useStore((s) => s.catalog);
  const ids = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [roleId, setRoleId] = useState("");
  const [idEdited, setIdEdited] = useState(false);
  const [description, setDescription] = useState("");
  const [access, setAccess] = useState<"read" | "write">("read");
  const [model, setModel] = useState<ModelTarget | null>(null);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);

  const id = (idEdited ? roleId : slug(name)).trim().toLowerCase();
  const idProblem = !id
    ? "Give the role an id."
    : !ROLE_ID_PATTERN.test(id)
      ? "Lowercase letters, digits and hyphens, 2 to 31 characters, starting with a letter."
      : RESERVED_IDS.has(id)
        ? `"${id}" is taken by Kumo itself. Pick another.`
        : takenIds.includes(id)
          ? `You already have a role called "${id}".`
          : null;
  const nameProblem = !name.trim() ? "Give the role a name." : null;
  const descriptionProblem = !description.trim() ? "Say what the role does: the lead reads this to decide when to call it." : null;
  const problems = Boolean(idProblem || nameProblem || descriptionProblem);
  // Field errors show once a save was tried; the id's shows as soon as there's something wrong to show.
  const show = (problem: string | null, always = false) => (tried || always ? problem : null);

  const save = async () => {
    setTried(true);
    if (problems || saving) return;
    setSaving(true);
    const target = model ? { provider: model.provider, model: model.model } : null;
    const effort = model ? pickEffort(findModel(catalog, model.provider, model.model)) : undefined;
    const ok = await onSave({
      id,
      name: name.trim(),
      description: description.trim(),
      prompt: description.trim(),
      access,
      ...(target ? { ...target, ...(effort ? { effort } : {}) } : {}),
    });
    if (!ok) setSaving(false);
  };

  const idError = show(idProblem, Boolean(roleId || name) && idProblem !== "Give the role an id.");

  return (
    <Modal
      title="New custom role"
      description="A worker tool of your own. The lead sees its name and description, and calls it when the work fits."
      size="md"
      part="new-role-dialog"
      initialFocus={nameRef}
      onClose={() => {
        if (!saving) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          void save();
        }
      }}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="btn primary" data-part="new-role-create" onClick={() => void save()} disabled={saving}>
            {saving ? "Creating…" : "Create role"}
          </button>
        </>
      }
    >
      <div className="form-stack">
        <div className="form-field">
          <label className="form-label" htmlFor={`${ids}-name`}>
            Name
          </label>
          <input
            ref={nameRef}
            id={`${ids}-name`}
            className="field"
            placeholder="Docs writer"
            maxLength={MAX_NAME}
            value={name}
            aria-invalid={show(nameProblem) ? true : undefined}
            aria-describedby={show(nameProblem) ? `${ids}-name-error` : undefined}
            onChange={(e) => setName(e.target.value)}
          />
          {show(nameProblem) && (
            <span className="form-hint" data-tone="fail" id={`${ids}-name-error`}>
              {nameProblem}
            </span>
          )}
        </div>

        <div className="form-field">
          <label className="form-label" htmlFor={`${ids}-id`}>
            Id
            <span className="form-label-aside">worker_{id || "…"}</span>
          </label>
          <input
            id={`${ids}-id`}
            className="field"
            data-mono
            spellCheck={false}
            autoComplete="off"
            maxLength={31}
            placeholder="docs-writer"
            value={idEdited ? roleId : slug(name)}
            aria-invalid={idError ? true : undefined}
            aria-describedby={`${ids}-id-hint`}
            onChange={(e) => {
              setIdEdited(true);
              setRoleId(e.target.value);
            }}
          />
          <span className="form-hint" id={`${ids}-id-hint`} data-tone={idError ? "fail" : undefined}>
            {idError ?? "The tool name the lead calls. Made from the name; edit it if you like."}
          </span>
        </div>

        <div className="form-field">
          <label className="form-label" htmlFor={`${ids}-desc`}>
            What it does
          </label>
          <textarea
            id={`${ids}-desc`}
            className="field"
            maxLength={MAX_DESCRIPTION}
            placeholder="Writes and updates user-facing documentation to match the code. Never edits source files."
            value={description}
            aria-invalid={show(descriptionProblem) ? true : undefined}
            aria-describedby={`${ids}-desc-hint`}
            onChange={(e) => setDescription(e.target.value)}
          />
          <span className="form-hint" id={`${ids}-desc-hint`} data-tone={show(descriptionProblem) ? "fail" : undefined}>
            {show(descriptionProblem) ?? `Also its instructions. ${description.length}/${MAX_DESCRIPTION}`}
          </span>
        </div>

        <div className="form-field">
          <span className="form-label" id={`${ids}-access`}>
            Access
          </span>
          <Segmented
            value={access}
            label="Access"
            options={[
              ["read", "Read-only"],
              ["write", "Can edit files"],
            ]}
            onChange={(v) => {
              setAccess(v);
              // A model that can't write doesn't fit a role that edits.
              if (v === "write" && model && catalog?.find((p) => p.provider === model.provider)?.canWrite === false) setModel(null);
            }}
          />
        </div>

        <div className="form-field">
          <span className="form-label" id={`${ids}-model`}>
            Model
          </span>
          <ModelPicker
            catalog={catalog}
            value={model}
            need={access}
            defaultWorker={defaultWorker}
            labelledBy={`${ids}-model`}
            onChange={setModel}
          />
        </div>
      </div>
    </Modal>
  );
}
