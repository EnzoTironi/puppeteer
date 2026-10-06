# Source attribution

The cloud image extends `plow-pbc/plow-openclaw-agent` at
`9ba247396c05a695bb0c8abf228fdb8e490c81ed`. Its base prompt and local dashboard
Caddy configuration come from that repository, licensed under Apache-2.0.
The base image retains those files' notices and dependency licenses.

The local connector started as a proposed addition to the MIT-licensed
`delattre1/mypeople` fork at `3051b5ce24a848fb10f2b7b8ebbb4040b23d73b4`.
Puppeteer now ships it as a standalone package. It uses MyPlow's installed
runtime without modifying MyPlow or depending on its Python package.

Puppeteer's connector, guest tools, source customization script, persona
additions and skill are MIT licensed. The image's customized Plow channel,
transport, configuration, plugin manifest and MCP bridge retain the upstream
Apache-2.0 license.
