# v2.4.0.9 이식 계획

기능 명세는 [FORK_FEATURES.md](FORK_FEATURES.md). 이 문서는 그 기능을 업스트림 `v2.4.0.9` 위로 옮기는 계획이다.

## 1. 결론부터

- **`git merge v2.4.0.9`로는 옮길 수 없다.** 병합을 시도해 보니 충돌 13개 중 5개가 "원본은 삭제, 내 쪽은 수정"이고, `translation.ts`는 NUL 문자 때문에 바이너리로 취급되며, `injectLyrics.ts`는 178줄짜리 충돌이 있다. 업스트림이 렌더러를 통째로 갈아엎었기 때문이다.
- **v2.4.0.9를 기준으로 새 브랜치(`port/2.4.0.9`)를 만들고, 기능을 하나씩 다시 얹는다.** 기존 `my-changes`(v2.3.3 계열)는 참조용으로 그대로 둔다.
- **업스트림 파일 수정은 최소화하고, 내 코드는 새 파일에 모은 뒤 "얇은 훅"으로만 연결한다.** 다음 업데이트 때 충돌이 거의 나지 않게 하는 것이 이번 이식의 두 번째 목표다.

### 확정된 결정 (사용자 결정)

| # | 질문 | 결정 | 계획에 미치는 영향 |
| --- | --- | --- | --- |
| 1 | PiP 뷰 지원 | **지원한다** | 후리가나, 번역(교체 포함), 시크/복사를 PiP 창에서도 동작시킨다. 4.3, Phase 6 참고 |
| 2 | 코어 패치/벤더링 | **허용하지 않는다** | `patch-package`와 코어 벤더링은 후퇴 수단에서 제외. 오버레이(추가 CSS, 캡처 리스너, MutationObserver, 우리 쪽 훅)만 쓴다. 코어에 없는 것은 우리 쪽에서 구현하거나 기능 범위를 줄인다 |
| 3 | UtaTen | **제거한다** (17MB 사전은 유지) | `utatenFurigana.ts`, `furiganaSource` 설정/UI, `utaten.com` 호스트 권한, 곡별 오버라이드 훅(`setSongFuriganaOverrides`)을 이식하지 않는다 |
| 4 | `my-changes` | **보존한다** | 이식은 `port/2.4.0.9`에서만 하고 `my-changes`는 수정하지 않는다 (`fork-v2.3.3` 태그도 만든다) |

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

1. **새 파일 = 그대로 복사** (충돌이 없다): `furigana.ts`, `llmTranslation.ts`, `lineInteractions.ts`(어댑팅 필요, `Document`를 인자로 받도록). `utatenFurigana.ts`는 복사하지 않는다(확정 결정 3), `tooling/path-shim.cjs`, `public/dict/`.
2. **업스트림 파일 수정 = 훅 호출만.** 큰 로직은 새 모듈(`src/modules/lyrics/forkEnhancements.ts` 등)에 두고 `injectLyrics.ts`에는 호출 수십 줄만 넣는다.
3. **CSS는 코어 스타일을 고치지 않고 우리 스타일시트를 추가한다.** 코어의 `lyrics.css`/`variables.css`는 패키지 파일이므로 수정 대상이 아니다. 새 파일(예: `public/css/blyrics/fork.css`)을 `index.css`의 임포트 목록에 추가하고, 변수 기본값도 거기서 정의한다.
4. **옵션 UI는 가능하면 JS로 생성**해서 `options.html` 충돌을 피한다. 단, `#options` 안에 붙어야 기존의 `change` → 저장 자동 연결이 동작한다. 저장/복원 규약(FORK_FEATURES 7.3)은 그대로 지킨다.
5. **코어(`@braccato/core`)는 수정하지 않는다** (확정 결정 2). 코어 동작을 바꿔야 할 때의 순서는 (a) 설정/공개 API/테마 설정으로 해결 → (b) 우리 쪽 오버레이(추가 CSS, 캡처 단계 리스너, MutationObserver, 우리가 만든 훅) → (c) 그래도 안 되면 그 기능의 범위를 줄이거나 포기하고 사용자와 상의한다. `patch-package`와 벤더링은 쓰지 않는다.
6. **PiP 창에서도 돌아야 하는 코드는 "세계 무관(world-agnostic)"으로 쓴다.** PiP 호스트는 Firefox에서 페이지(MAIN) 월드에서 돌아 `chrome.*`와 ISOLATED 월드의 모듈 싱글톤(`AppState` 등)에 접근할 수 없다. 그래서 (i) 무거운 계산(kuromoji, LLM, 번역)은 ISOLATED 월드에서 하고 결과는 **데이터**로 넘기며, (ii) 화면에 붙이는 코드(후리가나 DOM, 시크/복사 리스너)는 `Document`를 인자로 받는 순수 DOM 함수로 분리한다.

### 3.2 브랜치 운용

```bash
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
| 3 | Google 번역 개선(Tier 1) | 업스트림 `translation.ts`에 3-way 병합. **파일을 가져올 때 NUL 문자를 일반 구분자로 바꾼다** (`my-changes`는 수정하지 않는다) | M | - |
| 4 | LLM 번역 + 수정 패스 + 커스텀 프롬프트 | `llmTranslation.ts` 복사, `injectLyrics.ts` 훅, `upsertTranslation` | M | D |
| 5 | 로마자 게이팅(`songIsJapanese`, `isDefaultLanguage`) | 업스트림의 `trustedLanguage` 로직과 합치기 | S | - |
| 6 | 싱크 없음 밝게 | `fork.css`에 `[data-sync="none"]` 변수 덮어쓰기. 코어가 컨테이너에 `data-sync`를 계속 설정하고(`view.js`), `--blyrics-lyric-inactive-color`/`--blyrics-lyric-active-color`가 코어 `variables.css`에 있음을 확인. `none` 값과 번역/후리가나 변수명만 추가 확인 | S | - |
| 7 | 자동 스크롤 되감기 제거 | 테마 설정 값으로 우회(아래 4.1) → 안 되면 코어의 passive scroll을 끄고 우리 쪽 스크롤 루프로 대체. 메인 뷰와 PiP 모두 | S~M | C |
| 8 | 앨범 커버 슬라이더 | `general.css`의 `max-width: var(--blyrics-album-art-size, 800px)` 유지, 로더는 그대로 | S | - |
| 9 | 후리가나 렌더링 | 단어 선택자, 글자 스팬, 배치, 겹침 해소 재검증 | **L** | A |
| 10 | 후리가나 스윕 | WAAPI 기반으로 재설계 | **L** | A |
| 11 | 시크 거터/드래그 복사/더블클릭 | 캡처 리스너 + 새 줄 구조에 맞춘 CSS | **L** | B |
| 12 | AI 후리가나 (UtaTen은 제외: 확정 결정 3) | 9번 위에 얹기. UtaTen 파일/설정/권한/`setSongFuriganaOverrides` 훅은 이식하지 않는다 | S | - |
| 13 | 번역 스타일(밝기 페이드) | `fork.css` | S | B |
| 14 | PiP 뷰 지원 (확정 결정 1) | 후리가나, 번역 교체, 시크/복사를 PiP 창에서도 동작. 데이터는 `lyricDecorations`로 전달하고 화면 반영은 세계 무관 함수로(4.3) | **L** | E |

### 4.1 자동 스크롤(7): 패치 없이 해결할 후보

코어의 순환은 `bottom-pause`가 지나야 되감기가 시작된다. 테마 설정 `blyrics-passive-scroll-bottom-pause-s`를 아주 큰 값(예: 999999)으로 주면 사실상 맨 아래에서 멈춘다. 설정을 주입하는 공식 경로(컴파일된 CSS 주석 `blyrics-passive-scroll-bottom-pause-s = 999999;`, 또는 코어의 `setThemeSettings`)가 우리 확장에서 쓸 수 있는지 스파이크 C에서 확인한다. 사용자 테마가 이 값을 덮어쓰는 경우의 우선순위도 확인.

**대체안 (코어를 건드리지 않는 범위)**: 테마 설정 경로가 막히면 `currentTickOptions`가 넘기는 `passiveScrollEnabled`를 `false`로 주어 코어의 passive scroll을 끄고, 싱크 없는 가사일 때만 도는 우리 쪽 스크롤 루프(선형 스크롤 후 맨 아래 유지)를 둔다. PiP는 자기 스크롤 요소(`view.scrollElement`)와 자기 틱을 가지므로 PiP용 호출 지점도 따로 찾아야 한다. 한편 테마 설정은 각 창이 `renderer.setTheme(css)`로 받은 테마 CSS의 주석에서 읽으므로(`pipHost.ts`의 `mirrorOpenerStyles`), 설정 값을 테마 CSS 스트림에 실을 수 있으면 메인과 PiP에 한 번에 적용된다.

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

### 4.3 PiP 뷰(14, 지원하기로 확정)

**조사한 PiP 구조** (`src/modules/ui/pictureInPicture/*`, 코드에서 확인)
- PiP 창은 자기 문서에 **자체 렌더러**를 만든다(`pipHost.ts`의 `createLyricsRenderer`, 메인 뷰와 별개 인스턴스). 가사는 `publishPictureInPictureLyrics()` → `sendLyrics()`(bridge)로 `Lyric[]`, `decorations`(`AppState.lyricDecorations`: 줄 인덱스 → `{romanization, timedRomanization, translation}`), 오프셋을 받는다.
- `buildLyrics()`가 `renderer.setLyrics(...)`로 DOM을 만든 뒤 **`applyDecorations()`를 빌드마다 실행**한다. 이 함수가 코어의 `injectRomanization`/`injectTranslation`을 줄마다 호출하는데, 두 함수는 **이미 번역/로마자가 붙은 줄에는 아무것도 하지 않는다.** 즉 PiP에서는 메인 뷰처럼 "붙어 있는 번역 위에 덮어쓰기(upsert)"가 자동으로 되지 않는다.
- PiP 창의 스타일은 열 때 오프너의 테마 CSS(`renderer.setTheme(css)`), 효과 끄기 시트, 코어 가사 스타일시트/폰트 URL(`stylesheetUrls()`)을 미러링한다. **우리의 `fork.css`는 이 목록에 없으므로 PiP에 자동 적용되지 않는다.**
- Firefox에서는 이 호스트가 페이지(MAIN) 월드에서 돌아 `chrome.*`와 ISOLATED 월드의 모듈 상태에 접근할 수 없다(`mainWorldHost.ts`, `types.ts`의 설명).

**기능별 PiP 대응**

| 기능 | PiP 대응 | 메모 |
| --- | --- | --- |
| 번역(Google → LLM → 수정 교체) | `upsertTranslation` 시 `lyricDecorations[index].translation`을 갱신하고 `publishPictureInPictureLyrics()`를 호출한다. PiP 쪽은 `applyDecorations()`에 우리 훅을 걸어 **기존 번역 요소의 텍스트를 교체**하는 세계 무관 함수를 호출한다 | `recordLyricDecoration`은 모듈 비공개라 우리 쪽 기록 코드를 훅에 둔다 |
| 후리가나 | 읽기 계산은 ISOLATED에서 한다. 결과(`{start, end, reading}` 목록)를 `LyricLineDecoration.furigana`에 실어 bridge로 넘긴다. PiP에서 `attachFuriganaRuns(doc, line, text, runs)`(순수 DOM, `doc.defaultView`의 `Range`/`Node` 사용)로 붙인다 | `bridge.ts` 페이로드 타입 확장 필요. LLM 교체도 같은 데이터 경로 |
| 후리가나 스윕 | 메인과 같은 방식(스파이크 A 결과)을 세계 무관으로 구현. 창마다 자기 엔진의 애니메이션 타이밍을 읽는다 | 창 전용 전역 상태 금지 |
| 시크 거터/드래그 복사/더블클릭 | `installLineInteractions(container, { doc, seek, t })`로 분리해서 메인과 PiP에서 각각 설치한다. PiP는 `host.seek`(= `SEEK_EVENT` 디스패치)를 넘긴다 | PiP는 `Document`가 다르므로 `getComputedStyle`, `Range`, 토스트 요소 생성에 `doc`/`doc.defaultView`를 써야 한다. 클립보드는 PiP 창의 `navigator.clipboard`(사용자 제스처 필요) |
| 싱크 없음 밝게, 번역 밝기, 후리가나/거터 CSS | `fork.css`를 PiP 스타일 미러링 대상에 추가한다(`stylesheetUrls()` 확장 또는 `injectStylesheet` 경로) | 세계와 무관하게 URL로 로드되는지 확인 |
| 자동 스크롤 되감기 제거 | 4.1의 방식이 PiP 테마 경로에도 적용되는지 확인 | 창별 틱 |

**PiP 이식 순서**: 메인 뷰에서 각 기능이 안정된 뒤 Phase 6에서 얹는다. 대신 Phase 2~5의 화면 반영 코드는 처음부터 `doc` 인자를 받는 세계 무관 함수로 작성해서 재작업을 피한다(3.1 원칙 6).

## 5. 단계별 작업 순서와 완료 기준

각 단계의 공통 기준: `npm run typecheck`, `npm run build`(chrome/firefox/edge), `npm run knip`, 관련 자체 점검 통과, 체크리스트 수동 확인.

### Phase 0 — 준비 (S) — 완료

- [x] `my-changes`는 수정하지 않는다(확정 결정 4). `translation.ts`의 NUL 구분자는 이식 브랜치로 가져올 때(Phase 2) 일반 구분자로 바꾼다.
- [x] `git tag fork-v2.3.3 my-changes`(기존 작업 스냅샷, 로컬 태그), `git checkout -b port/2.4.0.9 v2.4.0.9`. 문서 커밋 두 개는 이 브랜치로 cherry-pick했다.
- [x] 기준선 확인: 업스트림 `v2.4.0.9` 그대로 `npm ci` → `npm run typecheck` → `npm run build`(chrome/firefox/edge)가 통과한다.

**기준선 기록** (이식 중 새로 생긴 문제와 구분하기 위함)
- 환경: node v24.18.0, npm 11.18.0. `npm ci`는 약 12초.
- `typecheck` 종료 코드 0. `generate:locales`가 만드는 `src/core/generated/locales.ts`는 git이 추적하지 않는다(작업 트리가 깨끗하게 유지됨).
- 빌드 산출물: `dist/chrome`, `dist/firefox`, `dist/edge`(모두 버전 2.4.0.9).
- 원래 있는 경고(우리 변경과 무관):
  - Firefox 빌드: `addons.mozilla.org requires browser_specific_settings.gecko.data_collection_permissions for new add-ons` (manifest).
  - `npm ci`: esbuild postinstall 스크립트가 `allowScripts`에 등록되지 않았다는 안내.

### Phase 1 — 스파이크 (M, 코드 변경 없음, 결과는 이 문서에 기록) — 완료

- **A. 단어 활성화 훅**: 코어 엔진이 단어 활성화/비활성화를 어떻게 알리는가. 후리가나 스윕 구현안 결정.
- **B. 줄 구조와 시크**: `blyrics--line` 직속 자식 구성, `::before` 바 플렉스 아이템이 새 구조에서 성립하는가, `addSeekHandler`가 언제 리스너를 붙이는가(`allZero` 처리 포함), 캡처 리스너로 가로챌 수 있는가.
- **C. 테마 설정 주입 경로**: 확장이 코어 설정을 직접 바꾸는 공식 방법.
- **D. `decorations` 맵과 `injectTranslation`/`injectRomanization`의 DOM**: 번역 행 요소 구조, 교체 시 처리, `lyricDecorations`와의 관계.
- **E. PiP** (지원 확정): (1) `applyDecorations()`에 우리 훅을 걸 위치와 방법, 기존 번역 요소를 교체할 수 있는지, (2) `bridge.ts` 페이로드와 `LyricLineDecoration` 확장 방법, 두 월드의 직렬화 제약, (3) `fork.css`를 PiP에 싣는 경로(`stylesheetUrls()`/`injectStylesheet`), (4) PiP의 스크롤/틱에서 passive scroll을 어떻게 다루는가, (5) Firefox 페이지 월드에서 우리 세계 무관 모듈을 번들하는 방법(`src/pageWorld.ts`).
- **F. 업스트림 옵션 화면 변경점**: `options.ts`/`options.html`의 Language/Display 탭 구성, 저장/복원 규약이 그대로인지.

**스파이크 결과 (조사 완료)**

- **A. 후리가나 스윕: 오버레이로 가능.** `PartData.animations`가 공개돼 있다. 자체 rAF 루프로 `isAnimating`인 줄을 훑고, 스윕 애니메이션의 `KeyframeEffect.getKeyframes()`를 복사해 후리가나 하이라이트 요소(자체 클래스, `.blyrics--word` 아님)에 우리 WAAPI 애니메이션을 만든다(`delay`=오프셋, `duration`=런 길이). `currentTime`은 단어 애니메이션에서 가져오고 pause/play를 미러링한다. `WeakMap<Animation, …>`로 추적. 글자 모드(`highlightLetterElements`)는 단순 그라디언트로 근사. 메인/PiP 문서 양쪽에서 동작해야 한다.
- **B. 줄 구조/시크:** 줄은 `lyricElement` → `.blyrics-line-main`(bidi-run, highlight-run) + 선택적 `.blyrics-background-line`. 코어 줄 CSS(`.blyrics-container > div`)에 `cursor: pointer`, `transform: scale`. `addSeekHandler`는 줄 요소에 click 리스너를 붙이므로(`allZero`면 `cursor: unset`), 여백(gutter)만 시크하려면 컨테이너에 캡처 단계 리스너를 걸어 이벤트를 막아야 한다. `::before` 바 플렉스 트릭은 새 block/main 레이아웃에서 재확인 필요. 더블클릭 시크는 `lyrics.ts`의 `seekPlayer` 또는 호스트 `seek` 사용.
- **C. 테마 설정:** `styleInjector.ts`의 `applyCustomStyles`가 `mainView.setTheme(withLetterWaveSetting(css))`를 호출하고 `/* blyrics-letter-wave = ...; */` 주석을 덧붙인다(마지막 값이 우선). 이 래퍼를 확장해 `/* blyrics-passive-scroll-bottom-pause-s = 999999; */`를 넣으면 패치·래핑 없이 자동 스크롤을 조절할 수 있다. PiP도 적용된 테마(`#blyrics-custom-style` textContent)를 `renderer.setTheme`으로 다시 읽으므로 양쪽에 적용될 것. 대안: `passiveScrollEnabled: false` + 자체 스크롤 루프.
- **D. 번역/데코레이션:** `injectTranslation`은 `.blyrics--translated`가 이미 있으면 no-op이므로 `upsertTranslation`은 기존 요소의 텍스트를 직접 수정해야 한다. `LineData.decorations`는 romanized/translated 요소의 슬라이드 애니메이션용일 뿐이다. 후리가나는 decorator가 아니므로 부착 후 `lyricsElementAdded()`로 relayout을 호출한다.
- **E. PiP:**
  - `pipHost.ts`는 페이로드의 줄이 같으면(`hasSameLines`) 재빌드 없이 `applyDecorations()` + `measureLyrics()`만 호출한다. 번역 교체/후리가나 부착은 여기에 얇은 훅이 필요하다.
  - 후리가나 데이터는 `LyricLineDecoration`과 `bridge.ts` 페이로드에 추가하고, 부착 코드는 `doc`를 받는 순수 DOM 함수로 작성한다.
  - `fork.css`는 `public/css/blyrics/index.css`에 `@import url("fork.css");`를 추가해 싣는다(PiP는 `LYRIC_STYLESHEET_PATH = css/blyrics/index.css` 단일 URL 사용, `extension.config.js`는 평탄화 시 파일명 충돌이면 실패).
  - 페이로드에 `passiveScrollEnabled`가 있다. Firefox 페이지 월드 번들은 `src/pageWorld.ts`가 `mainWorldHost`를 import한다. 우리 모듈은 `chrome.*`를 쓰지 않는 세계 무관 파일로 두면 그 번들에 들어간다.
  - 구현 단계(Phase 6)에서 재확인: PiP의 `tickLyrics()` 위치, 페이지 월드 번들에 fork 모듈이 실제로 포함되는지.
- **F. 옵션 화면:** 저장/복원 규약(`saveOptions`, `getOptionsFromForm`, `restoreOptions`의 `defaultOptions`/`readKeys`, `setOptionsInForm`, `#options input, #options select` 자동 연결) 동일. 탭은 `display-content`, `language-content`(`isRomanizationEnabled`, `translate`), `sources-content`, `themes-content`, `identity-content`. 추가할 키: `translationQuality`, `llmProvider`, `llmModel`, `llmCustomPrompt`, `isLlmFuriganaEnabled`, `isLlmRevisionEnabled`, `albumArtSize`(`furiganaSource` 제외). 옵션 UI는 JS로 생성해 upstream html 수정을 최소화한다.

### Phase 2 — 비렌더링 기능 (M) — 코드 완료(브라우저 실측 대기)

- [x] 빌드/의존성/사전/`manifest.json`(1), 설정 인프라(2), `translation.ts` 병합(3). (`extension.config.js`가 rspack으로 바뀌어 `resolve.fallback`은 `config: rspackConfig =>` 안에 넣음)
- [x] `llmTranslation.ts` 복사, `processBatchTranslationsAndRomanizations`에 훅(4), 로마자 게이팅(5), `isTemporary` 처리.
- 구현 메모: 업스트림 `translation.ts`에 Unison 번역(`enrichViaUnison`)이 추가돼 Google 앞에서 먼저 호출된다. 3-way 병합 때 Unison 캐시 키도 `cacheKeyFor`로 통일했다. NUL은 `` 이스케이프로 대체. LLM 통합은 `forkTranslation.ts`(`runLlmTranslationPass`)로 분리하고 `injectLyrics.ts`에는 훅만 추가. 후리가나 관련 로마자 게이팅(`songIsJapanese`)은 Phase 4에서 함께 처리.
- 완료 기준: Best 모드에서 번역이 Google → LLM → 수정 순으로 교체되고, 실패 시 앞 단계가 유지된다. 설정 화면 재오픈 후 값 유지.

### Phase 3 — 표시 설정 (S~M) — 코드 완료(브라우저 실측 대기)

- [x] `fork.css` 신설(변수 기본값 포함), 싱크 없음 밝게(6), 자동 스크롤(7), 앨범 커버(8), 번역 밝기(13).
- 구현 메모: `fork.css`는 `index.css`가 마지막에 import(PiP에도 실림). 자동 스크롤은 `styleInjector.ts`가 테마 뒤에 `blyrics-passive-scroll-bottom-pause-s = 999999` 주석을 붙이는 방식(코어 무수정). 로마자 스타일(위쪽 배치, 박스 제거)은 후리가나 레이아웃과 함께 Phase 4에서 결정. 앨범 아트 CSS는 Phase 2에서 처리됨.
- 완료 기준: 싱크 없는 가사 전체가 밝게 보이고 자동 스크롤이 맨 아래에서 유지된다.

### Phase 4 — 후리가나 (L) — 코드 완료(브라우저 실측 대기)

- [x] 스파이크 A 결과대로 렌더링/레이아웃(9) → 스윕(10) 순서. 정적 표시(읽기, 위치)가 먼저 정확한 뒤 스윕을 붙인다.
- [x] 후리가나 순수 로직은 이전 그대로: `alignKanjiRuns`, `mergeRuns`, `applyOverrides`, 병합 규칙.
- 구현 메모: `furigana.ts`(순수 로직+kuromoji, UtaTen 오버라이드 제거)와 `furiganaDom.ts`(세계 무관 DOM/스윕)로 분리. 단어 요소는 `LineData.parts[].lyricElement`(`data-content`)에서 얻고, 글자 위치는 TreeWalker+Range라 글자 모드에서도 동작. 스윕은 `part.animations`의 스윕 애니메이션(keyframe/timing)을 후리가나 하이라이트에 복제(길이·시작 오프셋 안분)하고 rAF로 currentTime/재생상태를 미러링. 글자 모드는 단순 그라디언트로 근사, 줄 싱크 단어는 fade 미러. 로마자 위치/박스 스타일은 업스트림 그대로 유지. 남은 위험: 로마자 배치 요청 캐시 의존, 재레이아웃(창 크기 변경) 시 후리가나 위치 재계산 없음(기존과 동일).
- 완료 기준: 6절의 후리가나 회귀 케이스 통과, 배경 보컬/오른쪽 정렬/글자 단위 싱크 곡에서 위치가 맞고 스윕이 단어와 같이 진행된다.

### Phase 5 — 시크/복사 (L) — 코드 완료(브라우저 실측 대기)

- [x] 스파이크 B 결과대로 CSS와 캡처 리스너 구성(11). `isInSeekGutter`의 텍스트 범위 측정에서 새 구조의 본문 단어만 대상으로.
- 구현 메모: 코어가 이미 모든 줄에 클릭 시크 리스너를 붙이므로(라인 요소 버블 단계), 별도 시크 구현 없이 컨테이너에 캡처 단계 `click` 리스너를 두어 거터 밖 단일 클릭만 `stopPropagation`으로 가로챈다. 더블클릭(`event.detail >= 2`)과 rich-sync Alt+클릭 단어 시크는 코어 자체 로직과 동일하므로 그대로 통과시킨다. 간주 행(`data-instrumental="true"`)은 거터 제한 없이 전체가 대상, 싱크 없음(`data-sync="none"`)은 코어가 리스너를 아예 안 붙이므로 손대지 않음. v2.3.3의 flex `::before` 트릭은 새 구조(`.blyrics--line`이 flex가 아님)에 안 맞아, 대신 JS가 실제 단어 rect를 측정해 `.blyrics-line-main::before`의 `left`를 CSS 변수로 직접 지정하는 방식으로 다시 만들었다(텍스트가 슬라이드하지 않아도 됨, 기존보다 단순). 복사/토스트/직렬화는 새 클래스명(`WORD_HIGHLIGHT_CLASS`, `HIGHLIGHT_RUN_CLASS`)에 맞춰 조정. `lineInteractions.ts`는 `Document`를 element에서 얻어 world-agnostic하게 작성(Phase 6에서 PiP 재사용 목적).
- 버그 수정(사용자 실측): (1) `getComputedStyle`로 커스텀 속성 `--blyrics-seek-gutter-width`를 읽어 `parseFloat`했더니 "1.5rem" 문자열의 단위가 무시되어 ~1.5px로 해석됨 → 히스테리시스가 안 보임. 루트 폰트 크기 기반 px 환산으로 교체. (2) 더블클릭 시크 후 브라우저의 기본 단어 선택이 지워지지 않던 문제 → 컨테이너에 `dblclick` 리스너를 추가해 선택을 해제.
- 완료 기준: 거터에서만 시크, 나머지는 선택/복사, 더블클릭 시크, 히스테리시스, 오른쪽 정렬/RTL/간주 행/싱크 없음 행 동작.

### Phase 6 — PiP 지원 (L)

- [ ] 스파이크 E 결과대로: 번역 교체 훅, 후리가나 데이터 전송과 PiP 측 부착, 스윕, 거터/복사 리스너 설치, `fork.css` 로드, 자동 스크롤.
- [ ] Chromium(ISOLATED 호스트)과 Firefox(MAIN 월드 호스트) 양쪽 빌드에서 확인.
- 완료 기준: PiP 창에서도 후리가나(위치, 스윕), LLM 번역 교체, 거터 시크와 복사, 싱크 없음 밝게가 메인 뷰와 같게 동작한다.

### Phase 7 — 마무리 (S~M)

- [ ] AI 후리가나(12) 마무리, UtaTen 흔적이 없는지 확인(`npm run knip`으로 미사용 코드 점검), 문서 갱신, `README.md` 버전 표기, 셀프체크 추가(6절).

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
| 코어가 확장 지점을 제공하지 않아 후리가나/시크를 오버레이로 못 함 | 9~11 지연 | 스파이크 A/B에서 조기 판단. 코어를 고치지 않는다는 결정(확정 2)에 따라 해당 기능의 범위를 줄이거나 사용자와 상의 |
| 코어 버전이 올라가면 내부 DOM이 다시 바뀜 | 후리가나/거터 깨짐 | 코어에 의존하는 선택자를 한 파일에 모으고, 셀프체크로 DOM 가정을 검사 |
| 사용자가 직접 확인해야 하는 항목 다수(브라우저 필수) | 일정 지연 | 단계마다 체크리스트를 짧게 나눠 전달 |
| 17MB 사전 커밋으로 저장소 비대 | 클론 시간 | 이미 커밋됨. 필요하면 릴리스 자산/빌드 시 다운로드로 전환 검토 |
| PiP가 두 월드(ISOLATED/MAIN)에서 돌고 우리 훅이 직렬화 경계를 넘어야 함 | PiP 기능 지연 | 계산은 ISOLATED, 화면 반영은 `doc`을 받는 세계 무관 함수 + 데이터 전달. Firefox 빌드에서 반드시 확인 |
| 업스트림이 내가 만든 기능과 같은 것을 추가 | 중복 | 이식 시점에 기능 목록을 다시 대조하고 겹치는 것은 업스트림 것을 채택 |

## 8. 남은 확인 사항

사용자 결정 4건은 1절의 "확정된 결정" 표에 반영했다. 남은 것은 스파이크 결과에 따라 범위가 달라질 수 있는 항목이다.

- 후리가나 스윕을 코어를 고치지 않고 구현할 수 있는가(스파이크 A). 안 되면 스윕 없이 정적 표시만 하는 축소안을 사용자와 상의한다.
- PiP 페이로드에 곡 전체의 후리가나 데이터를 실어도 크기와 갱신 빈도가 문제없는가(스파이크 E).
- Firefox(페이지 월드 호스트)에서 PiP 기능을 어디까지 지원할 것인가(스파이크 E).
