---
status: accepted
---

# Configuration 쓰기는 daemon에 집중하고 secret을 분리한다

설정 validation, optimistic revision, atomic write와 secret 비노출을 모든 caller가 우회할 수 없도록 configuration 쓰기는 UDS control interface를 제공하는 daemon만 수행한다. CLI와 후속 admin adapter가 파일을 직접 수정하는 방식은 lost update와 부분 검증을 만들기 때문에 채택하지 않는다.

일반 설정은 schema version과 revision을 가진 `settings.json`, credential은 별도 `secrets.json`에 저장한다. 첫 adapter는 두 파일 모두 Sky home의 private-file contract로 보호하는 방식이다. macOS Keychain이나 Linux Secret Service를 바로 사용하면 platform별 설치·headless 실행 차이가 초기 제품 계약에 섞이므로 보류하며, public configuration interface와 secret metadata 형식은 후속 secure-store adapter에서도 유지한다.

## 관련 이슈

- [TY-18](https://linear.app/jakdo/issue/TY-18)
- [TY-19](https://linear.app/jakdo/issue/TY-19)
