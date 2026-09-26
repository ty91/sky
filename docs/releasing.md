# Standalone 빌드와 배포

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

Tag workflow는 macOS arm64에서 tag와 `package.json` version 일치, lint, typecheck, 전체 테스트, standalone 실행과 실제 LaunchAgent lifecycle, archive·checksum 계약을 검증합니다. 통과한 `sky-<version>-darwin-arm64.tar.gz`와 checksum만 GitHub Release에 발행합니다. 발행 후 별도 job은 공개 release에서 install하고 낮은 version standalone을 `sky update`로 올린 뒤 service lifecycle과 `sky doctor`를 다시 검증합니다.

Workflow 정의는 [release-package.yml](../.github/workflows/release-package.yml)에 있습니다. Tag 이름에 `-`가 있으면 prerelease로 발행합니다. Release candidate 등 특정 버전을 설치하려면 다음처럼 지정합니다.

```bash
curl -fsSL https://raw.githubusercontent.com/ty91/sky/main/install.sh | sh -s -- --version <version>
```

## 서명과 기존 설치 전환

서명 Mac, 인증서·공증 인증과 복구 절차는 [macOS 서명 문서](macos-signing.md)에 있습니다. 실제 앱 빌드 연결과 공증 파이프라인은 해당 문서에 명시된 후속 작업입니다.

Homebrew 또는 외부 maintenance cron을 사용하던 환경은 배포 전에 [마이그레이션 절차](migrations.md)를 확인합니다. Installer와 updater는 사용자 crontab을 수정하지 않습니다.
