import { Fragment, memo, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { formatElapsed, providerLabel, toolLabel, useNow } from "../lib";
import { resolveApproval, revealDiff, toastFailure, useStore } from "../store";
import type { Approval, Message } from "../types";

const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // Links open in the system browser (the main process routes them).
        components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

export function ToolCard({ toolId }: { toolId: string }) {
  const tool = useStore((s) => s.tools[toolId]);
  const now = useNow(tool?.status === "running");
  if (!tool) return null;
  // A restored call that never reported its time has 0: leave the time out.
  const known = tool.status === "running" || Boolean(tool.elapsedMs);
  const elapsed = formatElapsed(tool.elapsedMs ?? now - tool.startedAt);
  const status = known ? `${tool.status} · ${elapsed}` : tool.status;
  return (
    <div className="tool-card" data-part="tool-card" data-status={tool.status} title={tool.task}>
      <span className={tool.status === "running" ? "dot pulse" : "dot"} />
      <span className="tool-name">{toolLabel(tool.name)}</span>
      <span className="tool-model">{[tool.model, tool.effort].filter(Boolean).join(" · ")}</span>
      <span className="spacer" />
      <span className="tool-status">{status}</span>
    </div>
  );
}

const UserMessage = memo(function UserMessage({ message }: { message: Message }) {
  return (
    <div className="msg-user glass" data-part="message-user">
      {message.text}
    </div>
  );
});

const LeadMessage = memo(function LeadMessage({ message }: { message: Message }) {
  const settings = useStore((s) => s.session?.settings);
  // A restored turn names the lead it ran on; a live one, the current lead.
  const ran = useStore((s) => (message.turnId ? s.turnMeta[message.turnId] : undefined));
  const lead = ran?.provider
    ? [providerLabel(ran.provider), ran.model].filter(Boolean).join(" · ")
    : settings
      ? `${providerLabel(settings.orchestratorProvider)} · ${settings.orchestratorModel}`
      : "lead";
  return (
    <article className="msg-lead glass" data-part="message-lead" aria-busy={message.streaming}>
      <div className="msg-meta">
        <span className={message.streaming ? "dot pulse" : "dot"} />
        <span>{lead}</span>
        {message.thinking && <span className="thinking">thinking…</span>}
      </div>
      {message.parts.map((part, i) =>
        part.kind === "tool" ? <ToolCard key={part.toolId} toolId={part.toolId} /> : <Markdown key={i} text={part.text} />
      )}
      {message.failed && <div className="msg-failed">{message.failed}</div>}
      {!message.streaming && !message.text && !message.failed && message.parts.length === 0 && (
        <div className="muted small">No answer recorded for this turn.</div>
      )}
    </article>
  );
});

/** Above a restored turn that began on another provider, with the earlier turns replayed into it. */
function ReplayDivider({ provider }: { provider: string | null }) {
  const name = providerLabel(provider) || "another provider";
  return (
    <div className="turn-divider" data-part="turn-divider">
      <span className="glass">Continued on {name} · earlier turns replayed into its context</span>
    </div>
  );
}

function Diff({ text }: { text: string }) {
  return (
    <pre className="diff">
      {text.split("\n").map((line, i) => {
        const kind =
          line.startsWith("+") && !line.startsWith("+++")
            ? "add"
            : line.startsWith("-") && !line.startsWith("---")
              ? "del"
              : line.startsWith("@@")
                ? "hunk"
                : undefined;
        return (
          <span key={i} className={kind}>
            {line}
            {"\n"}
          </span>
        );
      })}
    </pre>
  );
}

export function ApprovalCard({ approval }: { approval: Approval }) {
  const [sending, setSending] = useState(false);
  const decide = async (approved: boolean) => {
    setSending(true);
    try {
      await resolveApproval(approval.approvalId, approved);
    } catch (err) {
      toastFailure(err);
      setSending(false);
    }
  };
  const what = approval.kind === "write" ? "Apply this worker change?" : "The lead's CLI asks to go ahead";
  return (
    <section className="approval glass-strong" data-part="approval" aria-label="Approval needed">
      <div className="approval-strip">
        Approval needed · {approval.tool}
      </div>
      <div className="approval-body">
        <div>{what}</div>
        {approval.kind === "write" ? <Diff text={approval.preview} /> : <pre className="diff">{approval.preview}</pre>}
        <div className="approval-actions">
          <button className="btn" disabled={sending} onClick={() => void decide(false)}>
            Reject
          </button>
          <button className="btn primary" disabled={sending} onClick={() => void decide(true)}>
            Approve
          </button>
        </div>
      </div>
    </section>
  );
}

/** Approvals are answered in the Diff tab, next to the changes. The chat points there. */
function ApprovalNotice({ approval }: { approval: Approval }) {
  return (
    <section className="approval-notice glass-strong" data-part="approval-notice" aria-label="Approval needed">
      <span className="approval-notice-text">Approval needed · {approval.tool}</span>
      <button className="btn primary" onClick={() => revealDiff()}>
        Review
      </button>
    </section>
  );
}

export function Conversation() {
  const messages = useStore((s) => s.messages);
  const turnMeta = useStore((s) => s.turnMeta);
  const approvals = useStore((s) => s.approvals);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Follow the answer as it streams, unless the reader scrolled up.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  return (
    <div
      className="transcript"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      <div className="column">
        {messages.map((m) => {
          const meta = m.kind === "user" && m.turnId ? turnMeta[m.turnId] : undefined;
          return (
            <Fragment key={m.id}>
              {meta?.replayed && <ReplayDivider key="divider" provider={meta.provider} />}
              {m.kind === "user" ? <UserMessage key="message" message={m} /> : <LeadMessage key="message" message={m} />}
            </Fragment>
          );
        })}
        {approvals.map((a) => (
          <ApprovalNotice key={a.approvalId} approval={a} />
        ))}
      </div>
    </div>
  );
}
