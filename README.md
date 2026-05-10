# sky

Slack에서 Pi coding agent 기반 에이전트 봇을 **CLI + 데몬**으로 다루는 프로젝트입니다.

## 특징

- Slack Assistant thread별로 Pi `AgentSession` conversation을 유지합니다.
- Sky의 conversation key를 Pi session id/session file handle에 매핑해 같은 Slack thread를 이어서 처리합니다.
- public/private Slack 채널에서는 Sky를 한 번 멘션하면 해당 Slack thread에서 Pi conversation이 시작됩니다.
- 저장된 conversation이 있는 채널 thread는 이후 멘션 없이도 같은 Pi session으로 이어집니다.
- 채널 thread 중간에서 Sky를 처음 멘션하면 이전 thread 메시지가 첫 요청 앞에 포함됩니다.
- `~/.sky/settings.json`의 `workspace` 아래 `SOUL.md`, `AGENTS.md`, `USER.md`, `MEMORY.md`를 조립해 Pi resource/system prompt로 넣습니다.
- Slack 연결은 Bolt Socket Mode 기반 Assistant 레이어로 처리합니다.
- `sky status`는 데몬 프로세스 상태, 로그 파일, Slack 설정, Pi model, workspace를 보여줍니다.
- 활성화된 도구는 `Bash`, `Glob`, `Grep`, `Read`, `Edit`, `Write`, `Skill`, `TaskOutput`, `TaskStop`, `TodoWrite`, `WebFetch`, `WebSearch`, `restart_harness`로 제한되어 있습니다.
- 에이전트 작업 디렉토리(`cwd`)는 기본적으로 `~/.sky/workspace`로 고정됩니다.

## 준비물

- Node.js 18+
- Slack bot token + app token (Socket Mode 사용 시)
- Slack app event subscriptions: `app_mention`, public channel message events, private channel message events
- Slack scopes: `app_mentions.read`, `channels:history`, `groups:history`
- Pi coding agent에서 사용할 모델 인증 설정

## 인증 방식

Sky는 Pi coding agent SDK를 직접 사용합니다. 모델 인증과 provider 선택은 Pi model registry와 auth storage를 따릅니다.

`~/.sky/settings.json`의 `model` 값은 Pi가 인식하는 `<provider>/<model>` 이름이어야 합니다. 예를 들어 `anthropic/claude-opus-4-7`처럼 provider와 model id를 함께 지정합니다.

인증이 없거나 모델 이름을 Pi가 찾지 못하면 session 생성 단계에서 Pi model/auth 오류가 그대로 보고됩니다. 먼저 로컬 Pi coding agent 인증 상태와 선택한 모델 이름을 확인하세요.

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
  "workspace": "/Users/taeyoung/.sky/workspace"
}
```

- `slack.botToken` — Slack bot token.
- `slack.appToken` — Socket Mode용 app token.
- `model` — 필수. Pi coding agent가 인식하는 `<provider>/<model>` 형식입니다.
- `workspace` — 선택. 기본값 `~/.sky/workspace`. 이 디렉토리 아래의 `SOUL.md`, `AGENTS.md`, `USER.md`, `MEMORY.md`를 조립해 에이전트 지침으로 사용합니다.
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
  - 설정 파일을 읽을 수 있는 경우 Pi model과 workspace
- 데몬 PID/log 파일은 기본적으로 `~/.sky/` 아래에 저장됩니다.
- Pi conversation resume 매핑은 `~/.sky/sky.db`에 저장됩니다.
- 저장 record에는 Pi session id, Pi session file, agent 이름, model이 들어갑니다.

## 사용법

- Slack에서는 Assistant DM thread를 열면 새 Pi session이 시작됩니다.
- 같은 Slack thread에 이어서 메시지를 보내면 같은 Pi session으로 이어집니다.
- public/private 채널에서는 루트 메시지 또는 thread reply에서 Sky를 멘션하면 해당 Slack thread에 답변합니다.
- Pi conversation이 `~/.sky/sky.db`에 저장된 채널 thread는 멘션 없는 후속 reply도 같은 session으로 처리합니다.
- 채널 thread에서 처음 Sky를 멘션한 요청에는 해당 멘션 이전의 Slack thread history가 함께 전달됩니다.
