"""상가(상권)정보 -> 앱 장소 데이터(poi.json, addr.json).
입력: work/poi_seoul.parquet (상가정보 서울 CSV에서 필요한 열만 뽑은 것. 없으면 CSV에서 만든다)
출력: <APPDATA>/<지역>/poi.json, addr.json
poi.json  = {cats:[...], subs:[...], rows:[[이름, 분류, 소분류, 경도, 위도, 주소번호, 층], ...]}
addr.json = {addrs:[도로명주소...], pts:[[경도, 위도]...]}  (그 주소의 모든 업소 좌표 평균. 공유 글자 주소 찾기용)
분류: 0 음식점, 1 카페와 디저트, 2 술집, 3 편의점, 4 놀거리(코스용)"""
import os, json, glob, re, unicodedata, numpy as np, pandas as pd
U = os.environ.get('VIEWAPP', '/mnt/user-data/uploads/viewapp')
OUT = os.environ.get('APPDATA', os.path.join(os.path.dirname(__file__), '..', 'public', 'data'))
P = f'{U}/work/poi_seoul.parquet'
if not os.path.exists(P):
    f = [x for x in glob.glob(f'{U}/data/poi/*/*.csv') if '서울' in unicodedata.normalize('NFC', x)][0]
    cols = ['상가업소번호', '상호명', '지점명', '상권업종대분류명', '상권업종중분류코드', '상권업종중분류명', '상권업종소분류코드', '상권업종소분류명', '행정동명', '도로명주소', '건물명', '층정보', '경도', '위도']
    D = pd.read_csv(f, usecols=cols, dtype=str); D['경도'] = D['경도'].astype(float); D['위도'] = D['위도'].astype(float); D.to_parquet(P)
D = pd.read_parquet(P)
man = json.load(open(f'{OUT}/manifest.json'))
M = 0.004                                                       # 지역 경계 밖 여유(약 400m)
DESSERT = {'I21001', 'I21002', 'I21008'}                          # 빵/도넛, 떡/한과, 아이스크림/빙수
BAR = {'생맥주 전문', '요리 주점'}                                  # 유흥 주점은 뺀다
# 놀거리: 소분류 이름으로 고른다(데이트 코스에 넣을 만한 실내외 여가). 결과의 소분류 목록을 출력하니 보고 빼거나 더한다.
PLAY = ('노래', 'PC방', '당구', '볼링', '방탈출', '보드게임', '게임', '오락', '영화', '공연', '미술관', '박물관', '전시', '공방', '만화', '스크린 골프', '탁구', '클라이밍', '사격', '양궁', '실내 낚시', '롤러', '아이스', '수영장', '찜질', '사진 촬영')
NOT_PLAY = ('학원', '교습', '도매', '제조', '수리', '임대')
def cat(r):
    c2, c3, s = r.상권업종중분류코드, r.상권업종소분류코드, r.상권업종소분류명
    if c3 == 'G20405': return 3
    if isinstance(s, str) and any(k in s for k in PLAY) and not any(k in s for k in NOT_PLAY) and not str(c2).startswith('I2'): return 4
    if c2 == 'I212' or c3 in DESSERT: return 1
    if c2 == 'I211': return 2 if s in BAR else -1
    if isinstance(c2, str) and c2.startswith('I2') and c2 != 'I207': return 0
    return -1
CATS = ['음식점', '카페와 디저트', '술집', '편의점', '놀거리']
def key(a):                                                     # '서울특별시 동작구 노량진로 100' -> '노량진로 100'
    m = re.search(r'([가-힣A-Za-z0-9.]+(?:로|길))\s*(\d+(?:-\d+)?)', str(a)); return f'{m.group(1)} {m.group(2)}' if m else None
for reg in man['regions']:
    b = reg['bbox']
    R = D[(D.경도 > b[0] - M) & (D.경도 < b[2] + M) & (D.위도 > b[1] - M) & (D.위도 < b[3] + M)].copy()
    # 주소 좌표 표: 모든 업종으로 만든다
    R['k'] = R.도로명주소.map(key)
    A = R.dropna(subset=['k']).groupby('k')[['경도', '위도']].mean()
    addrs = list(A.index); aidx = {a: i for i, a in enumerate(addrs)}
    R['c'] = [cat(r) for r in R.itertuples()]
    S = R[R.c >= 0].copy()
    subs = sorted(S.상권업종소분류명.unique()); sidx = {s: i for i, s in enumerate(subs)}
    def nm(r):
        n = str(r.상호명).strip(); br = str(r.지점명).strip() if isinstance(r.지점명, str) else ''
        return f'{n} {br}' if br and br not in n else n
    def fl(v):
        try: v = int(float(v)); return v if v != 0 else None
        except Exception: return None
    rows = [[nm(r), int(r.c), sidx[r.상권업종소분류명], round(r.경도, 6), round(r.위도, 6), aidx.get(r.k, -1), fl(r.층정보)] for r in S.itertuples()]
    os.makedirs(f"{OUT}/{reg['id']}", exist_ok=True)
    json.dump(dict(cats=CATS, subs=subs, rows=rows), open(f"{OUT}/{reg['id']}/poi.json", 'w'), ensure_ascii=False, separators=(',', ':'))
    json.dump(dict(addrs=addrs, pts=[[round(x, 6), round(y, 6)] for x, y in A.values]), open(f"{OUT}/{reg['id']}/addr.json", 'w'), ensure_ascii=False, separators=(',', ':'))
    reg['poi'] = f"{reg['id']}/poi.json"; reg['addr'] = f"{reg['id']}/addr.json"
    print(reg['id'], len(rows), 'places', pd.Series([r[1] for r in rows]).value_counts().sort_index().to_dict(), len(addrs), 'addrs',
          os.path.getsize(f"{OUT}/{reg['id']}/poi.json") // 1024, 'KB')
    print('놀거리 소분류:', S[S.c == 4].상권업종소분류명.value_counts().to_dict())
json.dump(man, open(f'{OUT}/manifest.json', 'w'), ensure_ascii=False, indent=1)
