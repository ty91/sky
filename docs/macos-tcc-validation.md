# macOS 호스트의 TCC 검증

[macOS 앱](desktop.md) · [서명과 공증](macos-signing.md) · [TY-66](https://linear.app/jakdo/issue/TY-66)

설치된 앱의 SMAppService 호스트에서 직접 파일 접근, Pi 파일 도구·Bash, Claude 파일 도구·Bash를 구분한다. 최종 판정에는 실제 도구 결과, 파일 내용, 프로세스 관계, macOS 요청·설정·TCC 진단을 함께 사용한다. 자동 테스트나 서명 검증은 TCC 귀속의 증거가 아니다.

## 환경과 배포물

개인 운영 설치와 분리된 Apple Silicon macOS VM을 사용한다. 최초 설치 이후의 깨끗한 복사본을 보존하고 독립된 권한 시나리오마다 복원한다. OS의 정확한 버전·빌드를 기록한다. 앱의 최소 지원 버전은 13.0이며 한 OS의 결과를 다른 버전의 통과로 확장하지 않는다. Terminal·IDE·인터프리터·Claude helper의 기존 권한에 의존하거나 TCC·Gatekeeper·SIP를 끈 자동화 이미지는 기준 환경으로 쓰지 않는다.

같은 Sky 서명 정체성과 `com.jakdo.sky` 식별자를 유지하는 두 제품 버전을 각각 [서명·공증](macos-signing.md#로컬-배포-빌드)한다. ZIP checksum, 제품 버전, 소스 커밋, 공증 요청 ID를 보존한다. 최종 설치 위치에서 서명·stapling·Gatekeeper를 검증한 뒤 Finder로 앱을 열고 앱의 실제 등록 기능으로 서비스를 등록한다. 서명 뒤 plist·코드를 수정하거나 스모크용 다른 bundle ID로 바꾼 결과를 사용하지 않는다.

[ADR-0013](adr/0013-sign-fixed-desktop-code-before-notarization.md)의 코드 배치는 다음과 같다. 이 서명 결정 자체가 TCC 귀속을 확정하지는 않는다.

| 역할 | 앱 안의 경로 | 서명 정책 |
| --- | --- | --- |
| 네이티브 앱 | `Contents/MacOS/sky-desktop` | Sky Developer ID, 앱 식별자 |
| 호스트 | `Contents/MacOS/skyd` | Sky Developer ID, `com.jakdo.sky.skyd`, JIT entitlement |
| Claude | `Contents/Helpers/claude` | 공급자 Anthropic 서명 유지 |
| Pi native addon | `Contents/Frameworks/clipboard.darwin-arm64.node` | Sky Developer ID |

일반 CLI standalone의 임시 Claude 추출 경로는 앱 검증 경로와 다르다. 앱 배포물에서 실제 실행 경로를 확인한다.

## 로컬 검증 경로 활성화

호스트는 시작 시 Sky home의 `tcc-validation.json`이 있을 때만 사용자 전용 UDS에 `POST /validation/tcc`를 추가한다. 파일은 현재 사용자 소유의 일반 파일, 권한 `0600`, 최대 8192바이트여야 한다. symlink나 잘못된 설정은 검증 기능만 비활성화하고 호스트 로그에 오류를 남긴다. 브라우저 admin과 원격 HTTP에는 이 경로가 없다. 사용 후 파일을 삭제하고 호스트를 재시작한다.

격리 계정에서 비민감 테스트 데이터를 준비하고 실제 절대 경로를 등록한다. 아래 `skytest`는 실제 계정 이름으로 바꾼다. 각 디렉터리의 마지막 이름은 `sky-tcc-validation`이어야 한다. 기존 개인 데이터나 symlink를 fixture로 쓰지 않는다.

```json
{
  "fixtureDirectories": [
    "/Users/skytest/sky-tcc-validation",
    "/Users/skytest/Desktop/sky-tcc-validation",
    "/Users/skytest/Library/Mail/sky-tcc-validation"
  ]
}
```

첫 번째는 비보호 대조군, Desktop은 파일 및 폴더 권한, Mail 아래 테스트 디렉터리는 전체 디스크 접근 검증의 후보이다. 보호 위치의 동작은 OS에 따라 달라진다. 승인 전 실제 거부가 관찰되지 않으면 FDA 검증 성공으로 판정하지 않는다. 보호 위치의 fixture는 별도의 관찰자 경로로 준비하고, 준비에 쓴 앱과 권한도 기록한다. 관찰자의 접근 성공을 Sky의 접근 성공으로 간주하지 않는다.

각 `input.txt`에는 서로 다른 임의 문자열 한 줄을 넣는다. 기대 문자열은 관찰자가 별도로 보관하며 요청·모델 프롬프트에 넣지 않는다. 읽기 결과와 이를 비교한다. 쓰기는 실행별 `output-<id>.txt`를 만들며 실제 내용이 응답의 `expectedContent`와 정확히 같은지 따로 확인한다.

모델·credential은 호스트의 기존 설정을 사용한다. Slack 연결은 필요 없다. Pi와 Claude를 차례로 설정하고 각 backend에 사용 가능한 모델을 지정한다. 토큰은 명령행·결과 JSON·스크린샷·이슈에 넣지 않는다. fixture 이외의 개인 데이터는 VM에 옮기지 않는다.

## 요청과 증거

등록된 앱에서 호스트를 재시작한 뒤 요청한다. `route`는 `host`, `file`, `bash`, `operation`은 `read`, `write`다. 경로는 시작 시의 허용 목록과 정확히 같아야 한다.

```sh
curl --fail-with-body --max-time 200 \
  --unix-socket "$HOME/.sky/run/skyd.sock" \
  -H 'Content-Type: application/json' \
  --data-binary @request.json \
  http://localhost/validation/tcc > result.json
```

`request.json` 예시:

```json
{
  "route": "file",
  "operation": "read",
  "directory": "/Users/skytest/Desktop/sky-tcc-validation"
}
```

`host`는 skyd 자체가 파일 I/O를 수행한다. `file`은 설정한 backend의 실제 Read 또는 Write 하나만 제공한다. `bash`는 같은 backend의 실제 Bash에 고정된 foreground 명령을 전달한다. Bash는 PID·PPID를 출력하고 5초 대기한 뒤 `cat` 또는 `printf`로 접근한다. 이때 프로세스 관계를 수집한다. 모델이 다른 도구·명령을 사용하면 재검증한다.

한 번에 하나만 실행하며 호스트의 drain에 참여한다. 클라이언트 연결 종료·호스트 drain·180초 제한은 실행 중단과 세션 정리를 요청한다. 실행이 아직 종료되지 않았다면 새 요청은 `operation_active`로 거부한다. 중단한 요청의 부분 결과는 통과 근거가 아니다.

응답은 실행 ID·시각, 호스트 PID·PPID·실행 파일·OS kernel release, backend·모델·Claude 경로, 실제 대상 파일, 직접 I/O 결과·오류 코드, Pi 세션 파일 경로를 포함한다. `evidence`에는 Pi의 실제 `tool_execution_start`·`tool_execution_end` 또는 Claude의 실제 `tool_use`·`tool_result`를 담는다.

`turn-completed`는 모델 턴의 종료만 뜻한다. 도구 호출과 결과가 없거나 `truncated`가 참이면 통과를 판정할 수 없다. `attribution`은 항상 `unverified`다. 시스템 진단과 대조해야 Sky 귀속을 확정할 수 있다. 증거는 최대 64개 이벤트·256KiB로 제한한다. 설정된 Slack·Claude 토큰은 가리지만 임의의 개인 데이터 전체를 자동 익명화하는 기능은 아니다.

동시에 VM에서 다음을 수집한다. 전체 프로세스 인자·환경에는 credential이 있을 수 있으므로 수집하지 않는다.

```sh
sw_vers
launchctl print "gui/$(id -u)/com.ty91.skyd"
ps -axo pid,ppid,pgid,comm
log stream --style compact --predicate 'subsystem == "com.apple.TCC"'
```

필요하면 관리자 권한의 `launchctl procinfo <PID>`로 책임 프로세스 정보를 추가 확인한다. TCC 진단이 비공개로 가려지면 미확인으로 기록한다. PPID만으로 responsible code를 추정하지 않는다. helper의 daemonize·별도 서비스 전환과 Bash·외부 도구의 실제 경로를 점검한다. 앱·호스트·Claude 각각의 `codesign -dv --verbose=4`, `codesign -dr -`, 앱 서비스 plist, 실제 권한 요청 화면과 시스템 설정의 Sky 항목도 보존한다. helper나 인터프리터에 수동 권한을 추가해 통과시키지 않는다.

## 권한과 생명주기 검증

1. 깨끗한 환경에서 비보호 대조군의 다섯 경로를 실행한다. credential·모델·서비스·서명 오류를 TCC 거부와 구분한다.
2. FDA 없이 파일 및 폴더의 최초 요청·거부를 관찰한다. 요청에 Sky가 표시되는지 기록한다. 사용자 흐름으로 Sky를 승인한 뒤 같은 fixture를 읽고 쓴다.
3. 별도 깨끗한 상태에서 FDA 대상 fixture의 승인 전 거부를 확인한다. 시스템 설정에서 Sky만 승인하고 필요한 프로세스를 다시 시작해 같은 접근을 확인한다. 파일 및 폴더 승인을 FDA 승인으로 간주하지 않는다.
4. 각 권한을 철회하고 현재 프로세스와 재시작한 프로세스의 결과를 각각 기록한다. 즉시 반영되지 않으면 재시작 조건을 제약으로 남긴다.
5. 승인 상태에서 UI 앱을 종료하고 같은 호스트 PID로 검증한다. 호스트 재시작·로그아웃과 재로그인 후 새 PID와 같은 서비스·앱 귀속을 확인한다.
6. 승인 상태의 버전 A를 B로 통제 교체한다. 이전 앱에서 서비스를 해제하고 종료한 뒤 같은 위치에 새 전체 번들을 설치한다. 설정·credential·DB·TCC 설정을 지우지 않는다. 서명 정체성·designated requirement를 비교하고 새 앱에서 재등록한다. 승인 유지·실행 결과·재철회를 기록한다. 버전만 바꾸고 재서명·공증하지 않은 앱은 사용할 수 없다.
7. 패키징 보정이 필요하면 전체 서명·공증·서비스 검증과 영향받은 권한 행을 다시 실행한다. 일반 도구나 helper로 귀속되는 실패는 성공으로 마감하지 않는다.

자동화·손쉬운 사용·화면 녹화는 별도 권한이다. 이 검증 경로는 이를 요청하거나 제공하지 않는다. Bash에서 임의의 화면 제어 명령을 실행한 결과를 파일 접근 검증에 섞지 않는다.

## 판정과 기록표

`EPERM`·`EACCES`는 접근 거부의 관찰 결과이며 단독으로 TCC 원인을 확정하지 않는다. 소유권·ACL, sandbox, Endpoint Security와 TCC 진단을 함께 확인한다. `ENOENT`, 잘못된 경로·파일 종류, 모델 인증 실패, 도구 미호출·timeout은 별도 오류 또는 미확인이다. FDA를 확정 조회하는 일반 API나 TCC DB 조회 결과를 판정 근거로 가정하지 않는다.

## 2026-09-27 실측 결과

macOS 26.6.2(25G83), arm64 VM에서 SIP·Gatekeeper를 활성화한 채 측정했다. Pi 0.80.10은 `openai-codex/gpt-5.5`, Claude Agent SDK 0.3.283은 `anthropic/claude-opus-5-5`를 사용했다. 앱 최소 버전 13.0과 실측 OS 범위는 다르며 다른 macOS 버전의 결과는 미확인이다.

사용자 요청으로 Desktop 검증 후 실측을 종료했다. **FDA는 승인 전 Mail fixture 접근 거부까지만 확인했다. FDA 승인·철회·생명주기·버전 교체는 미실행이며 통과로 취급하지 않는다.** 작업용 VM과 복사본은 증거 보존 후 삭제했다. 이 기록은 TY-66의 전체 최초 검증표를 통과했다는 주장이 아니다.

### 배포물과 측정 조건

두 배포물 모두 코드 커밋 `6e1b6ae0dd9b`를 사용한다. B는 루트 패키지 버전만 0.2.12로 올려 빌드한 뒤 작업 트리를 0.2.11로 복원했다. A·B 각각 서명·공증·stapling·서명된 앱 이동 실행 검증을 통과했고, VM 설치 위치에서 서명과 Gatekeeper를 확인했다. 앱·호스트의 designated requirement는 두 버전에서 정확히 같다.

| 배포물 | SHA-256 | 공증 요청 ID |
| --- | --- | --- |
| A 0.2.11 | `6712757c0ebcdec16e273b49e6a2de344b5a44daee32eca00b98011bf22ccc1b` | `5185038f-c3b5-47b2-99a7-b07c5d3a7da6` |
| B 0.2.12 | `0096aa39e9ce85144b3cd70671e79890dda5c23b87a5ad7d7be83e75c7247df9` | `687f16dc-dbc4-4236-b418-35fe5c3c11f3` |

관찰자는 VM의 원격 로그인 경로로 비민감 fixture를 홈에서 생성해 Desktop·Mail로 옮기고 쓰기 결과를 읽었다. 이 관찰자에는 `sshd-keygen-wrapper`의 기존 전체 디스크 접근이 있었으며, 호스트는 SSH에서 실행하지 않고 Finder로 연 앱의 SMAppService 등록을 통해 실행했다. Sky·Claude helper·Bash에 관찰자 권한을 부여하지 않았다. 디렉터리는 테스트 계정 소유, `0700`, 별도 ACL 없음으로 확인했다.

최초 Desktop 요청 화면에는 Sky가 표시됐고 거부 후 시스템 설정의 Sky → 데스크탑 폴더 항목이 꺼졌다. 이후 같은 앱 식별자의 고정된 배포물 A에서 승인 전 거부를 재확인했다. 05:53:36 UTC에 시스템 설정에서 Sky를 승인하고 재시작 안내의 ‘나중에’를 선택했다. 기존 호스트 PID 2270에서 곧바로 읽기·쓰기가 성공했다. 승인 유지 검증 뒤 B의 권한을 06:10:40 UTC에 철회하고 다시 ‘나중에’를 선택해 현재 호스트와 재시작 호스트를 구분했다.

### Desktop 파일 및 폴더 권한

셀은 **읽기 / 새 파일 쓰기** 순서다. ‘허용’은 실제 반환한 fixture 문자열 또는 관찰자가 읽은 정확한 출력 파일 내용으로 확인했으며 모델의 설명만으로 판정하지 않았다. 모든 파일·Bash 행은 실제 도구 호출과 결과를 포함한다.

| 실행 경로 | A 승인 전 | A 승인 직후 | A UI 종료 | A 호스트 재시작 | A 재로그인 | B 교체 후 | B 철회 직후 | B 철회 후 재시작 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 호스트 직접 | 거부 / 허용 | 허용 / 허용 | 허용 / 허용 | 허용 / 허용 | 허용 / 허용 | 허용 / 허용 | 거부 / 허용 | 거부 / 허용 |
| Pi 파일 도구 | 거부 / 허용 | 허용 / 허용 | 허용 / 허용 | 허용 / 허용 | 허용 / 허용 | 허용 / 허용 | 거부 / 허용 | 거부 / 허용 |
| Pi Bash | 거부 / 허용 | 허용 / 허용 | 허용 / 허용 | 허용 / 허용 | 허용 / 허용 | 허용 / 허용 | 거부 / 허용 | 거부 / 허용 |
| Claude 파일 도구 | 거부 / 거부 | 허용 / 허용 | 허용 / 허용 | 허용 / 허용 | 허용 / 허용 | 허용 / 허용 | 거부 / 거부 | 거부 / 거부 |
| Claude Bash | 거부 / 허용 | 허용 / 허용 | 허용 / 허용 | 허용 / 허용 | 허용 / 허용 | 허용 / 허용 | 거부 / 허용 | 거부 / 허용 |

Desktop 미승인·철회 상태에서 일부 새 파일 쓰기는 실제로 허용됐다. 파일 도구별 선행 파일 시스템 접근도 다를 수 있으므로 이를 ‘모든 I/O 차단’으로 일반화하지 않는다. 측정한 동일 접근은 승인 전과 철회 후에 같은 결과를 보였고, 읽기는 모든 경로에서 `EPERM` 또는 실제 도구의 permission denied로 거부됐다.

UI를 종료해도 PID 2270의 호스트는 유지됐다. UDS 재시작 후 PID 8726, 실제 로그아웃·재로그인 후 PID 10707로 바뀌었으며 서비스가 자동 기동했다. 로그아웃 중에는 GUI 서비스 도메인과 이전 호스트가 사라진 것을 확인했다. A에서 서비스를 해제하고 UI를 종료한 뒤 같은 위치에 B 전체 번들을 설치하고 재등록했다. B의 PID 14306에서 별도 재승인 없이 접근이 유지됐으며 철회 후 PID 20944로 재시작해도 위 표와 같았다.

### FDA와 실행 실패의 구분

Mail fixture는 A의 호스트·Pi 파일·Pi Bash·Claude 파일·Claude Bash에서 읽기와 쓰기 모두 거부됐다. 그 이후 FDA 승인은 수행하지 않았다. 승인 전 거부만으로 이 경로가 FDA 승인 후 성공한다고 결론 내릴 수 없다.

비보호 대조군에서 실행 경로를 먼저 확인했다. Pi는 인증 갱신과 번들 보정 후 실제 도구 호출에 성공했다. 번들에 포함된 모델 목록의 `gpt-5.4-mini`는 해당 계정에서 서버가 거절해, 지원되는 `gpt-5.5`로 변경했다. 초기 Claude 대조군 Bash 읽기에는 공급자의 safety classifier 중단이 섞였으며, 완전한 고정 명령이 실행돼 문자열을 반환한 호출만 접근 증거로 사용했다. Mail의 첫 Claude Bash 쓰기는 도구 미호출로 미확인이어서 실제 호출이 발생한 재시도 결과를 기록했다. 관리자 인증 완료 전 실행한 `pending-auth` 결과도 승인 후 증거에서 제외했다.

### 귀속 근거와 증거 읽기

[TCC 발췌](evidence/ty-66/tcc-attribution.txt)는 Desktop 승인·철회 대상과 실제 접근 subject를 `com.jakdo.sky`, responsible code를 번들 안의 `com.jakdo.sky.skyd`로 기록한다. [프로세스 책임 기록](evidence/ty-66/fixed-a-process-responsibility.log)에서 Pi Bash와 Claude helper의 responsible PID는 호스트다. Claude Bash는 실제로 `/bin/zsh`를 사용했고 [별도 기록](evidence/ty-66/fixed-a-zsh-responsibility.log)에서도 Claude helper의 자식인 zsh의 responsible PID는 같은 호스트였다. 별도 프로세스 그룹에서도 이 관계가 유지됐다. 측정한 호출에서 별도 daemon/service로 책임 관계가 끊긴 증거는 없었다. 앱 경로는 고정된 `Contents/Helpers/claude`였고 Anthropic 서명을 유지했다.

[실행 증거 90건](evidence/ty-66/runs.jsonl)은 Desktop 8단계 × 10개 접근과 Mail 승인 전 10개 접근이다. 각 행에 `phase`, 실행 `id`, 시각, 호스트 PID, 요청, 실제 도구 이벤트, 접근 판정, 쓰기 관찰 결과가 있다. [manifest](evidence/ty-66/manifest.json)에 단계별 PID·fixture 기대 문자열·배포물·designated requirement·증거 파일 checksum을 연결했다. 공개 증거에서는 VM 사용자 경로만 `/Users/skytest`로 치환했다. credential, 전체 세션, 프로세스 환경은 포함하지 않는다. TCC 로그 시각은 KST, 실행 JSON 시각은 UTC다.

| 표의 단계 | 증거의 `phase` |
| --- | --- |
| A 승인 전 Desktop / Mail | `fixed-a-before-Desktop` / `fixed-a-before-Mail` |
| A 승인 직후 | `fixed-a-desktop-granted-current` |
| A UI 종료 | `fixed-a-desktop-ui-exit` |
| A 호스트 재시작 | `fixed-a-desktop-restarted` |
| A 재로그인 | `fixed-a-desktop-relogin` |
| B 교체 후 | `fixed-b-desktop-preserved` |
| B 철회 직후 | `fixed-b-desktop-revoked-current` |
| B 철회 후 재시작 | `fixed-b-desktop-revoked-restarted` |

패키징과 권한 귀속의 결정 및 남은 범위는 [ADR-0014](adr/0014-retain-app-responsibility-for-agent-file-tools.md)에 기록한다.

참고: [Apple 파일 시스템 권한·responsible code](https://developer.apple.com/forums/thread/678819), [Apple FDA 진단 설명](https://developer.apple.com/forums/thread/835851).
