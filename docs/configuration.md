# 설정과 에이전트 백엔드

[README](../README.md) · [운영](operations.md) · [Slack](slack.md)

## 초기 설정

새 설치에서는 LaunchAgent를 먼저 설치해 `needs_configuration` 상태의 daemon을 띄운 뒤 interactive wizard를 실행합니다. 설정 파일을 직접 만들거나 수정하지 않습니다.

```bash
sky service install
sky init
sky status
```

Slack credential이 아직 없으면 `sky init`이 token을 묻기 전에 create-from-manifest 링크를 출력하고 브라우저로 열지 물어봅니다. `--from-stdin`이나 TTY가 아닌 실행에서는 이 안내와 브라우저 실행을 모두 건너뜁니다.

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
- `slack.botToken`, `slack.appToken`: 선택적인 Slack 연결에 필요한 credential입니다. 둘 다 있어야 연결하며, 미설정이나 부분 설정은 에이전트 기동을 막지 않습니다.
- `claudeAgentSdk.oauthToken`: Claude Agent SDK backend에 필요합니다. `CLAUDE_CODE_OAUTH_TOKEN` 환경변수가 있으면 stored value보다 우선합니다.

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

에이전트 backend는 `sky init` 또는 admin의 Agent 화면에서 선택합니다.

- `pi`: 기본값입니다. Pi coding agent SDK를 직접 사용하며, 모델 인증과 provider 선택은 Pi model registry와 AuthStorage를 따릅니다.
- `claude-agent-sdk`: Claude Agent SDK를 사용합니다. `claudeAgentSdk.oauthToken`을 설정하거나 daemon 환경에 `CLAUDE_CODE_OAUTH_TOKEN`을 주입합니다. 명시적인 환경변수가 있으면 우선합니다. Sky는 SDK 호출 환경에서 `ANTHROPIC_API_KEY`를 제거하고 OAuth token을 전달합니다.

`model` 값은 `<provider>/<model>` 형식이어야 합니다. 예를 들어 `anthropic/claude-opus-4-7`처럼 provider와 model id를 함께 지정합니다. Pi backend는 이 값을 Pi model registry에서 찾고, Claude Agent SDK backend는 `anthropic/` provider를 제거한 model id를 SDK에 전달합니다.

인증이 없거나 모델 이름을 backend가 찾지 못하면 session 생성 단계의 model/auth 오류가 그대로 보고됩니다. 먼저 선택한 backend의 로컬 인증 상태와 모델 이름을 확인하세요.

## Workspace와 대화 복원

에이전트 작업 디렉터리는 설정한 workspace이며 기본값은 Sky home의 `workspace`입니다. Workspace의 `SOUL.md`, `AGENTS.md`, `USER.md`, `MEMORY.md`를 조립해 새 대화의 system prompt로 사용합니다. `sky init`이 기본 workspace prompt를 준비합니다.

Conversation 복원 정보는 Sky home의 `sky.db`에 저장됩니다. Backend를 바꾸어도 기존 대화 기록을 삭제하지 않으며, 이전 backend로 돌아오면 해당 backend의 대화를 복원할 수 있습니다.

| 항목 | pi | claude-agent-sdk |
| --- | --- | --- |
| 복원 시 system prompt | Pi 세션 파일의 prompt snapshot 사용 | Sky DB에 저장한 최초 prompt snapshot 사용 |
| 세션 파일 | Sky가 Pi 세션 파일 경로를 보관 | SDK가 `~/.claude/projects/` 아래에서 관리 |
| 프로세스 | 데몬 내부에서 실행 | 턴마다 subprocess 사용 |
| 도구 이름 | Pi의 built-in 소문자 이름으로 매핑 | 지원하지 않는 이름을 제외하고 커스텀 도구를 `mcp__sky__<tool>`로 노출 |

복원된 세션에서는 prompt loader를 다시 실행하지 않습니다. Workspace prompt를 수정해도 기존 대화의 snapshot이 자동으로 바뀌지는 않습니다.

설정 쓰기와 secret 분리의 근거는 [ADR-0003](adr/0003-centralize-configuration-writes.md), 경로와 권한의 근거는 [ADR-0002](adr/0002-centralize-sky-home.md)를 참고하세요.
