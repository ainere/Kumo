/**
 * Settings › Doctor: checks Node, Git, the provider CLIs, the MCP bridge and
 * the engine's files, repairs what it can in one click, and copies a report.
 */

import { useEffect, useRef, useState } from "react";
import { useStore } from "../../store";
import type { DoctorCheck, DoctorResult, RepairResult } from "../../types";
import { IconCheck, IconCopy, IconRefresh } from "../icons";
import { Badge, Callout, PageHeader, Row, Section, StatusDot } from "./controls";

const GROUPS: ReadonlyArray<{ key: DoctorCheck["group"]; label: string; hint: string }> = [
  { key: "runtime", label: "Runtime", hint: "Node, Git, Kumo's own folder and config, and the worker logs." },
  { key: "providers", label: "Providers", hint: "The provider CLIs, whether each is signed in, and the API keys in your environment." },
  { key: "bridge", label: "Bridge and engine", hint: "The MCP server workers run through, and how the engine talks to it." },
  { key: "permissions", label: "Permissions", hint: "What Kumo may read and write in this workspace, and the tool configs it relies on." },
];

const COPIED_MS = 2400;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function DoctorTab() {
  const workspace = useStore((s) => s.session?.workspace);
  const [checks, setChecks] = useState<DoctorCheck[] | null>(null);
  const [ranAt, setRanAt] = useState<number | null>(null);
  const [scanning, setScanning] = useState(false);
  const [repairing, setRepairing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repaired, setRepaired] = useState<{ ok: boolean; detail: string } | null>(null);
  const [copied, setCopied] = useState(false);
  // The latest run wins, and nothing lands after the page has gone.
  const run = useRef(0);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const runChecks = async () => {
    const mine = ++run.current;
    setScanning(true);
    setError(null);
    try {
      const res = (await window.kumo.invoke("doctor.run", { workspace: workspace || undefined })) as DoctorResult;
      if (!live.current || run.current !== mine) return;
      setChecks(res.checks);
      setRanAt(res.ranAt);
    } catch (err) {
      if (live.current && run.current === mine) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (live.current && run.current === mine) setScanning(false);
    }
  };

  const runRepair = async (id: string) => {
    setRepairing(id);
    setRepaired(null);
    try {
      const res = (await window.kumo.invoke("doctor.repair", { id, workspace: workspace || undefined })) as RepairResult;
      if (!live.current) return;
      setRepaired({ ok: res.ok, detail: res.detail });
      if (res.checks && res.checks.length > 0) {
        run.current++;
        setChecks(res.checks);
        setRanAt(Date.now());
        setScanning(false);
      } else {
        await runChecks();
      }
    } catch (err) {
      if (live.current) setRepaired({ ok: false, detail: `The repair failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      if (live.current) setRepairing(null);
    }
  };

  const copyReport = async () => {
    try {
      const res = (await window.kumo.invoke("doctor.report", { workspace: workspace || undefined })) as { markdown: string };
      await navigator.clipboard.writeText(res.markdown);
      if (live.current) setCopied(true);
    } catch (err) {
      if (live.current) setError(`Couldn't copy the report: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    void runChecks();
  }, [workspace]);

  const count = (status: DoctorCheck["status"]) => checks?.filter((c) => c.status === status).length ?? 0;
  const passed = count("ok");
  const warned = count("warn");
  const failed = count("fail");
  const overall = failed > 0 ? "fail" : warned > 0 ? "warn" : "ok";
  const headline =
    failed > 0 ? `${plural(failed, "check")} failed`
    : warned > 0 ? `${plural(warned, "warning")} to look at`
    : "Everything checks out";
  const busy = scanning || repairing !== null;

  return (
    <>
      <PageHeader
        title="Doctor"
        description="Checks what Kumo depends on, repairs what it can, and writes a report you can paste into an issue."
        actions={
          <>
            <button type="button" className="btn" data-part="doctor-copy" onClick={() => void copyReport()} disabled={!checks}>
              {copied ? <IconCheck /> : <IconCopy />}
              {copied ? "Copied" : "Copy report"}
            </button>
            <button type="button" className="btn" data-part="doctor-run" aria-busy={scanning || undefined} onClick={() => void runChecks()} disabled={busy}>
              <IconRefresh />
              {scanning ? "Checking…" : "Run again"}
            </button>
          </>
        }
      />

      <div className="doctor-summary" data-status={checks ? overall : "idle"} aria-busy={scanning || undefined} role="status" data-part="doctor-summary">
        {checks ? (
          <>
            <StatusDot status={overall} />
            <div className="doctor-summary-text">
              <div className="doctor-summary-head">{headline}</div>
              <div className="doctor-summary-sub">
                {plural(passed, "passed", "passed")}
                {warned > 0 && <> · {plural(warned, "warning")}</>}
                {failed > 0 && <> · {failed} failed</>}
                {ranAt && <> · Checked at {new Date(ranAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</>}
              </div>
            </div>
            {scanning && <span className="doctor-summary-note">Checking again…</span>}
          </>
        ) : (
          <>
            <span className="wave" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <div className="doctor-summary-text">
              <div className="doctor-summary-head">{error ? "The checks didn't run" : "Checking your setup…"}</div>
              <div className="doctor-summary-sub">Node, Git, the provider CLIs and the bridge.</div>
            </div>
          </>
        )}
      </div>

      {error && (
        <Callout
          tone="fail"
          part="doctor-error"
          action={
            <button type="button" className="btn sm" onClick={() => setError(null)}>
              Dismiss
            </button>
          }
        >
          {error}
        </Callout>
      )}

      {repaired && (
        <Callout
          tone={repaired.ok ? "ok" : "fail"}
          part="doctor-repair-result"
          action={
            <button type="button" className="btn sm" onClick={() => setRepaired(null)}>
              Dismiss
            </button>
          }
        >
          {repaired.detail}
        </Callout>
      )}

      {checks &&
        GROUPS.map(({ key, label, hint }) => {
          const list = checks.filter((c) => c.group === key);
          if (list.length === 0) return null;
          return (
            <Section key={key} label={label} hint={hint} part={`doctor-${key}`}>
              {list.map((check) => (
                <Row
                  key={check.id}
                  part="doctor-check"
                  label={
                    <>
                      <StatusDot status={check.status} />
                      {check.label}
                    </>
                  }
                  hint={check.detail}
                >
                  {check.repair && check.status !== "ok" && (
                    <button
                      type="button"
                      className={check.status === "fail" ? "btn sm primary" : "btn sm"}
                      data-part="doctor-repair"
                      aria-busy={repairing === check.repair.id || undefined}
                      disabled={busy}
                      onClick={() => void runRepair(check.repair!.id)}
                    >
                      {repairing === check.repair.id ? "Repairing…" : check.repair.label}
                    </button>
                  )}
                  {check.status !== "ok" && <Badge tone={check.status}>{check.status === "warn" ? "Warning" : "Failed"}</Badge>}
                </Row>
              ))}
            </Section>
          );
        })}
    </>
  );
}
