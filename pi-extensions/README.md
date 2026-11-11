# pi extensions for the multiagent harness

## queue-guard.ts

Enforces the task-queue rule (`tasks.md`): when a turn used tools, the queue must be
written in that turn. Otherwise the agent gets one reminder before it replies
(`agent_before_settle` continuation). Active only in the coordinator's workspace root and
in the harness directory; worker sessions in the backend and frontend checkouts are not
affected.

Install (global, all pi sessions on this host):

```bash
ln -sfn "$PWD/pi-extensions/queue-guard.ts" ~/.pi/agent/extensions/queue-guard.ts
```

Already-running pi sessions pick it up with `/reload`; new sessions load it at start.
If the checkout is not two levels below the workspace root, export `WORKSPACE_ROOT` in the
agent environment. `MAH_TASKS_FILE` overrides the queue path.

Test (no model calls):

```bash
node pi-extensions/queue-guard.test.mjs
```

Limits: detection is by tool call, so it cannot judge whether the queue text is right, only
whether it was written. Bash writes are recognised by a pattern (`>`, `sed -i`, `tee`, `mv`,
`jq`, ...), so an unusual write command can be missed.
