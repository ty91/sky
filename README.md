# claudeclaw

텔레그램용 Claude Agent SDK 봇을 **CLI + 데몬**으로 다루는 프로젝트입니다.

## 특징

- 텔레그램 `chat_id`별로 Claude **long-lived query 세션**을 유지합니다.
- 내부적으로 세션당 `query({ prompt: input, options })`를 한 번만 만들고, 이후엔 새 사용자 메시지를 `input.push(...)`로 넣습니다.
- long-lived query에서 현재 턴을 식별하기 위해 `replay-user-messages`를 활성화합니다.
- 같은 채팅방에서 이어서 보내는 메시지는 같은 query 컨텍스트로 처리됩니다.
- `/new` 명령으로 해당 채팅방 세션을 초기화할 수 있습니다.
- `~/.claudeclaw/settings.json`의 `workspace` 아래 `AGENTS.md`, `SOUL.md`, `USER.md`, `MEMORY.md`를 조립해 `systemPrompt`로 넣습니다.
- 텔레그램 연결은 **probe / polling / 송신 / 종료**를 분리한 런타임 계층으로 관리합니다.
- startup은 `bot.init()`에만 의존하지 않고, 직접 `getMe` probe로 readiness를 확인한 뒤 polling을 시작합니다.
- Telegram API 실패는 오류 분류 후 **지수 백오프 재시도**로 복구합니다.
- Telegram API 연결은 probe, polling, outbound request를 포함해 항상 **IPv4 고정**으로 처리합니다.
- `sendChatAction` 실패는 best-effort로 처리하고, polling stall은 watchdog으로 감지해 재기동합니다.
- `claudeclaw status`는 PID만 보는 대신 **실제 런타임 health**를 보여줍니다.
- 활성화된 도구는 `Bash`, `Glob`, `Grep`, `Read`, `Edit`, `Write`, `Skill`, `TaskOutput`, `TaskStop`, `TodoWrite`, `WebFetch`, `WebSearch`로 제한되어 있습니다.
- Claude Agent SDK의 작업 디렉토리(`cwd`)는 기본적으로 `~/.claudeclaw/workspace`로 고정됩니다.

## 준비물

- Node.js 18+
- Telegram bot token (`@BotFather`)
- **Claude Code 로컬 로그인 또는 Anthropic API key 중 하나**

## 인증 방식

이 프로젝트는 **로컬 Claude Code 인증 상태를 그대로 활용할 수 있습니다.**

즉, 이 머신에서 `claude` CLI가 이미 로그인되어 있다면 보통 `ANTHROPIC_API_KEY` 없이도 동작할 수 있습니다.

## 설정

```bash
cd ~/Developer/workspace/claudeclaw
pnpm install
```

`~/.claudeclaw/settings.json` 을 만듭니다:

```json
{
  "telegram": {
    "botToken": "your_telegram_bot_token_here"
  },
  "claude": {
    "model": "sonnet"
  },
  "workspace": "/Users/taeyoung/.claudeclaw/workspace"
}
```

- `telegram.botToken` — 필수. `@BotFather`에서 발급받은 토큰.
- `claude.model` — 선택. 기본값 `"sonnet"`.
- `workspace` — 선택. 기본값 `~/.claudeclaw/workspace`. 이 디렉토리 아래의 `AGENTS.md`, `SOUL.md`, `USER.md`, `MEMORY.md`를 조립해 시스템 프롬프트로 사용합니다.

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
claudeclaw start
claudeclaw stop
claudeclaw restart
claudeclaw status
claudeclaw logs
```

포그라운드 실행이 필요하면:

```bash
claudeclaw run
```

## 운영 메모

- `claudeclaw status`는 다음 정보를 보여줍니다.
  - process lifecycle과 telegram phase (`probing`, `connecting`, `polling`, `backoff` 등)
  - readiness
  - 마지막 초기화 성공 시각
  - 마지막 update / outbound 성공 시각
  - 고정된 IPv4 네트워크와 마지막 `getMe` probe 결과
  - 현재 backoff와 마지막 오류
- 런타임 health는 `~/.claudeclaw/runtime-health.json`에 저장됩니다.
- 데몬 PID/log 파일은 기본적으로 `~/.claudeclaw/` 아래에 저장됩니다.
- 텔레그램 세션 resume 매핑은 `~/.claudeclaw/telegram-sessions.json`에 저장됩니다.

## 사용법

- 봇과 대화를 시작하려면 `/start`
- 새 대화로 초기화하려면 `/new`
- 그냥 메시지를 보내면 같은 세션으로 이어집니다.
