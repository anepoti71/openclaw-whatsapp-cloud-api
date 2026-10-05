import { describe, it, expect, vi } from "vitest";
import { resolveInboundRoute } from "../index.js";

describe("resolveInboundRoute", () => {
  it("uses the core router so bindings pick the agent and session key", () => {
    const resolveAgentRoute = vi.fn().mockReturnValue({
      agentId: "public",
      sessionKey: "agent:public:whatsapp-cloud:direct:+393270000000",
    });
    const runtime = { channel: { routing: { resolveAgentRoute } } };
    const cfg = { session: { dmScope: "per-channel-peer" } };

    const route = resolveInboundRoute(runtime, cfg, "default", "393270000000");

    expect(resolveAgentRoute).toHaveBeenCalledWith({
      cfg,
      channel: "whatsapp-cloud",
      accountId: "default",
      peer: { kind: "direct", id: "+393270000000" },
    });
    expect(route).toEqual({
      agentId: "public",
      sessionKey: "agent:public:whatsapp-cloud:direct:+393270000000",
    });
  });

  it("defaults dmScope to per-channel-peer when the config leaves it unset", () => {
    const resolveAgentRoute = vi.fn().mockReturnValue({ agentId: "main", sessionKey: "k" });
    resolveInboundRoute({ channel: { routing: { resolveAgentRoute } } }, {}, "default", "34600000000");
    expect(resolveAgentRoute.mock.calls[0][0].dmScope).toBe("per-channel-peer");
  });

  it("falls back to the canonical per-peer key when the router is unavailable", () => {
    const route = resolveInboundRoute({}, {}, "default", "34600000000");
    expect(route).toEqual({
      agentId: "main",
      sessionKey: "agent:main:whatsapp-cloud:direct:+34600000000",
    });
  });

  it("falls back when the router throws (e.g. no agent selectable)", () => {
    const runtime = {
      channel: {
        routing: {
          resolveAgentRoute: () => {
            throw new Error("AgentSelectionRequiredError");
          },
        },
      },
    };
    const cfg = { agents: { entries: { solo: {} } } };
    const route = resolveInboundRoute(runtime, cfg, "default", "+34600000000");
    expect(route).toEqual({
      agentId: "solo",
      sessionKey: "agent:solo:whatsapp-cloud:direct:+34600000000",
    });
  });
});
