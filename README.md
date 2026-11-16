# 길눈

오늘 갈 동네에서 뷰 좋은 길을 찾는 지도.

- `src/` 웹앱 (Vite, Svelte, MapLibre)
- `public/data/` 앱이 읽는 데이터. `manifest.json`이 목록이고, 새 계산 결과가 나오면 파일을 덮어쓰고 `version`을 올린다
- `tools/build_app_data.py` 계산 결과를 앱 데이터로 바꾸는 스크립트

```
npm install
npm run dev
```

`main`에 올리면 GitHub Actions가 GitHub Pages로 배포한다.
