# Codex Companion Architecture
## 1. Kien truc tong quat
Plugin nay dua Codex vao Claude Code cho review, delegated task, job tracking, va Claude-session transfer. Claude command chi la UX; Node runtime so huu app-server, state, va rendering.
| Layer | Vi tri | Trach nhiem |
| --- | --- | --- |
| Commands | `commands/*.md` | Slash-command UX va routing. |
| Rescue agent | `agents/codex-rescue.md` | Forward mot lan sang `task`. |
| Runtime CLI | `scripts/codex-companion.mjs` | Commands, jobs, state, render. |
| Client | `scripts/lib/app-server.mjs` | JSON-RPC client va transport. |
| Orchestration | `scripts/lib/codex.mjs` | Threads, turns, review, notification capture. |
| Broker | `scripts/app-server-broker.mjs` | Chia se mot `codex app-server` trong session. |
| Hooks | `scripts/*-hook.mjs` | Session cleanup va stop-review gate. |
```text
Claude command / rescue
        |
        v
codex-companion.mjs ---> job state + logs
        |
        v
CodexAppServerClient
        |
        +-- broker JSONL --> one direct `codex app-server`
        +-- direct JSONL fallback --> `codex app-server`
```
Broker socket la JSONL proxy noi bo, khong phai native Unix/WebSocket transport cua Codex. Chi mot stream duoc chay; `turn/interrupt` la request duy nhat duoc phep trong khi stream dang chay.
Job co vong doi `queued -> running -> completed|failed`, hoac `queued|running -> cancelled`. State nam ngoai repository, scope theo workspace va Claude session. Tat ca executable jobs di qua `runTrackedJob` nen dung chung logs, progress, results, va failure handling.
## 2. Hien trang cua app-server va payload
`codex app-server` dung bidirectional JSON-RPC 2.0 tren JSONL/stdin-stdout. Request la `{ id, method, params }`; response lap lai `id`; notification khong co `id`. Tai lieu: [Codex App Server](https://developers.openai.com/codex/app-server/). Plugin serialize request tai `AppServerClientBase.request()` trong `scripts/lib/app-server.mjs`.
### Startup va handshake
Plugin spawn `codex app-server` voi default `stdio://`, khong truyen flag. Codex CLI co: `--config`, `--enable`, `--disable`, `--code-mode-host`, `--strict-config`, `--listen`, `--stdio`, `--analytics-default-enabled`, va WebSocket auth flags. Khong expose remote listener; neu sau nay dung non-loopback WebSocket thi phai them TLS va auth.
Moi connection gui `initialize`, sau do notification `initialized`, truoc request khac. Payload hien tai:
```json
{
  "clientInfo": { "title": "Codex Plugin", "name": "Claude Code", "version": "<plugin version>" },
  "capabilities": {
    "experimentalApi": false,
    "requestAttestation": false,
    "optOutNotificationMethods": [
      "item/agentMessage/delta",
      "item/reasoning/summaryTextDelta",
      "item/reasoning/summaryPartAdded",
      "item/reasoning/textDelta"
    ]
  }
}
```
`captureTurn()` dang ky handler truoc request streaming, buffer event den som, roi loc theo `threadId` va `turnId`. No luu progress, completed agent messages, reasoning, file changes, commands, review output, va hoan tat tai `turn/completed`.
### Request thuc te cua plugin
| Call site | Method | Payload |
| --- | --- | --- |
| `getCodexAuthStatusFromClient()` | `account/read` | `{ refreshToken: false }` |
| `getCodexAuthStatusFromClient()` | `config/read` | `{ includeLayers: false, cwd }` |
| `startThread()` | `thread/start` | `{ cwd, model: options.model ?? null, approvalPolicy: options.approvalPolicy ?? "never", sandbox: options.sandbox ?? "read-only", serviceName: "claude_code_codex_plugin", developerInstructions: options.developerInstructions ?? null, ephemeral: options.ephemeral ?? true }` |
| `startThread()` | `thread/name/set` | `{ threadId, name }`, khi co `threadName`. |
| `resumeThread()` | `thread/resume` | `{ threadId, cwd, model: options.model ?? null, approvalPolicy: options.approvalPolicy ?? "never", sandbox: options.sandbox ?? "read-only", developerInstructions: options.developerInstructions ?? null }` |
| `runAppServerTurn()` | `turn/start` | `{ threadId, input: [{ type: "text", text: prompt }], model: options.model ?? null, effort: options.effort ?? null, outputSchema: options.outputSchema ?? null }` |
| `runAppServerReview()` | `review/start` | `{ threadId: sourceThreadId, delivery: options.delivery ?? "inline", target: options.target }` |
| `interruptAppServerTurn()` | `turn/interrupt` | `{ threadId, turnId }` |
| `findLatestTaskThread()` | `thread/list` | `{ cwd, limit: 20, sortKey: "updated_at", sourceKinds: ["appServer"], searchTerm: "Codex Companion Task" }` |
| `requestExternalAgentSessionImport()` | `externalAgentConfig/import` | `migrationItems` voi mot record `SESSIONS` chua Claude JSONL source path. |
`task --write` doi `sandbox` thanh `workspace-write`; reviews va task read-only dung `read-only`. `approvalPolicy` luon `never`. Fallback direct chi khi broker busy/unreachable; khong retry protocol failure mo ho de tranh duplicate writes.
### Execution flow
```text
task moi:    thread/start -> optional thread/name/set -> turn/start -> notifications -> turn/completed
task resume: thread/resume -> turn/start -> notifications -> turn/completed
review:      thread/start(read-only, ephemeral) -> review/start -> exitedReviewMode -> turn/completed
cancel:      turn/interrupt(threadId, turnId) -> turn/completed(interrupted)
transfer:    externalAgentConfig/import -> externalAgentConfig/import/completed
```
## 3. Phan bo sung cua app-server va payload co the mo rong
Schema generate tu CLI hien tai (`codex app-server generate-ts`) cho `ThreadStartParams` co 14 controls. `buildThreadParams()` dang dung 6 fields.
| Field | Type / gia tri | Trang thai / khi nao them |
| --- | --- | --- |
| `model` | `string \| null` | Dang dung; chon model thread. |
| `modelProvider` | `string \| null` | Them khi co model picker theo provider. |
| `serviceTier` | `string \| null` | Them khi provider co requirement tier. |
| `cwd` | `string \| null` | Dang dung; workspace/instructions/tools scope. |
| `approvalPolicy` | `untrusted`, `on-request`, `never`, granular object | Dang dung `never`; chi them interactive mode khi host xu ly approval. |
| `approvalsReviewer` | `user`, `auto_review`, `guardian_subagent` | Chi co y nghia khi approval khong la `never`. |
| `sandbox` | `read-only`, `workspace-write`, `danger-full-access` | Dang dung 2 mode dau; khong expose mode cuoi. |
| `config` | map string -> JSON | Khong raw pass-through; no co the bypass plugin policy. |
| `serviceName` | `string \| null` | Dang dung cho integration metrics. |
| `baseInstructions` | `string \| null` | Chi them khi can host instruction layer. |
| `developerInstructions` | `string \| null` | Dang dung; noi dung lay tu worker roster trong plugin, khong nhan truc tiep tu slash command. |
| `personality` | `none`, `friendly`, `pragmatic` | Them neu can UX preference; khong doi tool permissions. |
| `ephemeral` | `boolean \| null` | Dang dung; false cho resumable task, true cho review. |
| `sessionStartSource` | `startup`, `clear` | Them khi UI co state tuong ung. |
| `threadSource` | `string \| null` | Telemetry only; khong can them. |
`thread/resume` bat buoc `threadId` va chi support `model`, `modelProvider`, `serviceTier`, `cwd`, `approvalPolicy`, `approvalsReviewer`, `sandbox`, `config`, `baseInstructions`, `developerInstructions`, `personality`. No khong thay doi persistence, service name, hay start metadata cua thread goc.
### API mo rong hop ly
| API | Payload chinh | Chi them khi |
| --- | --- | --- |
| `model/list` | `{ limit, includeHidden }` | Khong dung; validation lay tu `<provider base_url>/models` de dung dung danh sach cua proxy. |
| `turn/steer` | `threadId`, input them | Can nguoi dung chen chi dao vao turn dang chay. |
| `thread/read`, `thread/turns/list`, `thread/items/list` | Thread ID va pagination | Can history UI. |
| `thread/fork` | `threadId`, optional `lastTurnId`, `ephemeral` | Can branch conversation. |
| `thread/compact/start` | `threadId` | Can context-window management. |
| `thread/goal/set|get|clear` | `threadId`, objective/status/budget | Can persisted task objective. |
| `skills/list`, `hooks/list` | `cwd` | Can discovery UI. |
| `command/exec` family | command, cwd, sandbox | Khong can; Codex turn da tu goi tool. |
Khi them method: update generated types trong `app-server-protocol.d.ts`, them wrapper nho trong `codex.mjs`, va surface progress trong `recordItem()` neu can. Chi bat `experimentalApi: true` khi method bat buoc. Khong them method streaming vao `STREAMING_METHODS` neu no khong ket thuc bang `turn/completed`, vi broker se bi lock.
```text
thread/start / thread/resume: cwd, sandbox, approval, instructions, persistence
turn/start:                  input, model, effort, outputSchema
```
Khong expose `config`, instruction fields, `approvalsReviewer`, hay `danger-full-access` qua slash command neu chua co authorization boundary va audit. Day la policy expansion, khong phai them option don thuan.
