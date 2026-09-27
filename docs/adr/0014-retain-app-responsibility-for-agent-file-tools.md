---
status: accepted
---

# 실제 에이전트 파일 도구의 권한 책임을 앱에 연결된 호스트에 유지한다

[ADR-0012](0012-manage-app-host-with-smappservice.md)의 SMAppService와 [ADR-0013](0013-sign-fixed-desktop-code-before-notarization.md)의 고정된 번들 코드 배치를 유지한다. 권한 주체를 별도 인터프리터나 Claude helper로 옮기거나 이를 위한 수동 권한을 추가하지 않는다. 앱 식별자와 서명 정체성을 유지하고 배포물은 전체 번들로 교체한다.

[TY-66 실측](../macos-tcc-validation.md#2026-09-27-실측-결과)에서 macOS 26.6.2의 TCC 접근 subject는 `com.jakdo.sky`, responsible code는 번들의 skyd였다. Pi Bash, Anthropic 서명을 유지한 고정 경로의 Claude helper, 그 자식 zsh도 호스트를 responsible process로 유지했다. Desktop 읽기 권한은 Sky의 승인·철회를 따랐으며 UI 종료·호스트 재시작·재로그인·두 서명 공증 버전의 교체에서도 같은 관계를 관찰했다. PPID나 서명 검사만으로 이 결론을 내리지 않고 실제 도구 결과와 TCC·프로세스 책임 진단을 함께 사용했다.

측정 중 Pi의 OAuth 흐름을 동적으로 불러오는 코드가 Bun standalone에 포함되지 않는 문제를 발견했다. standalone과 해당 스모크 빌드에서 Pi가 제공하는 `bun-oauth` 등록 경로를 명시적으로 연결한다. 제품 인증 저장소나 권한 우회는 추가하지 않는다. 이 보정은 실제 모델 요청 전에 발생하는 실행 실패를 해결하며 TCC 권한을 부여하는 기능은 아니다.

검증 요청은 시작 시 소유자 전용 설정으로 명시적으로 활성화한 로컬 UDS에서만 받는다. 지정된 비민감 fixture에 호스트 직접 I/O 또는 제품과 같은 Pi·Claude 도구를 실행한다. 원격 HTTP나 일반 UI의 권한 상태 API로 제공하지 않는다. 모델 턴 완료, 파일 오류 코드, 시스템 설정 토글 어느 하나만으로 접근 성공이나 FDA 상태를 확정하지 않는다.

결론의 범위는 측정한 OS와 실행 경로다. Desktop에서 새 파일 쓰기는 읽기와 다르게 허용될 수 있어 파일 시스템 전체를 단일 허용 여부로 표현하지 않는다. 사용자가 검증 종료를 요청해 FDA는 승인 전 Mail 접근 거부만 확인했고 승인 이후는 미실행이다. 다른 지원 macOS 버전도 미확인이다. 자동화·손쉬운 사용·화면 녹화는 이 파일 접근 검증에 포함하지 않는다. 전체 최초 검증 관문이 통과됐다는 근거로 사용하지 않는다.

OS·백엔드·서명 정체성·실행 파일 위치가 바뀌거나 helper가 별도 서비스로 전환되면 영향받는 권한 경로를 다시 검증한다. FDA 지원을 확정하거나 이를 전제로 제품 범위를 확대하기 전에는 남은 승인·철회·생명주기 검증이 필요하다.

관련 이슈: [TY-66](https://linear.app/jakdo/issue/TY-66)
