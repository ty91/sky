---
status: accepted
---

# Homebrew tap으로 배포하고 bin 이름을 배포 계약으로 고정한다

Sky는 `brew install ty91/tap/sky` 한 줄로 설치한다. Homebrew는 파일 배포와 Node runtime 제공만 담당하고, LaunchAgent는 계속 Sky가 소유한다. `sky`와 `skyd` 두 bin 이름과 `#{HOMEBREW_PREFIX}/bin` 아래의 경로는 배포 계약이므로 내부 구현이 바뀌어도 유지한다.

## 맥락

GitHub Packages 경로는 소스 clone 없이 설치하려 해도 mise 전역 toolchain 구성, `pnpm setup`과 새 셸, `read:packages` 권한의 classic PAT 발급, `~/.npmrc` 편집, `NODE_AUTH_TOKEN` 주입까지 여섯 단계를 요구했다. 전부 기능과 무관한 배포 인프라 때문에 생긴 단계다. 지원 대상이 Apple Silicon macOS로 확정되었으므로 Homebrew tap이 이 여섯 단계를 한 줄로 대체하면서 Node runtime, PATH, 업그레이드 경로까지 함께 해결한다.

LaunchAgent는 이미 업그레이드에 견디도록 만들어져 있다. `resolveExecutable`은 PATH에서 wrapper를 찾되 의도적으로 realpath하지 않으므로 plist의 `ProgramArguments`에는 Cellar 실체가 아니라 안정적인 심링크 경로가 기록된다.

## 결정

### Homebrew는 배포만, lifecycle은 Sky가 소유한다

formula에 `service do` 블록을 두지 않는다. 두면 `brew services`와 Sky 자체 LaunchAgent 관리(plist reconcile, `SKY_HOME` override)가 한 daemon에 대해 두 개의 권위가 된다. 사용자는 설치 후 `sky service install`로 등록한다.

### bin 이름과 경로가 배포 계약이다

formula는 실체를 `libexec`에 설치하고 `bin`에는 `write_env_script` wrapper를 둔다. `node@24`가 keg-only라 wrapper가 PATH를 주입해야 하기 때문이다. 설치된 plist는 `#{HOMEBREW_PREFIX}/bin/skyd`를 `ProgramArguments`에 기록하므로, 이후 단일 바이너리로 전환하더라도 두 이름과 그 경로는 유지해야 한다. `test/homebrew-formula.test.mjs`가 이 계약을 검사한다.

### formula는 빌드하지 않고 runtime 의존성만 설치한다

`url`은 `pnpm pack` 산출 tarball을 올린 GitHub Release 에셋을 가리킨다. tarball에는 이미 `dist`가 들어 있으므로 설치 시점에 TypeScript build나 pnpm이 필요 없고 `npm install --omit=dev --ignore-scripts`만 실행한다.

lockfile은 함께 배포하지 않는다. 직접 의존성은 `package.json`에 정확한 version으로 고정되어 있지만 transitive 의존성은 설치 시점에 다시 해석된다. 재현성보다 Homebrew 표준 Node formula 패턴의 단순함을 택한 것이며, npmjs publish를 하지 않는 것과 npm registry를 사용하지 않는 것은 다른 문제다. 후자는 가능하지 않다.

### arm64가 아닌 prebuild를 제거한다

Homebrew는 설치한 모든 Mach-O를 ad-hoc으로 재서명한다. 이 과정에서 `@mariozechner/clipboard`의 `darwin-universal` slice 서명이 실패하고 파일이 손상되는데, napi 로더는 그 slice를 `darwin-arm64`보다 먼저 로드한다. 손상된 slice의 `dlopen`은 catch할 수 있는 오류가 아니라 프로세스 SIGKILL이므로 `sky --version`조차 조용히 죽는다. formula는 `darwin-arm64`가 아닌 `.node` prebuild를 모두 제거해 로더가 정상 slice로 떨어지게 한다. 부수적으로 설치 용량도 줄어든다.

### 업그레이드 drift는 감지하되 자동으로 고치지 않는다

`brew upgrade sky`는 파일만 교체하고 실행 중인 daemon은 이전 코드를 유지한다. 이전 keg는 삭제되므로 daemon이 요청마다 디스크에서 읽는 admin 자산이 먼저 깨진다. formula caveats가 `sky restart`를 안내하고 `sky doctor`가 `installation.drift`로 FAIL을 보고한다. 자동 재시작은 하지 않는다. Homebrew에는 신뢰할 만한 업그레이드 훅이 없고, 있더라도 lifecycle 권위를 Sky가 소유한다는 결정과 어긋난다.

이 check는 CLI가 붙인다. `sky doctor`는 daemon에게 진단 목록 조립을 맡기므로, daemon 안에서 version을 비교하면 자기 자신과 비교하게 되어 stale daemon을 원리적으로 감지할 수 없다.

### plist는 버전이 박히지 않은 경로만 기록한다

`process.execPath`는 realpath된 값이라 Homebrew 아래에서는 `…/Cellar/node@24/<version>/bin`이 되고 `brew upgrade node@24`에서 사라진다. plist의 `PATH`에는 PATH에서 찾은 `node`의 디렉터리(`…/opt/node@24/bin`)를 기록하고, PATH에 `node`가 없을 때만 `process.execPath`로 되돌아간다.

## 검토한 대안

### npm-shrinkwrap.json을 tarball에 포함한다

같은 sha256이 항상 같은 의존성 트리를 설치하게 만들 수 있다. 릴리스마다 shrinkwrap 생성 단계가 늘고 package 내용물 계약도 넓혀야 하며, pnpm-lock.yaml과 별개로 해석된 트리라 개발 환경과 미세하게 갈린다. 단순함을 택해 채택하지 않았다.

### node_modules까지 포함한 번들을 배포한다

설치 시점에 네트워크가 필요 없고 완전히 재현적이다. prod 트리만 해도 수백 MB라 릴리스 에셋으로 현실성이 없어 채택하지 않았다.

### homebrew-core에 등재한다

`brew install sky`로 짧아지지만 심사와 notability 요건이 붙는다. 개인 tap으로 충분하다.

### `brew services`를 사용한다

plist 관리를 Homebrew에 넘길 수 있지만 `SKY_HOME` override와 plist reconcile을 Sky가 이미 소유하고 있어 권위가 둘이 된다.

## 결과

* 새 macOS에서 Node 설치 상태와 무관하게 한 줄로 설치된다. mise 요구가 사라진다.
* 릴리스 workflow가 GitHub Release를 만들고 tap의 formula를 갱신한다. tap은 다른 repository이므로 `GITHUB_TOKEN`이 아니라 `TAP_REPO_TOKEN` secret이 필요하다.
* 릴리스 후 별도 job이 갱신된 tap을 실제로 설치하고, 이전 formula revision이 있으면 업그레이드 경로까지 검증한다. 첫 릴리스에는 비교할 이전 revision이 없어 설치만 검증된다.
* GitHub Packages publish는 이 결정에서 제거하지 않는다.
* macOS 외 플랫폼과 bottle 생성은 범위 밖이다.

## 구현 이슈

* [TY-10: Sky를 설치 가능한 로컬 에이전트 제품으로 패키징](https://linear.app/jakdo/issue/TY-10)
* [TY-29: Homebrew tap 기반 설치와 업그레이드 경로 구축](https://linear.app/jakdo/issue/TY-29)
