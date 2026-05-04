# sky

Slack과 Telegram에서 ACP 기반 에이전트 봇을 **CLI + 데몬**으로 다루는 프로젝트입니다.

## 특징

- Slack Assistant thread와 Telegram chat별로 ACP 세션을 유지합니다.
- 내부적으로 `@agentclientprotocol/claude-agent-acp` subprocess와 ACP stdio 연결을 맺고 `session/prompt`로 사용자 메시지를 전달합니다.
- 현재 지원되는 모델 provider는 `anthropic/*`이며, 예시는 `anthropic/claude-opus-4-7`입니다.
- Slack에서는 같은 assistant thread, Telegram에서는 같은 채팅방 메시지를 같은 ACP 세션 컨텍스트로 처리합니다.
- Telegram에서는 `/new` 명령으로 해당 채팅방 세션을 초기화할 수 있습니다.
- `~/.sky/settings.json`의 `workspace` 아래 `AGENTS.md`, `SOUL.md`, `USER.md`, `MEMORY.md`를 조립해 `systemPrompt`로 넣습니다.
- Slack 연결은 Bolt Socket Mode 기반 Assistant 레이어로 처리합니다.
- 텔레그램 연결은 **probe / polling / 송신 / 종료**를 분리한 런타임 계층으로 관리합니다.
- startup은 `bot.init()`에만 의존하지 않고, 직접 `getMe` probe로 readiness를 확인한 뒤 polling을 시작합니다.
- Telegram API 실패는 오류 분류 후 **지수 백오프 재시도**로 복구합니다.
- Telegram API 연결은 probe, polling, outbound request를 포함해 항상 **IPv4 고정**으로 처리합니다.
- `sendChatAction` 실패는 best-effort로 처리하고, polling stall은 watchdog으로 감지해 재기동합니다.
- `sky status`는 PID만 보는 대신 **실제 런타임 health**를 보여줍니다.
- 활성화된 도구는 `Bash`, `Glob`, `Grep`, `Read`, `Edit`, `Write`, `Skill`, `TaskOutput`, `TaskStop`, `TodoWrite`, `WebFetch`, `WebSearch`, `mcp__sky__restart_harness`로 제한되어 있습니다.
- 에이전트 작업 디렉토리(`cwd`)는 기본적으로 `~/.sky/workspace`로 고정됩니다.

## 준비물

- Node.js 18+
- Slack bot token + app token (Socket Mode 사용 시)
- Telegram bot token (`@BotFather`, 선택)
- **Claude Code 로컬 로그인 또는 Anthropic API key 중 하나**

## 인증 방식

이 프로젝트는 `@agentclientprotocol/claude-agent-acp`를 통해 **로컬 Claude Code 인증 상태를 그대로 활용할 수 있습니다.**

즉, 이 머신에서 `claude` CLI가 이미 로그인되어 있다면 보통 `ANTHROPIC_API_KEY` 없이도 동작할 수 있습니다.

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
- `telegram.botToken` — 선택. `@BotFather`에서 발급받은 토큰.
- `model` — 필수. `<provider>/<model>` 형식입니다. 현재는 `anthropic/*`만 지원합니다.
- `workspace` — 선택. 기본값 `~/.sky/workspace`. 이 디렉토리 아래의 `AGENTS.md`, `SOUL.md`, `USER.md`, `MEMORY.md`를 조립해 시스템 프롬프트로 사용합니다.
- `slack` 또는 `telegram` 중 하나 이상은 반드시 설정해야 합니다.

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
  - Telegram이 설정된 경우 process lifecycle과 telegram phase (`probing`, `connecting`, `polling`, `backoff` 등)
  - readiness
  - 마지막 초기화 성공 시각
  - 마지막 update / outbound 성공 시각
  - 고정된 IPv4 네트워크와 마지막 `getMe` probe 결과
  - 현재 backoff와 마지막 오류
- 런타임 health는 `~/.sky/runtime-health.json`에 저장됩니다.
- 데몬 PID/log 파일은 기본적으로 `~/.sky/` 아래에 저장됩니다.
- ACP 세션 resume 매핑은 `~/.sky/sky.db`에 저장됩니다.

## 사용법

- Slack에서는 Assistant DM thread를 열면 새 세션이 시작됩니다.
- 같은 Slack thread에 이어서 메시지를 보내면 같은 세션으로 이어집니다.
- Telegram에서는 `/start`로 대화를 시작하고, `/new`로 새 세션으로 초기화할 수 있습니다.
