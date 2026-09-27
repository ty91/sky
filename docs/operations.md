# 운영과 문제 해결

[README](../README.md) · [설정](configuration.md) · [Slack](slack.md) · [제어 API](control-api.md)

## 상태 확인과 서비스 관리

아래 CLI 명령은 CLI 설치의 LaunchAgent를 관리합니다. `Sky.app`에 등록한 호스트는 [앱의 로컬 서비스 제어](desktop.md#로컬-서비스-제어)를 사용합니다. 실행 중인 앱 서비스를 CLI로 변경하려 하면 `app_managed_service` 오류를 반환하며 자동 인계하지 않습니다.

```bash
sky status
sky service status
sky start
sky stop
sky restart
sky service uninstall
```

`sky status`는 LaunchAgent 설치·load 상태와 PID, control socket 도달 여부, runtime·Slack 상태, product version과 backend·model을 보여줍니다. `sky start`, `sky stop`, `sky status`, `sky service install`, `sky service uninstall`은 `--json`을 지원합니다.

`sky service install`은 `~/Library/LaunchAgents/com.ty91.skyd.plist`를 생성하거나 PATH에서 해석된 `skyd` 실행 파일과 환경 계약에 맞게 reconcile하고 즉시 시작합니다. plist가 이미 같다면 실행 중인 daemon을 재시작하지 않습니다. `sky stop`은 등록을 보존한 채 job만 내리고, `sky service uninstall`은 plist만 제거하므로 settings, DB, transcript와 logs는 유지됩니다.

`skyd`는 detach하거나 PID 파일을 만들지 않으며 종료할 때까지 foreground에 머뭅니다. 설치 환경에서는 macOS 사용자 LaunchAgent가 process lifecycle의 유일한 권위자입니다. `sky restart`는 진행 중인 Slack turn과 scheduler dispatch를 최대 120초 drain한 뒤 종료하고, launchd가 시작한 새 daemon이 startup 상태에 도달할 때까지 기다립니다. daemon이 응답하지 않을 때는 자동으로 강제 교체하지 않으며, 사용자가 `sky restart --force`를 명시한 경우에만 `launchctl kickstart -k`를 사용합니다.

설정이 없거나 잘못된 경우에도 `skyd`는 종료되지 않고 `needs_configuration` 상태로 control interface를 유지합니다. 에이전트 설정과 대화 실행 준비가 끝나면 Slack 상태와 무관하게 runtime은 `ready`가 됩니다. Slack은 선택적 연결이며 미설정은 `not_configured`, 연결 실패는 `retrying`으로 별도 표시합니다. 최초 연결과 연결 단절 모두 데몬이 exponential backoff로 재시도하고, 기존 대화 세션을 유지합니다. `ready`는 모델 제공자에 대한 실제 요청 성공을 보장하지 않습니다.

`skyd --foreground`는 supervisor가 없으므로 control restart를 거부합니다. `sky status`의 `supervision` 항목에서 현재 daemon이 `launchd` 또는 `foreground`로 실행 중인지 확인할 수 있습니다.

LaunchAgent plist에는 `HOME`, PATH에서 해석된 `skyd` 디렉터리와 표준 시스템 경로로 구성한 `PATH`, override 사용 시 `SKY_HOME`, 명시적으로 활성화한 비밀 아닌 진단 플래그만 들어가며 Slack/Claude/provider credential은 복사하지 않습니다.

Foreground 실행은 다음과 같습니다.

```bash
skyd --foreground
```

## 설치와 업데이트

설치 스크립트는 최신 release의 Apple Silicon macOS artifact와 checksum을 내려받아 검증한 뒤 `~/.local/bin/sky`와 같은 executable을 가리키는 `~/.local/bin/skyd` symlink를 설치합니다. `~/.local/bin`이 PATH에 없으면 추가 방법을 출력합니다. LaunchAgent는 `sky service install`이 소유합니다.

```bash
sky update
```

`sky update`는 최신 release와 현재 version을 비교하고 checksum과 architecture를 검증한 뒤 executable을 원자적으로 교체하고 daemon을 재시작합니다. 이미 최신이면 파일이나 daemon을 바꾸지 않습니다. 검증이나 재시작이 실패하면 기존 executable과 daemon을 보존하거나 복원합니다.

기존 Homebrew 설치와 외부 cron은 [마이그레이션](migrations.md)을 먼저 확인하세요.

## 문제 진단

`sky doctor`는 하나의 구조화된 check 목록에서 사람용 출력과 `--json` 출력을 만듭니다. 각 check는 안정적인 `id`, `pass`/`warn`/`fail` status, summary, 선택적 detail과 remediation을 가집니다. 설치된 Sky runtime/version과 PATH의 `skyd` executable, LaunchAgent, control socket, daemon runtime/Slack state, 최근 stable error code, 설정·credential metadata, managed path의 owner/mode/type, SQLite sidecar, workspace와 네 prompt file을 검사합니다.

`installation.drift`는 CLI와 실행 중인 daemon의 version 차이를 확인합니다. 실패하면 `sky restart`로 daemon을 갱신합니다.

```bash
sky doctor
sky doctor --json
```

daemon이 응답하면 CLI는 `GET /diagnostics`를 사용해 active runtime과 disk configuration의 차이까지 확인합니다. control socket에 연결할 수 없으면 같은 diagnostics module의 read-only local fallback이 service, Sky home, configuration metadata와 workspace를 검사합니다. fallback은 directory를 만들거나 mode를 바꾸거나 migration을 실행하지 않으며, runtime-only check는 실패 대신 `warn`과 unavailable detail로 표시합니다.

Exit code는 다음과 같습니다.

- `0`: fail이 없음. warning은 있을 수 있습니다.
- `1`: 하나 이상의 check가 fail입니다.
- `2`: daemon diagnostics 자체의 내부 오류 등으로 진단을 완료하지 못했습니다.

Doctor는 secret 값·길이, Slack message, prompt 또는 transcript 내용을 출력하지 않습니다. remediation도 `chmod`, 삭제, migration을 자동 실행하지 않고 검토할 명령과 위험만 안내합니다. 기본 doctor는 daemon이 이미 관찰한 Slack 연결 상태와 local backend 설정만 읽으며 Slack `auth.test`, scope probe, 새 network request 또는 비용이 생기는 agent turn을 실행하지 않습니다. 따라서 doctor는 어떤 scope가 빠졌는지 스스로 알지 못하고, Slack 관련 remediation은 scope를 직접 지목하는 대신 manifest 재적용 경로만 안내합니다. 부족한 scope 이름이 필요하면 admin gateway의 Slack 연결 검사를 사용합니다.

`sky doctor --json`은 `schemaVersion`, `mode`(`daemon`/`local-fallback`), `overall`과 check 배열을 반환합니다.

## 로그

```bash
sky logs
sky logs --json
sky logs --follow
sky logs --cursor <cursor> --limit 500
```

daemon이 살아 있으면 CLI는 `GET /logs` history와 `GET /logs/stream` live stream을 사용합니다. 각 app log record의 cursor는 daemon instance ID와 process-local sequence로 구성됩니다. follow stream이 끊기고 LaunchAgent job이 계속 loaded 상태면 마지막 cursor로 새 control socket에 재접속합니다. job이 unload되면 rotation archive까지 마지막 record를 읽고 종료합니다.

daemon control socket에 연결할 수 없으면 Sky home의 `logs/skyd.jsonl`과 최대 5개 archive, `logs/launchd.stderr.log`를 read-only fallback으로 조회합니다. `--json`은 record 하나당 JSON 한 줄을 출력합니다. 외부 `tail` process는 사용하지 않습니다.

`skyd` structured app log는 Sky home의 `logs/skyd.jsonl`에 기록되며 10 MiB 단위, archive 5개로 rotation됩니다.

LaunchAgent가 daemon entrypoint를 시작하지 못한 오류는 Sky home의 `logs/launchd.stderr.log`에 남으며 daemon down 상태의 `sky logs` fallback에 포함됩니다.

structured app log에는 Slack message, agent prompt, token을 기록하지 않고 operation 종류/상태와 안전한 daemon 진단만 기록합니다.

### Claude SDK 진단

Claude query의 진행 단계는 `claude-query` scope에 기록됩니다. 첫 SDK 응답이 지연되면 제한된 shell·locale·TTY metadata를 포함한 warning이 남습니다. Prompt, Slack 본문, token과 전체 환경은 구조화 로그에 기록하지 않습니다.

SDK raw stderr/debug는 기본 비활성입니다. LaunchAgent 조사 때만 `SKY_CLAUDE_DIAGNOSTICS=1 sky service install`로 활성화할 수 있으며 Sky home의 `logs/claude-agent-sdk.debug.log`를 mode `0600`, daemon 실행당 최대 10 MiB로 기록합니다. raw debug에는 민감한 실행 정보가 포함될 수 있으므로 공유하지 말고 조사 후 플래그 없이 `sky service install`을 다시 실행해 비활성화합니다.

## Admin 접속

`sky admin`은 같은 OS 사용자만 접근할 수 있는 control socket에서 5분짜리 일회용 token을 발급하고, 기본 browser를 `http://127.0.0.1:4815/#token=...` 형태로 엽니다. Browser는 token을 교환하기 전에 fragment를 주소에서 제거하며, 교환에 성공하면 daemon memory에만 존재하는 24시간 session을 사용합니다. Daemon을 재시작하면 발급된 token과 session이 모두 무효화됩니다.

다른 LAN 또는 tailnet 장치에서 접속할 때는 daemon host에서 다음 명령을 실행한 뒤 출력된 URL을 remote browser에서 열고 token을 직접 붙여 넣습니다.

```bash
sky admin --no-open
```

Tailscale에서 직접 접속할 때는 출력된 hostname 대신 daemon host의 MagicDNS 이름이나 Tailscale IP를 사용할 수 있습니다. 예를 들어 `http://sky-mac:4815` 또는 `http://100.x.y.z:4815`를 연 뒤 같은 일회용 token을 입력합니다. 이 경로도 Sky 자체로는 TLS를 추가하지 않으며 평문 HTTP입니다.

Admin gateway는 기본적으로 `0.0.0.0:4815`의 **평문 HTTP**로 LAN과 tailnet에 노출됩니다. 인터넷에 공개하지 마세요. 인증과 browser 보안 설계는 [ADR-0004](adr/0004-expose-authenticated-admin-gateway.md)에 정리되어 있습니다.

Agent·Connections 화면에서 설정과 credential을 변경하고 필요한 경우 재시작합니다. Credential 원문은 조회되지 않으며 keep·replace·delete로 관리합니다. 환경의 `CLAUDE_CODE_OAUTH_TOKEN`이 있으면 저장한 token보다 우선합니다. System 화면은 재시작을 지원하며 업데이트는 CLI의 `sky update`를 사용합니다. 재시작 후에는 `sky admin`으로 다시 로그인합니다.

명시적 연결 검사는 저장 상태와 별도로 daemon memory에 마지막 결과만 보관합니다. Slack bot은 `auth.test` 응답 identity와 `x-oauth-scopes`를 Sky 필수 scope와 비교하고, Slack app token은 `apps.connections.open` 성공만 확인한 뒤 발급된 WebSocket URL을 즉시 버립니다. Claude Agent SDK는 prompt나 turn 없이 bounded `accountInfo()` smoke를 실행하고 subprocess를 정리하며, Pi는 `sky doctor`와 같은 local model registry·provider credential·effort compatibility 규칙을 사용합니다. timeout, rate limit, invalid credential, missing scope는 서로 다른 안정된 결과 code로 반환되며 raw credential과 Socket Mode URL은 응답이나 log에 포함되지 않습니다. `missing_scope` 결과에는 부족한 scope 이름과 함께 manifest 재적용 안내가 들어갑니다.

## Memory와 dream

`sky memory`와 `sky dream`은 CLI 안에서 agent runtime을 만들지 않고 실행 중인 daemon에 operation을 요청합니다. CLI는 operation ID를 첫 줄에 출력하고 기본적으로 완료까지 event stream을 지켜봅니다. `Ctrl-C`는 operation을 취소하지 않고 화면만 분리합니다. 처음부터 기다리지 않으려면 `--detach`를 사용합니다.

```bash
sky memory --detach
sky dream --date 2026-08-01 --step summarize
sky operation status <operation-id> --json
sky operation watch <operation-id>
```

`memory`와 `dream`은 합쳐서 한 번에 하나만 실행됩니다. 이미 실행 중이면 새 요청은 active operation ID와 함께 거부됩니다. 완료 record는 최대 100개이면서 완료 후 24시간 이내인 것만, event는 operation당 최근 1,000개만 daemon 메모리에 남습니다. daemon을 재시작하면 operation registry는 복원되지 않습니다.

`skyd`는 유효한 configuration이 준비되면 Slack 연결 상태와 무관하게 memory와 dream을 예약 실행합니다. Memory는 `*/5 * * * *`, dream은 `0 2 * * *`, 모두 `Asia/Seoul` 기준입니다. 30초 ticker가 절전이나 긴 operation 때문에 여러 memory occurrence를 놓쳐도 후속 실행은 한 번으로 합칩니다. Dream은 같은 tick의 memory보다 먼저 검사하며, 마지막 성공 target date 다음 날부터 어제까지 누락된 날짜를 오래된 순서로 한 번씩 실행합니다.

Dream의 전체 summarize·knowledge operation이 `succeeded`가 된 뒤에만 Sky home의 `maintenance-state.json` watermark가 원자적으로 전진합니다. 이 private state는 versioned JSON document이며 mode `0600`인 regular file이어야 합니다. 최초 state가 없을 때만 workspace의 가장 최근 due daily episode를 완료된 날짜로 bootstrap합니다. 이후에는 daily 파일 존재로 성공을 추론하지 않습니다. 실패, timeout 또는 active-operation 충돌은 watermark를 전진시키지 않고 5분 cooldown 뒤 재시도합니다.

외부 cron을 사용하던 설치는 [전환과 rollback 절차](migrations.md#외부-cron에서-내장-스케줄러로-전환)를 따릅니다. 외부 cron과 내장 스케줄러가 같은 작업을 동시에 실행하면 안 됩니다.

## 예약 리마인더

예약된 리마인더는 Sky home의 `sky.db`에 저장되며 데몬의 30초 ticker가 실행합니다.

일회성 리마인더의 에이전트 실행 실패는 60초 간격으로 최대 3회 시도합니다. 실행 후 전달 실패는 별도로 기록하고 같은 작업을 자동 재실행하지 않습니다. 반복 예약은 실패를 기록한 뒤 다음 회차로 넘어갑니다.

Slack 전달이 불가능한 동안 예약은 실행 횟수를 소모하지 않고 대기합니다. 기한이 지난 대기 상태의 일회성 예약은 연결 복구·데몬 재시작 후 실행하며, 반복 예약의 누락 회차는 건너뛰고 다음 예정 시각부터 실행합니다. 이미 실행하다 중단된 작업은 중복 실행 방지를 위해 기존 stale-running 정책으로 실패 처리합니다.

실행 결과의 영속 보관과 전달만 재시도하는 기능은 아직 없으므로, 실행 후 전달 실패의 자동 재전송은 보장하지 않습니다.

실행과 전달을 나눈 근거는 [ADR-0010](adr/0010-separate-agent-runtime-from-slack.md)에 있습니다.
