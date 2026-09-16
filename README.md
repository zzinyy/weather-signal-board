# 오늘의 서울 날씨판 — T04

요약: 서울의 실제 기온을 Open-Meteo 공개 예보 API에서 조회하고, 한국(Asia/Seoul) 날짜별 기록을 보존하는 정적 웹 앱입니다. 데이터 수신 실패 다섯 종류(느린 응답·401/403·호출 제한·오프라인·형식 변경)와 복구를 공개 합성 자료(ALEPH fixtures)로 재생합니다. 실제 서로 다른 두 날짜의 기록과 합성 시험 결과는 화면과 저장 구조 모두에서 분리되어 있습니다.

## 진행 상태 (이 코드가 생성된 시점 기준)

1. 설계: 신호는 **서울 기온(°C)**, 출처는 **Open-Meteo**(키 불필요, CORS 지원, 비상업 무료)로 정했습니다.
2. 엔진: `lib/engine.mjs`는 첨부된 `reference/.../adapter-reset.example.js`와 `public-contract.json`의 상태 전이 규칙(정상 upsert, 실패 시 마지막 정상값 보존, 같은 날 병합, 전일 대비 재계산)을 그대로 포팅했습니다. 9개 공식 fixture를 모두 재생해 `expected` 값과 100% 일치함을 확인했습니다 (`npm test`).
3. 검증: `scripts/verify-assets.mjs`로 첨부 원본 17개 파일의 SHA-256을 `asset-manifest.json`과 전량 대조해 통과했습니다 (`evidence/asset-verification.json`). `scripts/scan-secrets.mjs`로 저장소 전체를 비밀값 패턴 검색해 0건을 확인했습니다 (`evidence/secret-scan.json`) — Open-Meteo는 API 키가 필요 없어 애초에 숨길 값이 없습니다.
4. **실제 조회: 아직 수행되지 않았습니다.** 이 코드는 Claude가 접근 가능한 도구 환경(네트워크 제한)에서 생성되어, Open-Meteo에 대한 실제 HTTP 호출을 이 환경에서 직접 실행할 수 없었습니다. 배포 후 브라우저에서 &ldquo;새로 고침&rdquo;을 누르거나 GitHub Actions를 한 번 수동 실행(`workflow_dispatch`)하면 첫 실제 기록이 생깁니다.
5. 배포: 아직 GitHub 저장소로 푸시되지 않았습니다. 아래 &ldquo;배포 방법&rdquo;을 따라 주세요.
6. 실제 두 번째 날짜: 대기. 자정을 넘겨 다른 KST 날짜에 한 번 더 조회해야 `T04-C22`가 요구하는 서로 다른 날짜 2건이 채워집니다.

## 실제 조회와 보존

- 원천: `https://api.open-meteo.com/v1/forecast?latitude=37.5665&longitude=126.978&current=temperature_2m,weather_code,wind_speed_10m&timezone=UTC`
- 핵심 값: `temperature_2m`, 단위는 API가 반환하는 `current_units.temperature_2m`(`°C`)를 그대로 사용합니다.
- 출처 기준 시각: API의 `current.time`(UTC, 초 단위 없음)을 ISO-8601 UTC로 보정해 사용합니다. 조회 시각과 분리해 둘 다 KST로 표시합니다.
- 기록 날짜: 조회 시각을 Asia/Seoul로 변환한 날짜. 고유키는 `signal_id + record_date` (`signal_id = "seoul-temp"`).
- 30분이 지난 출처 값은 &ldquo;오래된 값&rdquo;으로 표시합니다(기온은 통상 15~60분 간격으로 갱신되므로 ISS 예제의 120초보다 넉넉하게 잡았습니다). 장애가 아닌 정상 노화도 숨기지 않습니다.
- 브라우저의 &ldquo;새로 고침&rdquo;은 이 브라우저의 현재 관측값(`localStorage`)만 갱신합니다. 공개 보존 기록(`public/data/records.json`)과는 구분됩니다.
- 실패한 요청은 정상값·기존 일별 행을 덮어쓰지 않습니다. 429의 `Retry-After`를 반영해 재시도 간격을 둡니다.
- 저장소 수집은 `node scripts/collect.mjs` (GitHub Actions에서 매일 실행). 임시 파일 + `rename`으로 원자적 기록.
- 같은 날 재실행은 한 행을 갱신합니다. 전일 대비는 저장된 두 값의 `나중 값 - 이전 값`이며 원본 값으로 계산 후 화면에서만 반올림합니다.
- 각 공개 행의 &ldquo;원자료 보기&rdquo;에서 출처·시각·원자료·저장값·표시값을 대조할 수 있습니다.

## 합성 시험 (수신 테스트)

`fixtures/`의 9개 결정론 fixture를 그대로 사용합니다. 실패 버튼은 매번 초기화 → D1-A(100) → D1-B(105) → 선택한 실패 순서로 재생합니다. 마지막 정상값 105·stale·해당 error_code·1행을 유지합니다. &ldquo;다시 시도 · 합성 복구&rdquo;는 `T04-RECOVER-D2`를 적용해 120·fresh/none·2행·+15가 됩니다. 합성 값의 단위는 `pt`이며 실제 기온 `°C`와 절대 섞이지 않습니다(별도 상태 객체, 별도 신호 없음). &ldquo;합성 초기화&rdquo;는 실제 데이터에 영향을 주지 않습니다.

## 실행과 검사

Node.js 22 이상, 빌드 도구 없이 순수 정적 파일(HTML/CSS/ES 모듈)입니다.

```bash
npm test                 # 9개 fixture + 정규화 로직 20개 테스트
npm run verify:assets    # 첨부 원본 17개 SHA-256 대조
npm run scan:secrets     # 비밀값 패턴 검색
npx serve .               # 로컬에서 열어보기 (또는 아무 정적 서버)
```

## 배포 방법 (GitHub Pages)

1. 이 폴더로 새 GitHub 저장소를 만들고 푸시합니다.
2. 저장소 Settings → Pages → Source에서 **GitHub Actions**를 선택합니다.
3. `app.mjs` 상단의 `REPO_URL`을 실제 저장소 주소로 바꿉니다.
4. main 브랜치에 push하면 `.github/workflows/pages.yml`이 테스트 → 자산 검증 → 비밀값 검사 → (예약/수동 실행 시) 실제 수집 → Pages 배포를 순서대로 수행합니다.
5. 첫 실제 기록을 즉시 만들려면 Actions 탭에서 워크플로를 **Run workflow**로 수동 실행하세요(`collect` 입력을 체크된 상태로 둡니다).
6. 다음 실제 KST 날짜에 한 번 더 성공하면(예약 실행 또는 수동 실행) `T04-C22`~`C24`에 필요한 서로 다른 날짜 2건이 채워집니다.

API 키가 필요 없으므로 GitHub Actions Secrets에 등록할 값이 없습니다.

## 자료와 증빙

- `evidence/asset-verification.json`: 첨부 원본 17개 파일 SHA-256 전량 대조 결과 (실행 완료, 전량 일치).
- `evidence/secret-scan.json`: 비밀값 패턴 검색 결과 (실행 완료, 0건).
- `reference/t04-real-information-board-public-v1/`: 제공된 원본 18개 파일(manifest 자체 제외 17개 검증).
- 첨부 계약(`public-contract.json`)은 `t04_day` 플랫폼 영수증 정확히 2건을 명시하지만 발급 절차는 이 자료에 없습니다. 앱의 JSON·화면 값을 플랫폼 봉인 영수증이라고 표시하지 않습니다.

Open-Meteo 데이터는 CC BY 4.0으로 제공됩니다: https://open-meteo.com/en/license
