import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
export type Outbound = (chat: string, text: string, kind: "direct" | "group") => Promise<void>;

/** Only the scoped question workflow receives this sender. It is never a guest tool. */
export function sdkOutbound(api: OpenClawPluginApi): Outbound {
  return async (to, text, kind) => {
    const { buildOutboundSessionContext, sendDurableMessageBatch } = await import("openclaw/plugin-sdk/channel-outbound");
    const cfg = api.config;
    const { routing, session } = api.runtime.channel;
    const route = routing.resolveAgentRoute({ cfg, channel: "plow", accountId: "chat", peer: { kind, id: kind === "direct" ? "plow-owner" : to } });
    await session.updateLastRoute({ storePath: session.resolveStorePath(cfg.session?.store, { agentId: route.agentId }),
      sessionKey: route.sessionKey, channel: "plow", accountId: "chat", to, createIfMissing: true });
    const result = await sendDurableMessageBatch({ cfg, channel: "plow", accountId: "chat", to, payloads: [{ text }],
      session: buildOutboundSessionContext({ cfg, ...route, conversationType: kind }),
      mirror: { agentId: route.agentId, sessionKey: route.sessionKey }, skipQueue: true });
    if (result.status !== "sent") throw new Error("phone_delivery_unknown");
  };
}
