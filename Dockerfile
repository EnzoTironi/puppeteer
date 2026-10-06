FROM public.ecr.aws/e1h7x4a2/plow-cloud-agents:base-9ba247396c05a695bb0c8abf228fdb8e490c81ed@sha256:8c2b232074ef309c5a7ad26617bb657872bc44afdd102ee7580dc48eb3feb0ad

ENV AGENT_ID=puppeteer \
    AGENT_NAME=Puppeteer \
    AGENT_RUNTIME=OpenClaw \
    AGENT_BLURB="Talk to the Claude Code and Codex agents already running on your Mac."

LABEL org.opencontainers.image.title="Puppeteer" \
      org.opencontainers.image.description="Talk to the Claude Code and Codex agents already running on your Mac." \
      org.opencontainers.image.source="https://github.com/EnzoTironi/puppeteer" \
      org.opencontainers.image.licenses="MIT"

COPY LICENSE /usr/share/licenses/puppeteer/LICENSE
COPY prompt/AGENTS.md /opt/plow/prompt/AGENTS.md
COPY skills/ /opt/plow/skills/
