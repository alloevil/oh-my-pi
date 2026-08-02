<system-interrupt reason="command_churn_detected">
This session has now issued {{count}} `{{tool_name}}` calls sharing the same command prefix:
`{{prefix}}`

Repeating one command shape this many times usually means items are being processed one call at a time. Step back before the next call: prefer a batch approach — one script or loop that handles every remaining item at once — or surface the grind to the user: say what you are iterating over, why it must be per-item, and how much remains.
</system-interrupt>
