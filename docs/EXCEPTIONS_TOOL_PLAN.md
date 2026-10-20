# 예외처리 툴 제작 계획 (확장 안에서 직접 편집)

현재 예외는 세 곳에 흩어져 있고, 정적 표는 코드를 고쳐 다시 빌드해야 한다. 목표는 **빌드 없이 확장 UI에서 예외를 추가·수정·삭제·백업**하는 것이다.

## 1. 현재 상태

| 예외 | 위치 | 편집 방법 |
| --- | --- | --- |
| 후리가나 정적 표 `READING_OVERRIDES` (`[매치, 한자시작, 한자끝, 읽기]`) | `furigana.ts` | 코드 수정 + 빌드 |
| 후리가나 사용자 수정 | `chrome.storage.local["furiganaUserOverrides"]` (`한자 덩어리 → 읽기`, 전역) | 가사에서 더블클릭 (목록/삭제 UI 없음) |
| 번역 용어 지정 (예: 界隈) | 없음 (프롬프트 문구에 예시로만 존재) | 프롬프트 직접 수정 |

## 2. 범위 (3종 예외 + 공통 기능)

1. **후리가나 읽기 예외**: 정적 표와 같은 형식(매치 문자열, 한자 구간, 읽기)을 UI에서 편집. 한자 덩어리 단위인 지금의 더블클릭 수정은 "매치 = 덩어리 전체"인 특수 경우로 흡수.
2. **번역 용어집**: `원문 용어 → 대상 언어 표기`(+ 선택 메모), 대상 언어별. LLM 프롬프트에 "다음 용어는 반드시 이렇게 번역" 블록으로 주입하고, 결과에 빠졌으면 수정 패스에서 지적. Google 번역 경로에서는 적용하지 않음(한계로 명시).
3. **곡별 설정**: 곡 ID 단위의 원문 언어 고정, 로마자/번역 끄기, 후리가나 끄기. 언어 오판정 곡을 고치는 용도.
4. 공통: 범위(전역 / 이 곡만), 활성 토글, 가져오기·내보내기(JSON), 검색, 일괄 삭제.

## 3. 데이터 모델 (`chrome.storage.local`, 키 `blyricsExceptions`, 버전 필드 포함)

```ts
type ExceptionStore = {
  version: 1;
  reading: Array<{ id: string; match: string; start: number; end: number; reading: string; songId?: string; enabled: boolean }>;
  glossary: Array<{ id: string; term: string; target: string; lang: string; note?: string; songId?: string; enabled: boolean }>;
  song: Record<string, { sourceLanguage?: string; romanization?: boolean; translation?: boolean; furigana?: boolean }>;
};
```

- 기존 `furiganaUserOverrides`는 첫 로드 때 `reading`으로 마이그레이션(`match=덩어리 전체`, `start=0`, `end=길이`) 후 구키를 남겨 두었다가 한 버전 뒤 삭제.
- 용량: local 저장소라 여유가 크지만, 번역·로마자 캐시와 키를 분리해 캐시 정리에 지워지지 않게 한다.
- 우선순위: 사용자 곡별 > 사용자 전역 > 정적 표(`READING_OVERRIDES`). 지금 `applyUserOverrides`가 최우선인 것과 호환.

## 4. 코드 구조

- `src/modules/exceptions/store.ts` — 스키마, 로드/저장, 마이그레이션, `chrome.storage.onChanged` 구독으로 열린 탭에 즉시 반영. **순수 함수**(매치 계산 등)와 I/O를 분리해 셀프체크 가능하게 한다.
- `furigana.ts`: `applyUserOverrides`를 `store`의 `reading` 조회로 교체(곡 ID 전달 필요: `annotateFurigana*` 호출부에서 현재 곡 ID 주입).
- `llmTranslation.ts`: `buildPrompt`에 용어집 블록 추가, 캐시 키에 용어집 해시 포함(용어집이 바뀌면 재번역).
- `injectLyrics.ts`: 곡별 설정을 `scriptContradicts`/`isDefaultLanguage` 판정보다 먼저 적용.
- PiP: 후리가나/번역은 이미 ISOLATED에서 계산해 payload로 보내므로 **편집 UI는 메인 전용**, 결과만 PiP로 흐른다(지금의 더블클릭과 같은 제약).

## 5. UI

1. **옵션 페이지 "예외" 탭** (주 편집 화면): 세 섹션(후리가나/용어집/곡별), 표 + 추가 폼 + 검색 + 가져오기/내보내기. 후리가나 행은 미리보기(`漢字` 위에 읽기)를 보여 준다. 기존 모달 탭(`modal-tab`) 패턴 재사용, 문자열은 `_locales`에 추가.
2. **가사 위 빠른 추가** (보조):
   - 후리가나 더블클릭 수정 입력에 "이 곡만 / 항상" 선택을 추가(기본 항상).
   - 번역 줄 우클릭 → "용어 지정…": 선택한 원문 구간과 번역을 채운 작은 폼. 저장 시 해당 곡 번역 캐시를 비우고 재번역.
3. 변경 즉시 반영: 저장 → `onChanged` → 현재 곡 재주입(후리가나는 DOM 교체, 번역은 용어집이 바뀐 줄만 재요청).

## 6. 단계

| 단계 | 내용 | 규모 | 검증 |
| --- | --- | --- | --- |
| E1 | `store.ts` + 마이그레이션 + 셀프체크, 후리가나 조회 교체(동작 변화 없음) | S | 셀프체크, 기존 더블클릭 수정이 그대로 동작 |
| E2 | 옵션 "예외" 탭: 후리가나 섹션(목록/추가/삭제/토글/가져오기·내보내기) | M | 브라우저: 추가한 읽기가 열린 가사에 즉시 반영 |
| E3 | 번역 용어집(프롬프트 주입 + 캐시 키 + 수정 패스 지적) + UI 섹션 | M | 界隈 예시로 AI 번역 확인, Google 경로 미적용 안내 |
| E4 | 곡별 설정(+ 곡 ID 확보 경로 확인) + UI 섹션 | M | 언어 오판정 곡에서 고정 효과 |
| E5 | 가사 위 빠른 추가(더블클릭 범위 선택, 우클릭 용어 지정) | M | 브라우저 + PiP에서 결과 반영 확인 |

## 7. 열린 질문

- 용어집을 **한 줄 단위 치환(후처리)** 로도 보장할지: LLM 지시만으로는 어길 수 있다. 후처리는 어형 변화가 있는 언어에서 부자연스러워 기본은 프롬프트 + 수정 패스 지적으로 하고, 강제 치환은 항목별 옵션으로 둘지 결정 필요.
- 곡 ID를 무엇으로 쓸지(영상 ID vs 제목+아티스트 정규화). 같은 곡의 다른 업로드를 묶으려면 후자가 낫다.
- 기기 간 동기화(`storage.sync`)는 8KB/항목 제한 때문에 보류. 내보내기/가져오기로 대체.
