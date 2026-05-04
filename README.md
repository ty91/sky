# sky

Slack에서 ACP 기반 에이전트 봇을 **CLI + 데몬**으로 다루는 프로젝트입니다.

## 특징

- Slack Assistant thread별로 ACP 세션을 유지합니다.
- 내부적으로 provider에 따라 ACP subprocess와 stdio 연결을 맺고 `session/prompt`로 사용자 메시지를 전달합니다.
- 지원되는 모델 provider는 `anthropic/*`, `openai/*`입니다. 예시는 `anthropic/claude-opus-4-7`, `openai/gpt-5.5`입니다.
- `anthropic/*`는 `@agentclientprotocol/claude-agent-acp`를 사용하고, `openai/*`는 `@agentclientprotocol/codex-acp`를 통해 Codex `app-server`를 사용합니다.
- 같은 Slack assistant thread의 메시지를 같은 ACP 세션 컨텍스트로 처리합니다.
- public/private Slack 채널에서는 Sky를 한 번 멘션하면 해당 Slack thread에서 ACP 세션이 시작됩니다.
- ACP 세션이 저장된 채널 thread는 이후 멘션 없이도 같은 세션으로 이어집니다.
- 채널 thread 중간에서 Sky를 처음 멘션하면 이전 thread 메시지가 첫 요청 앞에 포함됩니다.
- `~/.sky/settings.json`의 `workspace` 아래 `SOUL.md`, `AGENTS.md`, `USER.md`, `MEMORY.md`를 조립해 에이전트 지침으로 넣습니다.
- Slack 연결은 Bolt Socket Mode 기반 Assistant 레이어로 처리합니다.
- `sky status`는 데몬 프로세스 상태, 로그 파일, Slack 설정, 모델, workspace를 보여줍니다.
- 활성화된 도구는 `Bash`, `Glob`, `Grep`, `Read`, `Edit`, `Write`, `Skill`, `TaskOutput`, `TaskStop`, `TodoWrite`, `WebFetch`, `WebSearch`, `mcp__sky__restart_harness`로 제한되어 있습니다.
- 에이전트 작업 디렉토리(`cwd`)는 기본적으로 `~/.sky/workspace`로 고정됩니다.

## 준비물

- Node.js 18+
- Slack bot token + app token (Socket Mode 사용 시)
- Slack app event subscriptions: `app_mention`, public channel message events, private channel message events
- Slack scopes: `app_mentions.read`, `channels:history`, `groups:history`
- `anthropic/*` 사용 시 **Claude Code 로컬 로그인 또는 Anthropic API key 중 하나**
- `openai/*` 사용 시 **Codex/ChatGPT 로그인 또는 `CODEX_API_KEY`/`OPENAI_API_KEY` 중 하나**

## 인증 방식

이 프로젝트는 `@agentclientprotocol/claude-agent-acp`를 통해 **로컬 Claude Code 인증 상태를 그대로 활용할 수 있습니다.**

즉, 이 머신에서 `claude` CLI가 이미 로그인되어 있다면 보통 `ANTHROPIC_API_KEY` 없이도 동작할 수 있습니다.

`openai/*` 모델을 사용할 때는 `@agentclientprotocol/codex-acp`가 Codex 인증을 처리합니다. Sky는 `~/.sky/codex-home`을 Codex 전용 home으로 사용하고, 기본 Codex 인증 파일인 `~/.codex/auth.json`이 있으면 `~/.sky/codex-home/auth.json` 심링크를 만듭니다. Codex/ChatGPT 로그인이 되어 있거나 `CODEX_API_KEY` 또는 `OPENAI_API_KEY`가 설정되어 있으면 동작할 수 있습니다.

Sky가 조립한 에이전트 지침은 `~/.sky/codex-home/sky-system-prompt.md`에 기록되고 Codex의 `model_instructions_file`로 전달됩니다. OpenAI 세션은 Sky 전용 Codex home에서 실행되며 프로젝트 문서 자동 주입을 끄기 때문에 사용자 기본 `~/.codex/AGENTS.md`는 Sky 세션에 포함되지 않습니다.

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
  "model": "openai/gpt-5.5",
  "workspace": "/Users/taeyoung/.sky/workspace"
}
```

- `slack.botToken` — Slack bot token.
- `slack.appToken` — Socket Mode용 app token.
- `model` — 필수. `<provider>/<model>` 형식입니다. `anthropic/*`, `openai/*`를 지원합니다.
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
  - 설정 파일을 읽을 수 있는 경우 model과 workspace
- 데몬 PID/log 파일은 기본적으로 `~/.sky/` 아래에 저장됩니다.
- ACP 세션 resume 매핑은 `~/.sky/sky.db`에 저장됩니다.

## 사용법

- Slack에서는 Assistant DM thread를 열면 새 세션이 시작됩니다.
- 같은 Slack thread에 이어서 메시지를 보내면 같은 세션으로 이어집니다.
- public/private 채널에서는 루트 메시지 또는 thread reply에서 Sky를 멘션하면 해당 Slack thread에 답변합니다.
- ACP 세션 ID가 `~/.sky/sky.db`에 저장된 채널 thread는 멘션 없는 후속 reply도 같은 세션으로 처리합니다.
- 채널 thread에서 처음 Sky를 멘션한 요청에는 해당 멘션 이전의 Slack thread history가 함께 전달됩니다.
