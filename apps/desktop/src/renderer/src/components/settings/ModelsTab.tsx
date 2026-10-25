/**
 * Settings › Models: the lead (orchestrator) and the shared worker, their
 * reasoning effort, and which providers the catalog can offer.
 */

import { useEffect, useState } from "react";
import { loadCatalog, loadGlobalConfig, updateSettings, useStore } from "../../store";
import { IconRefresh } from "../icons";
import { Badge, Note, PageHeader, Row, Section, Segmented, StatusDot } from "./controls";
import {
  effortLabel,
  effortsOf,
  findModel,
  ModelPicker,
  pickEffort,
  type ModelTarget,
} from "./ModelPicker";

export function ModelsTab() {
  const catalog = useStore((s) => s.catalog);
  const session = useStore((s) => s.session);
  const globalConfig = useStore((s) => s.globalConfig);
  const catalogError = useStore((s) => s.loadErrors.catalog);
  const [refreshing, setRefreshing] = useState(false);

  const refreshCatalog = async () => {
    setRefreshing(true);
    await loadCatalog(true);
    setRefreshing(false);
  };

  useEffect(() => {
    if (!catalog) void loadCatalog();
    if (!globalConfig) void loadGlobalConfig();
  }, [catalog, globalConfig]);

  const orchProvider = session?.settings.orchestratorProvider ?? globalConfig?.settings.orchestratorProvider ?? "codex";
  const orchModel = session?.settings.orchestratorModel ?? globalConfig?.settings.orchestratorModel ?? "gpt-5-codex";
  const orchEffort = session?.settings.reasoningEffort ?? globalConfig?.settings.reasoningEffort ?? "medium";

  const workerProvider = session?.settings.workerProvider ?? globalConfig?.settings.workerProvider ?? "codex";
  const workerModel = session?.settings.workerModel ?? globalConfig?.settings.workerModel ?? "gpt-5-codex";
  const workerEffort = session?.settings.workerEffort ?? globalConfig?.settings.workerEffort ?? "medium";

  const leadModelObj = findModel(catalog, orchProvider, orchModel);
  const leadEfforts = effortsOf(leadModelObj);

  const workerModelObj = findModel(catalog, workerProvider, workerModel);
  const workerEfforts = effortsOf(workerModelObj);

  // A saved effort the model doesn't have (Max on a Gemini model, say, from
  // before the model changed) shows as the nearest one it does, which is what
  // it runs at (agy takes Max as High). The setting itself is left alone:
  // roles with a model of their own inherit `workerEffort`, and rewriting the
  // lead's mid-turn would restart it.
  const leadFit = pickEffort(leadModelObj, orchEffort);
  const workerFit = pickEffort(workerModelObj, workerEffort);

  const handleLeadChange = async (target: ModelTarget | null) => {
    if (!target) return;
    const model = findModel(catalog, target.provider, target.model);
    const effort = pickEffort(model, orchEffort);
    await updateSettings({
      orchestratorProvider: target.provider,
      orchestratorModel: target.model,
      ...(effort ? { reasoningEffort: effort } : {}),
    });
  };

  const handleWorkerChange = async (target: ModelTarget | null) => {
    if (!target) return;
    const model = findModel(catalog, target.provider, target.model);
    const effort = pickEffort(model, workerEffort);
    await updateSettings({
      workerProvider: target.provider,
      workerModel: target.model,
      ...(effort ? { workerEffort: effort } : {}),
    });
  };

  const handleLeadEffortChange = async (effort: string) => {
    await updateSettings({ reasoningEffort: effort });
  };

  const handleWorkerEffortChange = async (effort: string) => {
    await updateSettings({ workerEffort: effort });
  };

  return (
    <>
      <PageHeader title="Models" description="The lead that plans and delegates, and the shared worker every role without its own model runs on." />

      <Section label="Lead" hint="Breaks the work down, makes the architecture calls and hands bounded tasks to the worker roles.">
        <Row label="Model" hint="Codex, Claude and Antigravity can lead: they call Kumo's worker tools.">
          <ModelPicker
            catalog={catalog}
            value={{ provider: orchProvider, model: orchModel, effort: orchEffort }}
            need="lead"
            onChange={(next) => void handleLeadChange(next)}
          />
        </Row>
        {leadEfforts.length > 1 && (
          <Row label="Reasoning effort" hint="More thinking per turn: better plans, slower and costlier turns.">
            <Segmented
              value={leadFit ?? orchEffort}
              options={leadEfforts.map((e) => [e, effortLabel(orchProvider, e)])}
              onChange={(e) => void handleLeadEffortChange(e)}
            />
          </Row>
        )}
      </Section>

      <Section label="Shared worker" hint="Runs every worker role that has no model of its own (Settings › Roles).">
        <Row label="Model" hint="Needs to be able to edit files: builder, tester and designer run on it.">
          <ModelPicker
            catalog={catalog}
            value={{ provider: workerProvider, model: workerModel, effort: workerEffort }}
            need="write"
            onChange={(next) => void handleWorkerChange(next)}
          />
        </Row>
        {workerEfforts.length > 1 && (
          <Row label="Reasoning effort">
            <Segmented
              value={workerFit ?? workerEffort}
              options={workerEfforts.map((e) => [e, effortLabel(workerProvider, e)])}
              onChange={(e) => void handleWorkerEffortChange(e)}
            />
          </Row>
        )}
      </Section>

      <Section
        label="Providers"
        hint="What each provider can offer right now. Sign in or set keys in Accounts."
        part="model-catalog"
        actions={
          <button
            type="button"
            className="btn sm"
            data-part="catalog-refresh"
            aria-busy={refreshing || undefined}
            disabled={refreshing}
            onClick={() => void refreshCatalog()}
          >
            <IconRefresh />
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        }
      >
        {catalog ? (
          catalog.map((p) => (
            <Row
              key={p.provider}
              part="catalog-provider"
              label={
                <>
                  <StatusDot status={p.available ? "ok" : "idle"} />
                  {p.name}
                </>
              }
              hint={
                p.available
                  ? `${p.models.length} model${p.models.length === 1 ? "" : "s"}, ${p.source === "live" ? "listed by the provider" : "from Kumo's built-in list"}`
                  : "Not signed in, or no API key"
              }
            >
              {p.canLead && <Badge tone="accent">Can lead</Badge>}
              {p.canWrite && <Badge>Can edit files</Badge>}
              <Badge mono>{p.kind}</Badge>
            </Row>
          ))
        ) : catalogError ? (
          <Note>Couldn't list the models: {catalogError}. Refresh to try again.</Note>
        ) : (
          <Note>Listing the models each provider offers…</Note>
        )}
      </Section>
    </>
  );
}
