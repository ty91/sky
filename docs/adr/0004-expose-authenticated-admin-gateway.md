---
status: accepted
---

# 평문 LAN 위에 인증된 admin gateway를 제공한다

Sky admin은 `skyd`가 제공하는 별도 HTTP adapter로 두고 기본적으로 `0.0.0.0:4815`에 bind한다. 운영 대상이 공유기 아래의 사설망과 Tailscale 연결로 제한되어 있으므로 첫 버전에서는 TLS와 Tailscale Serve를 요구하지 않으며, 인터넷 공개 운영은 지원하지 않는다. 같은 LAN의 다른 장치도 HTTP endpoint에 도달할 수 있다는 위험은 수용하되 network 위치나 Tailscale header를 인증으로 간주하지 않는다.

## 인증과 browser 보안

UDS control interface는 계속 filesystem 권한으로 같은 OS 사용자에게만 열어 둔다. `sky admin`은 이 privileged interface를 통해 5분 동안 유효한 256-bit 일회용 token을 발급하고, token은 URL query가 아니라 fragment 또는 사용자의 직접 입력으로 browser에 전달한다. Admin gateway는 token을 한 번만 교환해 daemon memory에만 존재하는 24시간 session을 만들며 daemon restart 시 모든 token과 session을 폐기한다.

Session cookie는 평문 HTTP 지원 때문에 `Secure`를 사용하지 않지만 `HttpOnly`, `SameSite=Strict`, `Path=/`를 적용한다. 모든 state-changing request는 session에 묶인 CSRF token과 same-origin 검사를 통과해야 하고 CORS는 열지 않는다. Login과 변경 요청에는 `Cache-Control: no-store`를 적용하고 CSP, frame 차단, MIME sniffing 차단과 referrer 차단 header를 제공한다.

## 제어와 데이터 소유권

UDS와 admin HTTP adapter는 동일한 daemon control module을 호출한다. Browser adapter가 settings, secret, SQLite 또는 workspace를 직접 수정하는 별도 경로는 만들지 않으며, daemon이 configuration과 runtime state의 유일한 writer라는 기존 원칙을 유지한다.

저장된 Slack bot/app token과 Claude OAuth token은 등록, 교체, 삭제할 수 있지만 값은 어떤 조회 응답에도 반환하지 않는다. Browser는 configured/source/updatedAt/displayHint metadata만 받는다. `CLAUDE_CODE_OAUTH_TOKEN` 환경변수가 있으면 기존 우선순위를 유지하고, admin은 저장 값을 바꿔도 환경변수가 effective credential임을 표시한다. Credential 변경은 저장 후 명시적인 검증과 graceful restart로 적용한다.

Workspace에서는 `SOUL.md`, `AGENTS.md`, `USER.md`, `MEMORY.md` 네 prompt file만 allowlist로 조회할 수 있다. Admin을 범용 file browser나 editor로 만들지 않는다.

## 화면과 배포

Admin frontend는 React와 Vite로 별도 static build를 만들고 package의 `dist`에 포함한다. `skyd`가 login shell과 static asset을 제공하며, authenticated JSON endpoint와 log SSE stream도 같은 origin에서 제공한다. 화면은 Dashboard, Connections, Agent, Sessions, Scheduler, Logs, System으로 구성한다.

System 화면은 현재 version, supervision/autostart 상태와 graceful restart를 제공한다. 실제 update와 rollback은 TY-10의 G 단계가 소유하므로 D에서는 capability가 아직 지원되지 않음을 명시적으로 표시한다.

## 검토한 대안

- Tailscale Serve와 HTTPS를 필수로 두면 secure cookie와 Tailscale access control을 사용할 수 있지만, 별도 proxy 설정 없이 Tailscale IP나 LAN 주소로 직접 접근하려는 운영 요구와 맞지 않아 채택하지 않는다.
- LAN을 신뢰하고 인증을 생략하면 token과 설정을 누구나 바꿀 수 있으므로 채택하지 않는다.
- Tailscale identity header를 인증으로 사용하면 `0.0.0.0` listener에 직접 접근한 LAN client가 header를 위조할 수 있으므로 채택하지 않는다.
- Admin gateway가 UDS를 우회해 파일과 SQLite를 직접 읽고 쓰면 CLI와 browser 사이에 검증 및 동시성 규칙이 갈라지므로 채택하지 않는다.
- Prompt file 편집이나 workspace file browser는 원격 filesystem 변경 권한과 path traversal surface를 크게 늘리므로 첫 버전에서 지원하지 않는다.

## 결과

- Admin endpoint는 LAN과 tailnet 모두에서 도달 가능하지만 항상 application session 인증을 요구한다.
- 평문 LAN에서 session cookie가 탈취될 수 있는 residual risk를 명시적으로 수용한다.
- Daemon restart는 session을 무효화하므로 사용자는 `sky admin`으로 다시 로그인한다.
- Secret과 prompt content를 제공하는 모든 endpoint는 인증과 no-store 정책의 적용 대상이다.
- HTTPS를 나중에 추가해도 control module과 browser interface는 유지하고 HTTP adapter의 transport 정책만 강화할 수 있다.

## 관련 이슈

- [TY-10](https://linear.app/jakdo/issue/TY-10)
- [TY-20](https://linear.app/jakdo/issue/TY-20)
- [TY-21](https://linear.app/jakdo/issue/TY-21)
- [TY-22](https://linear.app/jakdo/issue/TY-22)
- [TY-23](https://linear.app/jakdo/issue/TY-23)
- [TY-24](https://linear.app/jakdo/issue/TY-24)
- [TY-25](https://linear.app/jakdo/issue/TY-25)
- [TY-26](https://linear.app/jakdo/issue/TY-26)
