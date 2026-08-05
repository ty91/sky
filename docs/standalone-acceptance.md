# Standalone acceptance

이 문서는 Apple Silicon macOS용 standalone artifact가 개발 checkout과 JavaScript runtime 없이 동작하고, 실제 Pi 및 Claude credential로 turn·resume 계약을 지키는지 릴리스 전에 확인하는 절차다.

## 자동 검증

저장소 toolchain에서 다음 순서로 실행한다.

```bash
pnpm test
bun run build:standalone
pnpm test:standalone
```

`pnpm test`는 공통 agent session contract와 Claude Agent SDK의 resume, interrupt, Sky MCP tool wiring을 검증한다. `pnpm test:standalone`은 빌드된 artifact를 checkout 밖의 임시 디렉터리에서 실행하며 다음 조건을 확인한다.

- 임시 `bin`에는 같은 executable을 가리키는 `sky`, `skyd` symlink만 있다.
- 자식 프로세스의 `PATH`에는 Node.js와 Bun이 없고 `HOME`, `SKY_HOME`은 서로 다른 임시 경로다.
- `sky`와 `skyd`의 version·help, `skyd`의 explicit foreground 계약과 실제 startup이 동작한다.
- admin index와 hashed JavaScript·CSS가 package directory 없이 제공된다.
- artifact에는 물리 executable 하나와 `skyd` symlink만 있다.
- metafile에는 darwin-arm64 Claude helper와 Pi clipboard addon이 각각 하나만 있고 다른 target은 없다.

메타파일 audit 자체는 합성된 duplicate와 non-target 입력을 `pnpm test`에서 별도로 거부한다.

## 실제 launchd lifecycle 검증

Standalone LaunchAgent 스모크는 Apple Silicon macOS의 로그인된 GUI 세션에서만 수동으로 실행한다. 기본 테스트 스위트와 CI에는 포함되지 않는다.

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
