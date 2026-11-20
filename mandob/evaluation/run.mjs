// Default is estimate-only. Live evaluation never deploys or creates resources.
import { mkdir, writeFile } from "node:fs/promises";
import { cases, score } from "./cases.mjs";
import {
  TEXT_MODELS,
  analysisInput,
  textOutput,
  usageOf,
  estimatedNeurons,
} from "../src/text-models.mjs";
export function estimateSuite(input = 500, output = 250) {
  return Object.keys(TEXT_MODELS).map((model) => ({
    model,
    cases: cases.length,
    assumed_input_tokens_per_case: input,
    assumed_output_tokens_per_case: output,
    estimated_neurons: estimatedNeurons(model, input, output) * cases.length,
    quality_score: null,
  }));
}
export async function quotaSnapshot(account, request) {
  const now = new Date(),
    start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const query = `{viewer{accounts(filter:{accountTag:"${account}"}){aiInferenceAdaptiveGroups(limit:10000,filter:{datetime_geq:"${start.toISOString()}",datetime_leq:"${now.toISOString()}"}){sum{totalNeurons totalInputTokens totalOutputTokens}}}}}`;
  const result = await request("/graphql", { query }, false);
  if (result.errors?.length) throw new Error("quota_unavailable");
  const rows = result.data?.viewer?.accounts?.[0]?.aiInferenceAdaptiveGroups;
  if (!Array.isArray(rows)) throw new Error("quota_unavailable");
  return {
    observed_used_neurons: rows.reduce(
      (n, x) => n + Number(x.sum.totalNeurons || 0),
      0,
    ),
    remaining_estimated:
      10000 - rows.reduce((n, x) => n + Number(x.sum.totalNeurons || 0), 0),
    observed_at: now.toISOString(),
    source: "adaptive analytics; may lag, not billing-authoritative",
  };
}
export async function runLive({
  account,
  request,
  freeConfirmed,
  maxCalls = 36,
  maxEstimatedNeurons = 2000,
}) {
  if (!freeConfirmed) throw new Error("free_plan_not_confirmed");
  const results = [];
  let calls = 0,
    reserved = 0;
  for (const model of Object.keys(TEXT_MODELS)) {
    // Catalog access is a prerequisite, not a successful inference test.
    const catalog = await request(
      `/accounts/${account}/ai/models/search?search=${encodeURIComponent(model)}`,
      null,
    );
    if (
      catalog.success === false ||
      !Array.isArray(catalog.result) ||
      !catalog.result.some((x) => x.name === model)
    )
      throw new Error("model_catalog_not_verified");
    for (const c of cases) {
      const quota = await quotaSnapshot(account, request);
      const input = analysisInput(c.history, c.text);
      const bytes = Buffer.byteLength(JSON.stringify(input.messages), "utf8");
      if (bytes > 6000) throw new Error("benchmark_input_too_large");
      const upper = estimatedNeurons(model, bytes + 1024, input.max_tokens);
      if (
        calls >= maxCalls ||
        reserved + upper > maxEstimatedNeurons ||
        quota.remaining_estimated < reserved + upper + 1000
      )
        throw new Error("evaluation_budget_stop");
      reserved += upper;
      calls++;
      const start = Date.now();
      const response = await request(
        `/accounts/${account}/ai/run/${model}`,
        input,
      );
      const result = response.result ?? response;
      let parsed = null;
      try {
        parsed = JSON.parse(textOutput(result));
      } catch {}
      results.push({
        model,
        case: c.id,
        latency_ms: Date.now() - start,
        usage: usageOf(result, model),
        output: parsed ?? textOutput(result),
        score: parsed ? score(parsed, c) : null,
        quota_before: quota,
      });
    }
  }
  return {
    results,
    calls,
    conservatively_reserved_neurons: reserved,
    quality_requires_manual_review: true,
  };
}
if (process.argv.includes("--live")) {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!/^[a-f0-9]{32}$/.test(account || ""))
    throw new Error("account_required");
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error("authorization_required");
  const request = async (path, payload, wrapped = true) => {
    const r = await fetch("https://api.cloudflare.com/client/v4" + path, {
      method: payload ? "POST" : "GET",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(60000),
    });
    const d = await r.json();
    if (!r.ok || (wrapped && d.success === false))
      throw new Error("cloudflare_request_rejected_" + r.status);
    return d;
  };
  const report = await runLive({
    account,
    request,
    freeConfirmed: process.env.WORKERS_FREE_CONFIRMED === "true",
  });
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/ai-live.json", JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({ calls: report.calls, report: "artifacts/ai-live.json" }),
  );
} else if (process.argv[1]?.endsWith("/run.mjs"))
  console.log(
    JSON.stringify(
      {
        mode: "estimate_only",
        no_model_calls: true,
        estimates: estimateSuite(),
      },
      null,
      2,
    ),
  );
