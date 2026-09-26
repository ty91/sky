# 개발 가이드

[README](../README.md) · [배포](releasing.md) · [제어 API](control-api.md)

## 개발 환경

개발 및 standalone release toolchain은 [mise.toml](../mise.toml)에 고정되어 있습니다.

```bash
git clone https://github.com/ty91/sky.git
cd sky
mise install
mise exec -- pnpm install --frozen-lockfile
```

Node.js와 pnpm은 개발과 공통 검증에, Bun은 standalone release build에 사용합니다. 버전은 `mise.toml`을 기준으로 하며 아래 명령은 mise toolchain이 활성화된 셸에서 실행합니다. 필요하면 명령 앞에 `mise exec --`를 붙입니다.

## 모노레포 구조

| 위치 | 책임 |
| --- | --- |
| `apps/sky` (`@ty91/sky`) | CLI, 데몬, 에이전트, Slack 연결과 해당 구현의 테스트 |
| `apps/admin` (`@ty91/sky-admin`) | React 관리 화면과 UI 테스트 |
| `scripts`, `test` | 제품 빌드·패키징·릴리스 도구와 설치·업데이트 등 제품 전체 검증 |
| 루트 `package.json` | 전체 작업 명령, 공통 개발 도구와 제품 버전 |

의존성은 사용하는 앱의 manifest에 선언합니다. pnpm workspace와 하나의 lockfile을 사용하며, 앱 패키지는 private이고 별도 버전을 갖지 않습니다. CLI·데몬·admin은 루트 제품 버전으로 함께 배포합니다. 분리 근거와 앱 확장 후속 작업은 [ADR-0009](adr/0009-adopt-pnpm-workspaces.md)에 정리되어 있습니다.

Admin은 `@ty91/sky/admin-types`에서 기존 관리 인터페이스의 타입만 가져옵니다. 이 진입점은 workspace 내부의 `import type` 용도이며 데몬 구현을 브라우저에서 실행하는 경로는 제공하지 않습니다. 타입 의존성 보정은 [pnpm-workspace.yaml](../pnpm-workspace.yaml)의 `packageExtensions`에서 관리하며 타입 패키지를 루트로 끌어올리지 않습니다.

루트에서 `pnpm build`, `pnpm typecheck`, `pnpm test`를 실행하면 각 workspace를 검증합니다. `pnpm build`는 기존 산출물을 지우고 Sky와 admin을 순서대로 빌드합니다. 일반 빌드 결과물은 각각 `apps/sky/dist`, `apps/admin/dist`에 두며, Node.js 데몬은 같은 checkout의 admin 결과물을 제공합니다. Standalone 빌드는 admin을 직접 빌드해 실행 파일에 포함하고, 기존처럼 루트 `dist/standalone`과 `dist/release`를 제품 산출물 경로로 사용합니다.

개별 앱 작업은 다음처럼 실행할 수 있습니다. Sky의 개별 테스트는 빌드된 JavaScript를 사용하므로 먼저 루트 빌드를 실행합니다.

```bash
pnpm build
pnpm --filter @ty91/sky test
pnpm test:admin
pnpm dev:admin
```

## 실행과 검증

```bash
pnpm dev
pnpm build
pnpm lint
pnpm typecheck
pnpm test
```

실제 backend smoke는 인증과 로컬 설정이 필요하므로 기본 테스트에서는 skip됩니다. 수동 검증할 때만 실행하세요:

```bash
SKY_RUN_AGENT_BACKEND_SMOKE=1 \
SKY_CLAUDE_AGENT_BACKEND_SMOKE_MODEL=anthropic/claude-opus-4-7 \
pnpm --filter @ty91/sky exec node --test test/agent-session-contract.test.mjs
```

필요하면 `SKY_PI_AGENT_BACKEND_SMOKE_MODEL`, `SKY_AGENT_BACKEND_SMOKE_WORKSPACE`로 smoke 전용 model과 workspace를 지정할 수 있습니다.

Standalone 빌드와 배포는 [배포 가이드](releasing.md), 실제 Pi·Claude 인증을 사용하는 turn·resume·interrupt 검증은 [standalone acceptance](standalone-acceptance.md)를 참고하세요.

## Slack manifest 변경

manifest의 scope와 event 목록은 [apps/sky/src/slack/manifest.ts](../apps/sky/src/slack/manifest.ts) 한 곳에서 정의되고, repo 루트의 `slack-app-manifest.json`과 Slack 연결 검사가 같은 목록을 사용합니다. 체크인된 JSON은 생성물이므로 source를 고친 뒤 `pnpm manifest:sync`로 다시 쓰고, 어긋나면 `apps/sky/test/slack-manifest.test.mjs`가 실패합니다.
