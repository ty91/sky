# 기존 설치 마이그레이션

[README](../README.md) · [설치](../README.md#설치와-초기-설정) · [운영](operations.md)

이 문서는 Homebrew v0.2.3 설치 또는 외부 cron으로 memory·dream을 실행하던 기존 환경에만 적용됩니다. 새 설치에는 필요하지 않습니다. 설치 스크립트와 `sky update`는 crontab을 읽거나 변경하지 않습니다.

## v0.2.3 Homebrew 설치에서 마이그레이션

기존 Sky home은 Homebrew keg 밖의 `~/.sky` 또는 `SKY_HOME`에 있으므로 package를 제거해도 삭제되지 않습니다. Custom root를 사용한다면 기존 LaunchAgent와 같은 `SKY_HOME`을 명시한 상태에서 다음 절차를 실행합니다.

외부 memory·dream cron도 사용하고 있다면 아래 설치 명령을 실행하기 전에 [cron 전환 준비](#외부-cron에서-내장-스케줄러로-전환)를 먼저 마칩니다. `sky service install`은 새 데몬을 즉시 시작합니다.

```bash
sky_home="${SKY_HOME:-$HOME/.sky}"
sky_home_identity=$(stat -f '%d:%i' "$sky_home")
test "$(sky --version)" = '0.2.3'
brew uninstall sky
curl -fsSL https://raw.githubusercontent.com/ty91/sky/main/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
sky service install
sky restart
sky doctor
test "$(stat -f '%d:%i' "$sky_home")" = "$sky_home_identity"
```

`sky service install`은 기존 plist의 `/opt/homebrew/bin/skyd`를 `~/.local/bin/skyd`로 바꾸면서 같은 Sky home과 LaunchAgent label을 유지합니다. 마지막 `stat` 비교는 마이그레이션 전후 Sky home이 같은 directory인지 확인합니다.

## 외부 cron에서 내장 스케줄러로 전환

아래 memory·dream 절차는 두 기능을 순차적으로 도입하던 당시의 전환 및 rollback 절차입니다. Memory만 지원하는 중간 build로 전환할 때만 첫 절차에서 dream cron을 남깁니다. 두 기능을 모두 내장한 현재 build로 바로 전환한다면 daemon을 중지한 상태에서 Sky memory·dream cron 항목을 모두 백업·제거한 후 시작하고, 아래 두 절차의 실행 결과를 모두 검증합니다. 다른 cron 항목은 보존합니다.

현재 build에서 rollback할 때는 daemon을 먼저 멈추고, 복원할 cron 작업을 내장하지 않은 이전 build와 그에 맞는 cron 항목을 함께 복원합니다. 외부 cron과 같은 작업의 내장 스케줄러를 동시에 실행하지 않습니다.

### Memory 전환

기존 사용자 crontab의 `sky memory`에서 내장 ticker로 전환할 때는 두 실행 경로가 겹치지 않도록 다음 순서를 지킵니다.

1. ticker가 포함된 새 build를 아직 시작하지 않은 상태에서 `crontab -l`로 현재 memory와 dream entry를 확인하고 별도 private 파일에 백업합니다.
2. 새 build를 처음 시작하기 직전에 `crontab -e`를 열어 `sky memory`를 호출하는 entry 한 줄만 제거합니다. `sky dream` entry와 다른 모든 entry는 그대로 둡니다.
3. `crontab -l`에서 memory entry가 사라지고 dream entry가 남아 있는지 다시 확인합니다.
4. 새 build를 설치하고 `skyd`를 시작합니다. cron의 memory entry를 제거하기 전에 ticker build를 먼저 시작하면 안 됩니다.
5. 다음 5분 occurrence와 30초 tick을 기다리면서 `sky logs --json --follow`에서 scope가 `maintenance`이고 message가 `Scheduled memory operation submitted.`인 record의 `operationId`를 확인합니다.
6. 같은 ID를 `sky operation status <operation-id> --json` 또는 `sky operation watch <operation-id>`로 조회해 `succeeded`가 된 것을 확인한 뒤 cutover를 완료합니다. 제출 record와 같은 `operationId`의 `memory operation succeeded.` structured log도 같은 증거로 사용할 수 있습니다.

첫 내부 실행을 검증하지 못했다면 다음 순서로 rollback합니다.

1. `sky stop`으로 ticker가 포함된 daemon을 먼저 멈추고 종료를 확인합니다.
2. `crontab -e`에서 백업해 둔 memory entry 한 줄만 복원합니다. 전체 crontab을 백업본으로 덮어쓰거나 dream entry를 변경하지 않습니다.
3. `crontab -l`에서 memory와 dream entry가 각각 한 번씩만 존재하는지 확인합니다.
4. daemon이 필요하면 ticker가 없는 이전 build를 복원한 뒤 시작합니다. ticker build를 다시 시작하려면 memory cron entry를 먼저 제거하고 위 cutover를 처음부터 반복합니다.

### Dream 전환

Dream ticker를 처음 활성화할 때는 TY-57 cutover가 끝나 사용자 crontab에 memory entry는 없고 dream entry만 한 번 남아 있는 상태에서 시작합니다. 설치와 `sky update`는 crontab을 읽거나 변경하지 않으므로 이 전환은 명시적인 수동 작업입니다.

1. dream ticker가 포함된 새 build를 아직 시작하지 않은 상태에서 `crontab -l`로 memory entry가 없고 dream entry가 정확히 한 번 있는지 확인합니다. 전체 crontab을 mode `0600`인 private 파일에 백업합니다.
2. 새 build를 처음 활성화하기 직전에 `crontab -e`를 열어 Sky의 `dream` entry 한 줄만 제거합니다. 다른 사용자 entry는 변경하지 않습니다.
3. `crontab -l`을 다시 읽어 Sky memory/dream entry가 모두 없고 다른 entry가 보존되었는지 확인합니다.
4. 새 build를 설치하고 `skyd`를 시작합니다. dream cron entry를 제거하기 전에 ticker build를 시작하면 안 됩니다.
5. 첫 30초 tick 뒤 `maintenance-state.json`이 생기고 가장 최근 existing due daily episode를 한 번만 bootstrap했는지 확인합니다. Watermark보다 최신인 due date가 있으면 `sky logs --json --follow`의 `Scheduled dream operation submitted.` record에서 `targetDate`와 `operationId`를 기록합니다. 이미 최신 due date까지 bootstrap되었다면 다음 KST 02:00 occurrence를 기다리며 state를 인위적으로 변경하지 않습니다.
6. operation이 제출되면 `sky operation watch <operation-id> --json` 또는 `sky operation status <operation-id> --json`으로 전체 operation이 `succeeded`가 되었는지 확인합니다. 이어 같은 `operationId`와 `targetDate`를 가진 `Dream maintenance watermark advanced.` record를 확인합니다.
7. 누락일이 여러 개면 각 날짜가 오래된 순서로 제출되고 성공한 날짜만 watermark를 전진시키는지 반복 확인합니다. 다음 5분 occurrence에서는 `Scheduled memory operation submitted.`도 계속 나타나야 합니다.
8. `maintenance-state.json`이 현재 사용자 소유 regular file이고 mode `0600`인지 확인하고, `crontab -l`에 Sky maintenance entry가 없는 상태를 최종 기록합니다.

내부 dream 실행이나 watermark를 검증하지 못했다면 다음 순서로 rollback합니다.

1. `sky stop`으로 dream ticker build를 먼저 멈추고 daemon 종료를 확인합니다.
2. ticker가 없는 이전 build를 복원하되 아직 daemon을 시작하지 않습니다.
3. `crontab -e`에서 백업한 Sky dream entry 한 줄만 복원합니다. 전체 crontab을 백업본으로 덮어쓰지 않습니다.
4. `crontab -l`에서 memory entry는 없고 dream entry가 정확히 한 번인지 확인한 뒤 이전 daemon을 시작합니다.
5. ticker build를 다시 활성화하려면 외부 dream entry를 먼저 제거하고 cutover 절차를 처음부터 반복합니다. 외부 cron과 내장 ticker를 동시에 실행하지 않습니다.
