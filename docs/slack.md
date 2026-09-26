# Slack 연결과 사용법

[README](../README.md) · [설정](configuration.md) · [운영](operations.md)

## Slack app 만들기

Slack 연결은 Bolt Socket Mode를 사용합니다. 필요한 scope, event, Socket Mode와 agent view 설정은 manifest에 포함되어 있습니다.

```bash
sky slack manifest --open
```

1. 열린 링크에서 manifest를 확인하고 **Create**를 누릅니다.
2. **Install to Workspace**로 앱을 workspace에 설치합니다.
3. token 두 개를 복사합니다.
   - bot token(`xoxb-`): **OAuth & Permissions**
   - app token(`xapp-`): **Basic Information > App-Level Tokens**에서 `connections:write` scope로 새로 발급

app-level token은 manifest가 만들어 주지 못하므로 3번의 두 번째 항목만 콘솔에서 직접 생성합니다. `--open` 없이 실행하면 링크와 manifest JSON을 출력만 하고, `--json`은 자동화를 위한 안정된 JSON 문서를 냅니다.

### 기존 앱 갱신

Sky를 업데이트한 뒤 scope나 event가 늘어났다면 새 앱을 만들지 말고 기존 앱의 manifest를 교체합니다.

1. [api.slack.com/apps](https://api.slack.com/apps)에서 앱을 고릅니다.
2. **Features > App Manifest**에서 `sky slack manifest` 출력으로 전체를 교체합니다.
3. **Install to Workspace**로 재설치합니다. scope가 바뀌면 재설치가 필요합니다.
4. 재설치 후 bot token을 확인하고, 변경되었으면 `sky init`으로 갱신합니다. app token은 별도로 관리합니다.

### Sky가 확인할 수 있는 것

Slack 연결 검사는 bot token의 granted scope를 `auth.test` 응답으로 비교하고, app token으로 `apps.connections.open`이 성공하는지 확인해 Socket Mode 활성화를 간접 확인합니다. event 구독 목록과 agent view 설정은 앱 configuration token 없이 읽을 수 없으므로 Sky가 검증하지 못합니다. 그래서 부족한 항목을 하나씩 추가하는 대신 manifest 전체를 다시 적용하는 방식을 안내합니다.

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

Thread별 모델 설정은 저장되므로 재시작 이후의 예약 리마인더와 후속 턴에도 적용됩니다. 대화 중 리마인더의 예약·조회·취소를 요청할 수 있으며, 장애 시 동작은 [예약 리마인더 운영](operations.md#예약-리마인더)을 참고하세요.
