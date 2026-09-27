# sky

Pi coding agent 또는 Claude Agent SDK 기반 에이전트를 Mac에서 실행하고 Slack으로 대화하는 **CLI + 데몬**입니다.

- Slack 스레드별로 대화를 유지하고 재시작 후에도 이어갑니다.
- Workspace의 prompt와 memory 파일로 에이전트를 설정합니다.
- 예약 리마인더와 memory·dream 작업을 데몬에서 실행합니다.
- CLI와 웹 관리 화면으로 설정, 상태, 로그를 확인합니다.

## 준비물

- Apple Silicon macOS
- 선택한 에이전트 backend의 모델 인증
- Slack을 사용할 경우 workspace에 앱을 설치할 권한

설치에는 Node.js, Bun, GitHub CLI가 필요하지 않습니다. Slack은 선택적 연결이며 데몬은 Slack 연결 상태와 무관하게 실행됩니다.

## 설치와 초기 설정

```bash
curl -fsSL https://raw.githubusercontent.com/ty91/sky/main/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
sky --version
sky service install
```

실행 파일은 `~/.local/bin`, 설정과 데이터는 기본적으로 `~/.sky`에 보관합니다. 이후 터미널에서도 명령을 사용하려면 `~/.local/bin`을 셸의 PATH에 추가하세요.

Slack을 연결하려면 앱 생성 화면을 엽니다.

```bash
sky slack manifest --open
```

1. Manifest를 확인하고 **Create**를 누릅니다.
2. **Install to Workspace**로 앱을 설치하고 **OAuth & Permissions**의 bot token(`xoxb-`)을 복사합니다.
3. **Basic Information > App-Level Tokens**에서 `connections:write` 권한으로 app token(`xapp-`)을 만듭니다.

다음 명령에서 backend, model과 인증 정보를 설정하고, Slack을 사용하면 준비한 두 token을 입력합니다.

```bash
sky init
sky status
```

`sky init`은 설정을 저장하고 데몬을 재시작합니다. 인증 방식과 사용자 지정 workspace는 [설정 가이드](docs/configuration.md), 앱 갱신은 [Slack 가이드](docs/slack.md)를 참고하세요.

Admin은 기본적으로 `0.0.0.0:4815`의 평문 HTTP로 LAN에 노출됩니다. 인터넷에 공개하지 마세요. [접속과 인증](docs/operations.md#admin-접속)을 확인하세요.

기존 Homebrew 설치 또는 외부 memory·dream cron을 사용했다면 먼저 [마이그레이션 절차](docs/migrations.md)를 확인하세요.

## 첫 대화

- Slack 앱의 **Messages** 탭에서 메시지를 보내면 새 대화가 시작됩니다. 같은 스레드에서 이어서 대화하세요.
- 채널에서는 `@sky`를 멘션합니다. 대화가 시작된 스레드에서는 이후 멘션 없이 답글을 보낼 수 있습니다.
- 채팅 명령은 DM에서 `!help`, 채널에서 `@sky !help`로 확인합니다.

스레드별 모델 선택과 리마인더 사용은 [Slack 가이드](docs/slack.md#사용법)에 있습니다.

## 자주 쓰는 명령

| 명령 | 용도 |
| --- | --- |
| `sky status` | 데몬과 Slack 연결 상태 확인 |
| `sky admin` | 웹 관리 화면 열기 |
| `sky logs --follow` | 실시간 로그 보기 |
| `sky doctor` | 설치·설정·인증 metadata 진단 |
| `sky restart` | 데몬 재시작과 저장한 설정 적용 |
| `sky update` | 최신 release로 업데이트 |

문제 진단, 서비스 관리와 예약 작업의 복구 동작은 [운영 가이드](docs/operations.md)에 정리되어 있습니다.

## 문서

| 문서 | 내용 |
| --- | --- |
| [설정](docs/configuration.md) | Backend·인증, Sky home, workspace와 대화 복원 |
| [Slack](docs/slack.md) | 앱 생성·갱신, 대화와 채팅 명령 |
| [운영](docs/operations.md) | 서비스, admin, 진단·로그, memory·dream과 리마인더 |
| [마이그레이션](docs/migrations.md) | Homebrew와 외부 cron에서 전환 |
| [개발](docs/development.md) | 개발 환경, 모노레포, 빌드와 테스트 |
| [macOS 앱](docs/desktop.md) | Tauri 앱 빌드, 내장 호스트 배치와 격리 검증 |
| [배포](docs/releasing.md) | Standalone 빌드, 버전과 release 발행 |
| [Standalone acceptance](docs/standalone-acceptance.md) | 배포물과 실제 backend 검증 |
| [macOS 서명](docs/macos-signing.md) | 인증서·공증 인증과 복구 |
| [제어 API](docs/control-api.md) | Control socket과 admin API 계약 |
| [설계 결정](docs/adr/) | 아키텍처 선택과 근거 |
