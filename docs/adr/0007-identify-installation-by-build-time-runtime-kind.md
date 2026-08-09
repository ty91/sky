---
status: accepted
---

# 설치 identity는 build-time runtime kind와 PATH 해석 실행 파일로 판별한다

Standalone 전환 후에도 설치 진단이 결정적으로 동작하도록, 설치 identity는 두 가지로 판별한다: build가 새긴 runtime kind(`standalone` define, 미정의 시 `node`)와 PATH에서 해석된 `skyd` 실행 파일. `process.versions.bun` 같은 동적 감지는 `bun dist/skyd.js`처럼 bun CLI로 dist를 실행하는 경우와 standalone build를 구분하지 못하므로 채택하지 않는다. 실행 파일 검사는 X_OK 확인까지만 하고 파일 종류는 보지 않는데, Node 기반 개발 실행과 standalone Mach-O가 같은 계약("skyd라는 이름이 설치된 실행 파일로 해석된다")을 공유해야 하기 때문이다.

같은 이유로 lifecycle과 진단은 runtime 중립이 된다. LaunchAgent plist PATH에는 호스트 node 경로를 주입하지 않는다. [ADR-0008](./0008-self-distribute-standalone-releases.md)의 standalone은 node가 필요 없고, plist에는 설치된 `skyd`를 찾는 경로만 기록한다. `installation.node` 진단은 runtime 진단으로 교체한다: standalone runtime이면 통과하고, node runtime에서만 기존 Node version 검사를 적용한다. Node.js 부재는 더 이상 설치 오류가 아니다.

CLI와 daemon의 일치 판정은 기존 `productVersion` 비교(installation drift)를 유지하고, 실행 파일 realpath 비교는 채택하지 않는다. Update 후 stale daemon은 version 차이로 이미 감지되며, 같은 version의 다른 executable은 지원하는 update 경로에서 생기지 않고 설치 경로 변경은 LaunchAgent reconcile이 처리하므로 realpath 비교는 오탐 관리만 늘린다.

## 결과

- pre-LaunchAgent 시절 layout(`sky.pid`, `dist/bot.js`)을 검증하던 legacy 마이그레이션 코드는 제거한다.
- 사용자 노출 문구에서 "package wrapper" 같은 이전 설치 방식의 개념을 runtime 중립 표현으로 교체한다.
- 기존 versioned 설치 경로를 기록한 plist는 PATH 차이로 reconcile이 자동 발동해 새 계약으로 수렴한다.

## 관련 이슈

- [TY-33](https://linear.app/jakdo/issue/TY-33)
