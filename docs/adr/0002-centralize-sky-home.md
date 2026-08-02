---
status: accepted
---

# Sky가 소유하는 filesystem 경로를 SkyHome에 집중한다

Settings, secret, runtime socket, log, SQLite, transcript, cursor와 기본 workspace의 경로 및 private filesystem 정책은 `SkyHome` module이 소유한다. Caller별 경로 조립은 `SKY_HOME` override가 서로 다른 root를 가리키게 하고 파일 종류별 권한·symlink 검사를 빠뜨리기 쉬우므로 채택하지 않는다.

기본 root는 `~/.sky`이며, 명시적으로 주입한 절대 root와 절대 `SKY_HOME` override를 지원한다. Override는 기존 data를 이동하는 profile 기능이 아니라 별도 root를 선택하는 기능이고, LaunchAgent label과 active daemon은 계속 사용자당 하나만 유지한다.

Sky가 직접 관리하는 directory는 현재 사용자 소유의 실제 directory, file은 현재 사용자 소유의 regular file이어야 한다. 기존 권한은 각각 `0700`과 `0600`으로 교정하지만 symlink, 다른 사용자 소유 entry와 예상 타입이 다른 entry는 따라가거나 수정하지 않는다.

## 관련 이슈

- [TY-16](https://linear.app/jakdo/issue/TY-16)
