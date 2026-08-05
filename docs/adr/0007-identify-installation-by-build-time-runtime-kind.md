---
status: accepted
---

# 설치 identity는 build-time runtime kind와 PATH 해석 실행 파일로 판별한다

Standalone 전환 후에도 설치 진단이 결정적으로 동작하도록, 설치 identity는 두 가지로 판별한다: build가 새긴 runtime kind(`standalone` define, 미정의 시 `node`)와 PATH에서 해석된 `skyd` 실행 파일. `process.versions.bun` 같은 동적 감지는 `bun dist/skyd.js`처럼 bun CLI로 dist를 실행하는 경우와 standalone build를 구분하지 못하므로 채택하지 않는다. 실행 파일 검사는 X_OK 확인까지만 하고 파일 종류는 보지 않는데, 전환기 동안 npm package의 wrapper script와 standalone Mach-O가 같은 계약("skyd라는 이름이 설치된 실행 파일로 해석된다")을 공유해야 하기 때문이다.

같은 이유로 lifecycle과 진단은 runtime 중립이 된다. LaunchAgent plist PATH에는 호스트 node 경로를 더 이상 주입하지 않는다 — Homebrew npm 설치는 wrapper script가 스스로 node 경로를 주입하고, standalone은 node가 필요 없으므로, plist에 호스트 특정 경로를 기록하지 않는다는 [ADR-0005](./0005-distribute-through-a-homebrew-tap.md)의 계약을 완성하는 셈이다. `installation.node` 진단은 runtime 진단으로 교체한다: standalone runtime이면 통과하고, node runtime에서만 기존 Node version 검사를 적용한다. Node.js 부재는 더 이상 설치 오류가 아니다.

CLI와 daemon의 일치 판정은 기존 `productVersion` 비교(installation drift)를 유지하고, 실행 파일 realpath 비교는 채택하지 않는다. upgrade 후 stale daemon은 version 차이로 이미 감지되며, 같은 version에 다른 바이너리인 경우는 실제 발생 경로가 없고 Cellar versioned 경로 특성상 realpath 비교는 오탐 관리만 늘리기 때문이다.

## 결과

- pre-LaunchAgent 시절 npm layout(`sky.pid`, `dist/bot.js`)을 검증하던 legacy 마이그레이션 코드는 제거한다.
- 사용자 노출 문구에서 "package wrapper" 등 npm 시절 개념을 runtime 중립 표현으로 교체한다.
- 기존 Node 기반 설치가 만든 plist는 PATH 차이로 reconcile이 자동 발동해 새 계약으로 수렴한다.

## 관련 이슈

- [TY-33](https://linear.app/jakdo/issue/TY-33)
