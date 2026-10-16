# Plow's OpenClaw base, pinned by its commit tag and multi-arch index digest. The
# image boots holding this agent's Plow credential, so it never follows a moving
# tag. To bump: pick a newer base-<sha> tag, take its index digest, update
# tests/fixtures/base-main.ts.txt and base-AGENTS.md from that commit, keep
# boot/preboot.ts step-for-step with its boot/main.ts, and run npm test.
FROM public.ecr.aws/e1h7x4a2/plow-cloud-agents:base-ddbaa6bc0f9e071d9411777b91590e755e367d84@sha256:5b0ebf5e33514b09f0f22f1c14424a19b4eb3fc21adfaeb260002f76d362478c

# AGENT_*: a 1-click install has no compose file, so the Agent Index identity
# and the inherited five-minute usage reporter read it from the image.
# PUPPETEER_BRIDGE_COMMIT: the connector the setup tool installs on the owner's
# Mac. Bump it to a pushed commit whenever puppeteer_bridge/ changes.
# PLOW_THREAD_TRUST=untrusted: new groups are ordinary rooms; nobody in them gets
# the owner's Mac, mail or files. PLOW_GUEST_TOOLS: the only tools a group
# member can reach. The channel patch applies the same list to the owner's
# group turns, so setup and raw Latch tools exist only in the owner's DM.
ENV AGENT_ID=puppeteer \
    AGENT_NAME=Puppeteer \
    AGENT_RUNTIME=OpenClaw \
    PUPPETEER_BRIDGE_COMMIT=6375e8021e6362ad7a7938cfff9d7e8e39c0c67f \
    PLOW_THREAD_TRUST=untrusted \
    PLOW_GUEST_TOOLS=puppeteer_agents,puppeteer_ask,puppeteer_result,puppeteer_ask_owner \
    AGENT_BLURB="Talk to the Claude Code and Codex agents already running on your Mac."

LABEL org.opencontainers.image.title="Puppeteer" \
      org.opencontainers.image.description="Talk to the Claude Code and Codex agents already running on your Mac." \
      org.opencontainers.image.source="https://github.com/EnzoTironi/puppeteer" \
      org.opencontainers.image.licenses="MIT"

COPY LICENSE /usr/share/licenses/puppeteer/LICENSE
COPY prompt/AGENTS.md /opt/plow/prompt/AGENTS.md
COPY prompt/SOUL.md /opt/plow/prompt/SOUL.md
COPY skills/ /opt/plow/skills/
COPY plugin/ /opt/plow/puppeteer-src/
COPY boot/ /opt/puppeteer/boot/
COPY licenses/ /usr/share/licenses/puppeteer/
COPY scripts/customize-base.mjs /opt/plow/customize-puppeteer.mjs
COPY scripts/ /opt/puppeteer/scripts/
USER root
RUN node /opt/plow/customize-puppeteer.mjs \
    && mkdir -p /opt/puppeteer/plugin/node_modules \
    && ln -s /app /opt/puppeteer/plugin/node_modules/openclaw
USER node
CMD ["node", "/opt/puppeteer/boot/preboot.ts"]
