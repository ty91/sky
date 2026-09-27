# macOS 앱 빌드와 내장 호스트

[README](../README.md) · [개발](development.md) · [서명 준비](macos-signing.md) · [TCC 검증](macos-tcc-validation.md)

`apps/desktop`은 Tauri 2 + React 앱이다. 앱·호스트 버전, 대상 아키텍처, 소스 revision과 개발/번들 실행 모드를 표시한다. SMAppService로 내장 호스트를 등록하고 네이티브 UDS 연결로 상태·생명주기를 제어한다. 창 닫기와 UI 앱 종료는 호스트를 중지하지 않는다. Developer ID 서명·공증과 배포 ZIP 생성은 [서명 가이드](macos-signing.md#로컬-배포-빌드)를 따른다. Pi·Claude 도구의 TCC 귀속은 TY-66에서 다룬다.

## 대상과 준비

| 항목 | 값 |
| --- | --- |
| 앱 / bundle ID | `Sky.app` / `com.jakdo.sky` |
| 네이티브 주 실행 파일 | `Contents/MacOS/sky-desktop` (Rust Mach-O) |
| 내장 호스트 | `Contents/MacOS/skyd` (Bun standalone Mach-O) |
| 빌드 대상 | `aarch64-apple-darwin` / Apple Silicon |
| 최소 지원 OS | macOS 13.0 (SMAppService 사용 기준) |
| 제품 버전 | 루트 `package.json` → Tauri 설정과 standalone build-time version |
| 네이티브 도구 | Rust/Cargo 1.93.1, rustfmt, clippy, Apple Command Line Tools 또는 Xcode |
| JavaScript 도구 | `mise.toml`의 Node.js 24.16.0, pnpm 11.10.0, Bun 1.3.14 |

Rust 버전과 대상은 [rust-toolchain.toml](../apps/desktop/rust-toolchain.toml), Rust 의존성은 `src-tauri/Cargo.lock`, JS 의존성은 루트 `pnpm-lock.yaml`에 고정한다. 네이티브 crate의 Cargo 버전은 내부 패키지 메타데이터이며 제품 버전은 Tauri의 루트 manifest 참조로 결정한다. Tauri CLI/API는 pnpm으로, Rust 의존성은 Cargo로 관리한다.

macOS Apple Silicon에서 다음을 준비한다. Rust가 없다면 [공식 rustup 설치](https://rustup.rs/)를 먼저 수행한다. Apple 도구 준비는 [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/#macos)를 따른다. 검증에 사용한 Apple 도구는 Xcode 26.6이며, macOS 13 자체에서의 실행·권한 검증은 별도 환경에서 수행해야 한다.

```sh
xcode-select --install
rustup toolchain install 1.93.1 --profile minimal --component clippy --component rustfmt
rustup target add aarch64-apple-darwin --toolchain 1.93.1
mise install
mise exec -- pnpm install --frozen-lockfile
```

이미 Xcode나 Command Line Tools가 설치되어 있다면 `xcode-select --install`은 생략한다. 구형 mise의 aqua backend가 pnpm 11 배포 asset 이름을 인식하지 못하면 `mise install npm:pnpm@11.10.0`으로 같은 버전을 설치하고 해당 `bin`을 PATH에 넣는다. 저장소의 pnpm 버전을 바꾸지 않는다.

## 개발과 앱 번들

아래 명령은 저장소 루트에서 고정 도구들이 활성화된 셸로 실행한다.

```sh
pnpm dev:desktop
pnpm build:desktop
pnpm test:desktop
pnpm check:desktop
```

`dev:desktop`은 standalone 호스트를 새로 준비한 뒤 Vite(127.0.0.1:1420)와 Tauri 개발 창을 연다. Rust·frontend 변경은 개발 도구가 반영하지만 `apps/sky` 변경 후에는 명령을 다시 실행해야 내장 호스트가 갱신된다. 개발 창의 실행 모드는 `개발`이다.

`build:desktop`은 기존 `build:standalone`의 admin·Pi 검증을 포함해 호스트를 새로 만들고, frontend·Rust를 빌드해 아래 앱을 생성한다. Cargo lockfile은 `--locked`로 검증한다. 개발용 ad-hoc 서명을 적용하며 hardened runtime은 끈다. 배포용 인증서나 공증 credential은 이 단계에 필요하지 않다.

```text
apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Sky.app
  Contents/Info.plist
  Contents/MacOS/sky-desktop
  Contents/MacOS/skyd
  Contents/Helpers/claude
  Contents/Frameworks/clipboard.darwin-arm64.node
  Contents/Library/LaunchAgents/com.jakdo.sky.skyd.plist
  Contents/Resources/build-info.json
  Contents/Resources/icon.icns
```

Finder에서 이 앱을 열거나 별도 폴더로 복사해 열면 번들된 frontend를 사용하며 실행 모드는 `앱 번들`이다. 기존 설치와 충돌하지 않도록 이 단계에서는 `/Applications/Sky.app`을 자동 교체하지 않는다. 설치된 앱은 pnpm, Node.js, Bun이나 checkout을 필요로 하지 않는다. 이 개발 빌드는 배포용 공증을 수행하지 않는다. 배포용 앱은 별도의 서명·공증 절차를 따른다.

Tauri의 [externalBin 규약](https://v2.tauri.app/develop/sidecar/)에 맞춰 빌드 준비 시 `binaries/skyd-aarch64-apple-darwin`을 만들고, 번들에서는 suffix가 없는 정확한 `skyd` 이름으로 배치한다. `build:standalone --desktop`으로 만든 호스트를 복사한다. CLI standalone의 단일 파일 배포는 유지하고 앱 빌드만 Claude·clipboard를 번들 코드 경로에서 로드한다. `skyd --foreground`가 호스트 역할을 선택하며, `sky`라는 이름으로 호출하면 CLI 역할을 선택한다. 앱에는 CLI 복사본이나 공개 PATH 등록을 추가하지 않는다.

`build-info.json`은 실제 standalone의 `--version` 결과와 루트 버전의 일치를 확인한 뒤 생성하며, Git revision과 작업 트리 변경 여부(`-dirty`)를 함께 담는다. 앱은 Tauri resource directory에서 이 파일을 읽는다. 버전 정보 조회는 호스트나 helper를 실행하지 않는다.

일반 `pnpm build`·`typecheck`·`test`에는 desktop frontend 검증이 포함되며 Rust 설치를 요구하지 않는다. 네이티브 빌드와 검사는 위의 명시적인 desktop 명령이 담당한다. `pnpm clean`은 frontend와 루트 제품 산출물을 지우지만 Cargo 캐시와 이미 만든 `.app`은 보존한다. 네이티브 산출물을 지우려면 `pnpm --filter @ty91/sky-desktop exec cargo clean --manifest-path src-tauri/Cargo.toml`을 사용한다.

## 격리된 호스트 검증

`pnpm test:desktop`은 완성된 앱을 checkout 밖의 공백이 포함된 경로로 복사하고 임시 HOME·SKY_HOME 및 `PATH=/usr/bin:/bin`을 사용한다. bundle ID·OS 하한·arm64·제품 버전·호출 이름, 호스트 제어 소켓, 내장 admin HTML/JS/CSS 제공, 정상 종료를 검사한다. 기존 사용자의 `~/.sky`나 LaunchAgent를 수정하지 않는다. Finder 실행과 화면 확인은 별도 수동 검증이다.

호스트만 직접 확인할 때도 별도 Sky home을 사용한다.

```sh
SKY_APP="$PWD/apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Sky.app"
SKY_TEST_ROOT="$(mktemp -d /tmp/sky-app-manual.XXXXXX)"
mkdir "$SKY_TEST_ROOT/home" "$SKY_TEST_ROOT/tmp"
env -i HOME="$SKY_TEST_ROOT/home" SKY_HOME="$SKY_TEST_ROOT/sky-home" \
  PATH=/usr/bin:/bin TMPDIR="$SKY_TEST_ROOT/tmp" CLAUDE_CODE_TMPDIR="$SKY_TEST_ROOT/tmp" \
  "$SKY_APP/Contents/MacOS/skyd" --foreground --admin-port 0
```

설정 없이도 관리 API는 기동하고 에이전트 상태는 `needs_configuration`이다. Ctrl-C로 종료한다. 실제 모델 turn 검증은 credential이 필요한 [standalone acceptance](standalone-acceptance.md)를 따른다. 터미널에서 직접 실행한 호스트의 파일 접근 성공은 앱의 TCC 권한 귀속 증거가 아니다.

## 내장 자산과 서명 입력

| 구성 | 포함·실행 경로와 한계 |
| --- | --- |
| Bun 1.3.14와 Sky 코드 | `Contents/MacOS/skyd` 안에 포함. `SKY_RUNTIME=standalone`과 제품 버전이 build-time literal로 고정됨 |
| React admin | standalone 내부 `/$bunfs/` 자산. 호스트가 embedded asset reader로 HTTP 제공 |
| Pi 0.80.10 | JS와 필요한 import 자산을 standalone에 포함. 호스트 프로세스 안에서 실행 |
| Pi clipboard 0.3.9 | `Contents/Frameworks/clipboard.darwin-arm64.node`를 호스트가 직접 로드 |
| Claude Agent SDK 0.3.283 | SDK JS는 호스트에 포함하고 darwin-arm64 플랫폼 패키지의 `claude` Mach-O는 `Contents/Helpers/claude`로 복사 |
| Claude 실행 파일 | 호스트의 실제 실행 파일 위치를 기준으로 `../Helpers/claude`를 직접 실행. 임시 경로 추출 없음. CLI symlink로 호출해도 앱 내부 경로를 유지 |
| Bash·외부 도구 | macOS shell과 호스트 PATH를 사용. 임의의 에이전트 도구까지 앱에 모두 포함하지 않음 |
| Pi의 rg·fd | Pi가 PATH 또는 Pi agent directory의 `bin`을 조회하고 필요하면 다운로드. 기본 `~/.pi/agent/bin`, `PI_CODING_AGENT_DIR`로 변경 가능. Sky home과 별도이며 앱 번들의 고정 실행 파일이 아님 |

앱 호스트 메타파일은 `dist/desktop-host/darwin-arm64.metafile.json`에 남는다. 빌드는 Claude helper와 clipboard addon이 호스트 내부에 중복 포함되지 않았는지 검사하고, 실제 Pi import·세션 어댑터와 native addon 로드를 확인한다. `pnpm test:desktop`은 옮긴 번들의 Claude `--version`과 호스트 Bun 런타임에서의 clipboard 로드를 검증한다. `SKY_DESKTOP_APP`에 다른 앱의 절대 경로를 지정해 같은 검사를 실행할 수 있다. 외부 도구의 responsible code는 TY-66의 검증 입력이다. 현재 경로를 공유한다고 TCC 권한도 공유한다고 가정하지 않는다.

## 로컬 서비스 제어

앱의 `서비스 등록`은 `SMAppService.agent`로 `Contents/Library/LaunchAgents/com.jakdo.sky.skyd.plist`를 등록한다. `BundleProgram`은 `Contents/MacOS/skyd`이며, `AssociatedBundleIdentifiers`는 `com.jakdo.sky`다. 앱 UI가 호스트를 자식 프로세스로 띄우지 않는다. macOS 등록 상태와 launchd 프로세스, UDS의 PID·instance ID를 함께 확인한다. 서비스 등록은 TCC 권한 귀속의 증거가 아니다.

| 동작 | 의미 |
| --- | --- |
| 서비스 등록 | 현재 로그인 세션에서 기동하고 이후 로그인 때도 기동하도록 등록. 사용자 승인이 필요하면 설정에서 승인할 때까지 대기 |
| 호스트 시작 | 등록된 서비스가 중지되어 있으면 SMAppService로 다시 등록하여 기동 |
| 재시작 | UDS `POST /restart`로 최대 120초 drain한 뒤 launchd가 교체한 instance ID 확인 |
| 호스트 중지 | 현재 세션의 job을 bootout. SIGTERM의 최대 20초 drain과 cleanup을 수행하고 30초 launchd 종료 제한 적용. 로그인 자동 기동 등록은 보존 |
| 등록 해제 | 호스트 종료를 먼저 확인한 뒤 SMAppService 등록도 해제. 다음 로그인 자동 기동 중단 |
| 창 닫기 | 창을 숨김. Dock에서 앱을 다시 열면 창 복원 |
| 앱 종료 | UI만 종료. 호스트와 실행 중 작업 유지 |

중지·등록 해제는 설정, credential, DB, transcript, 로그를 삭제하지 않는다. 실패한 재시작이나 소켓 연결을 강제 종료로 바꾸지 않는다. `호스트 상태: 실행 중`은 프로세스와 제어 연결의 준비를 뜻하며 모델 인증·에이전트 설정 완료를 보장하지 않는다.

앱은 기본적으로 로그인 사용자의 `~/.sky/run/skyd.sock`에 연결한다. UI 실행 셸의 `SKY_HOME`은 launchd 환경과 다를 수 있으므로 사용하지 않는다. 격리 검증용으로 서명하기 전에 plist의 `EnvironmentVariables.SKY_HOME`을 설정하면 앱과 서비스가 같은 절대 경로를 사용한다. 설정·DB 쓰기는 기존 호스트가 계속 소유한다.

`서비스 등록`과 `호스트 상태`를 따로 표시한다. 승인 대기에는 `로그인 항목 설정` 버튼을 제공하고, 네이티브 등록 오류(`registration_failed`), 기동 실패(`startup_failed`), PID는 있지만 소켓에 연결하지 못한 상태(`connection_failed`)를 구분한다. launchd 자체를 조회할 수 없으면 미등록으로 추측하지 않고 조회 오류를 보고한다. 호스트 코드가 실행되기 전의 실패는 launchd의 최근 종료 코드와 macOS 통합 로그를 확인한다. 앱 서비스는 CLI의 `launchd.stderr.log` 출력 파일을 사용하지 않는다.

유효한 번들의 최초 실행에서 SMAppService가 `NotFound`를 반환하고 launchd job도 없으면 미등록으로 표시한다. 이 상태의 등록 해제는 아무 작업도 하지 않는다. 기존 job은 실제 PID의 실행 파일이 현재 앱 내부의 skyd인지 확인한 뒤에만 변경한다. 같은 bundle ID라도 다른 경로의 앱은 제어할 수 없다. PID가 없거나 아직 xpcproxy 단계인 job은 상태 조회만 허용한다. 기동 실패로 실행 경로를 확인할 수 없으면 자동 복구·중지·등록 해제를 수행하지 않으며, 등록한 앱의 경로와 launchd 상태를 먼저 진단해야 한다.

## 기존 CLI 설치와 충돌

앱과 CLI는 사용자 서비스 이름 `com.ty91.skyd`를 공유한다. 동일 사용자에게 두 감독자가 별도 이름으로 호스트를 실행하지 않도록 하기 위한 선택이다. 앱은 다음 경우 등록·시작·재시작·중지·등록 해제를 차단한다.

- 사용자 또는 시스템 LaunchAgents에 기존 `com.ty91.skyd.plist`가 존재함
- launchd job이 다른 CLI 또는 다른 앱 번들의 실행 파일을 가리킴
- 관리되지 않는 소켓이 존재하거나, 소켓이 응답한 PID가 launchd의 PID와 다름
- 격리 Sky home을 선택했지만 기본 `~/.sky`에도 소켓이 존재함

기존 CLI 설치를 사용 중이면 그 설치에서 `sky service uninstall`로 등록을 해제한 뒤 앱에서 등록한다. 이 명령은 데이터를 보존한다. CLI executable만 설치되어 있고 서비스·호스트가 없으면 앱 등록을 막지 않는다. 현재 CLI의 생명주기 명령도 실행 중인 앱 서비스를 감지하면 `app_managed_service`로 거부한다. 이전 CLI 버전은 이 보호를 제공하지 않으므로 앱 전환 후 기존 CLI로 서비스를 관리하지 않는다. 완전한 자동 인계·업데이트는 후속 작업이다.

## SMAppService 격리 검증

```sh
pnpm build:desktop
node --test test/desktop-service.smoke.mjs
```

이 검증은 로그인 GUI 세션에서 실제 SMAppService를 호출한다. 임시 앱 복사본의 네이티브 실행 파일을 동일 서비스 모듈의 Rust 테스트 실행 파일로 교체하고, 고유한 테스트 bundle ID·service label, 임시 Sky home과 임의 admin port를 plist에 지정한 후 다시 서명한다. 배포 plist의 식별자·실행 경로·종료 계약은 변경 전에 검사한다. 앱은 서명된 번들의 식별자와 plist의 label로 서비스 소유권을 확인한다. 기본값은 ad-hoc 서명이며, `SKY_DESKTOP_SIGNER=/절대/경로/서명프로그램`을 지정하면 앱 경로를 인자로 전달한다. 서명 프로그램은 내장 skyd, 주 실행 파일, 앱 순서로 서명하고 원래 경로에 결과를 돌려놓아야 한다. 인증서·개인 키를 테스트 파일에 기록하지 않는다. 준비된 인증서는 [서명 가이드](macos-signing.md)를 따른다. 일반 테스트는 이 통합 검증을 실행하지 않는다. 기존 개인 호스트·CLI 서비스가 있으면 충돌로 실패하며 자동 중지하거나 대체하지 않는다. 종료 정리에 실패하면 복사본을 지우지 않고 경로를 보고한다.

등록을 수행한 앱 프로세스가 종료된 후 다른 앱 프로세스가 같은 호스트 instance에 접속하는지, graceful restart가 instance를 교체하는지, 중지 상태가 유지되는지, 시작·등록 해제와 설정·DB 보존을 검사한다. 이것은 실제 로그아웃·재로그인이나 Finder 창 닫기 검증을 대신하지 않는다. 별도 테스트 사용자에서 등록 후 로그아웃·재로그인하고 UDS 응답과 새로운 PID를 확인해야 한다. 사용자 승인 차단·철회는 시스템 설정에서 별도로 확인한다. 등록 성공을 실제 Pi·Claude 도구의 TCC 성공으로 기록하지 않는다.

개발 중 같은 bundle ID·service label로 실행 파일의 서명 정체성을 바꾸거나 임시 앱을 계속 교체하면 macOS가 이전 launch constraint를 적용해 `OS_REASON_CODESIGNING / Launch Constraint Violation`으로 기동을 차단할 수 있다. 등록 성공만으로 정상 기동을 판단하지 않는다. 검증용 복사본은 고유한 식별자를 사용하고, 설치 앱을 교체하기 전에는 기존 앱에서 등록을 해제한다. 시스템 전체 background-item 기록이나 TCC 설정을 초기화하지 않는다. 배포 업데이트에서의 서명 정체성 유지·재등록은 TY-65 이후 검증 범위다.

수동 UI 검증용 앱은 처음부터 최종 테스트 설치 위치에 복사하고 고유한 식별자로 서명한 뒤 실행한다. 임시 위치에서 등록했던 복사본을 이동해 재사용한 검증에서는 macOS가 BTM container를 찾지 못해 `EX_CONFIG`로 실행을 거부했다. 새 식별자로 처음부터 `~/Applications`에 준비한 격리 번들에서는 등록, 창 닫기, 앱 종료 후 같은 호스트 재연결, 재시작, 중지, 시작, 등록 해제를 확인했다.
