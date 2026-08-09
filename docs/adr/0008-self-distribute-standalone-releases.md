---
status: accepted
---

# GitHub Release의 standalone executable로 자체 배포한다

Sky는 public repository를 유지하지만 불특정 사용자를 위한 package channel은 운영하지 않는다. 개인 Mac 몇 대에 배포하기 위해 Homebrew tap과 npm publish를 함께 유지하는 비용이 크고, Homebrew의 Mach-O 재서명이 standalone 의존성을 손상시킬 위험까지 만들기 때문에 GitHub Release의 Apple Silicon macOS standalone artifact를 유일한 배포물로 삼는다. 이 결정은 [ADR-0005](./0005-distribute-through-a-homebrew-tap.md)를 대체한다.

Release에는 runtime과 admin asset을 포함한 단일 `sky` executable의 tar archive와 SHA-256 checksum만 발행한다. Public repository의 release와 install script는 인증 없이 접근하며, install script는 검증한 executable을 `~/.local/bin/sky`에 원자적으로 설치하고 같은 파일을 가리키는 `skyd` symlink를 만든다. 설치된 Sky는 `sky update`가 새 artifact의 checksum과 architecture를 검증하고 executable 교체와 daemon restart를 하나의 복구 가능한 작업으로 수행한다. Update의 daemon 교체와 rollback은 설정 유효성과 무관하게 새 executable generation을 기동해야 하므로 launchd의 강제 restart를 사용하고, 사용자가 호출하는 일반 restart는 기존 graceful validation 경로를 유지한다.

LaunchAgent lifecycle과 Sky home은 계속 Sky가 소유한다. Homebrew v0.2.3 설치에서 전환할 때 package를 제거해도 keg 밖의 Sky home은 그대로 두고, standalone을 설치한 뒤 `sky service install`로 같은 `SKY_HOME`과 `com.ty91.skyd` LaunchAgent를 새 executable 경로에 reconcile한다.

## 검토한 대안

- Homebrew tap은 설치 명령이 익숙하지만 formula, 별도 repository, 발행 credential과 install·upgrade smoke를 계속 관리해야 하고 Mach-O 재서명 위험을 다시 도입하므로 유지하지 않는다.
- npm package 발행은 standalone과 중복되는 release artifact와 검증 경로를 만들고 설치 기기에 Node.js와 package manager 또는 registry 인증을 요구하므로 유지하지 않는다.

## 결과

- 지원 대상은 Apple Silicon macOS이며 Node.js, Bun과 GitHub CLI는 설치 의존성이 아니다.
- `ty91/homebrew-tap`의 Sky formula와 repository의 formula·npm publish 경로를 제거한다.
- GitHub Release 발행 후 실제 install과 update smoke가 유일한 배포 경로를 검증한다.
- 자동 background update, Intel Mac, 다른 운영체제, 서명과 notarization은 별도 결정 전까지 지원하지 않는다.

## 관련 이슈

- [TY-34](https://linear.app/jakdo/issue/TY-34)
- [TY-54](https://linear.app/jakdo/issue/TY-54)
