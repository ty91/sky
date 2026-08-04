---
status: accepted
---

# 하나의 executable에서 호출 이름으로 sky와 skyd를 선택한다

Bun standalone 배포는 runtime과 내장 asset의 중복을 피하기 위해 하나의 물리 executable을 설치하되, `sky`와 `skyd`라는 두 안정적인 bin 이름은 유지하고 호출 이름의 정확한 basename으로 역할을 선택한다. 알 수 없는 이름을 추측하거나 flag로 역할을 전환하면 LaunchAgent와 사용자가 의도한 실행 단위를 흐릴 수 있으므로 거부한다.

물리 artifact를 공유해도 `sky` control client와 `skyd` daemon의 Commander 조립, explicit foreground 계약, process lifecycle 책임은 별도 module에 남긴다. 기존 Node.js package는 두 module을 호출하는 별도 wrapper를 계속 제공하며, standalone build만 공용 entrypoint를 사용한다.

이 결정은 [ADR-0001](./0001-separate-cli-and-daemon.md)의 lifecycle과 역할 분리를 유지하면서 별도 물리 실행 파일 결정을 대체한다. [ADR-0005](./0005-distribute-through-a-homebrew-tap.md)가 고정한 두 bin 이름과 경로도 그대로 유지한다.

## 관련 이슈

- [TY-32](https://linear.app/jakdo/issue/TY-32)
- [TY-35](https://linear.app/jakdo/issue/TY-35)
