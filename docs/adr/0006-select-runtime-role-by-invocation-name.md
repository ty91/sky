---
status: accepted
---

# 하나의 executable에서 호출 이름으로 sky와 skyd를 선택한다

Bun standalone 배포는 runtime과 내장 asset의 중복을 피하기 위해 하나의 물리 executable을 설치하되, `sky`와 `skyd`라는 두 안정적인 bin 이름은 유지하고 호출 이름의 정확한 basename으로 역할을 선택한다. 알 수 없는 이름을 추측하거나 flag로 역할을 전환하면 LaunchAgent와 사용자가 의도한 실행 단위를 흐릴 수 있으므로 거부한다.

물리 artifact를 공유해도 `sky` control client와 `skyd` daemon의 Commander 조립, explicit foreground 계약, process lifecycle 책임은 별도 module에 남긴다. Node.js 개발 build는 두 module을 직접 실행하며, standalone build만 공용 entrypoint를 사용한다.

Standalone artifact의 `darwin-arm64` directory에는 mode `0755`인 arm64 Mach-O `sky` 하나와 이를 상대경로로 가리키는 `skyd` symlink만 둔다. 분석용 Bun metafile은 artifact directory 밖에 생성해 배포 대상의 물리 executable 개수를 흐리지 않는다. Standalone은 실행 위치의 `.env`와 `bunfig.toml`을 자동 로드하지 않으며, 제품 version은 package manifest 값을 build-time literal로 포함한다.

이 결정은 [ADR-0001](./0001-separate-cli-and-daemon.md)의 lifecycle과 역할 분리를 유지하면서 별도 물리 실행 파일 결정을 대체한다. [ADR-0008](./0008-self-distribute-standalone-releases.md)이 채택한 설치 방식에서도 두 bin 이름은 그대로 유지한다.

## 관련 이슈

- [TY-32](https://linear.app/jakdo/issue/TY-32)
- [TY-35](https://linear.app/jakdo/issue/TY-35)
- [TY-36](https://linear.app/jakdo/issue/TY-36)
