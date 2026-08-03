# sky

Slack에서 Pi coding agent 또는 Claude Agent SDK 기반 에이전트 봇을 **CLI + 데몬**으로 다루는 프로젝트입니다.

## 특징

- Slack Assistant thread별로 에이전트 backend `AgentSession` conversation을 유지합니다.
- Sky의 conversation key를 backend별 session id/resume handle에 매핑해 같은 Slack thread를 이어서 처리합니다.
- public/private Slack 채널에서는 Sky를 한 번 멘션하면 해당 Slack thread에서 backend conversation이 시작됩니다.
- 저장된 conversation이 있는 채널 thread는 이후 멘션 없이도 같은 backend session으로 이어집니다.
- 채널 thread 중간에서 Sky를 처음 멘션하면 이전 thread 메시지가 첫 요청 앞에 포함됩니다.
- Sky home의 `settings.json`에 지정된 `workspace` 아래 `SOUL.md`, `AGENTS.md`, `USER.md`, `MEMORY.md`를 조립해 system prompt로 넣습니다.
- Slack 연결은 Bolt Socket Mode 기반 Assistant 레이어로 처리합니다.
- `sky status`는 macOS LaunchAgent 상태와 daemon control 상태를 함께 보여주며 자동화를 위한 `--json`을 제공합니다.
- `sky doctor`는 설치, runtime, configuration, credential metadata, Sky home 권한과 workspace prompt를 한 번에 진단합니다.
- `sky init`은 실행 중인 daemon의 control interface를 통해 versioned configuration과 secret을 안전하게 설정하고 workspace prompt를 준비합니다.
- `skyd`는 foreground daemon으로 실행되며 Sky home의 `run/skyd.sock`에 HTTP/JSON control interface를 제공합니다.
- `GET /status`는 daemon instance, runtime/Slack 상태, uptime, backend/model, 활성 작업 수와 최근 오류 코드를 반환합니다.
- `memory`와 `dream`은 daemon operation으로 실행되며 CLI를 끊어도 계속 진행됩니다.
- structured JSONL log는 control interface에서 history와 live stream으로 제공되고, `sky logs --follow`는 daemon 교체 뒤에도 cursor로 이어집니다.
- 활성화된 도구는 `Bash`, `Glob`, `Grep`, `Read`, `Edit`, `Write`, `Skill`, `TaskOutput`, `TaskStop`, `TodoWrite`, `WebFetch`, `WebSearch`, `slack_attach_files`, `schedule_reminder`, `list_scheduled`, `cancel_scheduled`로 제한되어 있습니다.
- main agent는 `schedule_reminder`, `list_scheduled`, `cancel_scheduled`로 one-shot 리마인더를 관리하고 예정 시각에 먼저 Slack DM을 보낼 수 있습니다.
- 에이전트 작업 디렉토리(`cwd`)는 기본적으로 Sky home의 `workspace`로 고정됩니다.

## 준비물

- [mise](https://mise.jdx.dev/)
- Slack bot token + app token (Socket Mode 사용 시)
- Slack app event subscriptions: `app_mention`, `message.im`, public channel message events, private channel message events
- Slack agent messaging experience: `agent_view`
- Slack scopes: `app_mentions.read`, `chat:write`, `im:history`, `channels:history`, `groups:history`, `files:write`, `reactions:write`
- 선택한 backend에서 사용할 모델 인증 설정

Sky의 개발 및 package release toolchain은 `mise.toml`에 고정되어 있습니다.

```bash
mise install
mise exec -- node --version
mise exec -- pnpm --version
```

각각 Node.js `24.16.0`, pnpm `11.10.0`이 출력되어야 합니다.

## 설치

### Private GitHub Package

소스 clone 없이 설치하려면 Node.js와 pnpm을 mise의 전역 toolchain으로 준비합니다.

```bash
mise use --global node@24.16.0 pnpm@11.10.0
mise exec -- pnpm setup
```

새 shell을 연 뒤 `read:packages` 권한이 있는 GitHub personal access token(classic)을 준비합니다. 실제 token을 파일에 쓰지 않도록 `~/.npmrc`에는 환경변수 참조만 추가합니다.

```ini
@ty91:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

token을 현재 install 명령에만 주입해 package를 전역 설치합니다.

```bash
NODE_AUTH_TOKEN=<github-pat-classic> mise exec -- pnpm add --global @ty91/sky
mise exec -- sky --version
mise exec -- sky service install
mise exec -- sky init
mise exec -- sky status
```

### 개발 checkout

```bash
git clone https://github.com/ty91/sky.git
cd sky
mise install
mise exec -- pnpm install --frozen-lockfile
```

## Sky home과 private filesystem

Sky가 소유하는 settings, secret store, control socket, log, SQLite DB, transcript, memory cursor와 기본 workspace는 하나의 **Sky home** 아래에 있습니다. 기본 root는 `~/.sky`입니다.

다른 root를 사용하려면 비어 있지 않은 절대경로를 `SKY_HOME`에 지정합니다. 상대경로, 빈 값과 NUL 문자를 포함한 값은 configuration error로 거부됩니다.

```bash
SKY_HOME=/Volumes/private/sky sky service install
```

`sky service install`은 override를 LaunchAgent plist에 기록하므로 daemon도 같은 root를 사용합니다. 기본 root를 사용할 때는 plist에 `SKY_HOME`을 추가하지 않습니다. Override는 기존 `~/.sky`를 이동하거나 합치는 기능이 아니라 별도의 Sky home을 선택하는 기능이므로, 기존 data는 자동으로 복사되지 않습니다.

`SKY_HOME`을 사용해도 LaunchAgent label은 `com.ty91.skyd`로 유지되며 사용자당 active daemon은 하나뿐입니다. Named profile과 여러 daemon의 동시 실행은 지원하지 않습니다. Root를 바꿀 때는 새 환경값으로 `sky service install`을 다시 실행해 plist를 reconcile해야 합니다.

Sky가 만드는 directory는 `0700`, settings·secret·DB와 WAL/SHM·cursor·transcript·log는 `0600`으로 유지됩니다. 기존 managed entry는 현재 사용자 소유의 실제 directory 또는 regular file인 경우에만 권한을 교정합니다. Symlink, 다른 사용자 소유 entry와 예상 타입이 다른 entry는 따라가거나 수정하지 않습니다. Settings에서 외부 `workspace`를 지정한 경우 그 directory 전체를 재귀적으로 chmod하지 않습니다.

## 에이전트 백엔드와 인증 방식

Sky는 Sky home의 `settings.json`에 있는 `agentBackend` 값으로 에이전트 backend를 선택합니다.

- `pi`: 기본값입니다. Pi coding agent SDK를 직접 사용하며, 모델 인증과 provider 선택은 Pi model registry와 AuthStorage를 따릅니다.
- `claude-agent-sdk`: Claude Agent SDK를 사용합니다. `claudeAgentSdk.oauthToken`을 설정하거나 daemon 환경에 `CLAUDE_CODE_OAUTH_TOKEN`을 주입합니다. 명시적인 환경변수가 있으면 우선합니다. Sky는 SDK 호출 환경에서 `ANTHROPIC_API_KEY`를 제거하고 OAuth token을 전달합니다.

Sky home의 `settings.json`에 있는 `model` 값은 `<provider>/<model>` 형식이어야 합니다. 예를 들어 `anthropic/claude-opus-4-7`처럼 provider와 model id를 함께 지정합니다. Pi backend는 이 값을 Pi model registry에서 찾고, Claude Agent SDK backend는 `anthropic/` provider를 제거한 model id를 SDK에 전달합니다.

인증이 없거나 모델 이름을 backend가 찾지 못하면 session 생성 단계의 model/auth 오류가 그대로 보고됩니다. 먼저 선택한 backend의 로컬 인증 상태와 모델 이름을 확인하세요.

## 초기 설정

새 설치에서는 LaunchAgent를 먼저 설치해 `needs_configuration` 상태의 daemon을 띄운 뒤 interactive wizard를 실행합니다. 설정 파일을 직접 만들거나 수정하지 않습니다.

```bash
sky service install
sky init
sky status
```

`sky init`은 backend, model, 선택적 effort와 workspace를 물어보고 Slack/Claude credential은 echo 없이 입력받습니다. 기존 secret 값은 읽거나 보여주지 않으며 keep, replace, delete 중 하나만 선택합니다. 설정을 저장한 뒤 기본적으로 graceful restart를 요청하고 새 startup 상태를 확인합니다. 저장만 하려면 `--no-restart`를 사용한 뒤 직접 `sky restart`를 실행합니다.

자동화에서는 secret을 command-line argument나 shell history에 남기지 않고 stdin의 단일 JSON 문서로 전달합니다.

```json
{
  "backend": "pi",
  "model": "anthropic/claude-opus-4-7",
  "effort": "xhigh",
  "workspace": "/Users/me/.sky/workspace",
  "secrets": {
    "slack.botToken": "xoxb-your-slack-bot-token",
    "slack.appToken": "xapp-your-slack-app-token",
    "claudeAgentSdk.oauthToken": "your-claude-code-oauth-token"
  }
}
```

```bash
sky init --from-stdin --json < init.json
```

`secrets`에서 생략한 기존 값은 유지하고 `null`은 stored secret을 삭제합니다. `--json` 출력에는 전체 secret이 아니라 configured/source/updatedAt/displayHint metadata만 포함됩니다. daemon control socket이 없으면 `sky init`은 어떤 설정 파일도 직접 쓰지 않고 `sky service install` 또는 `sky start`를 안내합니다.

Sky는 non-secret 설정을 schema version과 revision이 있는 `settings.json`에, credential을 private `secrets.json`에 분리해 저장합니다. 기존 inline-secret `settings.json`은 daemon이 credential 손실 없이 새 형식으로 migration합니다. 두 파일의 물리 형식은 public interface가 아니며, 설정 변경은 active runtime을 자동으로 바꾸지 않습니다. `GET /configuration`의 `activeRevision`과 `restartRequired`로 disk/active 차이를 확인합니다.

- `model`: 필수 `<provider>/<model>` 값입니다.
- `backend` 또는 `agentBackend`: `pi`(기본값) 또는 `claude-agent-sdk`입니다.
- `effort`: 선택적인 `medium`, `high`, `xhigh`입니다. `null`은 기존 값을 제거합니다.
- `workspace`: 선택적인 절대경로입니다. 기본값은 선택한 Sky home의 `workspace`입니다.
- `slack.botToken`, `slack.appToken`: 필수 Slack credential입니다.
- `claudeAgentSdk.oauthToken`: Claude Agent SDK backend에 필요합니다. `CLAUDE_CODE_OAUTH_TOKEN` 환경변수가 있으면 stored value보다 우선합니다.

## 실행

개발 모드:

```bash
pnpm dev
```

빌드:

```bash
pnpm build
```

타입체크:

```bash
pnpm typecheck
```

테스트:

```bash
pnpm test
```

실제 backend smoke는 인증과 로컬 설정이 필요하므로 기본 테스트에서는 skip됩니다. 수동 검증할 때만 실행하세요:

```bash
SKY_RUN_AGENT_BACKEND_SMOKE=1 \
SKY_CLAUDE_AGENT_BACKEND_SMOKE_MODEL=anthropic/claude-opus-4-7 \
node --test test/agent-session-contract.test.mjs
```

필요하면 `SKY_PI_AGENT_BACKEND_SMOKE_MODEL`, `SKY_AGENT_BACKEND_SMOKE_WORKSPACE`로 smoke 전용 model과 workspace를 지정할 수 있습니다.

개발 checkout의 CLI를 전역으로 연결하려면:

```bash
pnpm link --global
```

이후 아래 커맨드를 쓸 수 있습니다:

```bash
sky service install
sky init
sky start
sky stop
sky restart
sky status
sky doctor
sky service status
sky logs
sky logs --follow
sky memory
sky dream
sky operation status <id>
sky operation watch <id>
sky service uninstall
```

`sky service install`은 `~/Library/LaunchAgents/com.ty91.skyd.plist`를 생성하거나 현재 package wrapper에 맞게 reconcile하고 즉시 시작합니다. plist가 이미 같다면 실행 중인 daemon을 재시작하지 않습니다. `sky stop`은 등록을 보존한 채 job만 내리고, `sky service uninstall`은 plist만 제거하므로 settings, DB, transcript와 logs는 유지됩니다.

포그라운드 실행이 필요하면 `skyd`를 명시적으로 사용합니다:

```bash
skyd --foreground
```

`skyd`는 detach하거나 PID 파일을 만들지 않으며 종료할 때까지 foreground에 머뭅니다. 설치 환경에서는 macOS 사용자 LaunchAgent가 process lifecycle의 유일한 권위자입니다. `sky restart`는 진행 중인 Slack turn과 scheduler dispatch를 최대 120초 drain한 뒤 종료하고, launchd가 시작한 새 daemon이 startup 상태에 도달할 때까지 기다립니다. daemon이 응답하지 않을 때는 자동으로 강제 교체하지 않으며, 사용자가 `sky restart --force`를 명시한 경우에만 `launchctl kickstart -k`를 사용합니다.

```bash
skyd --foreground
curl --unix-socket "${SKY_HOME:-$HOME/.sky}/run/skyd.sock" http://localhost/status
curl --unix-socket "${SKY_HOME:-$HOME/.sky}/run/skyd.sock" http://localhost/configuration
```

설정이 없거나 잘못된 경우에도 `skyd`는 종료되지 않고 `needs_configuration` 상태로 control interface를 유지합니다. Slack startup 오류는 `degraded` 상태에서 exponential backoff로 재시도합니다.

`skyd --foreground`는 supervisor가 없으므로 control restart를 거부합니다. `sky status`의 `supervision` 항목에서 현재 daemon이 `launchd` 또는 `foreground`로 실행 중인지 확인할 수 있습니다.

### Doctor

`sky doctor`는 하나의 구조화된 check 목록에서 사람용 출력과 `--json` 출력을 만듭니다. 각 check는 안정적인 `id`, `pass`/`warn`/`fail` status, summary, 선택적 detail과 remediation을 가집니다. 설치된 Node/Sky version과 package wrapper, LaunchAgent, control socket, daemon runtime/Slack state, 최근 stable error code, 설정·credential metadata, managed path의 owner/mode/type, SQLite sidecar, workspace와 네 prompt file을 검사합니다.

```bash
sky doctor
sky doctor --json
```

daemon이 응답하면 CLI는 `GET /diagnostics`를 사용해 active runtime과 disk configuration의 차이까지 확인합니다. control socket에 연결할 수 없으면 같은 diagnostics module의 read-only local fallback이 service, Sky home, configuration metadata와 workspace를 검사합니다. fallback은 directory를 만들거나 mode를 바꾸거나 migration을 실행하지 않으며, runtime-only check는 실패 대신 `warn`과 unavailable detail로 표시합니다.

Exit code는 다음과 같습니다.

- `0`: fail이 없음. warning은 있을 수 있습니다.
- `1`: 하나 이상의 check가 fail입니다.
- `2`: daemon diagnostics 자체의 내부 오류 등으로 진단을 완료하지 못했습니다.

Doctor는 secret 값·길이, Slack message, prompt 또는 transcript 내용을 출력하지 않습니다. remediation도 `chmod`, 삭제, migration을 자동 실행하지 않고 검토할 명령과 위험만 안내합니다. 기본 doctor는 daemon이 이미 관찰한 Slack 연결 상태와 local backend 설정만 읽으며 Slack `auth.test`, scope probe, 새 network request 또는 비용이 생기는 agent turn을 실행하지 않습니다. 외부 credential probe와 backend smoke는 별도의 명시적 opt-in 진단으로 추가해야 합니다.

### Maintenance operation

`sky memory`와 `sky dream`은 CLI 안에서 agent runtime을 만들지 않고 실행 중인 daemon에 operation을 요청합니다. CLI는 operation ID를 첫 줄에 출력하고 기본적으로 완료까지 event stream을 지켜봅니다. `Ctrl-C`는 operation을 취소하지 않고 화면만 분리합니다. 처음부터 기다리지 않으려면 `--detach`를 사용합니다.

```bash
sky memory --detach
sky dream --date 2026-08-01 --step summarize
sky operation status <operation-id> --json
sky operation watch <operation-id>
```

`memory`와 `dream`은 합쳐서 한 번에 하나만 실행됩니다. 이미 실행 중이면 새 요청은 active operation ID와 함께 거부됩니다. 완료 record는 최대 100개이면서 완료 후 24시간 이내인 것만, event는 operation당 최근 1,000개만 daemon 메모리에 남습니다. daemon을 재시작하면 operation registry는 복원되지 않습니다.

control interface의 operation endpoint는 다음과 같습니다.

- `POST /operations`: `{"type":"memory"}` 또는 `{"type":"dream","date":"YYYY-MM-DD","step":"summarize|knowledge"}`를 받아 `202`와 operation ID를 반환합니다.
- `GET /operations/:id`: 상태, 입력, 시각, 결과 또는 오류 코드를 반환합니다.
- `GET /operations/:id/events`: 완료될 때까지 `application/x-ndjson` event stream을 반환합니다.

### Structured log

```bash
sky logs
sky logs --json
sky logs --follow
sky logs --cursor <cursor> --limit 500
```

daemon이 살아 있으면 CLI는 `GET /logs` history와 `GET /logs/stream` live stream을 사용합니다. 각 app log record의 cursor는 daemon instance ID와 process-local sequence로 구성됩니다. follow stream이 끊기고 LaunchAgent job이 계속 loaded 상태면 마지막 cursor로 새 control socket에 재접속합니다. job이 unload되면 rotation archive까지 마지막 record를 읽고 종료합니다.

daemon control socket에 연결할 수 없으면 Sky home의 `logs/skyd.jsonl`과 최대 5개 archive, `logs/launchd.stderr.log`를 read-only fallback으로 조회합니다. `--json`은 record 하나당 JSON 한 줄을 출력합니다. 외부 `tail` process는 사용하지 않습니다.

## Package 검증과 release

`pnpm test:package`는 clean build로 tarball을 만들고 repository 밖의 격리된 pnpm home에 전역 설치한 다음 `sky`와 `skyd` bin을 검증합니다. package에는 `dist`, `package.json`, `README.md`만 포함될 수 있습니다. `pnpm test:launchd`는 GitHub-hosted macOS runner에서만 실제 LaunchAgent lifecycle을 검증하며 로컬 실행에서는 skip됩니다.

```bash
pnpm test:package
pnpm test:launchd
pnpm pack --dry-run --json
```

release version의 원본은 `package.json`입니다. version을 올리고 검증한 뒤 동일한 `vX.Y.Z` tag를 push합니다.

```bash
pnpm version <version> --no-git-tag-version
pnpm test
pnpm test:package
pnpm release:check-tag -- v<version>
git tag v<version>
git push origin v<version>
```

tag workflow는 macOS arm64에서 mise toolchain, lint, typecheck, 전체 테스트와 package smoke를 검증한 뒤 `@ty91/sky`를 private GitHub Packages에 publish합니다. tag와 `package.json` version이 다르면 publish하지 않습니다.

## 운영 메모

- `sky status`는 다음 정보를 보여줍니다.
  - LaunchAgent 설치/load 상태, launchd process state와 PID
  - control socket 도달 여부와 daemon runtime/Slack 상태
  - daemon이 보고하는 product version, model과 agent backend
- `sky doctor --json`은 `schemaVersion`, `mode`(`daemon`/`local-fallback`), `overall`과 안정적인 check 배열을 반환합니다.
- `sky start`, `sky stop`, `sky status`, `sky service install`, `sky service uninstall`은 안정적인 JSON 결과를 위한 `--json`을 지원합니다.
- LaunchAgent plist에는 `HOME`, Node wrapper 실행에 필요한 최소 `PATH`, override 사용 시 `SKY_HOME`만 들어가며 Slack/Claude/provider credential은 복사하지 않습니다.
- 이전 PID 기반 daemon이 발견되면 `sky service install`은 command가 실제 `@ty91/sky`의 `dist/bot.js`인지 확인한 뒤에만 `SIGTERM`을 보냅니다. 20초 안에 끝나지 않아도 자동으로 `SIGKILL`하지 않습니다.
- 기존 Sky home의 `sky.log`는 migration 시 `logs/legacy-sky.log`로 한 번만 이동됩니다.
- `skyd` structured app log는 Sky home의 `logs/skyd.jsonl`에 기록되며 10 MiB 단위, archive 5개로 rotation됩니다.
- LaunchAgent가 daemon entrypoint를 시작하지 못한 오류는 Sky home의 `logs/launchd.stderr.log`에 남으며 daemon down 상태의 `sky logs` fallback에 포함됩니다.
- structured app log에는 Slack message, agent prompt, token을 기록하지 않고 operation 종류/상태와 안전한 daemon 진단만 기록합니다.
- Sky home root와 `run`, `logs`, `transcripts`, 새 기본 `workspace`는 `0700`, control socket과 managed file은 `0600` 권한을 사용합니다.
- Conversation resume 매핑은 Sky home의 `sky.db`에 저장됩니다.
- 예약된 리마인더도 같은 `sky.db`에 저장되며 봇 프로세스의 30초 ticker가 실행합니다.
- 리마인더 실행이 실패하면 60초 간격으로 최대 3회 시도한 뒤 실패 알림을 보냅니다.
- 봇이 꺼져 있는 동안 예정 시각이 지난 리마인더는 재시작 후 catch-up하지 않고 건너뜁니다.
- 저장 record에는 backend, session id, resume reference, agent 이름, model이 들어갑니다.
- backend를 바꾸면 기존 record는 삭제하지 않고 새 backend record를 따로 만듭니다. 다시 이전 backend로 롤백하면 이전 Slack thread의 conversation을 복원할 수 있습니다.

### Backend 동작 차이

| 항목 | pi | claude-agent-sdk |
| -- | -- | -- |
| 복원 세션의 system prompt | 세션 파일의 prompt snapshot을 사용하고 loader를 스킵합니다. | Sky DB에 저장한 최초 prompt snapshot을 사용하고 loader를 스킵합니다. |
| 세션 파일 | Sky가 Pi session file 경로를 `resumeRef`로 저장합니다. | SDK가 `~/.claude/projects/` 아래에서 자체 관리하며 Sky의 `resumeRef`는 비어 있습니다. |
| 프로세스 모델 | 데몬 프로세스 안에서 실행됩니다. | 턴마다 서브프로세스를 사용합니다. 턴당 약 330MB를 쓰고 종료 시 회수되며, 스폰 비용은 약 200ms입니다. |
| 인증 | Pi AuthStorage를 사용합니다. | `CLAUDE_CODE_OAUTH_TOKEN` 환경변수를 사용합니다. 다른 Anthropic 인증 변수가 있으면 SDK 우선순위에 주의하세요. |
| 도구 이름 | built-in 도구 이름은 Pi용 소문자 이름으로 매핑합니다. | SDK가 지원하지 않는 이름은 필터링하고, 커스텀 도구는 `mcp__sky__<tool>` 이름으로 노출합니다. |

## 사용법

- Slack agent Messages 탭에서는 루트 DM을 보내면 해당 메시지의 Slack thread로 새 backend session이 시작됩니다.
- 같은 Slack thread에 이어서 메시지를 보내면 같은 backend session으로 이어집니다.
- public/private 채널에서는 루트 메시지 또는 thread reply에서 Sky를 멘션하면 해당 Slack thread에 답변합니다.
- Conversation이 Sky home의 `sky.db`에 저장된 채널 thread는 멘션 없는 후속 reply도 같은 session으로 처리합니다.
- 채널 thread에서 처음 Sky를 멘션한 요청에는 해당 멘션 이전의 Slack thread history가 함께 전달됩니다.

### 채팅 명령어

`!`로 시작하는 한 줄짜리 메시지는 에이전트 턴 대신 하네스가 직접 처리합니다.

| 명령어 | 설명 |
| --- | --- |
| `!model <fable\|opus\|sonnet>` | 해당 thread의 모델을 지정합니다. thread의 **첫 메시지에서만** 가능합니다. |
| `!help` | 사용 가능한 명령어를 보여줍니다. |

- 예: `!model fable` → `모델이 claude-fable-5로 설정되었습니다.` 이후 같은 thread의 모든 턴이 해당 모델로 실행됩니다.
- 대화가 이미 시작된 thread에서는 backend session의 모델을 바꿀 수 없으므로 `!model`이 거부됩니다.
- 채널에서는 멘션이 필요하므로 `@sky !model fable` 형태로 보냅니다.
- 알 수 없는 명령어(`!foo`)는 에이전트로 전달되지 않고 usage 안내로 응답합니다.
- thread별 모델은 Sky home의 `sky.db`에 있는 `thread_models` 테이블에 저장되며, 재시작 이후의 예약 리마인더/후속 턴에도 동일하게 적용됩니다.
