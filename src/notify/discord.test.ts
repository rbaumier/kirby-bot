import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { buildDiscordPayload, notifyIssueEnd, type IssueEndNotification } from "./discord";

type Embed = {
  readonly title: string;
  readonly color: number;
  readonly description?: string;
  readonly fields: ReadonlyArray<{ readonly name: string; readonly value: string; readonly inline?: boolean }>;
};

const embedOf = (payload: Record<string, unknown>): Embed =>
  (payload.embeds as ReadonlyArray<Embed>)[0]!;

describe("buildDiscordPayload", () => {
  const base: IssueEndNotification = {
    category: "failure",
    headline: "**AFK failed**",
    issue: { iid: 42, title: "Fix the thing" },
    branch: "afk/42-fix",
    pullRequestIid: 7,
    fixCycles: 2,
    reason: "the agent **judged** it unfixable",
  };

  it("strips markdown from the title and description", () => {
    const embed = embedOf(buildDiscordPayload(base));
    expect(embed.title).toBe("❌ #42 — AFK failed");
    expect(embed.description).toBe("the agent judged it unfixable");
  });

  it("renders branch, PR and fix cycles as fields", () => {
    expect(embedOf(buildDiscordPayload(base)).fields).toEqual([
      { name: "Issue", value: "#42 — Fix the thing" },
      { name: "Branch", value: "afk/42-fix", inline: true },
      { name: "PR", value: "#7", inline: true },
      { name: "Fix cycles", value: "2", inline: true },
    ]);
  });

  it("omits absent fields and the description rather than rendering empty rows", () => {
    const embed = embedOf(
      buildDiscordPayload({
        category: "success",
        headline: "merged",
        issue: { iid: 9, title: "Ship it" },
        pullRequestIid: 3,
      }),
    );
    expect(embed.description).toBeUndefined();
    expect(embed.fields).toEqual([
      { name: "Issue", value: "#9 — Ship it" },
      { name: "PR", value: "#3", inline: true },
    ]);
  });

  it("keeps fixCycles: 0 (a real value, not absence)", () => {
    const fields = embedOf(buildDiscordPayload({ ...base, fixCycles: 0 })).fields;
    expect(fields.some((f) => f.name === "Fix cycles")).toBe(true);
  });

  it("colours each category distinctly", () => {
    expect(embedOf(buildDiscordPayload({ ...base, category: "success" })).color).toBe(0x2ecc71);
    expect(embedOf(buildDiscordPayload({ ...base, category: "failure" })).color).toBe(0xe74c3c);
    expect(embedOf(buildDiscordPayload({ ...base, category: "requeued" })).color).toBe(0xf39c12);
  });

  it("omits the username when no source is given", () => {
    expect(buildDiscordPayload(base).username).toBeUndefined();
  });

  it("sets username to repo + runId so concurrent processes stay distinguishable", () => {
    const payload = buildDiscordPayload({
      ...base,
      source: { repo: "rbaumier/kirby-bot", runId: "20260531_143022-a3f9c1" },
    });
    expect(payload.username).toBe("kirby · rbaumier/kirby-bot · 20260531_143022-a3f9c1");
  });

  it("caps the username at Discord's 80-char limit", () => {
    const payload = buildDiscordPayload({
      ...base,
      source: { repo: "very-long-org/" + "x".repeat(80), runId: "20260531_143022-a3f9c1" },
    });
    expect((payload.username as string).length).toBeLessThanOrEqual(80);
  });
});

describe("notifyIssueEnd", () => {
  const notification: IssueEndNotification = {
    category: "success",
    headline: "merged",
    issue: { iid: 42, title: "Fix the thing" },
    pullRequestIid: 7,
  };

  const originalFetch = globalThis.fetch;
  const savedUrl = process.env.KIRBY_DISCORD_WEBHOOK_URL;
  let calls: Array<{ url: string; body: string }>;

  beforeEach(() => {
    calls = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (savedUrl === undefined) delete process.env.KIRBY_DISCORD_WEBHOOK_URL;
    else process.env.KIRBY_DISCORD_WEBHOOK_URL = savedUrl;
  });

  it("is a no-op when the webhook env var is unset — no network call", async () => {
    delete process.env.KIRBY_DISCORD_WEBHOOK_URL;
    await Effect.runPromise(notifyIssueEnd(notification));
    expect(calls).toHaveLength(0);
  });

  it("POSTs the payload to the configured webhook URL", async () => {
    process.env.KIRBY_DISCORD_WEBHOOK_URL = "https://discord.test/webhook/abc";
    await Effect.runPromise(notifyIssueEnd(notification));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://discord.test/webhook/abc");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual(buildDiscordPayload(notification));
  });

  it("swallows a non-2xx response — never fails the run", async () => {
    process.env.KIRBY_DISCORD_WEBHOOK_URL = "https://discord.test/webhook/abc";
    globalThis.fetch = (async () =>
      new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
    await Effect.runPromise(notifyIssueEnd(notification));
  });

  it("swallows a network error — never fails the run", async () => {
    process.env.KIRBY_DISCORD_WEBHOOK_URL = "https://discord.test/webhook/abc";
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    await Effect.runPromise(notifyIssueEnd(notification));
  });
});
