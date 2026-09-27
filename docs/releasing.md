# CLI와 macOS 앱 배포

[README](../README.md) · [개발](development.md) · [Standalone acceptance](standalone-acceptance.md) · [macOS 서명](macos-signing.md)

## 빌드와 검증

개발 환경은 [개발 가이드](development.md)에 따라 준비합니다.

```bash
pnpm build:standalone
pnpm test:standalone
```

빌드는 `dist/standalone/darwin-arm64/`에 물리 실행 파일 `sky`와 `skyd` symlink를 만들고 `dist/standalone/darwin-arm64.metafile.json`에 Bun build metafile을 기록합니다. Admin asset도 실행 파일에 포함합니다.

패키징, 설치·업데이트, 실제 backend 검증의 명령과 통과 조건은 [standalone acceptance](standalone-acceptance.md)를 기준으로 합니다. 실제 LaunchAgent 검증은 기존 Sky 서비스를 점유하지 않는 전용 test user 또는 service를 완전히 uninstall한 머신에서만 실행합니다.

## 버전과 발행

Release version의 원본은 루트 `package.json`입니다. Version을 올리고 검증한 변경을 커밋한 뒤, 그 커밋에 동일한 `vX.Y.Z` tag를 붙여 push합니다.

```bash
pnpm version <version> --no-git-tag-version
pnpm test
pnpm release:check-tag -- v<version>
```

버전 변경 커밋을 만든 뒤 발행합니다.

```bash
git tag v<version>
git push origin v<version>
```

`Release Sky` workflow는 GitHub-hosted macOS arm64에서 CLI와 앱을 별도 job으로 빌드합니다. CLI job은 tag와 `package.json` version 일치, lint, typecheck, 전체 테스트, standalone 실행과 실제 LaunchAgent lifecycle, archive·checksum 계약을 검증합니다. 앱 job은 고정 Rust 도구로 빌드·검사하고 Developer ID 서명, 격리된 내장 호스트 실행, Apple 공증·stapling·Gatekeeper 검증을 수행합니다. 인증 설정은 [CI 서명 가이드](macos-signing.md#github-actions-배포-인증)를 따릅니다.

두 job이 모두 성공하면 checksum을 재검증하고 다음 네 파일을 하나의 GitHub Release에 발행합니다.

- `sky-<version>-darwin-arm64.tar.gz`와 `.tar.gz.sha256`
- `Sky-<version>-darwin-arm64.zip`과 `.zip.sha256`

발행 후 별도 job은 공개 앱 ZIP의 checksum·서명·공증·내장 호스트 실행을 검사합니다. CLI도 공개 release에서 install하고 낮은 version standalone을 `sky update`로 올린 뒤 service lifecycle과 `sky doctor`를 다시 검증합니다. 발행 후 검사 실패는 이미 공개된 Release를 자동 삭제하지 않으므로 해당 job을 진단하고 필요한 수정 버전을 배포합니다. 앱은 전체 번들로 교체하며 CLI의 `sky update`로 업데이트하지 않습니다.

태그 발행 전에는 `main`의 현재 버전으로 배포 빌드와 공증까지 검증할 수 있습니다. 이 실행은 Release를 생성하지 않고 Actions artifact를 7일 보관합니다.

```bash
gh workflow run release-package.yml --ref main
```

Workflow 정의는 [release-package.yml](../.github/workflows/release-package.yml)에 있습니다. Tag 이름에 `-`가 있으면 prerelease로 발행합니다. Release candidate 등 특정 버전을 설치하려면 다음처럼 지정합니다.

```bash
curl -fsSL https://raw.githubusercontent.com/ty91/sky/main/install.sh | sh -s -- --version <version>
```

## 서명과 기존 설치 전환

CI와 수동 배포의 인증서·공증 인증 및 복구 절차는 [macOS 서명 문서](macos-signing.md)에 있습니다. 기존 CLI 서비스에서 앱으로 옮길 때는 [서비스 인계 절차](desktop.md#기존-cli-설치와-충돌)를 따릅니다. 릴리스 발행 자체는 설치된 호스트를 교체하지 않습니다.

Homebrew 또는 외부 maintenance cron을 사용하던 환경은 배포 전에 [마이그레이션 절차](migrations.md)를 확인합니다. Installer와 updater는 사용자 crontab을 수정하지 않습니다.
