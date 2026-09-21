# v2.4.0.9 이식 계획

기능 명세는 [FORK_FEATURES.md](FORK_FEATURES.md). 이 문서는 그 기능을 업스트림 `v2.4.0.9` 위로 옮기는 계획이다.

## 1. 결론부터

- **`git merge v2.4.0.9`로는 옮길 수 없다.** 병합을 시도해 보니 충돌 13개 중 5개가 "원본은 삭제, 내 쪽은 수정"이고, `translation.ts`는 NUL 문자 때문에 바이너리로 취급되며, `injectLyrics.ts`는 178줄짜리 충돌이 있다. 업스트림이 렌더러를 통째로 갈아엎었기 때문이다.
- **v2.4.0.9를 기준으로 새 브랜치(`port/2.4.0.9`)를 만들고, 기능을 하나씩 다시 얹는다.** 기존 `my-changes`(v2.3.3 계열)는 참조용으로 그대로 둔다.
- **업스트림 파일 수정은 최소화하고, 내 코드는 새 파일에 모은 뒤 "얇은 훅"으로만 연결한다.** 다음 업데이트 때 충돌이 거의 나지 않게 하는 것이 이번 이식의 두 번째 목표다.

## 2. 업스트림에서 바뀐 것 (조사 결과)

기준: `v2.3.3`(`eec3fbd`) → `v2.4.0.9`. 184개 파일, +18,665 / -12,326줄.

### 2.1 렌더러가 외부 패키지로 이동
- 가사 줄/단어 DOM 생성, 애니메이션 엔진, 자동 스크롤, 시크 처리, 가사 CSS가 npm 패키지 **`@braccato/core`(v2.4.0.9에서 1.6.4, MIT)** 로 옮겨졌다. 파서는 `@braccato/parsers`(0.2.2).
- 사라진 파일: `src/modules/ui/animationEngine.ts`, `src/modules/settings/themeOptions.ts`, `createInstrumentalElement.ts`, `instrumentalBreaks.ts`, `public/css/blyrics/{lyrics,variables,instrumental}.css`, `extension.config.cjs`(→ `extension.config.js`).
- 연결 계층: `src/modules/ui/mainLyricsView.ts`(`createLyricsRenderer`로 만든 `mainView`), `src/modules/ui/lyricsHost.ts`(`LyricsRendererHost` 구현: 보임 여부, 스크롤 요소, `seek`, 로그).
- 패키지의 스타일은 `extension.config.js`가 빌드 시 `public/...`로 내보낸다(`lyrics.css`, `variables.css`, `instrumental.css`).

### 2.2 새 DOM 구조 (`@braccato/core` 1.6.4 기준, 코드에서 확인한 것)
- 클래스 이름은 대부분 그대로다: `blyrics--line`, `blyrics--word`, `blyrics--translated`, `blyrics--romanized`, `blyrics--active`, `blyrics--animating`, `blyrics-rtl` 등.
- 새로 생긴 구조: `blyrics-content-line`, `blyrics-line-main`, `blyrics-background-line`, `blyrics-word-group`(+ `-long`), **`blyrics-word-highlight`(하이라이트 전용 별도 요소)**, `blyrics--letter`(글자 단위 스팬), `blyrics-highlight-run`, `blyrics-bidi-*`.
- **하이라이트가 `::after` 복제에서 별도 요소로 바뀌었다.** 하이라이트 요소는 `blyrics--word blyrics-word-highlight` 두 클래스를 가진다. 그래서 `querySelectorAll(".blyrics--word")`가 원문 단어와 하이라이트 요소를 둘 다 돌려준다.
- 하이라이트는 Web Animations API로 구동된다(`highlight.animate(gradient keyframes)`, `--lyric-transition-amount-start/end`를 keyframe으로). 예전의 `.blyrics--animating` + `--blyrics-swipe-delay`/`--blyrics-anim-delay` CSS 전환 방식은 가사 단어에는 더 이상 쓰이지 않는다(패키지 전체 검색에서 `swipe-delay`/`anim-delay`는 `styles/instrumental.css`에만 남아 있다).
- `LineData`: `lyricElement`, `parts: PartData[]`(각 `lyricElement`, `highlightElement`, `time`, `duration`, `letterElements?`, `animations`), `decorations: Map<HTMLElement, number>` 등. 이 `decorations` 맵의 의미는 아직 모른다(스파이크 D).
- 시크: 코어의 `addSeekHandler(seek, lyricElement, allZero)`가 줄 클릭을 처리한다(`Alt`+클릭은 richsync에서 단어 시각으로 시크). 컨테이너의 `data-sync`(`richsync` 등)를 읽는다.
- 자동 스크롤(passive): 코어 `engine.js`에 남아 있고, **맨 아래에서 멈춘 뒤 맨 위로 되감기는 순환이 그대로 있다**(`bottom-pause`, `reset-duration`, `top-pause`).
- 테마 설정(`registerThemeSetting`)은 컴파일된 CSS의 주석 속 `blyrics-키 = 값;` 형태로 들어온다(`themeSettings.js`의 `parseThemeConfig`).

### 2.3 업스트림 쪽 다른 큰 변화
- Picture-in-Picture 가사 뷰 신설(`src/modules/ui/pictureInPicture/*`). PiP는 자기 문서에 줄을 새로 만들고, 번역/로마자는 `AppState.lyricDecorations`(줄 인덱스 → `{romanization, timedRomanization, translation}`)를 통해 받는다.
- `src/modules/ui/playerControls/*`, `lyricsHost.ts`, `nativeLyricsFocus.ts`, `resumeScrollButton.ts`, 로거(`@core/logger`의 `logCore`), 폰트 자체 호스팅, 셀프체크 테스트 체계(`tooling/run-selfchecks.ts`, `*.selfcheck.ts`).

### 2.4 그대로 살아 있는 것 (이식이 쉬운 이유)
- `src/modules/lyrics/injectLyrics.ts`에 **`processBatchTranslationsAndRomanizations(doc, data, lines, isStale, signal)`가 같은 이름과 구조로 남아 있다.** `lines`는 `mainView.lines`(코어의 `LineData[]`)이고, `injectTranslation`/`injectRomanization`은 코어에서 임포트한다. 내가 v2.3.3에서 고친 위치와 1:1로 대응된다.
- `translation.ts`(378줄), `settings.ts`, `options.ts`, `appState.ts`, `constants.ts`, `manifest.json`은 구조가 비슷해 수작업 3-way 병합이 가능하다.

## 3. 이식 전략

### 3.1 원칙
1. **새 파일 = 그대로 복사** (충돌이 없다): `furigana.ts`, `llmTranslation.ts`, `utatenFurigana.ts`, `lineInteractions.ts`(어댑팅 필요), `tooling/path-shim.cjs`, `public/dict/`.
2. **업스트림 파일 수정 = 훅 호출만.** 큰 로직은 새 모듈(`src/modules/lyrics/forkEnhancements.ts` 등)에 두고 `injectLyrics.ts`에는 호출 수십 줄만 넣는다.
3. **CSS는 코어 스타일을 고치지 않고 우리 스타일시트를 추가한다.** 코어의 `lyrics.css`/`variables.css`는 패키지 파일이므로 수정 대상이 아니다. 새 파일(예: `public/css/blyrics/fork.css`)을 `index.css`의 임포트 목록에 추가하고, 변수 기본값도 거기서 정의한다.
4. **옵션 UI는 가능하면 JS로 생성**해서 `options.html` 충돌을 피한다. 단, `#options` 안에 붙어야 기존의 `change` → 저장 자동 연결이 동작한다. 저장/복원 규약(FORK_FEATURES 7.3)은 그대로 지킨다.
5. **패키지를 고쳐야 하는 경우의 순서**: (a) 설정/공개 API로 해결 → (b) 우리 쪽 오버레이(캡처 단계 리스너, 추가 CSS, MutationObserver) → (c) `patch-package` → (d) 코어를 저장소에 벤더링(MIT라 가능하지만 업스트림 추종이 어려워지므로 마지막 수단).

### 3.2 브랜치 운용
```
git fetch upstream --tags
git tag fork-v2.3.3 my-changes            # 기존 작업 스냅샷 (참조용)
git checkout -b port/2.4.0.9 v2.4.0.9     # 이식은 새 브랜치에서
```
- 단계마다 커밋하고, 각 단계 끝에서 `npm ci && npm run typecheck && npm run build` + 수동 확인.
- 완료 후 `port/2.4.0.9`를 포크의 기본 브랜치로 삼는다. 이후 업스트림 업데이트는 이 브랜치에 `git merge <태그>`로 반영한다.

## 4. 기능별 이식 계획

난이도: S(수 시간) / M(반나절~하루) / L(며칠, 스파이크 필요).

| # | 기능 | 대응 방식 | 난이도 | 선행 스파이크 |
| --- | --- | --- | --- | --- |
| 1 | 빌드/의존성/사전 | `package.json`에 kuroshiro 계열 추가, 웹팩 `resolve.fallback`을 `extension.config.js`로 이식, `public/dict`, `manifest.json` `host_permissions`/`web_accessible_resources` | S | - |
| 2 | 설정 인프라 | `AppState` 필드, `loadTranslationSettings`, 옵션 UI, `defaultOptions` 규약, `llmApiKey` | M | F |
| 3 | Google 번역 개선(Tier 1) | 업스트림 `translation.ts`에 3-way 병합. **먼저 NUL 문자를 제거** | M | - |
| 4 | LLM 번역 + 수정 패스 + 커스텀 프롬프트 | `llmTranslation.ts` 복사, `injectLyrics.ts` 훅, `upsertTranslation` | M | D |
| 5 | 로마자 게이팅(`songIsJapanese`, `isDefaultLanguage`) | 업스트림의 `trustedLanguage` 로직과 합치기 | S | - |
| 6 | 싱크 없음 밝게 | `fork.css`에 `[data-sync="none"]` 변수 덮어쓰기. 코어가 컨테이너에 `data-sync`를 계속 설정하고(`view.js`), `--blyrics-lyric-inactive-color`/`--blyrics-lyric-active-color`가 코어 `variables.css`에 있음을 확인. `none` 값과 번역/후리가나 변수명만 추가 확인 | S | - |
| 7 | 자동 스크롤 되감기 제거 | 테마 설정 값으로 우회(아래 4.1) → 안 되면 `patch-package` | S~M | C |
| 8 | 앨범 커버 슬라이더 | `general.css`의 `max-width: var(--blyrics-album-art-size, 800px)` 유지, 로더는 그대로 | S | - |
| 9 | 후리가나 렌더링 | 단어 선택자, 글자 스팬, 배치, 겹침 해소 재검증 | **L** | A |
| 10 | 후리가나 스윕 | WAAPI 기반으로 재설계 | **L** | A |
| 11 | 시크 거터/드래그 복사/더블클릭 | 캡처 리스너 + 새 줄 구조에 맞춘 CSS | **L** | B |
| 12 | AI 후리가나 / UtaTen | 9번 위에 얹기 | S | - |
| 13 | 번역 스타일(밝기 페이드) | `fork.css` | S | B |
| 14 | PiP 뷰 지원 | 범위 결정 필요(4.3) | 미정 | E |

### 4.1 자동 스크롤(7): 패치 없이 해결할 후보
코어의 순환은 `bottom-pause`가 지나야 되감기가 시작된다. 테마 설정 `blyrics-passive-scroll-bottom-pause-s`를 아주 큰 값(예: 999999)으로 주면 사실상 맨 아래에서 멈춘다. 설정을 주입하는 공식 경로(컴파일된 CSS 주석 `blyrics-passive-scroll-bottom-pause-s = 999999;`, 또는 코어의 `setThemeSettings`)가 우리 확장에서 쓸 수 있는지 스파이크 C에서 확인한다. 사용자 테마가 이 값을 덮어쓰는 경우의 우선순위도 확인.

### 4.2 후리가나(9, 10)에서 특히 조심할 점
- 워드 스팬 수집이 바뀐다: `.blyrics--word:not(.blyrics-word-highlight)`만 대상으로 해야 원문 텍스트가 두 번 세어지지 않는다. 또한 `PartData.lyricElement`가 있으므로 `mainView.lines[i].parts`를 직접 쓰는 편이 안전하다.
- 글자 단위 스팬(`blyrics--letter`)이 있는 단어는 텍스트 노드가 쪼개져서, `firstChild` 텍스트 노드에 Range를 잡는 기존 `charRect`가 깨진다. 글자 요소 또는 `Range`를 요소 단위로 잡도록 바꿔야 한다.
- 워드가 `blyrics-word-group` 안에 들어가고 하이라이트 요소가 형제로 붙으므로, 후리가나를 붙일 컨테이너(절대 위치 기준)를 다시 정한다. 기존에는 워드 스팬이 `transform`을 가져 기준이 됐다.
- 스윕: 기존 방식(`::after` + `--blyrics-swipe-delay` 전환)은 쓸 수 없다. 후보:
  1. 각 후리가나에 하이라이트 복제 요소를 넣고, 대응하는 단어의 하이라이트 애니메이션(`highlightElement.getAnimations()`)의 타이밍을 읽어 같은 keyframe을 후리가나 몫(시작 오프셋, 안분한 길이)으로 WAAPI 실행.
  2. 엔진이 단어 활성화 시 남기는 상태(클래스 변화나 `LineData.isAnimating`)를 `MutationObserver`로 받아 후리가나 애니메이션을 트리거.
  3. 코어에 후리가나 확장 지점을 만들어 업스트림에 제안(장기).
  스파이크 A에서 1번이 가능한지, 되감기/일시정지/시크 시 상태 동기화가 되는지 먼저 확인한다.
- 줄 레이아웃: v2.3.3에서는 워드에 `margin-top`을 줘서 후리가나 자리를 만들었다. 새 줄 구조(content/main/background 라인)에서 같은 방식이 맞는지 확인.
- `resolveFuriganaLayout`의 행 묶음(top 기준 6px 허용)은 배경 보컬이 새 구조에서 별도 `blyrics-background-line`으로 올 때도 유효한지 재검증.

### 4.3 PiP 뷰(14)
PiP는 자기 문서에 줄을 새로 만들고 `AppState.lyricDecorations`로만 번역/로마자를 받는다. 결정이 필요하다.
- **최소**: 번역만 반영. LLM/수정 패스 결과를 `upsertTranslation`할 때 `lyricDecorations[index].translation`도 함께 갱신(업스트림의 `recordLyricDecoration`은 모듈 비공개라 같은 방식의 기록 코드를 훅에 둔다).
- **후리가나/시크 거터는 PiP 제외**로 시작한다. 메인 뷰 안정화 후 필요하면 확장.

## 5. 단계별 작업 순서와 완료 기준

각 단계의 공통 기준: `npm run typecheck`, `npm run build`(chrome/firefox/edge), `npm run knip`, 관련 자체 점검 통과, 체크리스트 수동 확인.

### Phase 0 — 준비 (S)
- [ ] `my-changes`에서 `translation.ts`의 NUL 구분자를 일반 구분자로 교체하고 커밋(이식 대상 파일을 텍스트로 만든다).
- [ ] `git tag fork-v2.3.3 my-changes`, `git checkout -b port/2.4.0.9 v2.4.0.9`.
- [ ] `npm ci`로 v2.4.0.9가 빌드되는 상태를 먼저 확인(기준선).

### Phase 1 — 스파이크 (M, 코드 변경 없음, 결과는 이 문서에 기록)
- **A. 단어 활성화 훅**: 코어 엔진이 단어 활성화/비활성화를 어떻게 알리는가. 후리가나 스윕 구현안 결정.
- **B. 줄 구조와 시크**: `blyrics--line` 직속 자식 구성, `::before` 바 플렉스 아이템이 새 구조에서 성립하는가, `addSeekHandler`가 언제 리스너를 붙이는가(`allZero` 처리 포함), 캡처 리스너로 가로챌 수 있는가.
- **C. 테마 설정 주입 경로**: 확장이 코어 설정을 직접 바꾸는 공식 방법.
- **D. `decorations` 맵과 `injectTranslation`/`injectRomanization`의 DOM**: 번역 행 요소 구조, 교체 시 처리, `lyricDecorations`와의 관계.
- **E. PiP**: 번역 전달 경로 확인.
- **F. 업스트림 옵션 화면 변경점**: `options.ts`/`options.html`의 Language/Display 탭 구성, 저장/복원 규약이 그대로인지.

### Phase 2 — 비렌더링 기능 (M)
- [ ] 빌드/의존성/사전/`manifest.json`(1), 설정 인프라(2), `translation.ts` 병합(3).
- [ ] `llmTranslation.ts` 복사, `processBatchTranslationsAndRomanizations`에 훅(4), 로마자 게이팅(5), `isTemporary` 처리.
- 완료 기준: Best 모드에서 번역이 Google → LLM → 수정 순으로 교체되고, 실패 시 앞 단계가 유지된다. 설정 화면 재오픈 후 값 유지.

### Phase 3 — 표시 설정 (S~M)
- [ ] `fork.css` 신설(변수 기본값 포함), 싱크 없음 밝게(6), 자동 스크롤(7), 앨범 커버(8), 번역 밝기(13).
- 완료 기준: 싱크 없는 가사 전체가 밝게 보이고 자동 스크롤이 맨 아래에서 유지된다.

### Phase 4 — 후리가나 (L)
- [ ] 스파이크 A 결과대로 렌더링/레이아웃(9) → 스윕(10) 순서. 정적 표시(읽기, 위치)가 먼저 정확한 뒤 스윕을 붙인다.
- [ ] 후리가나 순수 로직은 이전 그대로: `alignKanjiRuns`, `mergeRuns`, `applyOverrides`, 병합 규칙.
- 완료 기준: 6절의 후리가나 회귀 케이스 통과, 배경 보컬/오른쪽 정렬/글자 단위 싱크 곡에서 위치가 맞고 스윕이 단어와 같이 진행된다.

### Phase 5 — 시크/복사 (L)
- [ ] 스파이크 B 결과대로 CSS와 캡처 리스너 구성(11). `isInSeekGutter`의 텍스트 범위 측정에서 새 구조의 본문 단어만 대상으로.
- 완료 기준: 거터에서만 시크, 나머지는 선택/복사, 더블클릭 시크, 히스테리시스, 오른쪽 정렬/RTL/간주 행/싱크 없음 행 동작.

### Phase 6 — 마무리 (S~M)
- [ ] AI 후리가나 + UtaTen(12), PiP 범위 반영(14), 문서 갱신, `README.md` 버전 표기, 셀프체크 추가(6절).

## 6. 검증

### 6.1 셀프체크로 굳힐 회귀 케이스 (v2.3.3 개발 중 실제로 났던 버그)
업스트림은 `tooling/run-selfchecks.ts`와 `*.selfcheck.ts` 체계가 있으므로 순수 함수를 export해서 여기에 넣는다. 아래 표의 예시는 짧은 단어이며 가사 전문이 아니다.

| 케이스 | 기대 |
| --- | --- |
| 두 한자어 사이에 영어 단어(`検証 is 不明瞭`) | 不明瞭에 영어 음절이 새어 들어가지 않음 |
| 괄호로만 이어진 두 한자어(`次元(立体)`) | 立体 = りったい (앞 묶음에 글자를 뺏기지 않음) |
| 물음표로만 이어진 두 한자어(`客観？主観？`) | きゃっかん / しゅかん |
| 장모음(`程遠い`) | ほどとお (う가 아니라 お) |
| 통단어 스팬의 뒤쪽 한자(`思い出`, `お願い`) | 뒤쪽 읽기가 앞 글자를 부른 뒤에 시작 |
| 정적 오버라이드(`相対性`, `空回`, `何度`, `傍に`, `熟れ`) | 표대로 |
| 곡 제목이 영어인 일본어 곡 | 가나가 있으면 일본어로 판정 |
| LLM 응답이 줄을 빠뜨림 / 잘림 / 코드펜스 | `parseIndexedLines`가 가능한 줄만 채우고 누락은 null |
| `en-US` 원문 언어 | Google 요청 `sl`이 `en` |

### 6.2 수동 체크리스트 (브라우저)
- 일본어 곡: 후리가나 위치/읽기/스윕, 배경 보컬(괄호) 행, 긴 줄 줄바꿈, 오른쪽 정렬(듀엣), 싱크 없음, richsync/글자 단위 싱크.
- 번역: Google → LLM → 수정 교체, API 키 없음/오류/한도 초과 시 폴백, 커스텀 프롬프트 Apply/Reset 유지.
- 영어 곡 번역, 번역 제외 언어 설정.
- 설정: 확장 새로고침 후 API 키/프롬프트/슬라이더/후리가나 소스 유지.
- 거터 시크, 드래그 복사 + 토스트, 더블클릭 시크, 간주 행, 싱크 없음 행.

## 7. 위험과 대응

| 위험 | 영향 | 대응 |
| --- | --- | --- |
| 코어가 확장 지점을 제공하지 않아 후리가나/시크를 오버레이로 못 함 | 9~11 지연 | 스파이크 A/B에서 조기 판단. `patch-package` → 벤더링 순으로 후퇴 |
| 코어 버전이 올라가면 내부 DOM이 다시 바뀜 | 후리가나/거터 깨짐 | 코어에 의존하는 선택자를 한 파일에 모으고, 셀프체크로 DOM 가정을 검사 |
| 사용자가 직접 확인해야 하는 항목 다수(브라우저 필수) | 일정 지연 | 단계마다 체크리스트를 짧게 나눠 전달 |
| 17MB 사전 커밋으로 저장소 비대 | 클론 시간 | 이미 커밋됨. 필요하면 릴리스 자산/빌드 시 다운로드로 전환 검토 |
| UtaTen 스크래핑의 약관/차단 | 법적/운영 | 옵트인 유지, README에 명시, 삭제 가능하도록 분리 |
| 업스트림이 내가 만든 기능과 같은 것을 추가 | 중복 | 이식 시점에 기능 목록을 다시 대조하고 겹치는 것은 업스트림 것을 채택 |

## 8. 사용자 결정이 필요한 것
1. PiP 뷰에서 후리가나/번역을 지원할 것인가(4.3).
2. 코어를 패치/벤더링하는 것까지 허용할 것인가, 오버레이로만 갈 것인가.
3. UtaTen 프로토타입과 17MB 사전을 그대로 유지할 것인가.
4. 이식 완료 후 `my-changes`를 보존할지, `port/2.4.0.9`로 대체할지.
