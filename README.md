# claudeclaw

텔레그램용 Claude Agent SDK 봇을 **CLI + 데몬**으로 다루는 프로젝트입니다.

## 특징

- 텔레그램 `chat_id`별로 Claude **long-lived query 세션**을 유지합니다.
- 내부적으로 세션당 `query({ prompt: input, options })`를 한 번만 만들고, 이후엔 새 사용자 메시지를 `input.push(...)`로 넣습니다.
- long-lived query에서 현재 턴을 식별하기 위해 `replay-user-messages`를 활성화합니다.
- 같은 채팅방에서 이어서 보내는 메시지는 같은 query 컨텍스트로 처리됩니다.
- `/new` 명령으로 해당 채팅방 세션을 초기화할 수 있습니다.
- `~/.claudeclaw/settings.json`의 `workspace` 아래 `AGENTS.md`, `SOUL.md`, `USER.md`, `MEMORY.md`를 조립해 `systemPrompt`로 넣습니다.
- 텔레그램 봇 프레임워크로 **[grammY](https://grammy.dev)** 를 사용합니다.
- 활성화된 도구는 다음으로 제한되어 있습니다: `Bash`, `Glob`, `Grep`, `Read`, `Edit`, `Write`, `Skill`, `TaskOutput`, `TaskStop`, `TodoWrite`, `WebFetch`, `WebSearch`
- 현재는 `permissionMode: 'bypassPermissions'` 입니다.
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

참고: macOS/일부 네트워크 환경에서는 Telegram API 연결이 IPv6 쪽에서 지연될 수 있어서, 실행 시 `NODE_OPTIONS=--dns-result-order=ipv4first`를 넣습니다.

빌드:

```bash
pnpm build
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
```

포그라운드 실행이 필요하면:

```bash
claudeclaw run
```

## 사용법

- 봇과 대화를 시작하려면 `/start`
- 새 대화로 초기화하려면 `/new`
- 그냥 메시지를 보내면 같은 세션으로 이어집니다.

## 구현 메모

- 내부적으로 `query()`를 매 턴 새로 호출하지 않고, 세션당 하나를 오래 유지합니다.
- 멀티턴 입력은 `AsyncIterable<SDKUserMessage>` 형태의 pushable queue로 넣습니다.
- 텔레그램 봇은 `grammy` 패키지를 사용합니다 (telegraf에서 마이그레이션).
- system prompt는 `workspace` 아래 `AGENTS.md`, `SOUL.md`, `USER.md`, `MEMORY.md`를 조립한 문자열입니다.
- 데몬 PID/log 파일은 기본적으로 `~/.claudeclaw/` 아래에 저장됩니다.
- 텔레그램 세션 resume 매핑도 `~/.claudeclaw/telegram-sessions.json`에 저장됩니다.
