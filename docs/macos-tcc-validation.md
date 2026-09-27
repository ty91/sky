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

첫 번째는 비보호 대조군, Desktop은 파일 및 폴더 권한, Mail 아래 테스트 디렉터리는 전체 디스크 접근 검증의 후보이다. 보호 위치의 동작은 OS에 따라 달라진다. 승인 전 실제 거부가 관찰되지 않으면 FDA 검증 성공으로 판정하지 않는다. 보호 위치의 fixture는 VM의 Finder와 편집기로 준비하고, 준비에 쓴 앱과 권한도 기록한다.

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

각 OS·backend 버전·권한 종류에 대해 표를 따로 작성하고 각 셀에 실행 ID와 증거 파일을 연결한다. 두 배포물의 소스 커밋·checksum·공증 ID를 함께 기록한다. `미실행`, `미확인`, `거부 확인`, `허용 확인`, `귀속 실패`를 구분한다.

| 실제 실행 경로 | 승인 전 | 승인 후 | 철회 후 | UI 종료 | 호스트 재시작 | 재로그인 | A→B 교체·재철회 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 호스트 직접 읽기·쓰기 | 미실행 | 미실행 | 미실행 | 미실행 | 미실행 | 미실행 | 미실행 |
| Pi 파일 도구 | 미실행 | 미실행 | 미실행 | 미실행 | 미실행 | 미실행 | 미실행 |
| Pi Bash | 미실행 | 미실행 | 미실행 | 미실행 | 미실행 | 미실행 | 미실행 |
| Claude 파일 도구 | 미실행 | 미실행 | 미실행 | 미실행 | 미실행 | 미실행 | 미실행 |
| Claude Bash | 미실행 | 미실행 | 미실행 | 미실행 | 미실행 | 미실행 | 미실행 |

이 표는 양식이며 통과 결과가 아니다. TY-66은 아직 실측 완료 전이다. 최종 ADR은 확인된 귀속과 남은 OS·실행 경로 제약을 근거로 작성한다.

참고: [Apple 파일 시스템 권한·responsible code](https://developer.apple.com/forums/thread/678819), [Apple FDA 진단 설명](https://developer.apple.com/forums/thread/835851).
