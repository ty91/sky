# sky

Slack에서 Pi coding agent 또는 Claude Agent SDK 기반 에이전트 봇을 **CLI + 데몬**으로 다루는 프로젝트입니다.

## 특징

- Slack Assistant thread별로 에이전트 backend `AgentSession` conversation을 유지합니다.
- Sky의 conversation key를 backend별 session id/resume handle에 매핑해 같은 Slack thread를 이어서 처리합니다.
- public/private Slack 채널에서는 Sky를 한 번 멘션하면 해당 Slack thread에서 backend conversation이 시작됩니다.
- 저장된 conversation이 있는 채널 thread는 이후 멘션 없이도 같은 backend session으로 이어집니다.
- 채널 thread 중간에서 Sky를 처음 멘션하면 이전 thread 메시지가 첫 요청 앞에 포함됩니다.
- `~/.sky/settings.json`의 `workspace` 아래 `SOUL.md`, `AGENTS.md`, `USER.md`, `MEMORY.md`를 조립해 system prompt로 넣습니다.
- Slack 연결은 Bolt Socket Mode 기반 Assistant 레이어로 처리합니다.
- `sky status`는 데몬 프로세스 상태, 로그 파일, Slack 설정, model, agent backend, workspace를 보여줍니다.
- 활성화된 도구는 `Bash`, `Glob`, `Grep`, `Read`, `Edit`, `Write`, `Skill`, `TaskOutput`, `TaskStop`, `TodoWrite`, `WebFetch`, `WebSearch`, `restart_harness`, `slack_attach_files`로 제한되어 있습니다.
- 에이전트 작업 디렉토리(`cwd`)는 기본적으로 `~/.sky/workspace`로 고정됩니다.

## 준비물

- Node.js 18+
- Slack bot token + app token (Socket Mode 사용 시)
- Slack app event subscriptions: `app_mention`, `message.im`, public channel message events, private channel message events
- Slack agent messaging experience: `agent_view`
- Slack scopes: `app_mentions.read`, `chat:write`, `im:history`, `channels:history`, `groups:history`, `files:write`, `reactions:write`
- 선택한 backend에서 사용할 모델 인증 설정

## 에이전트 백엔드와 인증 방식

Sky는 `~/.sky/settings.json`의 `agentBackend` 값으로 에이전트 backend를 선택합니다.

- `pi`: 기본값입니다. Pi coding agent SDK를 직접 사용하며, 모델 인증과 provider 선택은 Pi model registry와 AuthStorage를 따릅니다.
- `claude-agent-sdk`: Claude Agent SDK를 사용합니다. 데몬 환경에 `CLAUDE_CODE_OAUTH_TOKEN`을 주입해야 합니다. Sky는 SDK 호출 환경에서 `ANTHROPIC_API_KEY`를 제거하고 OAuth token을 전달합니다.

`~/.sky/settings.json`의 `model` 값은 `<provider>/<model>` 형식이어야 합니다. 예를 들어 `anthropic/claude-opus-4-7`처럼 provider와 model id를 함께 지정합니다. Pi backend는 이 값을 Pi model registry에서 찾고, Claude Agent SDK backend는 `anthropic/` provider를 제거한 model id를 SDK에 전달합니다.

인증이 없거나 모델 이름을 backend가 찾지 못하면 session 생성 단계의 model/auth 오류가 그대로 보고됩니다. 먼저 선택한 backend의 로컬 인증 상태와 모델 이름을 확인하세요.

## 설정

```bash
cd ~/Developer/workspace/sky
pnpm install
```

`~/.sky/settings.json` 을 만듭니다:

```json
{
  "slack": {
    "botToken": "xoxb-your-slack-bot-token",
    "appToken": "xapp-your-slack-app-token"
  },
  "model": "anthropic/claude-opus-4-7",
  "agentBackend": "pi",
  "workspace": "/Users/taeyoung/.sky/workspace"
}
```

- `slack.botToken`: Slack bot token.
- `slack.appToken`: Socket Mode용 app token.
- `model`: 필수. `<provider>/<model>` 형식입니다.
- `agentBackend`: 선택. 기본값 `pi`. `pi` 또는 `claude-agent-sdk`를 지정합니다.
- `workspace`: 선택. 기본값 `~/.sky/workspace`. 이 디렉토리 아래의 `SOUL.md`, `AGENTS.md`, `USER.md`, `MEMORY.md`를 조립해 에이전트 지침으로 사용합니다.
- `slack` 설정은 필수입니다.

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

CLI 설치:

```bash
pnpm link --global
```

이후 아래 커맨드를 쓸 수 있습니다:

```bash
sky start
sky stop
sky restart
sky status
sky logs
```

포그라운드 실행이 필요하면:

```bash
sky run
```

## 운영 메모

- `sky status`는 다음 정보를 보여줍니다.
  - 프로세스 상태와 로그 파일 경로
  - Slack 설정 여부
  - 설정 파일을 읽을 수 있는 경우 model, agent backend, workspace
- 데몬 PID/log 파일은 기본적으로 `~/.sky/` 아래에 저장됩니다.
- Conversation resume 매핑은 `~/.sky/sky.db`에 저장됩니다.
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
- Conversation이 `~/.sky/sky.db`에 저장된 채널 thread는 멘션 없는 후속 reply도 같은 session으로 처리합니다.
- 채널 thread에서 처음 Sky를 멘션한 요청에는 해당 멘션 이전의 Slack thread history가 함께 전달됩니다.
