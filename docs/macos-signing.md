# macOS 배포 서명과 공증 인증

Sky 배포물의 서명은 `mini`에서 수행한다. 설치 대상 Mac에는 서명용 개인 키를 배포하지 않는다. 이 문서는 TY-62에서 준비한 인증 수단과 복구 절차를 다룬다. Tauri 빌드 연결, 내장 실행 파일 서명 순서, 실제 Sky 배포물 공증과 CI 구성은 TY-65에서 검증한다.

## 운영 식별 정보

| 항목 | 값 |
| --- | --- |
| 개발자 팀 | Studio Jakdo |
| Team ID | `RY355N72WN` |
| 서명 Mac | `mini` |
| 인증서 | `Developer ID Application: Studio Jakdo (RY355N72WN)` |
| 인증서 종류 | Developer ID Application, G2 중간 인증 기관 |
| 인증서 SHA-1 식별자 | `DA0731BD463A75EEA2D0B4876C053E917F3434F1` |
| 인증서 만료 | 2031-09-17 00:00 UTC |
| 전용 Keychain | 로그인 사용자의 `Library/Keychains/sky-signing.keychain-db` |
| 공증 인증 | App Store Connect 팀 API 키, Developer 권한 |
| API 키 이름 | `Sky Notarization mini` |
| API Key ID | `4C3845KB23` |
| API Issuer ID | `1ada73ce-7b1a-49c0-98d6-d9560ad2a796` |
| notarytool 프로필 | `sky-notary` |

팀 API 키의 Developer 권한은 팀 전체 앱에 적용되며 Sky 하나로 제한되지 않는다. 기존 Expo용 관리자 키와 별도로 관리한다. API 키는 만료되지 않으므로 필요가 없어지거나 유출된 경우 명시적으로 폐기한다.

## 서명 세션

전용 Keychain은 기존 사용자 검색 목록에 추가되어 있으며 기본 login Keychain을 대체하지 않는다. 잠자기 및 1시간 유휴 시 잠기도록 구성했다. SSH 작업에서는 같은 연결 안에서 Keychain을 잠금 해제한 뒤 서명·공증 작업을 실행하고, 끝나면 다시 잠근다. 별도 SSH 연결에서 앞선 잠금 해제 상태를 가정하지 않는다.

Keychain 암호는 아래 1Password 항목의 정확한 필드에서 읽어 프로세스 메모리로 전달한다. 셸 tracing, 명령 기록, 전체 환경 출력, 비밀 값이 포함된 오류 출력은 사용하지 않는다. `security`에 전달할 암호를 저장소나 상시 평문 파일에 보관하지 않는다.

잠금 해제한 세션에서 정체성을 확인한다.

```sh
security find-identity -v -p codesigning "$HOME/Library/Keychains/sky-signing.keychain-db"
```

목록에 위 SHA-1과 인증서 이름이 유효한 정체성으로 표시되어야 한다. 공개 인증서만 설치한 상태로는 서명할 수 없으며 연결된 개인 키가 필요하다. Developer ID G2 중간 인증서도 전용 Keychain에 설치되어 있다.

테스트용 Mach-O 복사본에 대한 서명·검증은 다음 형태로 수행한다. `SIGNING_TEST_FILE`은 배포 앱이 아닌 테스트 파일 경로다.

```sh
codesign --force \
  --sign DA0731BD463A75EEA2D0B4876C053E917F3434F1 \
  --keychain "$HOME/Library/Keychains/sky-signing.keychain-db" \
  --options runtime --timestamp "$SIGNING_TEST_FILE"
codesign --verify --strict --verbose=2 "$SIGNING_TEST_FILE"
codesign -dv --verbose=4 "$SIGNING_TEST_FILE"
```

인증서가 보여도 `errSecInternalComponent`가 발생하면 해당 SSH 세션의 Keychain 잠금부터 확인한다. `0 valid identities`이면 개인 키 연결, 만료, 중간 인증서와 사용자 Keychain 검색 목록을 확인한다. 신뢰 설정을 강제로 변경하거나 모든 프로그램에 개인 키 접근을 허용해서 우회하지 않는다.

## 공증 인증 확인

`sky-notary`는 API 개인 키를 전용 Keychain에 저장한 프로필이다. 일회성 다운로드한 `.p8` 파일이 없어도 다음 명령으로 인증할 수 있다.

```sh
xcrun notarytool history \
  --keychain-profile sky-notary \
  --keychain "$HOME/Library/Keychains/sky-signing.keychain-db" \
  --output-format json
security lock-keychain "$HOME/Library/Keychains/sky-signing.keychain-db"
```

제출 이력이 없는 빈 목록도 인증 성공이다. 이 확인은 실제 앱의 공증 승인이나 Gatekeeper 통과를 의미하지 않는다. TY-65에서 Sky 배포물을 제출하고 공증 결과와 stapling을 검증한다.

## 보관과 복구

일상 사용본은 mini의 전용 Keychain, 복구 원본은 1Password `agents` vault에 보관한다. Keychain 암호와 백업 암호는 서로 다른 난수 값이다.

| 1Password 항목 | 필드 | 용도 |
| --- | --- | --- |
| `Sky Developer ID Application (mini)` | `certificate p12 base64` | 인증서와 개인 키를 포함한 암호화 PKCS#12 |
| 같은 항목 | `p12 password` | PKCS#12 복호화 암호 |
| 같은 항목 | `keychain password` | 전용 Keychain 잠금 해제 |
| 같은 항목 | `team id`, `certificate sha1` | 복원 결과 식별 |
| `Sky Notarization (mini)` | `private key` | API 개인 키 PEM |
| 같은 항목 | `key id`, `issuer id`, `keychain profile` | 공증 인증 설정 |

1Password CLI는 service account로 `agents`에 접근한다. `OP_LOAD_DESKTOP_APP_SETTINGS=false`와 `OP_BIOMETRIC_UNLOCK_ENABLED=false`를 함께 적용하고 터미널 대화형 stdin을 사용하지 않는다. 비밀 필드는 항목 JSON에서 정확한 `label`로 추출하며 출력하지 않는다. 단일 `--field` 조회에 의존하지 않는다.

복구는 지정한 서명 Mac에서만 수행한다.

1. 기존 Keychain을 덮어쓰지 않고 복구 대상과 사용자 계정을 확인한다. 기존 Keychain이 남아 있으면 백업의 암호로 잠금 해제부터 시도한다.
2. Keychain을 새로 만드는 경우 별도 난수 암호를 정하고 1Password의 `keychain password`를 갱신한다. 잠자기·유휴 잠금 설정을 유지하고 사용자 검색 목록에 추가하되 기본 Keychain과 기존 검색 목록을 보존한다.
3. `certificate p12 base64`를 권한 `0700`인 임시 디렉터리의 `0600` 파일로 복원한다. `p12 password`로 전용 Keychain에 가져오고 `/usr/bin/codesign` 접근만 지정한다. 전용 Keychain의 서명 키에 필요한 Apple 도구 partition ACL을 적용한다. 모든 앱을 허용하는 `security import -A`는 사용하지 않는다.
4. Apple 공식 배포처의 Developer ID G2 중간 인증서를 설치하고 SHA-1, 팀, 유효기간을 대조한다. 테스트 파일 서명과 검증까지 확인한다.
5. API `private key`를 같은 방식으로 임시 `.p8` 파일에 복원한다. 아래 명령으로 검증하며 프로필을 재생성한다. `NOTARY_KEY_FILE`은 이 임시 파일 경로다.

```sh
xcrun notarytool store-credentials sky-notary \
  --key "$NOTARY_KEY_FILE" \
  --key-id 4C3845KB23 \
  --issuer 1ada73ce-7b1a-49c0-98d6-d9560ad2a796 \
  --keychain "$HOME/Library/Keychains/sky-signing.keychain-db" \
  --validate
```

6. 임시 개인 키·PKCS#12·암호 파일을 제거한 후 프로필만으로 `notarytool history`가 성공하는지 확인한다. Keychain을 잠근다. 설치용 Mac이나 개발 노트북에 복구용 키를 상시 복제하지 않는다.

## 교체와 유출 대응

인증서 만료 전 새 개인 키·CSR로 Developer ID Application 인증서를 발급하고, 별도 백업과 테스트 서명을 검증한 뒤 빌드의 서명 식별자를 교체한다. API 키 교체 시에도 새 Developer 키를 발급하고 별도 프로필로 인증을 확인한 뒤 사용 프로필을 전환한다. 위 운영 식별 정보와 1Password 항목을 함께 갱신한다.

일반 인증서 교체 때문에 기존 Developer ID 인증서를 즉시 폐기하지 않는다. 폐기는 기존 배포 앱의 실행과 설치에 영향을 줄 수 있다. 유출되면 배포를 중지하고 Apple의 인증서 폐기 절차와 영향 범위를 확인한다. API 키 유출은 해당 키를 즉시 폐기하고 새 키로 교체한다. API 개인 키는 Apple에서 다시 다운로드할 수 없으므로 백업까지 잃었다면 새 키가 필요하다.

## 후속 빌드 설정

Tauri 연결 시 `APPLE_SIGNING_IDENTITY`는 위 인증서 이름을 사용한다. API 인증의 설정 이름은 `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH`다. `.p8` 경로가 필요한 도구에는 1Password에서 작업 시간에만 임시 파일을 복원하고 종료 시 제거한다. 직접 `notarytool`을 호출하는 파이프라인은 기존 Keychain 프로필을 사용할 수 있다.

향후 다른 빌드 환경에서 PKCS#12 가져오기가 필요하면 `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `KEYCHAIN_PASSWORD`를 사용한다. 현재 CI에 이 값들을 등록하거나 빌드 동작을 변경하지 않았다. 비밀 값은 이슈·저장소·로그에 기록하지 않는다.

## 참고

- [TY-62: 서명 인증서와 공증 인증 준비](https://linear.app/jakdo/issue/TY-62)
- [TY-65: 서명·공증 빌드 구성](https://linear.app/jakdo/issue/TY-65)
- [Apple Developer ID 인증서](https://developer.apple.com/help/account/certificates/create-developer-id-certificates)
- [Apple App Store Connect API](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api)
- [Apple 공증 워크플로](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)
- [Tauri macOS 서명과 공증](https://v2.tauri.app/distribute/sign/macos/)
