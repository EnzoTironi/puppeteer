FROM public.ecr.aws/e1h7x4a2/plow-cloud-agents:base-9ba247396c05a695bb0c8abf228fdb8e490c81ed@sha256:8c2b232074ef309c5a7ad26617bb657872bc44afdd102ee7580dc48eb3feb0ad

ENV AGENT_ID=puppeteer \
    AGENT_NAME=Puppeteer \
    AGENT_RUNTIME=OpenClaw \
    PUPPETEER_BRIDGE_COMMIT=753db8d94a7552cdebde6de578c4a919c550f11c \
    PLOW_THREAD_TRUST=untrusted \
    PLOW_GUEST_TOOLS=puppeteer_agents,puppeteer_ask,puppeteer_result \
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
COPY scripts/customize-base.mjs /opt/plow/customize-puppeteer.mjs
USER root
RUN node /opt/plow/customize-puppeteer.mjs
USER node
