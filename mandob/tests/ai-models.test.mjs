import test from "node:test";
import assert from "node:assert/strict";
import {
  modelFor,
  textOutput,
  estimatedNeurons,
  analysisInput,
} from "../src/text-models.mjs";
import { groundedExtract } from "../src/ai.mjs";
import { receive, drain } from "../src/memory.mjs";
import { fixture, event } from "./helpers.mjs";
import { estimateSuite, runLive } from "../evaluation/run.mjs";
test("only reviewed text models are accepted; no paid or Gateway fallback", () => {
  for (const m of [
    "@cf/openai/gpt-oss-120b",
    "@cf/google/gemma-4-26b-a4b-it",
    "@cf/zai-org/glm-4.7-flash",
  ])
    assert.equal(modelFor(m), m);
  for (const m of [
    "@cf/zai-org/glm-5.2",
    "openai/gpt-4",
    "https://gateway.ai.cloudflare.com",
  ])
    assert.throws(() => modelFor(m));
});
test("native, chat and Responses output normalization ignores reasoning content", () => {
  assert.equal(textOutput({ response: "{}" }), "{}");
  assert.equal(
    textOutput({
      choices: [{ message: { content: "{}", reasoning_content: "private" } }],
    }),
    "{}",
  );
  assert.equal(
    textOutput({
      output: [
        { type: "reasoning", content: [{ type: "text", text: "private" }] },
        { type: "message", content: [{ type: "output_text", text: "{}" }] },
      ],
    }),
    "{}",
  );
});
test("comparison fixture covers dialogue, incomplete details, correction and injection with explicit estimates", () => {
  assert.equal(estimateSuite().length, 3);
  assert(
    estimateSuite().every((x) => x.cases === 12 && x.quality_score === null),
  );
  assert.equal(
    estimatedNeurons("@cf/google/gemma-4-26b-a4b-it", 500, 250),
    11.36375,
  );
  assert.equal(analysisInput(["أول رسالة"], "رد ثان").messages.length, 3);
});
test("conversation context is loaded from encrypted same-page D1 memory and proposals stay private", async () => {
  const { env, sql } = fixture();
  await receive(env, event("عندي ثلاجة للبيع"));
  await drain(env);
  const item = sql.prepare("SELECT * FROM items").get();
  await receive(env, event("كاونتر للبيع", "other", "333"));
  await drain(env);
  sql.prepare("INSERT INTO settings(page_id,ai) VALUES(?,1)").run("111");
  env.ALLOW_AI = "true";
  env.AI_DAILY_CALL_LIMIT = "2";
  env.TEXT_MODEL = "@cf/zai-org/glm-4.7-flash";
  let prompt;
  env.AI = {
    run: async (model, input) => {
      assert.equal(model, env.TEXT_MODEL);
      prompt = input;
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: "ثلاجة",
                area: "مكان مخترع",
                reply: "هذه مسودة لا تُرسل",
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      };
    },
  };
  const r = await groundedExtract(
    env,
    "نفس الغرض",
    { intent: "unclear", title: null, area: null },
    { conversationId: item.conversation_id, itemId: item.id },
  );
  assert.equal(r.title, "ثلاجة");
  assert.equal(r.area, null);
  assert(!JSON.stringify(prompt).includes("كاونتر"));
  assert.equal(sql.prepare("SELECT count(*) n FROM ai_analyses").get().n, 1);
  assert.equal(sql.prepare("SELECT count(*) n FROM outbox").get().n, 0);
  assert.equal(
    sql.prepare("SELECT input_tokens FROM ai_analyses").get().input_tokens,
    100,
  );
});
test("disabled AI does not call a model, even with binding configured", async () => {
  const { env } = fixture();
  let calls = 0;
  env.AI = {
    run: async () => {
      calls++;
    },
  };
  await assert.rejects(groundedExtract(env, "ثلاجة", {}), /ai_not_enabled/);
  assert.equal(calls, 0);
});
test("live evaluation stops before inference if catalog authorization fails", async () => {
  let calls = 0;
  await assert.rejects(
    runLive({
      account: "a".repeat(32),
      freeConfirmed: true,
      request: async (path) => {
        if (path.includes("/run/")) calls++;
        throw new Error("cloudflare_request_rejected_403");
      },
    }),
    /403/,
  );
  assert.equal(calls, 0);
});
test("live evaluation refuses unverified plan and low quota before any model invocation", async () => {
  await assert.rejects(
    runLive({
      account: "a".repeat(32),
      freeConfirmed: false,
      request: async () => {
        throw new Error("must not call");
      },
    }),
    /free_plan/,
  );
  let calls = 0;
  await assert.rejects(
    runLive({
      account: "a".repeat(32),
      freeConfirmed: true,
      request: async (path) => {
        if (path.includes("/models/"))
          return { result: [{ name: "@cf/openai/gpt-oss-120b" }] };
        if (path === "/graphql")
          return {
            data: {
              viewer: {
                accounts: [
                  {
                    aiInferenceAdaptiveGroups: [
                      { sum: { totalNeurons: 9999 } },
                    ],
                  },
                ],
              },
            },
          };
        calls++;
      },
    }),
    /budget_stop/,
  );
  assert.equal(calls, 0);
});
test('reported neuron usage is preserved separately from a token-derived estimate',async()=>{const {usageOf}=await import('../src/text-models.mjs');const u=usageOf({usage:{prompt_tokens:20,completion_tokens:32,neurons:1.0545454025268555}},'@cf/google/gemma-4-26b-a4b-it');assert.equal(u.neurons_actual,1.0545454025268555);assert.equal(u.input_tokens,20);assert.notEqual(u.neurons_estimated,null);});
