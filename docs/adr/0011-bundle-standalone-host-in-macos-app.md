---
status: accepted
---

# macOS 앱은 기존 standalone 호스트를 skyd 이름으로 포함한다

`apps/desktop`에 Tauri + React 앱을 추가하고 네이티브 Mach-O `sky-desktop`을 앱의 주 실행 파일로 둔다. bundle ID는 `com.jakdo.sky`, 최소 macOS는 후속 SMAppService 사용을 고려한 13.0, 빌드 대상은 Apple Silicon으로 정한다. 앱·호스트 제품 버전은 루트 manifest를 함께 사용한다.

기존 standalone 빌드를 그대로 실행하고 검증된 바이너리를 Tauri externalBin으로 복사해 `Contents/MacOS/skyd`에 배치한다. 번들 전체를 옮겨도 호스트·admin·백엔드 자산을 찾을 수 있고 Node.js나 Bun 설치를 요구하지 않는다. 호출 이름으로 역할을 선택하는 [ADR-0006](0006-select-runtime-role-by-invocation-name.md)은 유지한다. CLI 중복 바이너리와 사용자 PATH 등록은 추가하지 않는다.

이번 앱은 빌드 정보를 보여주며 호스트를 자동 실행하거나 서비스로 등록하지 않는다. 앱 UI의 자식 프로세스 생명주기를 제품 호스트 생명주기로 확정하지 않기 위해 서비스 연결은 TY-64에서 구현한다. 기존 운영 설치를 전환하거나 standalone updater가 앱을 관리하도록 연결하지 않는다.

Pi native addon과 Claude helper의 현재 Bun 포함·추출 방식을 보존해 기존 standalone 검증을 재사용한다. 이 선택은 배포 서명이나 TCC 귀속이 검증되었다는 의미가 아니다. 후속 서명·권한 검증에서 필요하면 앱 내부 고정 helper 경로로 변경한다. 현재 배치·실행 경로와 재현 명령은 [macOS 앱 가이드](../desktop.md)에 기록한다.

관련 이슈: [TY-63](https://linear.app/jakdo/issue/TY-63)
