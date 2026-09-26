# 제어 API 참고

[README](../README.md) · [운영](operations.md) · [설정](configuration.md) · [개발](development.md)

이 문서는 CLI와 admin이 사용하는 주요 계약을 정리합니다. 전체 라우트 정의는 [UDS adapter](../apps/sky/src/skyd/control-uds.ts)와 [admin HTTP adapter](../apps/sky/src/skyd/admin-http.ts), 공유 타입은 [admin-types](../apps/sky/src/admin-types.ts)를 참고하세요.

## 로컬 control socket

`skyd`는 Sky home의 `run/skyd.sock`에 HTTP/JSON interface를 제공합니다. Socket은 현재 OS 사용자만 접근할 수 있도록 mode `0600`으로 유지합니다. Foreground daemon을 실행한 뒤 다른 terminal에서 조회할 수 있습니다.

```bash
curl --unix-socket "${SKY_HOME:-$HOME/.sky}/run/skyd.sock" http://localhost/status
curl --unix-socket "${SKY_HOME:-$HOME/.sky}/run/skyd.sock" http://localhost/configuration
```

| Endpoint | 계약 |
| --- | --- |
| `GET /status` | Daemon instance, runtime·Slack 상태, uptime, backend·model, 활성 작업 수, 최근 오류 code |
| `GET /configuration` | 설정과 credential metadata, `activeRevision`, `restartRequired`로 저장 상태와 실행 상태 구분 |
| `GET /diagnostics` | 안정적인 check ID와 `pass`·`warn`·`fail`, summary 및 선택적인 detail·remediation |
| `GET /logs` | Structured log history |
| `GET /logs/stream` | Live log stream |

설정 파일의 물리 형식은 public interface가 아닙니다. 설정 변경과 secret의 유지·교체·삭제 규칙은 [설정 문서](configuration.md)를 따릅니다.

## Maintenance operation

- `POST /operations`: `{"type":"memory"}` 또는 `{"type":"dream","date":"YYYY-MM-DD","step":"summarize|knowledge"}`를 받아 `202`와 operation ID를 반환합니다.
- `GET /operations/:id`: 상태, 입력, 시각, 결과 또는 오류 코드를 반환합니다.
- `GET /operations/:id/events`: 완료될 때까지 `application/x-ndjson` event stream을 반환합니다.

CLI 분리, 보관 한도, 동시 실행 제한과 재시작 시 동작은 [운영 문서](operations.md#memory와-dream)를 참고하세요.

## Admin HTTP API

Admin API는 인증된 session을 요구하며 변경 요청은 same-origin과 session-bound CSRF token을 검증합니다. 인증 수명과 접속 방법은 [운영 문서](operations.md#admin-접속), cookie와 보안 설계는 [ADR-0004](adr/0004-expose-authenticated-admin-gateway.md)를 참고하세요.

Admin의 Agent 화면은 `GET /api/configuration`과 optimistic revision을 사용하는 `PATCH /api/configuration`으로 다음 실행 설정을 관리합니다. 저장은 현재 runtime을 부분 변경하지 않으며, 응답의 `restartRequired`가 참일 때 CSRF로 보호된 `POST /api/restart`로 graceful restart를 요청합니다. `GET /api/prompts`는 client path 입력 없이 `SOUL.md`, `AGENTS.md`, `USER.md`, `MEMORY.md`만 읽는 read-only snapshot입니다. 각 role은 entry/symlink target 상태, byte size, 수정 시각과 최대 256 KiB의 UTF-8 content를 제공하며 모든 응답은 `no-store`입니다.

Connections 화면은 credential 원문을 읽지 않고 `configured`, `source`, `updatedAt`, `displayHint` metadata만 표시합니다. 각 credential은 keep, replace, delete를 명시적으로 선택한 뒤 적용하며 replace input은 기존 값으로 채워지지 않습니다. 저장 변경은 active runtime에 즉시 섞이지 않고 `restartRequired`를 만들며, 환경의 `CLAUDE_CODE_OAUTH_TOKEN`이 effective credential이면 stored Claude token보다 우선한다는 점을 화면에 표시합니다.

Logs 화면은 authenticated `GET /api/logs` history와 `GET /api/logs/stream` SSE를 사용합니다. SSE의 `id`는 structured log cursor이며 browser reconnect의 `Last-Event-ID` 또는 `cursor` query 이후부터 중복 없이 이어집니다. Rotation으로 cursor가 만료되면 `410 log_cursor_expired`를 확인하고 최신 history tail로 복구했다는 안내를 표시합니다. Level과 scope filter는 browser에 이미 전달된 safe log record에만 적용됩니다.

System 화면의 `GET /api/system`은 product version, admin listener, supervision mode, LaunchAgent 설치/load/autostart 상태, 최근 daemon error와 package capability를 함께 반환합니다. Update와 rollback은 `unsupported`이며 action button이 없습니다. Graceful restart가 `202`로 수락되면 잠깐의 connection loss를 정상으로 취급하고, replacement daemon이 이전 in-memory session을 거부하므로 새 `sky admin` token으로 로그인해야 합니다.
