import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { registerPuppeteer } from "./puppeteer.ts";

export default {
  id: "puppeteer", name: "Puppeteer", description: "Shared coding tools, owner setup gate and private question handoffs.",
  register(api: OpenClawPluginApi): void { registerPuppeteer(api); },
};
