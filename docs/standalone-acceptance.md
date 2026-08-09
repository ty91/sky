# Standalone acceptance

이 문서는 Apple Silicon macOS용 standalone artifact가 개발 checkout과 JavaScript runtime 없이 동작하고, 실제 Pi 및 Claude credential로 turn·resume 계약을 지키는지 릴리스 전에 확인하는 절차다.

## 자동 검증

저장소 toolchain에서 다음 순서로 실행한다.

```bash
pnpm test
bun run build:standalone
pnpm test:standalone
pnpm package:standalone
pnpm test:standalone:package
pnpm test:standalone:install
```

`pnpm test`는 공통 agent session contract와 Claude Agent SDK의 resume, interrupt, Sky MCP tool wiring을 검증한다. `pnpm test:standalone`은 빌드된 artifact를 checkout 밖의 임시 디렉터리에서 실행하며 다음 조건을 확인한다.

- 임시 `bin`에는 같은 executable을 가리키는 `sky`, `skyd` symlink만 있다.
- 자식 프로세스의 `PATH`에는 Node.js와 Bun이 없고 `HOME`, `SKY_HOME`은 서로 다른 임시 경로다.
- `sky`와 `skyd`의 version·help, `skyd`의 explicit foreground 계약과 실제 startup이 동작한다.
- admin index와 hashed JavaScript·CSS가 package directory 없이 제공된다.
- artifact에는 물리 executable 하나와 `skyd` symlink만 있다.
- metafile에는 darwin-arm64 Claude helper와 Pi clipboard addon이 각각 하나만 있고 다른 target은 없다.

`pnpm package:standalone`은 검증된 `dist/standalone/darwin-arm64/sky`로부터 다음 두 release asset을 `dist/release`에 생성한다.

- `sky-<version>-darwin-arm64.tar.gz`
- `sky-<version>-darwin-arm64.tar.gz.sha256`

Archive에는 mode `0755`인 arm64 Mach-O 실행 파일 `sky` 하나만 들어 있다. `skyd` 링크는 설치 과정에서 생성하므로 archive에 포함하지 않는다. 파일 이름의 version은 실행 파일의 `sky --version` 및 `package.json` version과 일치해야 한다. Checksum 파일은 archive와 같은 디렉터리에서 다음 표준 명령으로 검증한다.

```bash
shasum -a 256 -c sky-<version>-darwin-arm64.tar.gz.sha256
```

`pnpm test:standalone:package`는 패키징 명령을 실행하고 asset 이름, archive 내용물과 실행 권한, 실행 파일 version과 architecture, checksum 검증을 실제 생성물 기준으로 확인한다.

루트의 `install.sh`는 옵션이 없으면 GitHub의 latest release를 조회하고, `--version <version>`으로 release를 고정할 수 있다. 선택한 release의 archive와 checksum을 모두 내려받아 checksum, 단일 `sky` 내용물, 실행 권한과 version을 검증한 뒤에만 `~/.local/bin/sky`를 교체하고 같은 디렉터리에 `sky`를 가리키는 `skyd` 상대 symlink를 만든다. `~/.local/bin`이 `PATH`에 없으면 설치 후 추가 방법을 출력한다.

`--artifact-base-url <url>`은 지정한 version의 두 asset을 가져올 source를 바꾼다. 이 옵션은 `--version`과 함께 사용해야 한다. `pnpm test:standalone:install`은 `file://` source와 격리된 `HOME`, `/usr/bin:/bin`만 있는 `PATH`에서 checksum 실패의 무변경 보장, 첫 설치, PATH 안내, 재설치 멱등성과 설치된 `sky --version`을 실제 `/bin/sh` 프로세스로 검증한다.

Standalone 설치 후 `sky update`는 GitHub의 latest release API를 무인증으로 조회한다. 현재 version과 같으면 artifact나 daemon을 건드리지 않고 종료한다. 새 version이면 정확한 이름의 archive와 checksum asset을 내려받아 checksum, 단일 `sky` 내용물, 실행 권한과 version을 검증한 뒤 실행 중인 `sky`와 같은 directory에 staging file을 만들고 원자적으로 교체한다. 교체가 끝난 뒤에는 기존 graceful restart 경로를 호출해 LaunchAgent daemon을 새 executable로 올린다. Node.js 개발 runtime에서는 package 또는 checkout의 update 경로를 사용하도록 안내하고 실행을 거부한다.

`pnpm test:standalone:update`는 mock latest-release API와 release asset 서버를 사용해 이미 최신인 경우의 무변경, download와 checksum 실패 시 executable·daemon 무변경, 성공 시 원자적 교체와 daemon restart, Node.js runtime 거부를 검증한다. 이 smoke는 `bun run build:standalone` 뒤에 실행한다. `--release-api-url <url>`은 이 mock server처럼 latest-release API endpoint를 명시적으로 바꿔야 하는 검증 환경을 위한 override다.

메타파일 audit 자체는 합성된 duplicate와 non-target 입력을 `pnpm test`에서 별도로 거부한다.

## 실제 launchd lifecycle 검증

Standalone LaunchAgent 스모크는 Apple Silicon macOS의 로그인된 GUI 세션에서 실행한다. Release workflow는 standalone artifact를 빌드한 뒤 이 스모크를 발행 gate로 실행한다. 로컬에서는 다음 명령으로 같은 검증을 수동 실행할 수 있으며 기본 테스트 스위트에는 포함되지 않는다.

```bash
pnpm build:standalone
pnpm test:launchd:standalone
```

이 스모크는 실제 사용자 gui domain의 `com.ty91.skyd` service target을 점유한다. 기존 Sky LaunchAgent가 로드되어 있거나 `~/Library/LaunchAgents/com.ty91.skyd.plist`가 남아 있으면 실행하지 않는다. 스모크도 이 상태를 선검사해 기존 daemon을 중지하거나 plist를 변경하지 않고 실패한다. 전용 test user 또는 Sky LaunchAgent를 완전히 uninstall한 개발 머신에서만 실행한다.

통과 조건은 다음과 같다.

- `sky`와 `skyd`만 있는 임시 bin과 `/usr/bin:/bin`으로 구성한 PATH에 Node.js와 Bun이 없고, standalone `service install`이 daemon을 시작한다.
- `status`, `stop`, `start`, 강제 `restart`, `service uninstall` 전체 lifecycle이 실제 launchd에서 동작한다.
- plist `ProgramArguments`가 standalone build의 versioned 산출물 경로가 아니라 임시 설치의 안정적인 `skyd` 경로를 기록한다.
- 호스트 `node@24` 경로가 들어 있는 기존 plist를 `service install`이 새 PATH와 안정적인 `skyd` 계약으로 reconcile한다.
- 새 plist의 bootstrap 실패가 이전 plist를 byte-for-byte 복원하고 이전 daemon을 다시 시작한다.
- `sky doctor`의 standalone runtime과 executable 검사가 pass하며 `installation.node` 검사가 존재하지 않는다.

## 실제 backend acceptance 준비

실제 acceptance에는 별도의 Slack test app credential, 사용할 model credential, 테스트용 Slack 대화 공간이 필요하다. 같은 Slack app으로 실행 중인 다른 Sky daemon이 있으면 Socket Mode event가 어느 daemon으로 전달될지 보장되지 않으므로 기존 daemon을 중지하거나 전용 test app을 사용한다.

빌드 artifact를 checkout 밖에서 같은 물리 파일로 실행한다. 아래 변수 이름은 예시이며 secret 값은 command line이나 shell history에 직접 넣지 않는다.

```bash
acceptance_root="$(mktemp -d)"
mkdir -p "$acceptance_root/bin" "$acceptance_root/home" "$acceptance_root/sky-home" "$acceptance_root/workspace"
ln -s "$PWD/dist/standalone/darwin-arm64/sky" "$acceptance_root/bin/sky"
ln -s "$PWD/dist/standalone/darwin-arm64/sky" "$acceptance_root/bin/skyd"
export HOME="$acceptance_root/home"
export SKY_HOME="$acceptance_root/sky-home"
export PATH=/usr/bin:/bin
```

Pi credential을 기존 설치에서 재사용한다면 원래 home의 `.pi/agent`를 가리키도록 `PI_CODING_AGENT_DIR`을 설정한다. 더 강한 격리가 필요하면 해당 디렉터리에서 `auth.json`, `models.json`과 model store를 mode `0600`인 임시 credential 디렉터리로 복사한 뒤 그 경로를 지정한다. Claude는 `sky init --from-stdin`으로 `claudeAgentSdk.oauthToken`을 test용 Sky home에 저장하거나 daemon 환경에 `CLAUDE_CODE_OAUTH_TOKEN`을 전달한다.

foreground daemon은 충돌 없는 임시 admin port로 시작한다.

```bash
"$acceptance_root/bin/skyd" --foreground --admin-port 0
```

다른 terminal에서도 같은 `HOME`, `SKY_HOME`, `PATH`를 설정한다. daemon이 실행 중인 상태에서 `sky init --from-stdin --json --no-restart`로 backend, model, workspace, Slack credential과 필요한 Claude credential을 저장한다. 입력 JSON은 mode `0600`인 임시 파일로 만들고 acceptance 종료 시 삭제한다. 설정 변경 후 foreground daemon을 종료하고 같은 명령으로 다시 시작해 새 설정을 적용한다.

## Pi turn과 resume

1. backend를 `pi`로 설정하고 Pi registry에 존재하는 `<provider>/<model>`을 선택한다.
2. 새 Slack thread에서 고유 nonce를 기억하고 그대로 답하라고 요청한다.
3. 응답이 끝나면 foreground daemon을 `SIGTERM`으로 종료하고 같은 환경과 명령으로 다시 시작한다.
4. 같은 Slack thread에서 이전 nonce를 묻는다.
5. `sky.db`의 해당 conversation record를 확인한다.

통과 조건은 첫 turn이 streaming 응답을 완료하고, 재시작 후 후속 turn이 nonce를 정확히 복원하며, 같은 `session_id`를 유지하고 `resume_ref`가 선택한 Pi agent directory의 session file을 가리키는 것이다. daemon log에는 addon load, model lookup, auth, session open 오류가 없어야 한다.

## Claude turn, resume, interrupt와 Sky MCP

1. backend를 `claude-agent-sdk`로 설정하고 `anthropic/<model>`을 선택한다.
2. 새 Slack thread에서 고유 nonce를 기억하고 그대로 답하라고 요청한다.
3. daemon을 종료했다가 같은 환경과 명령으로 다시 시작한 뒤 같은 thread에서 nonce를 묻는다.
4. 새 thread에서 Bash로 20초 대기한 뒤 답하도록 요청하고, 대기가 끝나기 전에 같은 thread에 두 번째 요청을 보낸다.
5. 새 thread에서 먼 미래 시각의 일회성 reminder를 `schedule_reminder`로 만들고, 이어서 `list_scheduled`와 `cancel_scheduled`를 사용하도록 요청한다.

통과 조건은 다음과 같다.

- 첫 turn과 재시작 후 resume가 모두 완료되고 같은 `session_id`를 유지한다. Claude record의 `resume_ref`는 비어 있어야 한다.
- 첫 long-running turn은 interrupt된 응답을 별도로 전송하지 않고 두 번째 요청이 완료된다. daemon은 계속 실행 중이어야 한다.
- reminder가 `sky.db`에 pending 상태로 생성되고 list 결과에 나타난 뒤 cancelled 상태가 된다. 이는 embedded Claude helper가 `mcp__sky__schedule_reminder`, `mcp__sky__list_scheduled`, `mcp__sky__cancel_scheduled` 경로를 실제 호출했다는 acceptance 증거다.
- daemon log에는 helper extraction·spawn, OAuth, resume, interrupt 또는 MCP transport 오류가 없어야 한다.

## 종료와 기록

각 backend에 대해 사용한 artifact version, model, 첫 turn, 재시작 후 resume, Claude interrupt, Sky MCP 결과를 pass/fail로 기록한다. 실패 시 credential 원문이나 전체 environment를 남기지 말고 backend, 단계, 안전하게 정리한 오류와 `skyd.jsonl`의 관련 event만 기록한다.

foreground daemon을 종료한 뒤 test Slack app credential을 폐기하거나 회수하고 임시 root를 삭제한다. 기존 credential 디렉터리를 직접 가리킨 경우 그 디렉터리는 삭제 대상에 포함하지 않는다.
