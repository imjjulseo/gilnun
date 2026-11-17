# 트이길

오늘 갈 동네를 펼치면 트인 길이 먼저 보이는 지도. 가고 싶은 곳을 넣으면 트인 길로 잇고, 데이트 코스까지 짜 준다.

- `src/App.svelte` 지도 탭(길 색칠, 가게 이름, 검색, 가게 카드, 길 찾기)과 하단 탭
- `src/components/` 검색, 코스 탭, 저장 탭, 설정 탭, 공유, 나란히 보기
- `src/lib/route.ts`, `course.ts`, `route.worker.ts` 길 찾기와 코스 짜기(별도 스레드)
- `src/lib/sun.ts`, `theme.ts` 해 위치, 하늘 단계(낮, 노을, 밤과 별빛)
- `src/lib/share.ts` 공유 링크(`?c=`)와 공유 이미지
- `public/data/` 앱이 읽는 데이터. `manifest.json`이 목록이고, 새 계산 결과가 나오면 파일을 덮어쓰고 `version`을 올린다
- `tools/` 계산 결과를 앱 데이터로 바꾸는 스크립트(Mac에서 실행)

```
npm install
npm run dev
```

`main`에 올리면 GitHub Actions가 GitHub Pages로 배포한다.
