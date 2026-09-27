# macOS 앱 빌드와 내장 호스트

[README](../README.md) · [개발](development.md) · [서명 준비](macos-signing.md)

`apps/desktop`은 Tauri 2 + React 앱이다. 앱·호스트 버전, 대상 아키텍처, 소스 revision과 개발/번들 실행 모드를 표시한다. 창을 열거나 닫아도 호스트를 시작하거나 중지하지 않는다. 호스트는 아래 격리 실행 절차로 별도로 검증한다. SMAppService 등록은 TY-64, Developer ID 서명·공증은 TY-65, Pi·Claude 도구의 TCC 귀속은 TY-66에서 다룬다.

## 대상과 준비

| 항목 | 값 |
| --- | --- |
| 앱 / bundle ID | `Sky.app` / `com.jakdo.sky` |
| 네이티브 주 실행 파일 | `Contents/MacOS/sky-desktop` (Rust Mach-O) |
| 내장 호스트 | `Contents/MacOS/skyd` (Bun standalone Mach-O) |
| 빌드 대상 | `aarch64-apple-darwin` / Apple Silicon |
| 최소 지원 OS | macOS 13.0 (후속 SMAppService 사용 기준) |
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
  Contents/Resources/build-info.json
  Contents/Resources/icon.icns
```

Finder에서 이 앱을 열거나 별도 폴더로 복사해 열면 번들된 frontend를 사용하며 실행 모드는 `앱 번들`이다. 기존 설치와 충돌하지 않도록 이 단계에서는 `/Applications/Sky.app`을 자동 교체하지 않는다. 설치된 앱은 pnpm, Node.js, Bun이나 checkout을 필요로 하지 않는다. 인터넷에서 내려받은 앱의 Gatekeeper 통과를 보장하는 배포 절차는 아직 아니다.

Tauri의 [externalBin 규약](https://v2.tauri.app/develop/sidecar/)에 맞춰 빌드 준비 시 `binaries/skyd-aarch64-apple-darwin`을 만들고, 번들에서는 suffix가 없는 정확한 `skyd` 이름으로 배치한다. 기존 standalone `sky` 파일을 복사하므로 내장 자산과 실행 이름 계약은 동일하다. `skyd --foreground`가 호스트 역할을 선택하며, `sky`라는 이름으로 호출하면 CLI 역할을 선택한다. 앱에는 CLI 복사본이나 공개 PATH 등록을 추가하지 않는다.

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

## 내장 자산과 후속 서명 입력

| 구성 | 포함·실행 경로와 한계 |
| --- | --- |
| Bun 1.3.14와 Sky 코드 | `Contents/MacOS/skyd` 안에 포함. `SKY_RUNTIME=standalone`과 제품 버전이 build-time literal로 고정됨 |
| React admin | standalone 내부 `/$bunfs/` 자산. 호스트가 embedded asset reader로 HTTP 제공 |
| Pi 0.80.10 | JS와 필요한 import 자산을 standalone에 포함. 호스트 프로세스 안에서 실행 |
| Pi clipboard 0.3.9 | `clipboard.darwin-arm64.node`를 Bun N-API asset으로 포함. Bun이 디스크로 추출해 로드하며 앱 번들의 고정 helper 경로가 아님 |
| Claude Agent SDK 0.3.283 | SDK JS와 darwin-arm64 플랫폼 패키지의 `claude` Mach-O를 포함 |
| Claude 실행 파일 | 첫 backend 사용 시 `extractFromBunfs`로 `${CLAUDE_CODE_TMPDIR:-/tmp}/claude-<uid>/claude-agent-sdk-<sha256 앞 16자>/<embedded basename>`에 추출, mode 0755로 직접 실행. `--version`·`--help`는 추출하지 않음 |
| Bash·외부 도구 | macOS shell과 호스트 PATH를 사용. 임의의 에이전트 도구까지 앱에 모두 포함하지 않음 |
| Pi의 rg·fd | Pi가 PATH 또는 Pi agent directory의 `bin`을 조회하고 필요하면 다운로드. 기본 `~/.pi/agent/bin`, `PI_CODING_AGENT_DIR`로 변경 가능. Sky home과 별도이며 앱 번들의 고정 실행 파일이 아님 |

정확한 포함 파일 목록은 `dist/standalone/darwin-arm64.metafile.json`에 남고 기존 standalone audit가 플랫폼 helper와 clipboard addon을 검사한다. 앱 빌드는 이 검증을 그대로 사용한다. Claude 실행 파일을 앱 내부 고정 위치로 옮기는 변경과 Bun이 추출한 native addon의 서명·entitlement, 외부 도구의 responsible code는 TY-65/TY-66의 검증 입력이다. 현재 경로를 공유한다고 TCC 권한도 공유한다고 가정하지 않는다.
