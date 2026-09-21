# 포크 기능 명세 (v2.3.3 기반, `my-changes` 브랜치)

이 문서는 v2.3.3 위에 추가한 기능을 **동작, 설정/저장 키, 코드 위치, 알려진 함정** 단위로 기록한다.
v2.4.0.9로 이식할 때의 기준 명세이며, 이식 계획은 [PORTING_PLAN_2.4.0.9.md](PORTING_PLAN_2.4.0.9.md)에 있다.

- 기준 커밋: `f2dc5ca` (v2.3.3 릴리스 `eec3fbd` 위 3커밋)
- 변경 파일: 실제 변경 37개(신규 포함). 줄바꿈(LF/CRLF) 차이만 있는 파일은 제외.
- 모든 코드는 Claude Code로 작성했고, 브라우저 실사용 검증은 사용자가 했다.

## 0. 한눈에 보는 변경 파일

| 구분 | 파일 | 신규/수정 |
| --- | --- | --- |
| 후리가나 | `src/modules/lyrics/furigana.ts` | 신규 (~1,000줄) |
| UtaTen | `src/modules/lyrics/utatenFurigana.ts` | 신규 (이식 제외) |
| LLM | `src/modules/lyrics/llmTranslation.ts` | 신규 (번역, 수정 패스, 후리가나) |
| 시크/복사 | `src/modules/lyrics/lineInteractions.ts` | 신규 |
| 주입 로직 | `src/modules/lyrics/injectLyrics.ts` | 수정 (가장 큼) |
| 구글 번역 | `src/modules/lyrics/translation.ts` | 수정 |
| 스크롤 | `src/modules/ui/animationEngine.ts` | 수정 (passive scroll) |
| 설정 | `src/core/appState.ts`, `src/modules/settings/settings.ts`, `src/index.ts` | 수정 |
| 옵션 UI | `src/options/options.ts`, `options.html`, `options.css` | 수정 |
| 상수 | `src/core/constants.ts` | 수정 |
| CSS | `public/css/blyrics/lyrics.css`, `variables.css`, `misc.css`, `public/css/ytmusic/general.css` | 수정 |
| 빌드 | `extension.config.cjs`, `tooling/path-shim.cjs`, `package.json`, `package-lock.json`, `manifest.json` | 수정/신규 |
| 사전 | `public/dict/*.dat.gz` (12개, 17MB) | 신규 |
| 로케일 | `_locales/en/messages.json`, `_locales/ko/messages.json` | 수정 (`lyrics_copied`) |

## 1. 후리가나 (`furigana.ts`)

### 1.1 동작

- 일본어 가사의 한자 위에 **한자 묶음(run) 단위**로 가나 읽기를 표시한다.
- 가라오케 스윕에 맞춰 후리가나도 좌→우로 하이라이트된다.
- 로마자(romanization) 스위치가 켜져 있어야 동작한다. 후리가나는 로마자 배치 요청을 통해 캐시를 채우고 그것을 읽어 쓴다.

### 1.2 적용 조건

- `shouldFurigana(text, lang)`: 텍스트에 가나가 있으면 일본어로 본다(언어 태그보다 우선). 없으면 `lang`이 `ja`로 시작하는지 본다.
- 곡 단위 판정 `songIsJapanese`: 한 줄이라도 가나가 있으면 그 곡 전체를 일본어로 본다. 한자만 있는 줄도 후리가나를 받고, 로마자 제외 언어 목록도 우회한다. 곡 제목이 영어인 일본어 곡에서 언어가 `en`으로 잘못 감지되는 문제 대응.
- 이미 `.blyrics--furigana`가 있는 줄은 건너뛴다(중복 렌더링 방지).

### 1.3 읽기 결정 파이프라인

1. **로마자 패스**: 구글 로마자를 히라가나로 변환(`romajiToHiragana`)하고 `alignKanjiRuns`로 표면 텍스트의 가나를 앵커 삼아 한자 묶음에 배분한다.
   - 띄어쓰기/구두점으로만 이어진 한자 그룹은 "체인"으로 묶어 한자 개수 비례로 나눈다. 뒤에 오는 가나가 조사가 아니면 okurigana로 보고 마지막 그룹은 최소만 준다.
   - 숫자 뒤 한자(1分 등 조수사)는 읽기를 추정하지 않고 건너뛴다.
   - 라틴 문자가 섞인 읽기는 버린다. 읽기 길이가 한자 수 × 4 + 2를 넘으면 정렬이 어긋난 것으로 보고 버린다.
2. **kuromoji 패스**: 로컬 사전(번들)으로 토큰화하고 토큰별로 `alignKanjiRuns`를 돌린다(`kuromojiKanjiRuns`). 첫 일본어 줄에서 사전을 로드(약 1.1초).
3. **병합** `mergeRuns(surface, romajiRuns, kuromojiRuns)`: 시작/끝 위치가 정확히 같은 묶음끼리 비교한다.
   - 한 글자 한자: 읽기가 다르면 kuromoji 채택(愛=あい, 구글은 いと로 오독).
   - 구두점/영어로만 이어진 체인 경계의 묶음(`isChainAdjacent`): 다르면 kuromoji 채택. 로마자 쪽 배분이 한쪽 글자를 훔치는 버그 대응(예: 두 한자어 사이에 괄호).
   - 읽기가 장모음 표기(う/お)만 다르면 kuromoji 채택(`foldLongO`). 구글은 ō를 항상 おう로 적는다.
   - 나머지 다글자 묶음은 로마자 유지. 한쪽만 찾은 묶음은 그대로 채택.
4. **오버라이드** `applyOverrides`: 정적 표 `READING_OVERRIDES`(약 90개, `[매치문자열, 한자시작, 한자끝, 읽기]`) + 곡별 오버라이드(`setSongFuriganaOverrides`, UtaTen에서 채움). 곡별이 정적 표보다 우선(같은 길이일 때). 긴 매치 우선, 이미 차지한 범위는 건너뜀, 한자가 맞닿은 복합어의 일부는 건너뜀(경계 검사).
5. **LLM 교체** (1.6 참고).

### 1.4 배치와 레이아웃 (`attachFuriganaRuns`, `resolveFuriganaLayout`)

- 각 묶음마다 `<span class="blyrics--furigana">`를 **첫 한자가 있는 `.blyrics--word` 스팬의 자식**으로 붙인다. 워드 스팬이 `transform: translateY(0)`을 가지고 있어 이 스팬이 절대 위치의 기준(containing block)이 된다.
- 가로 중심: Range로 첫/마지막 한자의 실제 rect를 재고, 줄에 걸린 `scale`(active/inactive)을 나눠 워드 스팬 로컬 px로 변환해 `left`에 넣는다. 묶음이 여러 스팬(글자별 richsync)에 걸쳐도 첫~마지막 글자의 중점에 맞춘다.
- 겹침 해소:
  - 읽기가 한자 폭의 1.7배를 넘으면 `scaleX` 압축(하한 0.72).
  - **행(top 값, 허용 6px) 단위로 묶어서** 좌→우로 밀어내고 줄 경계 안으로 되돌린다. 행 구분을 안 하면 배경 보컬(괄호) 행의 후리가나가 본문 행과 겹친다고 오판해 오른쪽으로 밀린다.
- 레이아웃: 후리가나가 있는 줄의 워드에 `margin-top: var(--blyrics-furigana-gap)`(0.75em), 줄은 같은 값만큼 위로 당김.

### 1.5 카라오케 스윕

- 후리가나의 `::after`가 `data-content` 복제본이며 `background-clip: text` 그라디언트가 `--lyric-transition-amount-start/end` 전환으로 지나간다.
- 시간 계산:
  - `--blyrics-furigana-duration`: 그 묶음의 한자가 차지하는 시간. 겹치는 모든 워드 스팬의 `data-duration`을 글자 수 비율로 안분해 합산.
  - `--blyrics-furigana-offset`: 같은 스팬 안에서 그 한자 앞에 있는 글자(히라가나 포함)를 부르는 시간(안분). 딜레이 `calc(var(--blyrics-swipe-delay,0s) + var(--blyrics-furigana-offset,0s))`. 스팬이 통단어(思い出, お願い)일 때 뒤쪽 한자의 읽기가 단어 첫 음절에 함께 켜지는 문제 대응.
  - 되감기/일시정지/재생 상태에서 하이라이트가 남지 않도록 `opacity` 0/1 + 페이드.
- 비활성/활성 불투명도: `--blyrics-furigana-inactive-opacity`(0.5), `--blyrics-furigana-active-opacity`(0.9), 크기 `--blyrics-furigana-font-size`(0.52em), 페이드 `--blyrics-furigana-fade-duration`(0.4s).

### 1.6 AI 후리가나 (선택)

- `furiganaWithLlm(lines, cfg, signal)`: 한자가 있는 줄만, 중복 제거해 한 번에 요청. "부르는 그대로의 읽기, 아테지 포함, 한자에만 읽기" 프롬프트. 응답은 줄별 `[한자, 읽기]` 배열.
- `runsFromLlmPairs`: 순서대로 `indexOf`로 줄 안 위치를 찾고, 표면에 붙은 okurigana는 떼고 읽기 끝에서도 같은 가나를 뗀다. 읽기는 가나만 허용(가타카나 허용).
- `applyLlmFurigana`: 기존 후리가나와 읽기 목록이 같으면 아무것도 안 함(깜빡임 없음). 다르면 기존 요소를 지우고 새로 붙이고 `.blyrics--furigana-swapped`(0.6초 페이드 인).
- 요청은 배치 요청과 병렬로 일찍 시작하고, 로컬 후리가나를 먼저 붙인 뒤 응답이 오면 교체. LLM 결과가 UtaTen/수동 오버라이드보다 우선.
- 조건: Best 모드 + API 키 + `isLlmFuriganaEnabled`. 임시(placeholder) 가사에서는 호출하지 않는다.
- 캐시: 곡 단위(`blyrics_llm_translation_cache` 공유, 키에 `furigana` 접두).

### 1.7 UtaTen 소스 (프로토타입, `utatenFurigana.ts`)

> **v2.4.0.9 이식에서는 제외하기로 결정했다**(이식 계획의 확정 결정 3). 이 브랜치(`my-changes`)에는 그대로 남아 있다.

- `furiganaSource === "utaten"`일 때 곡 단위로 1회 크롤링.
  - 검색: `https://utaten.com/lyric/search?artist_name=…&title=…&sort=popular_sort_asc`. 제목이 정규화 후 일치하는 링크 우선, 없으면 첫 결과.
  - 파싱: `.lyricBody .hiragana` 안의 `.ruby > .rb/.rt`. 곡 전체의 (단어, 읽기)를 평탄화한 오버라이드 표로 변환(줄 정렬은 하지 않음).
  - 캐시: `blyrics_utaten_furigana_cache`(40곡). 검색 실패도 빈 배열로 캐시.
- `manifest.json`의 `host_permissions`에 `https://utaten.com/*` 필요.
- 한계: 같은 단어를 곡 안에서 다르게 읽는 경우 첫 항목만 유지. 제3자 사이트 스크래핑이라 약관/차단 위험이 있다.

## 2. LLM 번역 ("Best" 모드, `llmTranslation.ts`)

### 2.1 동작

1. Google 번역(또는 제공처 번역)을 먼저 화면에 붙인다.
2. 곡 전체를 한 번에 LLM에 보내 문맥 번역을 받고, 공식 번역이 없는 줄에 한해 제자리 교체(`upsertTranslation`).
3. 2차 수정 패스(선택, 기본 켜짐): 원문+1차 번역 짝을 보내 구어체로 고쳐 쓰게 한 뒤 다시 교체.
4. 어느 단계든 실패하면 앞 단계 결과가 그대로 남는다(화면 표시 없음, 콘솔에만 기록).

### 2.2 설정과 저장

| 항목 | 저장소 | 키 |
| --- | --- | --- |
| 번역 품질 fast/best | sync | `translationQuality` |
| 제공사 | sync | `llmProvider` (`openai`/`anthropic`/`gemini`) |
| 모델(비우면 기본) | sync | `llmModel` |
| 커스텀 프롬프트(적용값) | sync | `llmCustomPrompt` (최대 2000자) |
| AI 후리가나 | sync | `isLlmFuriganaEnabled` (기본 true) |
| 2차 수정 패스 | sync | `isLlmRevisionEnabled` (기본 true) |
| **API 키** | **local** | `llmApiKey` (구 이름 `blyrics_llm_api_key`는 로드 시 이전) |
| 곡 캐시 | local | `blyrics_llm_translation_cache` (최대 300항목, 오래된 순 삭제) |

- 기본 모델: openai `gpt-4o-mini`, anthropic `claude-haiku-4-5-20251001`, gemini `gemini-3.5-flash-lite`.
- API 키를 `blyrics_` 접두어로 저장하면 안 된다. `clearCache()`와 CSS 에디터의 공간 부족 정리가 `blyrics_*`를 전부 지워서 키가 사라졌다. 키 이름은 접두어 없이 유지한다.
- 호출은 콘텐츠 스크립트에서 직접 `fetch`한다. `manifest.json`의 `host_permissions`에 `api.openai.com`, `api.anthropic.com`, `generativelanguage.googleapis.com`이 필요하다(Anthropic은 `anthropic-dangerous-direct-browser-access: true` 헤더).

### 2.3 프롬프트 프로토콜

- 요청: `{"lines":[{"id":0,"text":"…"},…]}` / 응답: `{"lines":[{"id":0,"text":"…"},…]}`. **id로 줄을 맞춘다.** 모델이 줄을 합치거나 빠뜨려도 그 줄만 실패하고 곡 전체가 실패하지 않는다.
- `parseIndexedLines`: JSON 실패나 잘림 시 완성된 `{"id":N,"text":"…"}` 항목만 정규식으로 살린다. 정확한 길이의 순수 문자열 배열은 구형식으로 허용.
- 누락 줄 재요청: 글자/숫자가 있는 줄 중 비어 있는 것만 모아 1회 재요청. 완전한 결과만 캐시하고 부분 결과는 다음 재생 때 재시도.
- 커스텀 프롬프트는 시스템 프롬프트 뒤에 "사용자 추가 지시"로 붙고, 2차 수정 프롬프트에도 붙는다. 후리가나 프롬프트에는 붙지 않는다.
- 캐시 키: 제공사, 모델, 대상 언어, 커스텀 프롬프트, 줄 목록(수정 패스는 초안까지). 프롬프트를 바꾸면 자동으로 다시 번역한다.
- 내장 시스템 프롬프트에 "Translate for meaning and singability"가 남아 있다(번안 요소를 뺀 커스텀 프롬프트와 어긋남. 필요하면 제거).

### 2.4 2차 수정 패스

- 목적: 독백/시적 표현이 많은 가사에서 나오는 문어체(~이다/~한다/~하다)와 기본형 연결(동사 원형으로 구절 이음)을 구어체로 교정. 한 곡 안에서 말투 단계(반말/~요)를 통일하고 어미는 다양하게.
- 원문이 진짜 문어체인 곡에서는 과교정할 수 있어 토글로 끌 수 있다.

### 2.5 커스텀 프롬프트 UI

- 입력칸 + **Apply / Reset** + 상태 표시(`Default prompt` / `Applied` / `Not applied yet`).
- 저장되는 값은 **마지막으로 Apply한 값**뿐이다(`appliedCustomPrompt`). 입력만 하고 Apply하지 않은 초안이나 다른 설정 변경이 저장값에 섞이지 않는다. 이전에는 textarea의 `change` 이벤트(포커스 아웃)에만 저장돼서 팝업이 닫히면 내용이 사라졌다.

### 2.6 임시 가사

- 임시(YT Music) 가사가 먼저 붙었다가 동기화 가사로 교체되는 곡에서는 LLM 호출(번역, 수정, 후리가나)을 건너뛴다(`isTemporary` = `keepLoaderVisible`). 무료 한도 낭비 방지. Google 번역과 로컬 후리가나는 임시 단계에서도 돈다.

## 3. Google 번역 개선 (`translation.ts`)

- 배치 결합자를 `\n\n;\n\n` → 줄바꿈으로 변경하고 응답을 줄 단위로 분리. 개수가 안 맞으면 번들 전체 재시도 대신 **줄별 재시도**(앞뒤 줄을 문맥으로 붙여 3줄로 보내고 가운데만 취함).
- `neighbors`(앞/뒤 줄) 전달.
- `normalizeCacheKey`: 대소문자, 따옴표/괄호, 끝 구두점 무시(후렴 일관성).
- 곡 언어를 `sl`로 명시 전달(`TRANSLATE_LYRICS_URL(lang, text, sourceLang)`)하고, `en-US` 같은 지역 코드는 `en`으로 줄여서 보낸다(`toGoogleSourceLanguage`, 중국어 `zh-CN`/`zh-TW`는 유지). 지역 코드를 그대로 보내면 요청이 실패해 곡 전체가 번역되지 않았다.
- `commitTranslation`: 원문과 같은 결과는 버린다.
- 알려진 문제: `cacheKeyFor`에 리터럴 NUL 문자(`\x00`)가 구분자로 들어 있어 git이 파일을 바이너리로 취급한다(병합 시 텍스트 병합 불가). 이식 전에 `String.fromCharCode(0)` 또는 다른 구분자로 바꿀 것.

## 4. 로마자/언어 게이팅

- 가사 언어가 **번역 대상 언어(= 기본 언어)** 와 같으면 일반 로마자를 붙이지 않는다(설정은 꺼지지 않음). 후리가나 경로는 이 조건의 영향을 받지 않는다(`isDefaultLanguage`).
- 영어 곡을 걸러내는 로직은 없다. 번역 제외 언어(`translationDisabledLanguages`)에 `en`이 들어 있으면 그 곡은 번역을 통째로 건너뛴다.

## 5. 시크(seek)와 복사 (`lineInteractions.ts`)

### 5.1 동작

- **왼쪽 거터 바로만 시크.** 줄의 텍스트 왼쪽 가장자리에 걸린 약 1.5rem 폭의 영역을 호버하면 세로 바가 나타나고, 그 영역을 클릭해야 시크된다.
- 나머지 영역은 텍스트 선택용: 드래그로 선택하고 마우스를 놓으면 **선택한 가사가 클립보드에 복사**되고 "Copied" 토스트(`.blyrics--copied-toast`, 로케일 `lyrics_copied`)가 뜬다. 복사에서는 읽기 보조(줄바꿈 요소, 로마자, 번역, 후리가나, 숨김 요소)를 제외한다. 복사 후 선택을 해제한다.
- **더블클릭은 줄 어디서든 시크**하고, 더블클릭이 만든 단어 선택은 즉시 지운다. 더블클릭은 복사를 건너뛴다(`event.detail >= 2`).
- 동기화가 없는 가사는 `data-no-seek="true"`로 거터가 없다. 간주(instrumental) 행은 통째로 클릭 대상.
- 선택이 있는 상태에서는 클릭 시크를 하지 않는다(`hasActiveTextSelection`).

### 5.2 히트 판정 `isInSeekGutter(line, clientX)`

- 거터 폭은 `::before`의 계산된 폭(`--blyrics-seek-gutter-width`). 줄의 `scale`을 곱해 실제 px로 환산.
- 텍스트의 실제 시작/끝은 **본문 단어만** 재서 구한다(로마자/번역 행의 `.blyrics--word`는 제외).
- 오른쪽 정렬 줄(`data-agent` v2/v3, RTL)은 텍스트 오른쪽 가장자리에 바가 붙는다.
- 호버 중에는 단어가 거터 폭만큼 밀려나 있으므로 그만큼 되돌려서 판정 영역이 바와 어긋나지 않게 한다.
- **히스테리시스**: 이미 호버 중인 줄은 판정 영역을 1.6배(`SEEK_HOVER_WIDEN_FACTOR`)로 넓힌다. 살짝 흔들려도 바가 깜빡이지 않는다.

### 5.3 CSS 구조 (`lyrics.css`)

- `.blyrics--line::before`가 flex 아이템으로 바 역할을 한다. `margin-inline-end: calc(1px - gutter)`로 폭을 거의 상쇄하되 **1px는 남겨서**, 로마자 위 줄바꿈 행에 이 요소가 얹히지 않고 텍스트 행으로 내려오게 한다.
- 왼쪽 정렬은 `order: 0`, 오른쪽 정렬은 `order: 1`과 반대쪽 마진.
- 호버 시 `> *`(단어, 번역 등)에 `translate: var(--blyrics-seek-gutter-width)`(오른쪽 정렬은 반대 방향)를 줘서 바가 들어갈 자리를 만든다.
- 후리가나가 있는 줄은 바에 `margin-top: var(--blyrics-furigana-gap)`로 한자 높이에 맞춘다.
- 변수: `--blyrics-seek-gutter-width`(1.5rem), `-bar-width`, `-bar-opacity`, `-transition-duration`, `-transition-easing`.

## 6. 표시/스크롤 설정

| 기능 | 동작 | 위치 |
| --- | --- | --- |
| 싱크 없는 가사 밝게 | `.blyrics-container[data-sync="none"]`에서 비활성 색/번역/후리가나 불투명도 변수를 활성 값으로 덮어씀 | `lyrics.css` |
| 자동 스크롤이 끝에서 안 돌아감 | passive scroll을 선형 스크롤 후 맨 아래 유지로 변경. 순환(맨 위로 되감기)과 3개 테마 설정(`bottom-pause`, `reset-duration`, `top-pause`) 제거 | `animationEngine.ts` |
| 앨범 커버 크기 슬라이더 | `albumArtSize`(sync, 300–1400, 기본 800). `--blyrics-album-art-size`를 `:root`에 설정하고 `ytmusic-player-page … #player`의 `max-width`가 사용 | `settings.ts`(`loadAlbumArtSizeSetting`), `options.*`, `general.css`, `variables.css` |
| 번역 밝기 | 비활성 줄의 번역은 어둡게(`--blyrics-translated-inactive-opacity` 0.45), 활성 줄에서 서서히 밝아짐(`--blyrics-translated-fade-duration` 1.1s) | `lyrics.css`, `variables.css` |

## 7. 옵션 UI

### 7.1 Language 탭 추가 항목

- Furigana source(`furiganaSource`: local / utaten)
- Translation quality(fast / best) → best일 때만 보이는 블록(`#llmConfig`): AI provider, API key(password), Model, Second AI pass 체크박스, AI furigana 체크박스, 번역 프롬프트 + Apply/Reset/상태.

### 7.2 Display 탭 추가 항목

- Album art size 슬라이더 + 실시간 값 표시.

### 7.3 저장/복원 규약과 함정

- 모든 `#options input, #options select`는 `change` → `saveOptions()`에 자동 연결된다.
- **`restoreOptions()`의 로컬 `defaultOptions` 리터럴에 새 키를 반드시 추가해야 한다.** 읽을 키 목록(`readKeys`)이 이 리터럴에서 만들어져서, 빠지면 저장은 되는데 로드 때 기본값으로 돌아간다(과거에 세 번 발생).
- API 키는 옵션 객체에 넣지 않고 `chrome.storage.local`에 따로 저장하며, 변경 시 열린 탭에 `updateSettings`를 보내 재실행시킨다.
- 커스텀 프롬프트는 5.의 "적용값" 규약을 따른다.
- 콘텐츠 스크립트는 `updateSettings` 메시지를 받으면 `chrome.storage.sync`에서 다시 읽는다(`request.settings`는 사용하지 않음). 새 설정은 `loadTranslationSettings()`(번역/LLM/후리가나 관련)나 전용 로더에 추가해야 한다.

## 8. 빌드/패키징

- 의존성: `kuroshiro`, `kuroshiro-analyzer-kuromoji`.
- kuromoji는 Node용 패키지라 `extension.config`의 webpack `resolve.fallback`에서 `path` → `tooling/path-shim.cjs`, `fs`/`zlib` → `false`로 대체한다. path 심은 `chrome-extension://…/dict/` URL의 `//`를 망가뜨리지 않도록 직접 결합한다.
- 사전은 `public/dict/*.dat.gz`(12개, 17MB)를 그대로 커밋해서 `chrome.runtime.getURL("dict/")`로 읽는다. `manifest.json`의 `web_accessible_resources`에 `dict/*.dat.gz` 추가.
- 정적 임포트(`import Kuroshiro from "kuroshiro"`)를 쓴다. 동적 `import()`는 webpack `publicPath` 문제로 `ChunkLoadError`가 났다.

## 9. 알려진 이슈와 메모

- 서로 다른 단어의 한자가 붙어 있으면(예: 声+聞こえ) 읽기는 맞지만 후리가나가 한 묶음으로 표시된다(외형만).
- 스윕 시간 안분은 글자 수 균등 가정이라 실제 발음 길이와 어긋날 수 있다.
- 무료 등급 한도: 곡당 최대 3회 호출(번역, 수정, 후리가나). 429/모델 오류는 조용히 폴백돼서 원인이 화면에 안 보인다.
- 2차 수정 패스는 원문이 문어체인 곡에서 과교정할 수 있다.
- `translation.ts`의 NUL 구분자(3.의 알려진 문제).
