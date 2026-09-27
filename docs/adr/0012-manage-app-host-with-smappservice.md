---
status: accepted
---

# 앱의 로그인 호스트는 SMAppService가 등록하고 기존 launchd·UDS 계약으로 제어한다

[ADR-0011](0011-bundle-standalone-host-in-macos-app.md)의 내장 skyd를 `SMAppService.agent`로 등록한다. 앱 번들의 LaunchAgent는 `BundleProgram`으로 실행 파일을 지정하고 `AssociatedBundleIdentifiers`에 앱 식별자를 제공한다. UI의 자식 프로세스로 실행하면 앱 종료가 호스트 실행과 권한 책임 관계에 영향을 줄 수 있으므로 채택하지 않는다. 등록 성공과 실제 도구의 TCC 귀속 성공은 별개이며 후자는 TY-66이 검증한다.

앱과 기존 CLI가 같은 `com.ty91.skyd` label을 사용한다. 서로 다른 label은 같은 데이터나 Slack 연결에 두 호스트가 접근할 여지를 남긴다. 앱은 기존 CLI plist, 다른 실행 경로의 job, 관리되지 않는 소켓을 발견하면 충돌을 보고하고 자동 인계하지 않는다. 현재 CLI도 앱이 소유한 활성 job의 변경을 거부한다. 이전 CLI와 수동 launchctl 조작까지 자동 조정하는 전환은 범위 밖이다.

서비스 등록 상태는 macOS의 승인·자동 기동 의도를 나타내며 프로세스 실행 증거로 쓰지 않는다. 앱은 launchd 실행 파일 경로·PID와 UDS 상태 응답의 PID·instance ID를 대조한다. 이를 통해 승인 대기, 미등록, 중지, 기동 실패, 제어 연결 실패와 실행 중을 구분한다. UI에 전달하는 제어 명령은 고정된 동작만 받고 임의 실행 파일·소켓 경로를 받지 않는다.

[ADR-0001](0001-separate-cli-and-daemon.md)의 drain 계약을 유지한다. 재시작은 UDS로 요청하고 새로운 instance를 기다린다. 중지는 현재 세션의 job을 bootout하여 SIGTERM drain·cleanup을 거치며 로그인 자동 기동 등록은 보존한다. 중지된 서비스의 시작은 SMAppService 해제·등록으로 새로 bootstrap한다. 등록 해제는 호스트 종료를 먼저 확인하고 이후 로그인 자동 기동도 해제한다. 창 닫기와 UI 종료는 이 경로를 호출하지 않는다. 설정·credential·DB는 어떤 생명주기 동작에서도 삭제하지 않는다.

기본 Sky home은 로그인 사용자의 `~/.sky`다. 앱 UI가 물려받은 환경은 launchd와 다를 수 있으므로 앱은 내장 plist의 `SKY_HOME` 또는 기본 home으로 제어 경로를 결정한다. 임시 home을 사용하는 통합 검증은 서명 전 plist를 수정한 격리 복사본에서만 수행한다. 배포 앱에서 home 선택과 기존 설치의 완전한 인계가 필요해질 때 이 계약을 확장한다.

관련 이슈: [TY-64](https://linear.app/jakdo/issue/TY-64)
