---
status: accepted
---

# 앱의 실행 코드는 고정된 번들 경로에 두고 안쪽부터 서명한다

[ADR-0011](0011-bundle-standalone-host-in-macos-app.md)의 Bun 내부 자산 추출은 CLI standalone에 유지한다. 앱 호스트는 Claude를 `Contents/Helpers/claude`, Pi clipboard를 `Contents/Frameworks/clipboard.darwin-arm64.node`에서 직접 사용한다. 실행 파일의 실제 경로를 기준으로 찾으므로 앱 이동과 CLI symlink에도 같은 번들의 코드를 사용한다. 자산을 opaque Bun 파일 안에 숨기면 공증 전 코드별 서명 검사와 실행 시 library validation을 분리해 확인하기 어렵다.

Claude의 유효한 Anthropic Developer ID 서명은 보존한다. Pi native addon은 Sky 팀으로 서명해 같은 팀의 호스트에서 library validation을 유지한다. Bun 호스트에만 JIT entitlement를 적용하고 네이티브 앱에는 부여하지 않는다. 앱 식별자 `com.jakdo.sky`와 SMAppService 계약은 유지한다. 필요한 entitlement의 확대는 실제 실행 실패와 별도 검증을 근거로 결정한다.

번들 조립을 마친 뒤 native addon과 호스트, 바깥 앱 순서로 서명한다. 공증 승인 후 앱에 티켓을 첨부하고 최종 ZIP을 다시 생성한다. 배포물은 앱 번들 전체이며 내부 실행 파일만 교체하는 업데이트는 지원하지 않는다. 실제 도구의 Desktop 권한 귀속·버전 교체 실측과 FDA 등 남은 검증 범위는 [ADR-0014](0014-retain-app-responsibility-for-agent-file-tools.md)에 기록한다.

관련 이슈: [TY-65](https://linear.app/jakdo/issue/TY-65)
