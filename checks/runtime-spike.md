# Runtime boundaries that require evidence

The pinned Plow base owns `plugins.load`; Puppeteer must be installed in the
global state-volume extension root before the gateway starts. Registering it
only inside the Plow plugin hides setup hooks and conflates tool provenance.
Packaged tests discover the independent plugin and exercise group policies.

The Mac MCP default request timeout is 1.5 seconds. A relay round trip may exceed
that during tool listing even with Latch connected. Preboot supplies 60 seconds,
while respecting a timeout supplied by upstream. Timeout alone cannot diagnose
an asleep Mac.

Native OpenClaw command jobs have no inbound conversation context. Recovery
therefore cannot call a conversational setup tool or infer a new destination.
It reads previously persisted group receipt routes, checks the currently served
group, and records delivery before sending. Empty state makes no service calls.

The private owner-question path uses public SDK durable outbound APIs. Its route
comes from fresh authenticated owner-DM records, and its return route comes only
from the original still-shared group. Owner answers quote the current source
message and do not authorize additional actions.

Do not publish API credentials, pairing keys, callback keys, personal participant
addresses or raw transcripts as evidence. Model/transport fixtures are explicitly
labelled simulated. Sam's hardware and venue transport need the live checklist.
