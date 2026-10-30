---
"@pg-txmode/harness": patch
---

A server whose cleanup watchdog cannot run (no `sh`, or no `sleep` or `rm` on PATH) is killed and the start fails with the cause, instead of crashing the host or spinning a core.
