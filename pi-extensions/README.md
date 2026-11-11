# pi extensions for the multiagent harness

## role-model.ts

Keeps each agent on its role's predefined model across `/new`, `/fork` and
`/resume`. On every `session_start` it reads `../role-models.json`, resolves the
role from the herdr tab label (or `MAH_ROLE`), and calls `pi.setModel()` when the
current model differs. `<role>` entries are exact; the shared `default` is only
used for agents already listed in `memory.json`, so other herdr tabs are never
changed. Set `MAH_ROLE_MODELS` to override the config path and `MAH_STATE_DIR`
to point at the `memory.json` used for that fallback.

Install (global, all pi sessions on this host):

```bash
ln -sfn "$PWD/pi-extensions/role-model.ts" ~/.pi/agent/extensions/role-model.ts
```

Running sessions pick it up on their next `/new` (pi reloads extensions for the
new session); a process restart also loads it. `bootstrap.sh` additionally passes
`--model <role model>` when it starts an agent, and the dashboard model picker
writes the choice back to `role-models.json`.

Test (no model calls):

```bash
node pi-extensions/role-model.test.mjs
```

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
