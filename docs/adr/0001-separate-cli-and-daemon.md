---
status: accepted
---

# CLI와 daemon을 분리하고 launchd가 생명주기를 소유한다

Sky는 사람이 실행하는 `sky` CLI와 상주 runtime인 `skyd`를 별도 실행 파일로 제공한다. `skyd`는 foreground process로만 동작하고 macOS 사용자 LaunchAgent가 생성, 종료, 재기동을 전담한다. CLI가 PID 파일과 signal로 detached process를 관리하던 구조는 launchd와 소유권이 겹쳐 이중 실행과 restart race를 만들 수 있으므로 제거한다.

## 맥락

기존 `sky`는 CLI인 동시에 daemon launcher였다. CLI가 detached bot process를 spawn하고 PID 파일을 기록했으며, 실행 중인 bot도 restart 요청을 받으면 replacement process를 직접 spawn했다. 이 구조에서는 process 존재 여부가 PID 파일에 의존하고, CLI와 daemon이 같은 runtime 구현을 직접 열며, launchd를 추가할 경우 lifecycle 권위가 둘이 된다.

TY-10은 Sky를 source checkout 없이 설치하고 로그인 후 자동 시작할 수 있는 macOS 로컬 제품으로 만드는 작업이다. CLI와 이후의 admin web이 동일한 control interface로 runtime을 관리하려면 daemon 내부 동작과 process supervision을 먼저 분리해야 한다.

## 결정

### 실행 단위와 lifecycle

제품은 하나지만 `sky`와 `skyd`를 한 package에 들어 있는 별도 bin으로 배포한다.

* `sky`는 사람과 자동화가 사용하는 얇은 control client다.
* `skyd`는 Slack, agent backend, scheduler, settings, SQLite, maintenance operation과 logging을 소유한다.
* `skyd`는 daemonize하거나 PID 파일을 만들거나 replacement를 spawn하지 않는다.
* 설치 환경에서는 `com.ty91.skyd` 사용자 LaunchAgent가 process lifecycle의 유일한 권위자다.
* `sky service install/uninstall`이 LaunchAgent의 영구 등록을 관리하고 `sky start/stop/restart`는 등록된 job을 제어한다.
* `skyd --foreground`는 개발과 진단을 위해 제공하지만 supervisor가 없으므로 자동 restart를 거부한다.

이번 구조는 macOS 사용자당 하나의 Sky instance만 지원한다. systemd, Windows, profile별 복수 daemon은 이 결정의 범위에 포함하지 않는다.

### 두 개의 제어 seam

CLI는 목적이 다른 두 adapter를 사용한다.

1. LaunchAgent 설치, start, stop, 강제 restart와 service 상태는 `launchctl` adapter가 담당한다.
2. 실행 중 runtime의 상태, graceful restart, maintenance operation과 log stream은 Unix domain socket의 control interface가 담당한다.

Control interface는 `~/.sky/run/skyd.sock`에서 HTTP/1.1과 JSON을 사용한다. filesystem 권한으로 동일 사용자만 접근하게 하며 별도 bearer token은 두지 않는다. TCP listener와 browser 인증은 admin web 작업에서 별도 adapter로 추가하고, daemon의 control module과 요청/응답 의미는 재사용한다.

Package version과 control protocol version의 negotiation은 현재 도입하지 않는다. `sky`와 `skyd`는 함께 설치·업데이트하는 것을 운영 전제로 삼고 product version은 진단 정보로만 노출한다.

### Runtime 상태와 복구

Control socket과 logger는 Slack과 agent runtime보다 먼저 시작한다. Runtime은 `starting`, `ready`, `needs_configuration`, `degraded`, `draining` 상태를 가진다.

설정 누락이나 검증 실패, Slack 연결 실패처럼 control interface를 통한 진단과 복구가 가능한 오류에서는 daemon을 종료하지 않는다. 일시적인 외부 연결 오류는 daemon 내부에서 backoff하며 재시도한다. Process 재기동 없이는 복구할 수 없는 내부 invariant 위반만 exit하여 launchd가 다시 실행하게 한다.

Settings는 daemon process 한 세대가 시작할 때 검증한 snapshot으로 사용한다. 일반적인 file watch와 부분 hot reload는 지원하지 않고 runtime에 영향을 주는 설정 변경은 graceful restart로 적용한다. 새 agent session에서 prompt 파일을 다시 읽는 기존 동작은 예외로 유지한다.

LaunchAgent plist에는 credential을 저장하지 않는다. Claude credential은 secure store가 도입되기 전까지 `settings.json`의 `claudeAgentSdk.oauthToken`을 사용한다. Sky 디렉터리는 `0700`, settings와 log 파일은 `0600`을 보장하며 secret 값과 Slack 메시지 본문은 status나 log에 기록하지 않는다.

### Graceful restart와 stop

Restart 요청을 받으면 daemon은 `draining`으로 전환해 새 Slack turn, scheduler dispatch와 maintenance operation을 거부한다. 이미 시작한 작업과 Slack 최종 응답은 최대 120초 동안 완료할 수 있고, 남은 작업은 제한 시간이 지난 뒤 abort한다. Process가 정리되어 종료되면 launchd가 새 `skyd`를 실행한다.

`sky stop`과 macOS logout의 `SIGTERM`은 시스템 종료를 오래 막지 않도록 최대 20초만 drain한다. LaunchAgent의 `ExitTimeOut`은 cleanup 여유를 포함해 30초로 둔다.

일반 `sky restart`가 control socket에 연결하지 못해도 자동으로 process를 죽이지 않는다. 사용자가 `--force`를 명시했을 때만 `launchctl kickstart -k`를 사용한다. `restart_harness`도 PID signal과 self-spawn 대신 daemon runtime controller에 restart를 예약하며, 호출한 agent turn의 최종 응답이 전달된 뒤 drain되게 한다.

### Long-running operation과 logging

`sky memory`와 `sky dream`은 CLI 안에서 agent runtime을 직접 만들지 않고 daemon operation을 생성한다. Maintenance operation은 한 번에 하나만 실행하며 중복 요청을 queue하지 않는다. CLI 연결이 끊겨도 operation은 계속되고 `Ctrl-C`는 cancel이 아니라 관찰 중단을 뜻한다.

Daemon app log는 크기 제한이 있는 structured JSONL로 기록한다. 실행 중에는 control interface로 history와 live stream을 제공하고, daemon이 시작하지 못한 경우에만 CLI가 log 파일을 read-only로 조회한다. Follow client는 daemon restart 후 새 instance에 다시 연결한다.

## 검토한 대안

### Detached daemon과 LaunchAgent를 함께 유지한다

기존 CLI 사용법을 보존할 수 있지만 PID 파일, direct signal과 launchd가 동일 process의 lifecycle을 함께 소유한다. 어떤 경로로 실행됐는지에 따라 stop/restart 의미가 달라지고 같은 Slack app에 두 process가 연결될 수 있어 채택하지 않는다.

### 하나의 multicall binary로 유지한다

배포 파일 수는 줄지만 CLI와 daemon의 책임 및 dependency가 다시 하나의 entrypoint에 결합된다. 두 실행 파일을 한 installer 또는 package로 배포하면 제품의 원자성은 유지할 수 있으므로 물리적 분리를 선택한다.

### Control interface를 localhost TCP에 연다

향후 browser가 바로 접근하기는 쉽지만 CLI 전용 제어면을 불필요하게 network interface에 노출하고 browser authentication과 CSRF 정책을 지금부터 끌어오게 된다. 먼저 UDS를 사용하고 admin web은 인증된 loopback adapter로 추가한다.

### 설정을 process 안에서 부분적으로 hot reload한다

Slack connection, backend factory, conversation session과 scheduler가 서로 다른 설정 세대를 사용하게 될 수 있다. 설정 적용의 원자성과 현재 적용된 설정의 명확성을 위해 process restart를 선택한다.

## 결과

* CLI는 daemon runtime을 직접 생성하거나 settings와 SQLite를 수정하지 않는다.
* Process 존재 여부와 PID는 launchd가 관리하며 `sky.pid`는 제거한다.
* 기존 detached daemon은 `sky service install`이 command identity를 확인한 뒤 graceful stop하고 migration한다. 확인할 수 없거나 종료되지 않는 process를 자동으로 강제 종료하지 않는다.
* 기존 settings, database, transcript와 pending restart state는 migration과 service uninstall에서 보존한다.
* Bun native executable, installer, admin web과 secure credential store는 이 interface 위에 별도 작업으로 추가할 수 있다.

## 구현 이슈

* [TY-10: Sky를 설치 가능한 로컬 에이전트 제품으로 패키징](https://linear.app/jakdo/issue/TY-10)
* [TY-12: skyd foundation과 local control interface 구축](https://linear.app/jakdo/issue/TY-12)
* [TY-13: macOS LaunchAgent 기반 daemon lifecycle 구현](https://linear.app/jakdo/issue/TY-13)
* [TY-14: graceful restart와 restart_harness lifecycle 전환](https://linear.app/jakdo/issue/TY-14)
* [TY-15: daemon operation과 structured log streaming 구현](https://linear.app/jakdo/issue/TY-15)
